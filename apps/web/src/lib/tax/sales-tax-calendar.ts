/**
 * Sales/use-tax FILING CALENDAR + LIABILITY-OWED engine.
 *
 * The companion to the return-prep worksheet (`sales-tax-return.ts`, "what do I
 * owe this period, and does it tie to the books?") and the EC-7 economic-nexus
 * tripwire (`lib/controls/sales-tax-nexus.ts`, "where SHOULD I be registered?").
 * THIS answers the two operational questions a filer lives by:
 *
 *   1. WHEN is my next return due, per jurisdiction — and what's overdue?
 *   2. For each jurisdiction+period: how much did I COLLECT, how much have I
 *      REMITTED, and therefore what do I still OWE?
 *
 * Jurisdictions are the states the tenant has a configured RATE for (they collect
 * there) UNION the states they actually collected tax in over the window. Each
 * jurisdiction files at a FREQUENCY (monthly / quarterly / annual): the default is
 * a documented per-state seed, overridden by whatever frequency the tenant last
 * recorded a filing at (so it's tenant-tunable without a config screen). Filing
 * periods and their due dates are computed purely from frequency; "filed / remitted"
 * status comes from a small `public.sales_tax_filings` record (one row per
 * org+jurisdiction+period). The engine DEGRADES SAFE: absent that table the calendar
 * still computes periods, due dates, and net-owed from the accrual — only the
 * filed/remitted overlay goes unavailable.
 *
 * DESIGN INVARIANTS (canon):
 *   • Pure & deterministic: the calendar math (period generation, due-date rules,
 *     status classification, liability roll-up) is I/O-free and unit-testable.
 *   • All money is bigint cents. No floats for money. Dates are 'YYYY-MM-DD' UTC.
 *   • Read-only ledger: this never registers, files, posts, or moves money. Marking
 *     a period "filed" writes a filing RECORD only — it does not post a remittance JE.
 *   • Sale→jurisdiction attribution is IDENTICAL to the return worksheet: both call
 *     `loadReturnInvoices`, so the calendar and the return can never disagree on
 *     where/when a sale landed.
 *
 * ── NEEDS CENTRAL (reference data the schema is missing) ──────────────────────
 *   The per-state DUE-DAY and DEFAULT-FREQUENCY maps below are a documented SEED,
 *   not maintained legal reference data. States vary (filing day, threshold-driven
 *   frequency assignment); the conservative default is the 20th of the month after
 *   period end, quarterly. This belongs in central reference data with an owner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadReturnInvoices, normalizeState } from '@/lib/tax/sales-tax-return';

export type Frequency = 'monthly' | 'quarterly' | 'annual';
export type FilingStatus = 'filed' | 'overdue' | 'due-soon' | 'upcoming';

export const CALENDAR_TUNABLES = {
  /** trailing months of history to surface (default 12). */
  lookbackMonths: 12,
  /** forward months of upcoming filings to surface (default 3). */
  lookaheadMonths: 3,
  /** an unfiled return within this many days of its due date is "due-soon". */
  dueSoonDays: 14,
  /** default day-of-following-month a return is due (most states: the 20th). */
  defaultDueDay: 20,
} as const;

/**
 * SEED per-state default filing frequency. This is a starting point, NOT maintained
 * legal reference data (NEEDS CENTRAL) — real assignment is threshold-driven by the
 * state. Absent an override the safe default is quarterly (a mid-cadence that rarely
 * misses a deadline). A tenant's recorded filing frequency always wins over this.
 */
export const STATE_DEFAULT_FREQUENCY: Record<string, Frequency> = {
  // (intentionally sparse — the documented default below covers every state.)
};

/**
 * SEED per-state override for the due DAY of the month following period end. Default
 * is the 20th (the most-cited cadence). Documented starting point only (NEEDS CENTRAL);
 * a handful of states file on the last day or the 23rd/25th — add them here as the
 * central reference is populated, keeping the conservative 20th as the fallback.
 */
export const STATE_DUE_DAY_OVERRIDES: Record<string, number> = {
  // e.g. ME: 15, but left empty until backed by maintained reference data.
};

export function defaultFrequencyForState(state: string): Frequency {
  return STATE_DEFAULT_FREQUENCY[state] ?? 'quarterly';
}

