/**
 * The request engine's public API: create · cancel · fulfil · snooze · send now.
 *
 * All writes go through the service role (core.requests is SELECT-only for members,
 * migration 178), org pinned on every statement. Routes MUST have authorized the caller
 * (requirePermission) and — for an existing request — proven it is visible to them by
 * reading it through their RLS-scoped client first (lib/db/scoped-writer.ts rule 4).
 */

import { serviceWriter } from '@/lib/db/scoped-writer';
import { anchorBase, deferForQuietHours, initialSchedule, resolveTimeZone } from './cadence';
import { cadenceOf, dispatchOne, type EngineDeps } from './dispatch';
import { recordEvent } from './events';
import { loadPolicyContext, resolvePolicy, type PolicyContext } from './policy';
import {
  LIVE_STATUSES,
  SYSTEM_ACTOR,
  isChannel,
  type Cadence,
  type CadenceAnchor,
  type Channel,
  type FulfilledVia,
  type RecipientType,
  type RequestKind,
  type RequestRow,
  type RequestSource,
  type SubjectType,
} from './types';

const LIVE: string[] = [...LIVE_STATUSES];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class RequestError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface RecipientInput {
  type: RecipientType;
  membershipId?: string | null;
  vendorId?: string | null;
  customerId?: string | null;
  employeeId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  timezone?: string | null;
}

export interface CreateRequestInput {
  orgId: string;
  locationId?: string | null;
  kind: RequestKind;
  subjectType?: SubjectType;
  subjectId?: string | null;
  dedupeKey?: string | null;
  title: string;
  message?: string | null;
  deepLink?: string | null;
  recipient: RecipientInput;
  channels?: Channel[];
  dueDate?: string | null;
  /** A due-anchored COI renewal (uses the coi_renewal policy). */
  renewal?: boolean;
  cadence?: Partial<Pick<Cadence, 'offsetsMinutes' | 'repeatEveryMinutes' | 'maxSends'>> & { anchor?: CadenceAnchor };
  escalateAfter?: number | null;
  escalateToMembershipId?: string | null;
  ownerMembershipId?: string | null;
  source?: RequestSource;
  meta?: Record<string, unknown>;
  createdBy: string;
}

export interface CreateResult {
  created: boolean;
  request: RequestRow;
}

function isUnique(e: { message: string; code?: string } | null): boolean {
  return !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message));
}

