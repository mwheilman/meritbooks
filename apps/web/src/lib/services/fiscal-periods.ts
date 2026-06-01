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

type DB = SupabaseClient;
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

export interface GenerateResult { locationId: string; created: number; skipped: number }

/**
 * Generate the 12 monthly periods for a location + year. Idempotent: existing
 * months are left untouched; only missing ones are inserted.
 */
export async function generateYear(db: DB, orgId: string, locationId: string, year: number): Promise<GenerateResult> {
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
      status: defaultStatus(year, month, now),
    });
  }

  if (rows.length > 0) {
    const { error } = await db.from('fiscal_periods').insert(rows);
    if (error) throw new Error(`generateYear: ${error.message}`);
  }
  return { locationId, created: rows.length, skipped: have.size };
}

/** Transition a period's status. Reopening a HARD_CLOSE requires a reason. */
export async function setPeriodStatus(db: DB, orgId: string, periodId: string, status: PeriodStatus, actor: string, reason: string | null): Promise<void> {
  const { data: current } = await db
    .from('fiscal_periods')
    .select('status')
    .eq('org_id', orgId)
    .eq('id', periodId)
    .single();
  if (!current) throw new Error('Period not found');

  const wasHardClosed = (current as { status: PeriodStatus }).status === 'HARD_CLOSE';
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
  if (reason) update.close_override_reason = reason;

  const { error } = await db.from('fiscal_periods').update(update).eq('org_id', orgId).eq('id', periodId);
  if (error) throw new Error(`setPeriodStatus: ${error.message}`);
}
