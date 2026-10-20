/**
 * Fiscal period lifecycle (Session 18+).
 *
 * GL posting requires an OPEN/SOFT_CLOSE period covering the entry date for the
 * location. Periods were previously only created at company setup, so any new
 * year, newly-added company, or back/forward-dated entry could hit
 * "No fiscal period found". This service generates periods for a year
 * (idempotent), ensures a single covering period exists on demand, and applies
 * status transitions.
 *
 * Status semantics (period_status_enum): OPEN | SOFT_CLOSE | HARD_CLOSE.
 *   - OPEN        — fully postable
 *   - SOFT_CLOSE  — postable (gl-posting allows it); used to signal "review done"
 *   - HARD_CLOSE  — locked; gl-posting rejects it. Reopen requires a reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopedWriter } from '@/lib/db/scoped-writer';

type DB = SupabaseClient;

// public.fiscal_periods is SELECT-only for members (migration 171) — a member could
// otherwise reopen a hard-closed period over PostgREST. Reads go through the caller's
// client `db`; a member caller's writes go through the service role (scopedWriter),
// pinned to the org, after the company is checked against the caller's org + client
// scope. Callers authorize first.
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

/** First/last calendar day of a month as YYYY-MM-DD (UTC-safe, no TZ drift). */
export function monthBounds(year: number, month: number): { start_date: string; end_date: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start_date: `${year}-${pad(month)}-01`,
    end_date: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

/** Default status for a generated month relative to "now": prior years hard-closed,
 *  months before the current month soft-closed, current + future open. */
export function defaultStatus(year: number, month: number, now: Date = new Date()): PeriodStatus {
  if (year < now.getUTCFullYear()) return 'HARD_CLOSE';
  if (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) return 'SOFT_CLOSE';
  return 'OPEN';
}

/**
 * Status for a month generated for a company that is being CONVERTED onto MeritBooks
 * (a pre-go-live year). Months before the current month are SOFT_CLOSE (postable —
 * opening balances and catch-up entries must be able to land there); the current
 * month and later are OPEN. NEVER HARD_CLOSE: a brand-new book has nothing to lock
 * yet, and a hard-closed cutover month would block the opening entry (FPB B1).
 */
export function preGoLiveStatus(year: number, month: number, now: Date = new Date()): PeriodStatus {
  if (year < now.getUTCFullYear()) return 'SOFT_CLOSE';
  if (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) return 'SOFT_CLOSE';
  return 'OPEN';
}

export interface GenerateResult { locationId: string; created: number; skipped: number }

export interface GenerateYearOptions {
  /**
   * Optional per-month status override. Defaults to `defaultStatus` (prior years
   * HARD_CLOSE) so existing callers are unchanged; onboarding passes
   * `preGoLiveStatus` so a conversion year is never hard-closed.
   */
  statusFor?: (year: number, month: number, now: Date) => PeriodStatus;
  /** Writer override (tests). Default: the service role for a member caller, else `db`. */
  writer?: DB;
}

/**
 * Generate the 12 monthly periods for a location + year. Idempotent: existing
 * months are left untouched; only missing ones are inserted.
 */
export async function generateYear(
  db: DB,
  orgId: string,
  locationId: string,
  year: number,
  opts: GenerateYearOptions = {},
): Promise<GenerateResult> {
  const statusFor = opts.statusFor ?? defaultStatus;
  const { data: existing } = await db
    .from('fiscal_periods')
    .select('period_month')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('period_year', year);

  const have = new Set((existing ?? []).map((p) => (p as { period_month: number }).period_month));
  const now = new Date();
  const rows = [] as Array<Record<string, unknown>>;

  for (let month = 1; month <= 12; month++) {
    if (have.has(month)) continue;
    const { start_date, end_date } = monthBounds(year, month);
    rows.push({
      org_id: orgId,
      location_id: locationId,
      period_year: year,
      period_month: month,
      start_date,
      end_date,
      status: statusFor(year, month, now),
    });
  }

  if (rows.length > 0) {
    const writer = await scopedWriter(db, orgId, [locationId], { writer: opts.writer });
    const { error } = await writer.from('fiscal_periods').insert(rows);
    if (error) throw new Error(`generateYear: ${error.message}`);
  }
  return { locationId, created: rows.length, skipped: have.size };
}

/** Transition a period's status. Reopening a HARD_CLOSE requires a reason. */
export async function setPeriodStatus(
  db: DB,
  orgId: string,
  periodId: string,
  status: PeriodStatus,
  actor: string,
  reason: string | null,
  opts: { writer?: DB } = {},
): Promise<void> {
  const { data: current } = await db
    .from('fiscal_periods')
    .select('status, close_started_at, location_id')
    .eq('org_id', orgId)
    .eq('id', periodId)
    .single();
  if (!current) throw new Error('Period not found');

  const cur = current as { status: PeriodStatus; close_started_at: string | null; location_id: string | null };
  const writer = await scopedWriter(db, orgId, [cur.location_id], { writer: opts.writer });
  const wasHardClosed = cur.status === 'HARD_CLOSE';
  if (wasHardClosed && status !== 'HARD_CLOSE' && !reason) {
    throw new Error('Reopening a hard-closed period requires a reason');
  }

  const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === 'HARD_CLOSE') {
    update.closed_at = new Date().toISOString();
    update.closed_by = actor;
  } else {
    update.closed_at = null;
    update.closed_by = null;
  }
  // Team Performance (FPB C4 days-to-close): stamp when the close process begins.
  // Set once on the first SOFT_CLOSE and never overwrite (preserve the true start).
  if (status === 'SOFT_CLOSE' && !cur.close_started_at) {
    update.close_started_at = new Date().toISOString();
  }
  if (reason) update.close_override_reason = reason;

  const { error } = await writer.from('fiscal_periods').update(update).eq('org_id', orgId).eq('id', periodId);
  if (error) throw new Error(`setPeriodStatus: ${error.message}`);
}
