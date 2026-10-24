/**
 * The dispatcher: `dispatchDueRequests(deps, orgId)` sends what is due for one tenant.
 *
 * Per live request, in this order (FPB §4):
 *   1. resolver   the need is already met → fulfilled, owner told, nothing sent
 *   2. exhausted  max sends reached / cadence over → expired, owner told
 *   3. quiet      inside the recipient's quiet hours → moved to the window's end
 *   4. channels   email (claim → Resend → sent | failed→retry | not configured→skipped),
 *                 in_app (member recipients), sms/push (adapter: "not configured")
 *   5. advance    to the first cadence slot after now (no catch-up bursts)
 *   6. escalate   after N unanswered asks → one notification to the escalation member
 *                 (else the owner, else tenant admins)
 *
 * IDEMPOTENT: a send is claimed per (request, step, channel) before the provider is
 * called (events.ts), and the row update is optimistic on (sends_count, cadence_slot),
 * so a rerun or a parallel tick never double-sends.
 *
 * TENANCY: runs on the service role (like the event drains) — EVERY query below pins
 * org_id; there is no cross-tenant read or write.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRequestEmail } from '@/lib/notify/request-email';
import { loadBrand } from '@/lib/branding/resolve';
import { emailBrandOf } from '@/lib/branding/email';
import type { Channels } from '@/lib/notify/channels';
import { createNotification, notifyMembers, tenantAdminMemberships } from '@/lib/notify/in-app';
import { afterSend, anchorBase, deferForQuietHours, inQuietHours, quietHoursOf, resolveTimeZone, shouldEscalate, slotTime } from './cadence';
import { claimSend, markSent, recordEvent, recordOnce, releaseClaim } from './events';
import { loadPolicyContext, type PolicyContext } from './policy';
import { DEFAULT_RESOLVERS, type Resolution, type ResolverRegistry } from './resolvers';
import { mintRequestToken } from './tokens';
import { KIND_LABEL, LIVE_STATUSES, SYSTEM_ACTOR, type Cadence, type Channel, type FulfilledVia, type RequestRow } from './types';

const LIVE: string[] = [...LIVE_STATUSES];

const MIN = 60_000;
const RETRY_AFTER_FAILURE_MIN = 15;
const GRACE_AFTER_LAST_MIN = 7 * 1440;

export interface EngineDeps {
  /** Service-role client. Every query the engine runs pins org_id. */
  db: SupabaseClient;
  channels: Channels;
  now: () => Date;
  /** Absolute origin for links in emails ("https://app.example.com"). */
  appUrl: string;
  resolvers?: ResolverRegistry;
  signal?: AbortSignal;
}

export type DispatchOutcome = 'fulfilled' | 'expired' | 'deferred' | 'sent' | 'failed' | 'undeliverable' | 'not_due' | 'raced';

export interface DispatchSummary {
  examined: number;
  sent: number;
  fulfilled: number;
  expired: number;
  deferred: number;
  escalated: number;
  failed: number;
  undeliverable: number;
  errors: string[];
}

export function cadenceOf(r: RequestRow): Cadence {
  return {
    anchor: r.cadence_anchor,
    offsetsMinutes: r.cadence_offsets_minutes?.length ? r.cadence_offsets_minutes : [0],
    repeatEveryMinutes: r.repeat_every_minutes,
    maxSends: r.max_sends,
  };
}

export function timezoneOf(r: RequestRow, ctx: PolicyContext | null): string {
  return resolveTimeZone(r.recipient_timezone, ctx?.org.timezone ?? null);
}