/** Validate + build the row. Pure (exported for tests). */
export function buildRequestRow(input: CreateRequestInput, ctx: PolicyContext, now: Date): Record<string, unknown> {
  const title = input.title?.trim();
  if (!title) throw new RequestError('A request needs a title.');
  if (title.length > 200) throw new RequestError('Keep the title under 200 characters.');
  const email = input.recipient.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new RequestError('That email address does not look right.');
  if (input.recipient.type === 'member' && !input.recipient.membershipId) throw new RequestError('Pick the team member to ask.');
  if (input.recipient.type !== 'member' && !email && !input.recipient.phone) {
    // allowed (the owner is told it can't be delivered), but only for engine-created rows
    if (input.source === 'manual' || !input.source) throw new RequestError('Add an email address for the recipient.');
  }
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new RequestError('Due date must be YYYY-MM-DD.');

  const policy = resolvePolicy(ctx, input.kind, { renewal: input.renewal });
  const anchor = input.cadence?.anchor ?? policy.anchor;
  if (anchor === 'due' && !input.dueDate) throw new RequestError('This kind of request is timed from a due date — add one.');
  const offsets = (input.cadence?.offsetsMinutes?.length ? input.cadence.offsetsMinutes : policy.cadence.offsetsMinutes)
    .map((n) => Math.trunc(n))
    .sort((a, b) => a - b);
  if (offsets.length > 12) throw new RequestError('At most 12 scheduled asks.');
  const cadence: Cadence = {
    anchor,
    offsetsMinutes: offsets,
    repeatEveryMinutes: input.cadence?.repeatEveryMinutes !== undefined ? input.cadence.repeatEveryMinutes : policy.cadence.repeatEveryMinutes,
    maxSends: input.cadence?.maxSends ?? policy.cadence.maxSends,
  };
  let channels = (input.channels?.length ? input.channels : policy.channels).filter(isChannel);
  if (input.recipient.type === 'member' && !channels.includes('in_app')) channels = [...channels, 'in_app'];
  channels = Array.from(new Set(channels));
  if (channels.length === 0) throw new RequestError('Pick at least one channel.');

  const tz = resolveTimeZone(input.recipient.timezone, policy.timezone);
  const base = anchorBase(anchor, now, input.dueDate ?? null, tz);
  const first = initialSchedule(cadence, base, now);
  const nextAt = deferForQuietHours(first.at, policy.quiet, tz);

  return {
    org_id: input.orgId,
    location_id: input.locationId ?? null,
    kind: input.kind,
    subject_type: input.subjectType ?? 'none',
    subject_id: input.subjectId ?? null,
    dedupe_key: input.dedupeKey ?? null,
    title,
    message: input.message?.trim() ? input.message.trim().slice(0, 4000) : null,
    deep_link: input.deepLink && input.deepLink.startsWith('/') && !input.deepLink.startsWith('//') ? input.deepLink : null,
    recipient_type: input.recipient.type,
    recipient_membership_id: input.recipient.membershipId ?? null,
    recipient_vendor_id: input.recipient.vendorId ?? null,
    recipient_customer_id: input.recipient.customerId ?? null,
    recipient_employee_id: input.recipient.employeeId ?? null,
    recipient_name: input.recipient.name?.trim() || null,
    recipient_email: email,
    recipient_phone: input.recipient.phone?.trim() || null,
    recipient_timezone: input.recipient.timezone && input.recipient.timezone === tz ? tz : null,
    channels,
    cadence_anchor: anchor,
    cadence_offsets_minutes: cadence.offsetsMinutes,
    repeat_every_minutes: cadence.repeatEveryMinutes,
    max_sends: cadence.maxSends,
    cadence_slot: first.slot,
    quiet_start: policy.quiet?.start ?? null,
    quiet_end: policy.quiet?.end ?? null,
    escalate_after: input.escalateAfter !== undefined ? input.escalateAfter : policy.escalateAfter,
    escalate_to_membership_id: input.escalateToMembershipId ?? null,
    owner_membership_id: input.ownerMembershipId ?? null,
    status: 'open',
    due_date: input.dueDate ?? null,
    next_send_at: nextAt.toISOString(),
    source: input.source ?? 'manual',
    meta: input.meta ?? {},
    created_by: input.createdBy,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export async function createRequest(deps: Pick<EngineDeps, 'db' | 'now'>, input: CreateRequestInput, ctx?: PolicyContext): Promise<CreateResult> {
  const now = deps.now();
  const policyCtx = ctx ?? (await loadPolicyContext(deps.db, input.orgId));
  const row = buildRequestRow(input, policyCtx, now);
  const { data, error } = await deps.db.schema('core').from('requests').insert(row).select('*').single();
  if (error) {
    if (isUnique(error as { message: string; code?: string }) && input.dedupeKey) {
      const { data: existing } = await deps.db
        .schema('core')
        .from('requests')
        .select('*')
        .eq('org_id', input.orgId)
        .eq('dedupe_key', input.dedupeKey)
        .in('status', LIVE)
        .limit(1)
        .maybeSingle();
      if (existing) return { created: false, request: existing as RequestRow };
    }
    throw new RequestError(`Could not create the request: ${error.message}`, 500);
  }
  const request = data as RequestRow;
  await recordEvent(
    deps.db,
    request,
    { event_type: 'created', actor: input.createdBy, detail: `Next ask ${request.next_send_at ?? 'not scheduled'}.`, meta: { source: request.source } },
    now,
  );
  return { created: true, request };
}

/** Load one request, org pinned (service role). */
export async function getRequest(deps: Pick<EngineDeps, 'db'>, orgId: string, id: string): Promise<RequestRow | null> {
  const { data, error } = await deps.db.schema('core').from('requests').select('*').eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) throw new RequestError(`Could not read the request: ${error.message}`, 500);
  return (data as RequestRow | null) ?? null;
}

/** Label + creator the W-9 / COI bridge stamps on a vendor-portal link it mints (vendor-compliance.ts). */
const REQUEST_PORTAL_LABEL = 'Document request link';

/**
 * A closed W-9 / COI request no longer needs its vendor upload link: revoke the
 * vendor-portal token the bridge minted for it — but only a token the bridge minted
 * (SYSTEM_ACTOR + its label; a link a person created by hand is theirs to manage) and only
 * when no other live request still points at the same token (the bridge reuses a live
 * link that covers the documents asked for). Best-effort: the request is already closed.
 */
async function revokeRequestPortalLink(deps: Pick<EngineDeps, 'db'>, orgId: string, row: RequestRow, now: Date): Promise<void> {
  const tokenId = typeof row.meta?.vendor_portal_token_id === 'string' ? row.meta.vendor_portal_token_id : null;
  if (!tokenId) return;
  try {
    const { data: others } = await deps.db
      .schema('core')
      .from('requests')
      .select('id, meta')
      .eq('org_id', orgId)
      .in('kind', ['w9', 'coi'])
      .in('status', LIVE)
      .neq('id', row.id)
      .limit(1000);
    const stillUsed = ((others ?? []) as Array<{ id: string; meta: Record<string, unknown> | null }>)
      .some((r) => r.meta?.vendor_portal_token_id === tokenId);
    if (stillUsed) return;
    // deps.db is the engine's service-role writer (vendor_portal_tokens is service-write only).
    const { error } = await serviceWriter(deps.db)
      .from('vendor_portal_tokens')
      .update({ status: 'REVOKED', updated_at: now.toISOString() })
      .eq('org_id', orgId)
      .eq('id', tokenId)
      .eq('status', 'ACTIVE')
      .eq('created_by', SYSTEM_ACTOR)
      .eq('label', REQUEST_PORTAL_LABEL);
    if (error) console.warn('[requests] vendor portal link revoke failed (non-fatal):', error.message);
  } catch (e) {
    console.warn('[requests] vendor portal link revoke failed (non-fatal):', e);
  }
}

async function transition(
  deps: Pick<EngineDeps, 'db' | 'now'>,
  orgId: string,
  id: string,
  patch: Record<string, unknown>,
  event: { type: 'cancelled' | 'fulfilled' | 'snoozed' | 'reopened'; detail: string; actor: string },
  from: string[] = LIVE,
): Promise<RequestRow> {
  const now = deps.now();
  const { data, error } = await deps.db
    .schema('core')
    .from('requests')
    .update({ ...patch, updated_at: now.toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .in('status', from)
    .select('*');
  if (error) throw new RequestError(`Could not update the request: ${error.message}`, 500);
  const row = (Array.isArray(data) ? data[0] : null) as RequestRow | null;
  if (!row) throw new RequestError('That request is already closed or does not exist.', 409);
  if (event.type === 'cancelled' || event.type === 'fulfilled') {
    await deps.db.schema('core').from('request_tokens').update({ revoked_at: now.toISOString() }).eq('org_id', orgId).eq('request_id', id).is('revoked_at', null);
    await revokeRequestPortalLink(deps, orgId, row, now);
  }
  await recordEvent(deps.db, row, { event_type: event.type, detail: event.detail, actor: event.actor }, now);
  return row;
}

export function cancelRequest(deps: Pick<EngineDeps, 'db' | 'now'>, orgId: string, id: string, actor: string, reason: string): Promise<RequestRow> {
  const why = reason.trim();
  if (!why) throw new RequestError('Say why you are cancelling (it goes on the timeline).');
  const now = deps.now();
  return transition(
    deps,
    orgId,
    id,
    { status: 'cancelled', cancelled_at: now.toISOString(), cancelled_by: actor, cancel_reason: why.slice(0, 500), next_send_at: null, snoozed_until: null },
    { type: 'cancelled', detail: why.slice(0, 500), actor },
  );
}

export function fulfilRequest(
  deps: Pick<EngineDeps, 'db' | 'now'>,
  orgId: string,
  id: string,
  actor: string,
  opts: { via?: FulfilledVia; note?: string | null } = {},
): Promise<RequestRow> {
  const now = deps.now();
  const note = opts.note?.trim() || 'Marked fulfilled.';
  return transition(
    deps,
    orgId,
    id,
    { status: 'fulfilled', fulfilled_at: now.toISOString(), fulfilled_by: actor, fulfilled_via: opts.via ?? 'manual', fulfilled_note: note.slice(0, 500), next_send_at: null, snoozed_until: null },
    { type: 'fulfilled', detail: note.slice(0, 500), actor },
  );
}

export function snoozeRequest(deps: Pick<EngineDeps, 'db' | 'now'>, orgId: string, id: string, actor: string, until: Date): Promise<RequestRow> {
  const now = deps.now();
  if (!(until.getTime() > now.getTime())) throw new RequestError('Snooze until a time in the future.');
  if (until.getTime() - now.getTime() > 90 * 86_400_000) throw new RequestError('Snooze for at most 90 days.');
  return transition(
    deps,
    orgId,
    id,
    { status: 'snoozed', snoozed_until: until.toISOString(), next_send_at: until.toISOString() },
    { type: 'snoozed', detail: `Snoozed until ${until.toISOString()}.`, actor },
  );
}

/**
 * "Send now": the next ask goes immediately — unless the recipient is in quiet hours,
 * in which case it is queued for the end of them (the result says when).
 */
export async function sendNow(deps: EngineDeps, orgId: string, id: string, actor: string) {
  const r = await getRequest(deps, orgId, id);
  if (!r || !(LIVE as string[]).includes(r.status)) throw new RequestError('That request is already closed or does not exist.', 409);
  const ctx = await loadPolicyContext(deps.db, orgId);
  const live: RequestRow = { ...r, status: r.status === 'snoozed' ? 'open' : r.status, snoozed_until: null, next_send_at: deps.now().toISOString() };
  if (r.status === 'snoozed') {
    await deps.db.schema('core').from('requests').update({ status: 'open', snoozed_until: null }).eq('id', id).eq('org_id', orgId);
  }
  return dispatchOne(deps, live, ctx, { actor });
}

export { cadenceOf, SYSTEM_ACTOR };
