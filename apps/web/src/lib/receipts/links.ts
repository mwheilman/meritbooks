/**
 * Merit Workforce magic links (public.workforce_links, migration 181).
 *
 * A link opens ONE cardholder's receipts (one card assignment) without a login. The
 * clear token exists only in the URL we hand out; the table keeps its sha256. The reminder
 * email's button is the request engine's `/r/<token>` link; for a `receipt` request that
 * page asks `workforcePathFor()` here, which mints (or reuses) a workforce link for the
 * request's cardholder and forwards to `/w/s/<link>`.
 *
 * Scope rule (FPB §15.2): everything a link can see or write is narrowed to its
 * assignment's org + company + card assignment — resolved FROM THE ROW, never from the
 * client.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ASSIGNMENT_COLUMNS } from './chase';
import type { CardAssignmentRow } from './types';

export const WORKFORCE_LINK_TTL_DAYS = 14;

export function hashWorkforceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function looksLikeWorkforceToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(v) && !/^[0-9a-f]{64}$/.test(v);
}

export async function mintWorkforceLink(
  admin: SupabaseClient,
  a: Pick<CardAssignmentRow, 'id' | 'org_id' | 'location_id'>,
  now: Date,
  sourceRequestId: string | null = null,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const { error } = await admin.from('workforce_links').insert({
    org_id: a.org_id,
    location_id: a.location_id,
    card_assignment_id: a.id,
    purpose: 'receipts',
    token_hash: hashWorkforceToken(token),
    source_request_id: sourceRequestId,
    expires_at: new Date(now.getTime() + WORKFORCE_LINK_TTL_DAYS * 86_400_000).toISOString(),
  });
  if (error) throw new Error(`Could not create the Merit Workforce link: ${error.message}`);
  return token;
}

export type WorkforceLinkLookup =
  | { ok: true; linkId: string; assignment: CardAssignmentRow }
  | { ok: false; state: 'not_found' | 'expired' | 'ended' };

/** Resolve a presented link (service role). Ended assignments and expired / revoked links refuse. */
export async function resolveWorkforceLink(admin: SupabaseClient, token: string, now: Date = new Date()): Promise<WorkforceLinkLookup> {
  if (!looksLikeWorkforceToken(token)) return { ok: false, state: 'not_found' };
  const { data } = await admin
    .from('workforce_links')
    .select('id, org_id, card_assignment_id, expires_at, revoked_at')
    .eq('token_hash', hashWorkforceToken(token))
    .maybeSingle();
  const l = data as { id: string; org_id: string; card_assignment_id: string; expires_at: string; revoked_at: string | null } | null;
  if (!l) return { ok: false, state: 'not_found' };
  if (l.revoked_at || new Date(l.expires_at).getTime() <= now.getTime()) return { ok: false, state: 'expired' };
  const { data: a } = await admin.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', l.org_id).eq('id', l.card_assignment_id).maybeSingle();
  const assignment = a as CardAssignmentRow | null;
  if (!assignment) return { ok: false, state: 'not_found' };
  if (!assignment.active) return { ok: false, state: 'ended' };
  await admin.from('workforce_links').update({ last_used_at: now.toISOString() }).eq('id', l.id).eq('org_id', l.org_id);
  return { ok: true, linkId: l.id, assignment };
}

/**
 * The workforce token a request link opens, DERIVED from the presented request token
 * (HMAC keyed by it): re-opening the same email button yields the same link instead of a
 * new row per click. Only someone holding the request token can derive it — the same
 * person the request link already authorizes. Pure.
 */
export function derivedWorkforceToken(requestToken: string, requestId: string): string {
  return createHmac('sha256', requestToken).update(`merit-workforce-link:v1:${requestId}`).digest('base64url');
}

/**
 * For the request engine's `/r/<token>` page: where a receipt request's link should go.
 * With the presented request token, REUSES the unexpired workforce link derived from it
 * (creating it on first open); without one — or once that link expired / was revoked —
 * mints a fresh random link. Always scoped to the request's (active) cardholder.
 */
export async function workforcePathFor(
  admin: SupabaseClient,
  req: { id: string; org_id: string; meta: Record<string, unknown> | null },
  now: Date = new Date(),
  opts: { presentedToken?: string | null } = {},
): Promise<string | null> {
  const aid = typeof req.meta?.card_assignment_id === 'string' ? req.meta.card_assignment_id : null;
  if (!aid) return null;
  const { data } = await admin.from('card_assignments').select('id, org_id, location_id, active').eq('org_id', req.org_id).eq('id', aid).maybeSingle();
  const a = data as { id: string; org_id: string; location_id: string; active: boolean } | null;
  if (!a || !a.active) return null;
  if (opts.presentedToken) {
    const reused = await reuseDerivedLink(admin, a, req.id, opts.presentedToken, now);
    if (reused) return `/w/s/${reused}`;
  }
  const token = await mintWorkforceLink(admin, a, now, req.id);
  return `/w/s/${token}`;
}

type LinkRowLite = { id: string; org_id: string; card_assignment_id: string; expires_at: string; revoked_at: string | null };

async function reuseDerivedLink(
  admin: SupabaseClient,
  a: Pick<CardAssignmentRow, 'id' | 'org_id' | 'location_id'>,
  requestId: string,
  presentedToken: string,
  now: Date,
): Promise<string | null> {
  const token = derivedWorkforceToken(presentedToken, requestId);
  const hash = hashWorkforceToken(token);
  const live = (l: LinkRowLite | null): boolean =>
    Boolean(l && l.org_id === a.org_id && l.card_assignment_id === a.id && !l.revoked_at && new Date(l.expires_at).getTime() > now.getTime());
  const read = async (): Promise<LinkRowLite | null> => {
    const { data } = await admin.from('workforce_links').select('id, org_id, card_assignment_id, expires_at, revoked_at').eq('token_hash', hash).maybeSingle();
    return (data as LinkRowLite | null) ?? null;
  };
  const existing = await read();
  if (existing) return live(existing) ? token : null; // expired / revoked → caller mints a fresh one
  const { error } = await admin.from('workforce_links').insert({
    org_id: a.org_id,
    location_id: a.location_id,
    card_assignment_id: a.id,
    purpose: 'receipts',
    token_hash: hash,
    source_request_id: requestId,
    expires_at: new Date(now.getTime() + WORKFORCE_LINK_TTL_DAYS * 86_400_000).toISOString(),
  });
  if (!error) return token;
  // a concurrent open inserted it first
  return live(await read()) ? token : null;
}
