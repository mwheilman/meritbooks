/**
 * Atomic claim for the core.events drains (security finding M5, migration 167).
 *
 * THE RACE. Every drain (JOB_BILLING, DEPT_INVOICE_ISSUE, JOB_PROGRESS) used to SELECT
 * the "pending" rows and then process them one by one. Two concurrent drains — the
 * hourly scheduler run and a person pressing "Process" (or two cron ticks) — both saw
 * the same pending row and both processed it: two invoices, two GL posts. And the
 * scheduled drain gated the autonomy cap on the pending total it read FIRST, then
 * re-read the queue to process it, so anything that arrived in between was posted
 * above the cap.
 *
 * THE FIX. `core.claim_pending_events` (service_role only) claims a batch in ONE
 * statement — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` with a lease —
 * so a row is handed to exactly one claimer. Drains process ONLY the rows they
 * claimed; the scheduled drain gates on the claimed set's total and releases the
 * claim when the gate says no. A crashed drain's claim expires after the lease and
 * the rows become claimable again.
 *
 * Callers must pass the SERVICE-ROLE client (every drain already does).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One claimed core.events row (the columns the consumers read). */
export interface ClaimedEvent<P = unknown> {
  id: string;
  event_id: string;
  org_id: string;
  event_type: string;
  source_module: string;
  payload: P;
  occurred_on: string;
  created_at: string;
  claimed_by: string;
}

export interface ClaimOptions {
  eventType: string;
  /** Restrict to one tenant; null = every tenant (cron caller only). */
  orgId?: string | null;
  sourceModule?: string | null;
  /** Max rows per claim (default 500). */
  limit?: number;
  /** Lease after which an unprocessed claim is reclaimable (default 15 min). */
  leaseSeconds?: number;
  /** Claim token; generated when omitted. */
  token?: string;
}

export interface Claim<P = unknown> {
  token: string;
  rows: ClaimedEvent<P>[];
}

export const DEFAULT_CLAIM_LIMIT = 500;
export const DEFAULT_LEASE_SECONDS = 900;

export function newClaimToken(prefix = 'drain'): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

/** Atomically claim pending events. Rows come back oldest first. */
export async function claimPendingEvents<P = unknown>(db: SupabaseClient, opts: ClaimOptions): Promise<Claim<P>> {
  const token = opts.token ?? newClaimToken();
  const { data, error } = await db.schema('core').rpc('claim_pending_events', {
    p_event_type: opts.eventType,
    p_org: opts.orgId ?? null,
    p_source_module: opts.sourceModule ?? null,
    p_limit: opts.limit ?? DEFAULT_CLAIM_LIMIT,
    p_token: token,
    p_lease_seconds: opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_pending_events: ${error.message}`);
  const rows = ((data ?? []) as ClaimedEvent<P>[]).slice().sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? -1 : 1,
  );
  return { token, rows };
}

/** Give a claim back (unprocessed rows become claimable immediately). */
export async function releaseEventClaims(db: SupabaseClient, token: string, ids?: string[]): Promise<number> {
  const { data, error } = await db.schema('core').rpc('release_event_claims', {
    p_token: token,
    p_ids: ids && ids.length > 0 ? ids : null,
  });
  if (error) throw new Error(`release_event_claims: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Re-assert THIS drain's claim on one event right before working it, and extend its
 * lease (wave 2G). A batch is claimed once; a long batch can outlive the 15-minute
 * lease, after which a second drain may legitimately reclaim the tail. Renewing per
 * event means a drain only ever works an event it still holds — and holds it for a
 * fresh lease while it does. false = the claim was lost (skip the event).
 */
export async function renewEventClaim(db: SupabaseClient, eventRowId: string, token: string): Promise<boolean> {
  const { data, error } = await db
    .schema('core')
    .from('events')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', eventRowId)
    .eq('claimed_by', token)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`renew event claim: ${error.message}`);
  return Array.isArray(data) ? data.length > 0 : !!data;
}

/**
 * Finalize an event (processed / rejected + its write-backs) ONLY while this drain
 * still holds the claim and the event is still pending. Returns false when another
 * drain owns it now (nothing was written) — the caller must not report it processed.
 */
export async function finalizeClaimedEvent(
  db: SupabaseClient,
  eventRowId: string,
  token: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await db
    .schema('core')
    .from('events')
    .update(patch)
    .eq('id', eventRowId)
    .eq('claimed_by', token)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`finalize event: ${error.message}`);
  return Array.isArray(data) ? data.length > 0 : !!data;
}

/** Postgres unique_violation (an index said "this already exists"). */
export function isUniqueViolation(err: { code?: string; message?: string } | null | undefined): boolean {
  return !!err && (err.code === '23505' || /duplicate key value/i.test(err.message ?? ''));
}

/** The GL source_ref a drain stamps on the entry it posts for one event (064 unique index). */
export function eventSourceRef(eventRowId: string): string {
  return `core.events:${eventRowId}`;
}

/**
 * Sum of absolute line amounts across claimed events (the figure the autonomy gate
 * is asked about). Events without lines contribute 0.
 */
export function claimedAmountCents(rows: ReadonlyArray<ClaimedEvent<{ lines?: Array<{ amount_cents?: number | string | null }> } | null>>): number {
  return rows.reduce(
    (sum, r) => sum + (r.payload?.lines ?? []).reduce((s, l) => s + Math.abs(Math.round(Number(l.amount_cents ?? 0))), 0),
    0,
  );
}