export function dueDayForState(state: string): number {
  return STATE_DUE_DAY_OVERRIDES[state] ?? CALENDAR_TUNABLES.defaultDueDay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (pure, UTC — no TZ drift, mirrors the existing period math).
// ─────────────────────────────────────────────────────────────────────────────

/** Last calendar day (28..31) of a given 0-indexed month. */
export function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Build a 'YYYY-MM-DD' string from y / 0-indexed month / day. */
export function isoDate(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse a 'YYYY-MM-DD' (or longer ISO) into { year, month0, day }, or null. */
export function parseISODate(dateISO: string): { year: number; month0: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateISO));
  if (!m) return null;
  return { year: Number(m[1]), month0: Number(m[2]) - 1, day: Number(m[3]) };
}

/** Whole days from `fromISO` to `toISO` (positive when `toISO` is later). */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** 'YYYY-MM' month key for a date (or null). */
export function monthKeyOf(dateISO: string | null | undefined): string | null {
  const p = dateISO ? parseISODate(dateISO) : null;
  return p ? `${p.year}-${String(p.month0 + 1).padStart(2, '0')}` : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filing-period generation + due dates (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface FilingPeriod {
  /** stable key: 'YYYY-MM' (monthly) | 'YYYY-Qn' (quarterly) | 'YYYY' (annual). */
  periodKey: string;
  /** human label, e.g. 'Mar 2026', 'Q1 2026', 'FY 2026'. */
  label: string;
  frequency: Frequency;
  periodStart: string; // 'YYYY-MM-DD' inclusive
  periodEnd: string; // 'YYYY-MM-DD' inclusive
  dueDate: string; // 'YYYY-MM-DD'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The due date for a period end: the state's due-day of the FOLLOWING month. Pure. */
export function dueDateForPeriodEnd(periodEndISO: string, dueDay: number): string {
  const p = parseISODate(periodEndISO);
  if (!p) return periodEndISO;
  let ny = p.year;
  let nm = p.month0 + 1;
  if (nm > 11) {
    nm = 0;
    ny += 1;
  }
  const day = Math.min(Math.max(1, dueDay), lastDayOfMonth(ny, nm));
  return isoDate(ny, nm, day);
}

/** One filing period covering month0 for the given frequency. Pure. */
function periodForMonth(year: number, month0: number, frequency: Frequency, dueDay: number): FilingPeriod {
  if (frequency === 'monthly') {
    const start = isoDate(year, month0, 1);
    const end = isoDate(year, month0, lastDayOfMonth(year, month0));
    return {
      periodKey: `${year}-${String(month0 + 1).padStart(2, '0')}`,
      label: `${MONTHS[month0]} ${year}`,
      frequency,
      periodStart: start,
      periodEnd: end,
      dueDate: dueDateForPeriodEnd(end, dueDay),
    };
  }
  if (frequency === 'quarterly') {
    const q = Math.floor(month0 / 3); // 0..3
    const startMonth = q * 3;
    const endMonth = startMonth + 2;
    const start = isoDate(year, startMonth, 1);
    const end = isoDate(year, endMonth, lastDayOfMonth(year, endMonth));
    return {
      periodKey: `${year}-Q${q + 1}`,
      label: `Q${q + 1} ${year}`,
      frequency,
      periodStart: start,
      periodEnd: end,
      dueDate: dueDateForPeriodEnd(end, dueDay),
    };
  }
  // annual
  const start = isoDate(year, 0, 1);
  const end = isoDate(year, 11, 31);
  return {
    periodKey: `${year}`,
    label: `FY ${year}`,
    frequency,
    periodStart: start,
    periodEnd: end,
    dueDate: dueDateForPeriodEnd(end, dueDay),
  };
}

/**
 * Generate the distinct filing periods (by frequency) that OVERLAP [fromISO, toISO],
 * sorted by period end ascending. Pure — dedupes so a quarter/year is emitted once.
 */
export function generateFilingPeriods(
  frequency: Frequency,
  fromISO: string,
  toISO: string,
  dueDay: number = CALENDAR_TUNABLES.defaultDueDay,
): FilingPeriod[] {
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if (!from || !to) return [];
  const seen = new Map<string, FilingPeriod>();
  let y = from.year;
  let m = from.month0;
  // Walk month-by-month across the window; each month maps to its enclosing period.
  while (y < to.year || (y === to.year && m <= to.month0)) {
    const period = periodForMonth(y, m, frequency, dueDay);
    if (!seen.has(period.periodKey)) seen.set(period.periodKey, period);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/**
 * Classify a filing's status against "today". A recorded filing is `filed`; otherwise
 * an already-past due date is `overdue`, within `dueSoonDays` is `due-soon`, else
 * `upcoming`. Pure.
 */
export function classifyFilingStatus(
  dueDateISO: string,
  filed: boolean,
  todayISO: string,
  dueSoonDays: number = CALENDAR_TUNABLES.dueSoonDays,
): FilingStatus {
  if (filed) return 'filed';
  const days = daysBetween(todayISO, dueDateISO);
  if (days < 0) return 'overdue';
  if (days <= dueSoonDays) return 'due-soon';
  return 'upcoming';
}

/** Sum collected cents for the months a filing period spans. Pure. */
export function collectedForPeriod(
  collectedByMonth: Map<string, number>,
  period: FilingPeriod,
): number {
  let total = 0;
  const startKey = period.periodStart.slice(0, 7);
  const endKey = period.periodEnd.slice(0, 7);
  for (const [monthKey, cents] of collectedByMonth) {
    if (monthKey >= startKey && monthKey <= endKey) total += cents;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembler (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

/** A persisted filing record (public.sales_tax_filings), keyed by jurisdiction+period. */
export interface FilingRecord {
  id: string;
  jurisdiction: string;
  periodKey: string;
  frequency: Frequency;
  status: 'FILED' | 'REMITTED';
  filedAt: string | null;
  remittedCents: number;
  confirmationNumber: string | null;
}

/** One period row for a jurisdiction: computed liability + filing overlay. */
export interface CalendarFilingRow {
  periodKey: string;
  label: string;
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: FilingStatus;
  collectedCents: number;
  remittedCents: number;
  netOwedCents: number;
  filedAt: string | null;
  confirmationNumber: string | null;
  filingId: string | null;
}

/** A jurisdiction's calendar + liability roll-up over the window. */
export interface JurisdictionCalendar {
  jurisdiction: string;
  frequency: Frequency;
  frequencySource: 'recorded' | 'default';
  hasConfiguredRate: boolean;
  collectingNow: boolean;
  /** roll-ups over the window. */
  collectedCents: number;
  remittedCents: number;
  netOwedCents: number;
  openPeriods: number; // periods with net owed > 0 and not filed
  overdueCount: number;
  dueSoonCount: number;
  /** the soonest unfiled due date across the window (for sorting/urgency), or null. */
  nextDueDate: string | null;
  rows: CalendarFilingRow[];
}

export interface SalesTaxCalendarReport {
  window: { startDate: string; endDate: string; today: string };
  locationFilter: string | null;
  filingsAvailable: boolean;
  jurisdictions: JurisdictionCalendar[];
  totals: {
    collectedCents: number;
    remittedCents: number;
    netOwedCents: number;
    overdueCount: number;
    dueSoonCount: number;
    upcomingCount: number;
    filedCount: number;
    jurisdictionCount: number;
  };
  meta: {
    invoicesScanned: number;
    invoicesAttributed: number;
    generatedAt: string;
  };
}

export interface SalesTaxCalendarOptions {
  /** injectable clock (YYYY-MM-DD) for deterministic tests; defaults to today. */
  todayISO?: string;
  /** entity/location filter (default: all). */
  locationId?: string | null;
  lookbackMonths?: number;
  lookaheadMonths?: number;
}

interface RateRow {
  state: string | null;
  county: string | null;
  city: string | null;
  is_active: boolean | null;
}

interface FilingDbRow {
  id: string;
  jurisdiction: string | null;
  period_key: string | null;
  frequency: string | null;
  status: string | null;
  filed_at: string | null;
  remitted_cents: number | string | null;
  confirmation_number: string | null;
}

function normalizeFrequency(raw: string | null | undefined): Frequency | null {
  const f = (raw ?? '').toLowerCase();
  return f === 'monthly' || f === 'quarterly' || f === 'annual' ? f : null;
}

/** First day of the month `n` months before the month of `todayISO`. */
function windowStartFrom(todayISO: string, lookbackMonths: number): string {
  const p = parseISODate(todayISO);
  if (!p) return todayISO;
  let y = p.year;
  let m = p.month0 - lookbackMonths;
  while (m < 0) {
    m += 12;
    y -= 1;
  }
  return isoDate(y, m, 1);
}

/** Last day of the month `n` months after the month of `todayISO`. */
function windowEndFrom(todayISO: string, lookaheadMonths: number): string {
  const p = parseISODate(todayISO);
  if (!p) return todayISO;
  let y = p.year;
  let m = p.month0 + lookaheadMonths;
  while (m > 11) {
    m -= 12;
    y += 1;
  }
  return isoDate(y, m, lastDayOfMonth(y, m));
}

/**
 * Assemble the sales-tax FILING CALENDAR + LIABILITY-OWED report for the caller's
 * org. Read-only. Never throws — a missing table/data degrades the affected overlay
 * (filed status) rather than failing the report. RLS scopes everything to the org.
 */
export async function buildSalesTaxCalendar(
  supabase: SupabaseClient,
  orgId: string,
  opts: SalesTaxCalendarOptions = {},
): Promise<SalesTaxCalendarReport> {
  const todayISO = (opts.todayISO ?? new Date().toISOString()).slice(0, 10);
  const lookback = opts.lookbackMonths ?? CALENDAR_TUNABLES.lookbackMonths;
  const lookahead = opts.lookaheadMonths ?? CALENDAR_TUNABLES.lookaheadMonths;
  const locationId = opts.locationId && opts.locationId !== 'all' ? opts.locationId : null;

  const windowStart = windowStartFrom(todayISO, lookback);
  const windowEnd = windowEndFrom(todayISO, lookahead);

  // ── 1. Collected tax per (state, month), attributed exactly like the return. ──
  // Only load history up to today (future months can't have collected sales yet).
  const invoiceEnd = todayISO < windowEnd ? todayISO : windowEnd;
  const { invoices, scanned, attributed } = await loadReturnInvoices(supabase, {
    startDate: windowStart,
    endDate: invoiceEnd,
    locationId,
  });

  // collectedByState -> Map<'YYYY-MM', cents>. Collected = tax actually charged.
  const collectedByState = new Map<string, Map<string, number>>();
  const collectingStates = new Set<string>();
  for (const inv of invoices) {
    if (!inv.state || !inv.period) continue;
    const tax = Math.max(0, Math.round(Number(inv.taxCents) || 0));
    if (tax <= 0) continue;
    collectingStates.add(inv.state);
    let months = collectedByState.get(inv.state);
    if (!months) {
      months = new Map<string, number>();
      collectedByState.set(inv.state, months);
    }
    months.set(inv.period, (months.get(inv.period) ?? 0) + tax);
  }

  // ── 2. Configured-rate states (they collect there → they must file there). ────
  const ratedStates = new Set<string>();
  try {
    const { data, error } = await supabase
      .from('sales_tax_rates')
      .select('state, county, city, is_active')
      .limit(5000);
    if (!error) {
      for (const r of (data ?? []) as RateRow[]) {
        if (r.is_active === false) continue;
        const st = normalizeState(r.state);
        if (st) ratedStates.add(st);
      }
    }
  } catch {
    /* rates are additive to the jurisdiction set — absence degrades gracefully. */
  }

  // ── 3. Filing records overlay (degrade-safe: absent table → unavailable). ─────
  let filingsAvailable = true;
  const filingsByState = new Map<string, Map<string, FilingRecord>>();
  const recordedFreqByState = new Map<string, Frequency>();
  try {
    const { data, error } = await supabase
      .from('sales_tax_filings')
      .select('id, jurisdiction, period_key, frequency, status, filed_at, remitted_cents, confirmation_number')
      .order('period_end', { ascending: false })
      .limit(5000);
    if (error) {
      filingsAvailable = false;
    } else {
      for (const row of (data ?? []) as FilingDbRow[]) {
        const st = normalizeState(row.jurisdiction);
        const key = row.period_key;
        if (!st || !key) continue;
        const freq = normalizeFrequency(row.frequency) ?? defaultFrequencyForState(st);
        // First-seen (rows come newest-first) = the tenant's current filing cadence.
        if (!recordedFreqByState.has(st)) recordedFreqByState.set(st, freq);
        let byPeriod = filingsByState.get(st);
        if (!byPeriod) {
          byPeriod = new Map<string, FilingRecord>();
          filingsByState.set(st, byPeriod);
        }
        byPeriod.set(key, {
          id: row.id,
          jurisdiction: st,
          periodKey: key,
          frequency: freq,
          status: row.status === 'REMITTED' ? 'REMITTED' : 'FILED',
          filedAt: row.filed_at,
          remittedCents: Math.max(0, Math.round(Number(row.remitted_cents) || 0)),
          confirmationNumber: row.confirmation_number,
        });
      }
    }
  } catch {
    filingsAvailable = false;
  }

  // ── 4. Build the per-jurisdiction calendar. ──────────────────────────────────
  const allStates = new Set<string>([...ratedStates, ...collectingStates, ...filingsByState.keys()]);
  const jurisdictions: JurisdictionCalendar[] = [];

  for (const state of allStates) {
    const frequency = recordedFreqByState.get(state) ?? defaultFrequencyForState(state);
    const frequencySource: 'recorded' | 'default' = recordedFreqByState.has(state) ? 'recorded' : 'default';
    const dueDay = dueDayForState(state);
    const months = collectedByState.get(state) ?? new Map<string, number>();
    const records = filingsByState.get(state) ?? new Map<string, FilingRecord>();

    const periods = generateFilingPeriods(frequency, windowStart, windowEnd, dueDay);
    const rows: CalendarFilingRow[] = [];
    let collectedSum = 0;
    let remittedSum = 0;
    let overdueCount = 0;
    let dueSoonCount = 0;
    let openPeriods = 0;
    let nextDueDate: string | null = null;

    for (const period of periods) {
      const collected = collectedForPeriod(months, period);
      const record = records.get(period.periodKey) ?? null;
      const filed = record != null;
      const remitted = record?.remittedCents ?? 0;
      const netOwed = collected - remitted;
      const status = classifyFilingStatus(period.dueDate, filed, todayISO);

      // Skip empty future periods with nothing owed and no record (calendar noise),
      // but always keep periods that carry a liability, a record, or are already due.
      if (!filed && collected === 0 && status === 'upcoming') continue;

      collectedSum += collected;
      remittedSum += remitted;
      if (status === 'overdue') overdueCount += 1;
      if (status === 'due-soon') dueSoonCount += 1;
      if (!filed && netOwed > 0) openPeriods += 1;
      if (!filed && (nextDueDate === null || period.dueDate < nextDueDate)) nextDueDate = period.dueDate;

      rows.push({
        periodKey: period.periodKey,
        label: period.label,
        frequency: period.frequency,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueDate: period.dueDate,
        status,
        collectedCents: collected,
        remittedCents: remitted,
        netOwedCents: netOwed,
        filedAt: record?.filedAt ?? null,
        confirmationNumber: record?.confirmationNumber ?? null,
        filingId: record?.id ?? null,
      });
    }

    // Newest period first (the actionable filings sit at the top).
    rows.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));

    jurisdictions.push({
      jurisdiction: state,
      frequency,
      frequencySource,
      hasConfiguredRate: ratedStates.has(state),
      collectingNow: collectingStates.has(state),
      collectedCents: collectedSum,
      remittedCents: remittedSum,
      netOwedCents: collectedSum - remittedSum,
      openPeriods,
      overdueCount,
      dueSoonCount,
      nextDueDate,
      rows,
    });
  }

  // Most urgent first: overdue, then due-soon, then soonest due date, then $ owed.
  jurisdictions.sort((a, b) => {
    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    if (a.dueSoonCount !== b.dueSoonCount) return b.dueSoonCount - a.dueSoonCount;
    if (a.nextDueDate && b.nextDueDate && a.nextDueDate !== b.nextDueDate) {
      return a.nextDueDate.localeCompare(b.nextDueDate);
    }
    if (a.nextDueDate !== b.nextDueDate) return a.nextDueDate ? -1 : 1;
    return b.netOwedCents - a.netOwedCents || a.jurisdiction.localeCompare(b.jurisdiction);
  });

  const totals = {
    collectedCents: 0,
    remittedCents: 0,
    netOwedCents: 0,
    overdueCount: 0,
    dueSoonCount: 0,
    upcomingCount: 0,
    filedCount: 0,
    jurisdictionCount: jurisdictions.length,
  };
  for (const j of jurisdictions) {
    totals.collectedCents += j.collectedCents;
    totals.remittedCents += j.remittedCents;
    totals.netOwedCents += j.netOwedCents;
    for (const r of j.rows) {
      if (r.status === 'overdue') totals.overdueCount += 1;
      else if (r.status === 'due-soon') totals.dueSoonCount += 1;
      else if (r.status === 'upcoming') totals.upcomingCount += 1;
      else if (r.status === 'filed') totals.filedCount += 1;
    }
  }

  return {
    window: { startDate: windowStart, endDate: windowEnd, today: todayISO },
    locationFilter: locationId,
    filingsAvailable,
    jurisdictions,
    totals,
    meta: {
      invoicesScanned: scanned,
      invoicesAttributed: attributed,
      generatedAt: new Date().toISOString(),
    },
  };
}