/** The display / email sender name: the asking client, else the tenant. */
async function senderName(db: SupabaseClient, r: RequestRow, cache: Map<string, string>): Promise<string> {
  const key = r.location_id ?? `org:${r.org_id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let name: string | null = null;
  if (r.location_id) {
    const { data } = await db.schema('core').from('locations').select('name').eq('id', r.location_id).eq('org_id', r.org_id).maybeSingle();
    name = (data as { name?: string } | null)?.name ?? null;
  }
  if (!name) {
    const { data } = await db.schema('core').from('organizations').select('name').eq('id', r.org_id).maybeSingle();
    name = (data as { name?: string } | null)?.name ?? null;
  }
  const out = name ?? 'Your accounting team';
  cache.set(key, out);
  return out;
}

async function isSuppressed(db: SupabaseClient, orgId: string, channel: 'email' | 'sms', address: string): Promise<boolean> {
  const { data } = await db
    .schema('core')
    .from('request_suppressions')
    .select('id')
    .eq('org_id', orgId)
    .eq('channel', channel)
    .eq('address', address.toLowerCase())
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** Who hears about this request internally: owner, else tenant admins. */
async function ownerTargets(db: SupabaseClient, r: RequestRow): Promise<string[]> {
  if (r.owner_membership_id) return [r.owner_membership_id];
  return tenantAdminMemberships(db, r.org_id);
}

async function updateRequest(
  db: SupabaseClient,
  r: RequestRow,
  patch: Record<string, unknown>,
  now: Date,
  guard: { optimistic?: boolean } = {},
): Promise<boolean> {
  let q = db
    .schema('core')
    .from('requests')
    .update({ ...patch, updated_at: now.toISOString() })
    .eq('id', r.id)
    .eq('org_id', r.org_id)
    .in('status', LIVE);
  if (guard.optimistic) q = q.eq('sends_count', r.sends_count).eq('cadence_slot', r.cadence_slot);
  const { data, error } = await q.select('id');
  if (error) throw new Error(`Could not update the request: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function revokeTokens(db: SupabaseClient, r: RequestRow, now: Date): Promise<void> {
  await db
    .schema('core')
    .from('request_tokens')
    .update({ revoked_at: now.toISOString() })
    .eq('org_id', r.org_id)
    .eq('request_id', r.id)
    .is('revoked_at', null);
}

export async function closeAsFulfilled(deps: EngineDeps, r: RequestRow, res: { via: FulfilledVia; note: string }, actor: string): Promise<boolean> {
  const now = deps.now();
  const ok = await updateRequest(deps.db, r, {
    status: 'fulfilled',
    fulfilled_at: now.toISOString(),
    fulfilled_by: actor,
    fulfilled_via: res.via,
    fulfilled_note: res.note,
    next_send_at: null,
    snoozed_until: null,
  }, now);
  if (!ok) return false;
  await revokeTokens(deps.db, r, now);
  await recordEvent(deps.db, r, { event_type: 'fulfilled', detail: res.note, actor, meta: { via: res.via } }, now);
  if (actor === SYSTEM_ACTOR) {
    await notifyMembers(deps.db, await ownerTargets(deps.db, r), {
      orgId: r.org_id,
      locationId: r.location_id,
      kind: 'request.fulfilled',
      severity: 'info',
      title: `${r.recipient_name ?? 'The recipient'} answered: ${r.title}`.slice(0, 200),
      body: res.note,
      deepLink: `/requests?id=${r.id}`,
      requestId: r.id,
      dedupeKey: `fulfilled:${r.id}`,
    });
  }
  return true;
}

async function expire(deps: EngineDeps, r: RequestRow): Promise<boolean> {
  const now = deps.now();
  const ok = await updateRequest(deps.db, r, { status: 'expired', next_send_at: null }, now);
  if (!ok) return false;
  await revokeTokens(deps.db, r, now);
  await recordEvent(deps.db, r, { event_type: 'expired', detail: `No answer after ${r.sends_count} ask${r.sends_count === 1 ? '' : 's'}.`, actor: SYSTEM_ACTOR }, now);
  await notifyMembers(deps.db, await ownerTargets(deps.db, r), {
    orgId: r.org_id,
    locationId: r.location_id,
    kind: 'request.expired',
    severity: 'attention',
    title: `No answer: ${r.title}`.slice(0, 200),
    body: `${r.recipient_name ?? r.recipient_email ?? 'The recipient'} was asked ${r.sends_count} time${r.sends_count === 1 ? '' : 's'}. The chase has stopped; follow up by hand or send a new request.`,
    deepLink: `/requests?id=${r.id}`,
    requestId: r.id,
    dedupeKey: `expired:${r.id}`,
  });
  return true;
}

async function escalate(deps: EngineDeps, r: RequestRow, sendsCount: number): Promise<boolean> {
  const now = deps.now();
  const { data, error } = await deps.db
    .schema('core')
    .from('requests')
    .update({ escalated_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', r.id)
    .eq('org_id', r.org_id)
    .is('escalated_at', null)
    .select('id');
  if (error || !Array.isArray(data) || data.length === 0) return false;
  const targets = r.escalate_to_membership_id ? [r.escalate_to_membership_id] : await ownerTargets(deps.db, r);
  await recordEvent(deps.db, r, { event_type: 'escalated', step: sendsCount, detail: `Escalated after ${sendsCount} unanswered ask${sendsCount === 1 ? '' : 's'}.`, actor: SYSTEM_ACTOR, meta: { to: targets } }, now);
  await notifyMembers(deps.db, targets, {
    orgId: r.org_id,
    locationId: r.location_id,
    kind: 'request.escalated',
    severity: 'attention',
    title: `${r.recipient_name ?? r.recipient_email ?? 'Someone'} hasn't answered: ${r.title}`.slice(0, 200),
    body: `Asked ${sendsCount} times. ${KIND_LABEL[r.kind]} · first asked ${r.created_at.slice(0, 10)}.`,
    deepLink: `/requests?id=${r.id}`,
    requestId: r.id,
    dedupeKey: `escalated:${r.id}`,
  });
  return true;
}

interface ChannelResult {
  channel: Channel;
  result: 'sent' | 'failed' | 'skipped' | 'n/a';
  reason?: string;
}

/**
 * Work ONE request that is due now. Callers: the cycle below, and "Send now".
 * `resolution` lets the cycle pass a batch-resolver answer it already has.
 */
export async function dispatchOne(
  deps: EngineDeps,
  r: RequestRow,
  ctx: PolicyContext | null,
  opts: { resolution?: Resolution; actor?: string; senderCache?: Map<string, string> } = {},
): Promise<{ outcome: DispatchOutcome; escalated: boolean; channels: ChannelResult[]; nextSendAt: string | null }> {
  const db = deps.db;
  const now = deps.now();
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const none = { escalated: false, channels: [] as ChannelResult[], nextSendAt: r.next_send_at };

  if (!(LIVE_STATUSES as readonly string[]).includes(r.status)) return { outcome: 'not_due', ...none };
  if (r.status === 'snoozed' && r.snoozed_until && new Date(r.snoozed_until).getTime() > now.getTime()) return { outcome: 'not_due', ...none };

  // 1. resolver
  let resolution = opts.resolution;
  if (!resolution) {
    const resolver = (deps.resolvers ?? DEFAULT_RESOLVERS)[r.kind];
    if (resolver) resolution = (await resolver(db, r.org_id, [r], now)).get(r.id);
  }
  if (resolution?.satisfied) {
    const ok = await closeAsFulfilled(deps, r, { via: resolution.via, note: resolution.note }, SYSTEM_ACTOR);
    return { outcome: ok ? 'fulfilled' : 'raced', ...none, nextSendAt: null };
  }

  // 2. exhausted
  const cadence = cadenceOf(r);
  const tz = timezoneOf(r, ctx);
  const base = anchorBase(r.cadence_anchor, new Date(r.created_at), r.due_date, tz);
  const slotExists = slotTime(cadence, base, r.cadence_slot) !== null;
  const undeliverable = Number((r.meta as { undeliverable_count?: unknown })?.undeliverable_count ?? 0) || 0;
  if (r.sends_count >= r.max_sends || undeliverable >= r.max_sends || (!slotExists && r.sends_count > 0)) {
    const ok = await expire(deps, r);
    return { outcome: ok ? 'expired' : 'raced', ...none, nextSendAt: null };
  }

  // 3. quiet hours
  const quiet = quietHoursOf(r.quiet_start, r.quiet_end);
  const step = r.sends_count + 1;
  if (inQuietHours(now, quiet, tz)) {
    const at = deferForQuietHours(now, quiet, tz);
    await updateRequest(db, r, { next_send_at: at.toISOString(), status: r.status === 'snoozed' ? 'open' : r.status }, now);
    await recordOnce(db, r, `defer:${r.id}:${step}:${at.toISOString().slice(0, 13)}`, { event_type: 'deferred', step, detail: `Quiet hours (${quiet?.start}–${quiet?.end} ${tz}); will send ${at.toISOString()}.`, actor }, now);
    return { outcome: 'deferred', ...none, nextSendAt: at.toISOString() };
  }

  // 4. channels
  const results: ChannelResult[] = [];
  const skip = async (channel: Channel, reason: string) => {
    results.push({ channel, result: 'skipped', reason });
    await recordOnce(db, r, `skip:${r.id}:${r.cadence_slot}:${channel}`, { event_type: 'skipped', step, channel, delivery_status: 'skipped', detail: reason, actor }, now);
  };

  for (const channel of r.channels) {
    if (deps.signal?.aborted) break;
    if (channel === 'in_app') {
      if (!r.recipient_membership_id) {
        results.push({ channel, result: 'n/a' });
        continue;
      }
      const claim = await claimSend(db, r, step, 'in_app', now, actor);
      if (!claim) {
        results.push({ channel, result: 'sent', reason: 'already sent' });
        continue;
      }
      const made = await createNotification(db, {
        orgId: r.org_id,
        membershipId: r.recipient_membership_id,
        locationId: r.location_id,
        kind: `request.${r.kind}`,
        severity: step > 1 ? 'attention' : 'info',
        title: `${step > 1 ? 'Reminder: ' : ''}${r.title}`.slice(0, 200),
        body: r.message,
        deepLink: r.deep_link ?? `/requests?id=${r.id}`,
        requestId: r.id,
        dedupeKey: `req:${r.id}:${step}`,
      });
      if (made === 'failed') {
        await releaseClaim(db, r.org_id, claim, 'failed', 'In-app notification could not be written.', 'in_app');
        results.push({ channel, result: 'failed', reason: 'in-app write failed' });
      } else {
        await markSent(db, r.org_id, claim, 'in_app', null);
        results.push({ channel, result: 'sent' });
      }
      continue;
    }
    if (channel === 'email') {
      const addr = r.recipient_email?.trim().toLowerCase() ?? '';
      if (!addr) {
        await skip('email', 'No email address for the recipient.');
        continue;
      }
      if (r.bounced_at) {
        await skip('email', 'The email address bounced; fix it to resume.');
        continue;
      }
      if (r.unsubscribed_at || (await isSuppressed(db, r.org_id, 'email', addr))) {
        await skip('email', 'The recipient unsubscribed from these emails.');
        continue;
      }
      const claim = await claimSend(db, r, step, 'email', now, actor);
      if (!claim) {
        results.push({ channel, result: 'sent', reason: 'already sent' });
        continue;
      }
      try {
        const token = await mintRequestToken(db, r, now);
        const base = deps.appUrl.replace(/\/$/, '');
        const mail = buildRequestEmail({
          senderName: await senderName(db, r, opts.senderCache ?? new Map()),
          recipientName: r.recipient_name,
          kind: r.kind,
          title: r.title,
          message: r.message,
          step,
          dueDate: r.due_date,
          ctaUrl: `${base}/r/${token}`,
          unsubscribeUrl: `${base}/r/${token}/unsubscribe`,
          // The asking company's brand (FPB-branding); Merit look when it has none.
          brand: emailBrandOf(await loadBrand(db, r.org_id, r.location_id ?? null)),
        });
        const out = await deps.channels.email.send({ to: addr, subject: mail.subject, html: mail.html, text: mail.text });
        if (out.status === 'sent') {
          await markSent(db, r.org_id, claim, out.provider, out.providerMessageId, `To ${addr}`);
          results.push({ channel, result: 'sent' });
        } else if (out.status === 'not_configured') {
          await releaseClaim(db, r.org_id, claim, 'skipped', out.reason, null);
          results.push({ channel, result: 'skipped', reason: out.reason });
        } else {
          await releaseClaim(db, r.org_id, claim, 'failed', out.reason, out.provider ?? null);
          results.push({ channel, result: 'failed', reason: out.reason });
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await releaseClaim(db, r.org_id, claim, 'failed', reason, null).catch(() => undefined);
        results.push({ channel, result: 'failed', reason });
      }
      continue;
    }
    if (channel === 'sms') {
      if (!r.recipient_phone) {
        await skip('sms', 'No mobile number for the recipient.');
        continue;
      }
      const out = await deps.channels.sms.send({ to: r.recipient_phone, body: `${r.title} — reply STOP to opt out.` });
      if (out.status === 'sent') {
        await recordEvent(db, r, { event_type: 'sent', step, channel: 'sms', delivery_status: 'sent', provider: out.provider, provider_message_id: out.providerMessageId, actor }, now);
        results.push({ channel, result: 'sent' });
      } else {
        await skip('sms', out.reason);
      }
      continue;
    }
    if (channel === 'push') {
      if (!r.recipient_membership_id) {
        results.push({ channel, result: 'n/a' });
        continue;
      }
      const out = await deps.channels.push.send({ membershipId: r.recipient_membership_id, title: r.title, body: r.message ?? '', deepLink: r.deep_link });
      if (out.status === 'sent') {
        await recordEvent(db, r, { event_type: 'sent', step, channel: 'push', delivery_status: 'sent', provider: out.provider, provider_message_id: out.providerMessageId, actor }, now);
        results.push({ channel, result: 'sent' });
      } else {
        await skip('push', out.reason);
      }
    }
  }

  const delivered = results.some((c) => c.result === 'sent');
  const failed = results.some((c) => c.result === 'failed');

  // 5. advance
  if (delivered) {
    const next = afterSend(cadence, base, now, r.cadence_slot);
    const lastAsk = step >= r.max_sends;
    const nextAt = !next || lastAsk ? new Date(now.getTime() + (r.repeat_every_minutes ?? GRACE_AFTER_LAST_MIN) * MIN) : deferForQuietHours(next.at, quiet, tz);
    const moved = await updateRequest(
      db,
      r,
      {
        status: 'sent',
        sends_count: step,
        last_sent_at: now.toISOString(),
        cadence_slot: next ? next.slot : r.cadence_slot + 1,
        next_send_at: nextAt.toISOString(),
        snoozed_until: null,
      },
      now,
      { optimistic: true },
    );
    if (!moved) return { outcome: 'raced', escalated: false, channels: results, nextSendAt: null };
    // 6. escalate
    const esc = shouldEscalate(step, r.escalate_after, r.escalated_at) ? await escalate(deps, r, step) : false;
    return { outcome: 'sent', escalated: esc, channels: results, nextSendAt: nextAt.toISOString() };
  }

  if (failed) {
    const retry = new Date(now.getTime() + RETRY_AFTER_FAILURE_MIN * MIN);
    await updateRequest(db, r, { next_send_at: retry.toISOString() }, now);
    return { outcome: 'failed', escalated: false, channels: results, nextSendAt: retry.toISOString() };
  }

  // Nothing could be delivered (no address / unsubscribed / channel not set up): keep the
  // cadence moving (so it eventually expires) and tell the owner ONCE.
  const next = afterSend(cadence, base, now, r.cadence_slot);
  const nextAt = next ? deferForQuietHours(next.at, quiet, tz) : new Date(now.getTime() + GRACE_AFTER_LAST_MIN * MIN);
  await updateRequest(
    db,
    r,
    {
      cadence_slot: next ? next.slot : r.cadence_slot + 1,
      next_send_at: nextAt.toISOString(),
      status: r.status === 'snoozed' ? 'open' : r.status,
      meta: { ...(r.meta ?? {}), undeliverable_count: undeliverable + 1 },
    },
    now,
    { optimistic: true },
  );
  const why = results.filter((c) => c.result === 'skipped').map((c) => c.reason).filter(Boolean).join(' ');
  await notifyMembers(db, await ownerTargets(db, r), {
    orgId: r.org_id,
    locationId: r.location_id,
    kind: 'request.undeliverable',
    severity: 'attention',
    title: `Couldn't send: ${r.title}`.slice(0, 200),
    body: why || 'No channel could reach the recipient.',
    deepLink: `/requests?id=${r.id}`,
    requestId: r.id,
    dedupeKey: `undeliverable:${r.id}`,
  });
  return { outcome: 'undeliverable', escalated: false, channels: results, nextSendAt: nextAt.toISOString() };
}

const SELECT_LIVE = '*';

/** Every resolver-backed live request for the tenant, swept in batch (not only the due ones). */
async function sweepResolvers(deps: EngineDeps, orgId: string, summary: DispatchSummary): Promise<Set<string>> {
  const closed = new Set<string>();
  const registry = deps.resolvers ?? DEFAULT_RESOLVERS;
  const kinds = Object.keys(registry) as Array<keyof ResolverRegistry>;
  if (kinds.length === 0) return closed;
  const { data, error } = await deps.db
    .schema('core')
    .from('requests')
    .select(SELECT_LIVE)
    .eq('org_id', orgId)
    .in('status', LIVE)
    .in('kind', kinds as string[])
    .limit(1000);
  if (error) throw new Error(`Could not read live requests: ${error.message}`);
  const rows = (data ?? []) as RequestRow[];
  for (const kind of kinds) {
    const mine = rows.filter((r) => r.kind === kind);
    const resolver = registry[kind];
    if (!resolver || mine.length === 0) continue;
    const answers = await resolver(deps.db, orgId, mine, deps.now());
    for (const r of mine) {
      const a = answers.get(r.id);
      if (a?.satisfied && (await closeAsFulfilled(deps, r, { via: a.via, note: a.note }, SYSTEM_ACTOR))) {
        closed.add(r.id);
        summary.fulfilled++;
      }
    }
  }
  return closed;
}

/** One tenant's dispatch cycle. */
export async function dispatchDueRequests(deps: EngineDeps, orgId: string, opts: { limit?: number } = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { examined: 0, sent: 0, fulfilled: 0, expired: 0, deferred: 0, escalated: 0, failed: 0, undeliverable: 0, errors: [] };
  const ctx = await loadPolicyContext(deps.db, orgId);
  const closed = await sweepResolvers(deps, orgId, summary);
  const now = deps.now();
  const { data, error } = await deps.db
    .schema('core')
    .from('requests')
    .select(SELECT_LIVE)
    .eq('org_id', orgId)
    .in('status', LIVE)
    .lte('next_send_at', now.toISOString())
    .order('next_send_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (error) throw new Error(`Could not read due requests: ${error.message}`);
  const senderCache = new Map<string, string>();
  for (const r of (data ?? []) as RequestRow[]) {
    if (deps.signal?.aborted) break;
    if (closed.has(r.id)) continue;
    summary.examined++;
    try {
      // The sweep already answered every resolver-backed kind: pass "not satisfied" through.
      const res = await dispatchOne(deps, r, ctx, { resolution: { satisfied: false }, senderCache });
      if (res.outcome === 'sent') summary.sent++;
      else if (res.outcome === 'fulfilled') summary.fulfilled++;
      else if (res.outcome === 'expired') summary.expired++;
      else if (res.outcome === 'deferred') summary.deferred++;
      else if (res.outcome === 'failed') summary.failed++;
      else if (res.outcome === 'undeliverable') summary.undeliverable++;
      if (res.escalated) summary.escalated++;
    } catch (e) {
      summary.errors.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}
