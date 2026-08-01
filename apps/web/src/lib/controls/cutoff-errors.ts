/**
 * Financial Control Exception EC-12 — Period cut-off errors.
 *
 * The classic period-boundary misstatement, and a top audit/fraud focus: revenue or
 * expense recognized on the WRONG side of a period cut. A December-dated invoice
 * booked in January (income recognized late / understating the closed period), a bill
 * dated next period expensed in this one (premature recognition / understating next
 * period), a large P&L entry landing in the last days of a period that materially
 * shifts the result. Left alone, income lands in the wrong period — an audit
 * adjustment, a covenant breach, tax paid early. Only the OWNED ledger can make this
 * check at the source, because only it holds BOTH the posted entry (entry_date /
 * fiscal period) AND the economic document that vouches for it (bill_date /
 * invoice_date / service date). This control NEVER posts, reverses, or edits — it
 * DETECTS the mismatch, quantifies the $ shifted, and DRAFTS the correction (which
 * period it belongs in) for a human to confirm and book through the deterministic
 * engine (canon §3: AI proposes a fact + drafts a fix; a human confirms the period —
 * respecting period locks, the AI never moves income between periods silently).
 *
 * Two detection signals:
 *   A. date_mismatch  — a posted P&L entry whose ECONOMIC date (bill/invoice/receipt
 *                       document date, or a service date parsed from the memo) falls
 *                       in a DIFFERENT fiscal period than where it was posted, with
 *                       one of the two dates within N days of the cut between them.
 *                       The owned-ledger catch a bolt-on can't make: doc-date vs
 *                       posted-period, at the boundary. Estimate = the P&L impact.
 *   B. material_near_close — a large P&L entry posted within N days of a period
 *                       boundary with NO source-document date to verify against
 *                       (manual entry / plug). It materially shifts the period result
 *                       and lands right at the cut — worth a human's cut-off review
 *                       even absent a documentary mismatch.
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each cut-off
 * is written as a PROPOSED row in public.ai_decisions with feature 'CUTOFF_ERROR'.
 * The existing /exceptions route folds PROPOSED ai_decisions in as an `ai_proposal`
 * source. This mirrors EC-1 / EC-2 / EC-4 / EC-10 exactly — no aggregator change, no
 * schema change, no new table.
 *
 * Idempotency: each cut-off carries a stable `dedup_key` (`cutoff:<gl_entry_id>`) in
 * proposed_output, so a re-scan UPDATES the open exception rather than duplicating it
 * (migration 070 makes the DB the guarantor: one open PROPOSED row per
 * (org, feature, dedup_key)), leaves human-resolved (APPROVED/REJECTED) rows
 * untouched, and EXPIRES rows whose entry no longer trips the signal (it was moved to
 * the right period).
 *
 * The pure date/period comparison + materiality logic (`assessCutoff`,
 * `resolveCutoffTier`, `extractMemoDate`, `nearOwnBoundary`, period helpers) is
 * I/O-free and unit-tested. `scanCutoffErrors` does the RLS-scoped reads/writes and
 * never throws — a control must not break the pass it rides on.
 *
 * All money is bigint cents. EC-12 is fundamentally a REVIEW control (a human
 * confirms the period); it ESCALATEs only when the correction crosses a CLOSED /
 * LOCKED period (can't simply repost — needs a reopen or an approved prior-period
 * adjustment) or the $ shifted is very large. Accounts are referenced by TYPE
 * (REVENUE / COGS / OPEX — the P&L that a cut-off shifts), never by hard-coded number
 * (canon §2: there is no EXPENSE type).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { formatMoney } from '@meritbooks/shared';

export const CUTOFF_ERROR_FEATURE = 'CUTOFF_ERROR';

export type CutoffSignal = 'date_mismatch' | 'material_near_close';
export type CutoffDirection = 'early' | 'late';
export type EconomicEvidence = 'document' | 'memo';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const CUTOFF_THRESHOLDS = {
  /** a mismatch counts as a cut-off only if it spans at most this many months
   *  (1 = adjacent periods; a months-old doc posted now is a late/prior-period
   *  entry, a different control — not a boundary slip). */
  maxSpanMonths: 1,
  /** one of the two dates must be within this many days of the cut between the
   *  periods for the mismatch to read as a cut-off (vs a plain reclass). */
  boundaryWindowDays: 5,
  /** a mismatch within this many days of the cut is a tight, high-confidence slip. */
  tightWindowDays: 3,
  /** signal B: a P&L entry at/above this $ posted right at the cut is "material". */
  materialNearCloseCents: 2_500_000, // $25,000
  /** a cut-off shifting at/above this much ESCALATES (materially wrong period). */
  escalateAtRiskCents: 10_000_000, // $100,000
  /** how many recent posted entries to load per scan (most recent by entry_date). */
  scanLimit: 2000,
  /** confidence ramp bounds (never certain — a human confirms the period). */
  confidenceFloor: 0.6,
  confidenceCeil: 0.92,
  /** base confidence for a documentary vs memo-parsed economic date. */
  documentBaseConfidence: 0.78,
  memoBaseConfidence: 0.72,
  /** confidence for the softer signal-B proximity flag (no documentary mismatch).
   *  Set at the review cut-line so a bare proximity flag lands REVIEW (not ESCALATE);
   *  it only escalates when it crosses a closed period or the shift is very large. */
  proximityConfidence: 0.7,
} as const;

const CLOSED_STATUSES = new Set(['SOFT_CLOSE', 'HARD_CLOSE']);

// ─────────────────────────────────────────────────────────────────────────────
// Period + date math (pure). Periods are 'YYYY-MM'; an "index" is months since
// year 0 (year*12 + month-1) so arithmetic is trivial and off-by-one-free.
// ─────────────────────────────────────────────────────────────────────────────

/** Fiscal period bucket (YYYY-MM) for a date; null when undatable. */
export function periodOf(dateISO: string | null | undefined): string | null {
  if (!dateISO) return null;
  const s = String(dateISO);
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' → month index (year*12 + month-1); null when malformed. */
export function periodToIndex(period: string | null | undefined): number | null {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  const [y, m] = period.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

/** month index → 'YYYY-MM'. */
export function indexToPeriod(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** the period immediately before `period`. */
export function previousPeriod(period: string): string | null {
  const idx = periodToIndex(period);
  return idx == null ? null : indexToPeriod(idx - 1);
}

/** Last calendar day of a 'YYYY-MM' period as an ISO date ('YYYY-MM-DD'). */
export function lastDayOfPeriodISO(period: string): string | null {
  const idx = periodToIndex(period);
  if (idx == null) return null;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last of this
  return `${period}-${String(day).padStart(2, '0')}`;
}

/** Parse an ISO/date string to a UTC-midnight epoch (ms); null when unparseable. */
function toUtcMs(dateISO: string): number | null {
  const s = String(dateISO);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Whole-day signed difference a − b (positive when a is later). null on bad input. */
export function daysBetween(aISO: string, bISO: string): number | null {
  const a = toUtcMs(aISO);
  const b = toUtcMs(bISO);
  if (a == null || b == null) return null;
  return Math.round((a - b) / 86_400_000);
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Deterministic, stable dedup key for a cut-off on a given GL entry. */
export function dedupKey(glEntryId: string): string {
  return `cutoff:${glEntryId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Economic-date extraction from a memo (fallback when no source document links)
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Best-effort parse of a service / economic date from a free-text memo. Recognizes
 * ISO ('2025-12-31'), US numeric ('12/31/2025', '12/2025'), and month-name
 * ('Dec 2025', 'December 2025') forms; a month-only match resolves to the first of
 * that month. Conservative: returns null on anything ambiguous. Pure.
 */
export function extractMemoDate(memo: string | null | undefined): string | null {
  if (!memo) return null;
  const s = String(memo);

  // 1. ISO date.
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31) return `${y}-${m}-${d}`;
  }

  // 2. US numeric MM/DD/YYYY or MM/YYYY (also accepts '-' separators).
  const usFull = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (usFull) {
    const mm = +usFull[1];
    const dd = +usFull[2];
    const yy = usFull[3];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  const usMonth = s.match(/\b(\d{1,2})[/-](\d{4})\b/);
  if (usMonth) {
    const mm = +usMonth[1];
    const yy = usMonth[2];
    if (mm >= 1 && mm <= 12) return `${yy}-${String(mm).padStart(2, '0')}-01`;
  }

  // 3. Month name + year.
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (named) {
    const mm = MONTHS[named[1].slice(0, 3).toLowerCase()];
    const yy = named[2];
    if (mm) return `${yy}-${String(mm).padStart(2, '0')}-01`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary proximity (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundaryProximity {
  near: boolean;
  days: number; // distance in days to the nearest own-period boundary (start/end)
  side: 'start' | 'end';
}

/**
 * How close a date sits to its OWN period's boundary (first-of-month or last-of-
 * month), and on which side. Used by signal B (a large entry landing right at the
 * cut). Pure.
 */
export function nearOwnBoundary(dateISO: string, windowDays: number): BoundaryProximity {
  const period = periodOf(dateISO);
  if (!period) return { near: false, days: Number.POSITIVE_INFINITY, side: 'end' };
  const start = `${period}-01`;
  const end = lastDayOfPeriodISO(period)!;
  const toStart = Math.abs(daysBetween(dateISO, start) ?? Number.POSITIVE_INFINITY);
  const toEnd = Math.abs(daysBetween(dateISO, end) ?? Number.POSITIVE_INFINITY);
  const side: 'start' | 'end' = toStart <= toEnd ? 'start' : 'end';
  const days = Math.min(toStart, toEnd);
  return { near: days <= windowDays, days, side };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal A — economic-date vs posted-period mismatch (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface CutoffInput {
  /** the economic / performance date (bill_date, invoice_date, receipt_date, or memo). */
  economicDateISO: string;
  /** the date the entry was actually booked to the ledger (gl_entries.entry_date). */
  postedDateISO: string;
  /** the P&L $ this entry shifts between periods (revenue credits + expense debits). */
  amountAtRiskCents: number;
  /** did the economic date come from a linked source document, or a parsed memo? */
  evidence: EconomicEvidence;
}

export interface CutoffAssessment {
  direction: CutoffDirection; // 'late' (economic earlier than posted) | 'early' (posted before economic)
  economicPeriod: string;
  postedPeriod: string;
  spanMonths: number;
  /** minimum distance (days) of either date to the cut between the two periods. */
  daysFromCut: number;
  confidence: number; // 0..1
}

/**
 * Assess whether a posted entry is a period cut-off error. Returns null when the
 * economic and posted dates fall in the SAME period, span more than the configured
 * window (a plain late/prior-period entry, not a boundary slip), or neither date is
 * near the cut (a genuine reclass, not a cut-off). Pure — no I/O, no clock.
 */
export function assessCutoff(
  input: CutoffInput,
  thresholds: typeof CUTOFF_THRESHOLDS = CUTOFF_THRESHOLDS,
): CutoffAssessment | null {
  const economicPeriod = periodOf(input.economicDateISO);
  const postedPeriod = periodOf(input.postedDateISO);
  const econIdx = periodToIndex(economicPeriod);
  const postIdx = periodToIndex(postedPeriod);
  if (economicPeriod == null || postedPeriod == null || econIdx == null || postIdx == null) return null;
  if (econIdx === postIdx) return null; // same period — no cut-off

  const spanMonths = Math.abs(postIdx - econIdx);
  if (spanMonths < 1 || spanMonths > thresholds.maxSpanMonths) return null;

  // The cut between the two periods = the end of the EARLIER period.
  const earlierPeriod = econIdx < postIdx ? economicPeriod : postedPeriod;
  const cutISO = lastDayOfPeriodISO(earlierPeriod);
  if (!cutISO) return null;

  const dEcon = Math.abs(daysBetween(input.economicDateISO, cutISO) ?? Number.POSITIVE_INFINITY);
  const dPost = Math.abs(daysBetween(input.postedDateISO, cutISO) ?? Number.POSITIVE_INFINITY);
  const daysFromCut = Math.min(dEcon, dPost);
  if (daysFromCut > thresholds.boundaryWindowDays) return null;

  // late  = economic activity earlier, booked later (recognized late; belongs earlier).
  // early = booked before the economic date (premature; belongs later).
  const direction: CutoffDirection = econIdx < postIdx ? 'late' : 'early';

  const base =
    input.evidence === 'document' ? thresholds.documentBaseConfidence : thresholds.memoBaseConfidence;
  let confidence = base;
  if (daysFromCut <= thresholds.tightWindowDays) confidence += 0.1;
  if (input.evidence === 'document') confidence += 0.04;
  confidence = Math.max(thresholds.confidenceFloor, Math.min(thresholds.confidenceCeil, confidence));

  return { direction, economicPeriod, postedPeriod, spanMonths, daysFromCut, confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — EC-12 is a REVIEW control (a human confirms the period). It ESCALATEs
// only when the correction crosses a CLOSED/LOCKED period (can't simply repost) or
// the $ shifted is very large. A control never auto-suppresses.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveCutoffTier(
  amountAtRiskCents: number,
  crossesClosedPeriod: boolean,
  confidence: number,
  policy: TierPolicy,
  escalateAtRiskCents: number = CUTOFF_THRESHOLDS.escalateAtRiskCents,
): Tier {
  if (crossesClosedPeriod) return 'escalate';
  if (amountAtRiskCents >= escalateAtRiskCents) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier; // a detection never auto-applies
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafted remediation (never auto-applied — canon §3)
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftJeLine {
  account_id: string | null;
  account_name: string | null;
  account_type: string;
  debit_cents: number;
  credit_cents: number;
  memo: string;
}

export interface CutoffRemediation {
  type: 'CUTOFF_REVERSAL_REPOST' | 'CUTOFF_REVIEW';
  /** the period the entry belongs in (null for a review-only proximity flag). */
  correct_period: string | null;
  /** the period the entry was (incorrectly) posted into. */
  posted_period: string;
  amount_cents: number;
  respects_period_lock: boolean;
  /** the lines to re-post in the correct period (mirror = the reversing entry). */
  lines: DraftJeLine[];
  note: string;
  source_ref: { table: string; id: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

export interface CutoffBucket {
  dedupKey: string;
  signal: CutoffSignal;
  glEntryId: string;
  entryNumber: string | null;
  locationId: string | null;
  postedPeriod: string;
  economicPeriod: string | null;
  direction: CutoffDirection | null;
  amountAtRiskCents: number;
  crossesClosedPeriod: boolean;
  confidence: number; // 0..1 pre-clamp
  tier: Tier;
  title: string;
  reason: string;
  question: string;
  remediation: CutoffRemediation;
}

export interface CutoffScanSummary {
  scanned: { entries: number; nearBoundary: number };
  buckets: number;
  bySignal: Record<CutoffSignal, number>;
  byTier: Record<Tier, number>;
  queued: number;
  refreshed: number;
  expired: number;
  totalAtRiskCents: number;
  errors: number;
  cutoffs: Array<{
    signal: CutoffSignal;
    glEntryId: string;
    postedPeriod: string;
    economicPeriod: string | null;
    amountAtRiskCents: number;
    tier: Tier;
    title: string;
  }>;
}

export interface CutoffScanOptions {
  /** injectable clock for deterministic tests; defaults to now. */
  asOfISO?: string;
  /** only consider entries whose posted OR economic period is this ('YYYY-MM'). */
  period?: string;
  /** only scan entries with entry_date >= this ('YYYY-MM-DD'). */
  sinceDate?: string;
  /** cap the population loaded (default CUTOFF_THRESHOLDS.scanLimit). */
  limit?: number;
  /** compute + return the cut-offs WITHOUT persisting any exception rows. */
  dryRun?: boolean;
}

interface GlEntryRow {
  id: string;
  entry_number: string | null;
  entry_date: string;
  fiscal_period_id: string | null;
  location_id: string | null;
  source_module: string | null;
  memo: string | null;
  status: string;
}

interface GlLineRow {
  gl_entry_id: string;
  account_id: string;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
}

interface AccountRow {
  id: string;
  name: string;
  account_type: string;
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const PNL_TYPES = new Set(['REVENUE', 'COGS', 'OPEX']);

/**
 * Scan the org's recent posted entries for EC-12 period cut-off errors, queue /
 * refresh them into /exceptions (PROPOSED ai_decisions, feature 'CUTOFF_ERROR'), and
 * return a summary. Never throws. Reads/writes run through the RLS-scoped client; org
 * isolation is enforced by the database, never by hand-filtering org_id.
 */
export async function scanCutoffErrors(
  supabase: SupabaseClient,
  orgId: string,
  opts: CutoffScanOptions = {},
): Promise<CutoffScanSummary> {
  const limit = opts.limit ?? CUTOFF_THRESHOLDS.scanLimit;
  const summary: CutoffScanSummary = {
    scanned: { entries: 0, nearBoundary: 0 },
    buckets: 0,
    bySignal: { date_mismatch: 0, material_near_close: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    queued: 0,
    refreshed: 0,
    expired: 0,
    totalAtRiskCents: 0,
    errors: 0,
    cutoffs: [],
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // 1. Load the recent posted-entry population (the cut-off risk surface).
  let entries: GlEntryRow[] = [];
  try {
    let q = supabase
      .from('gl_entries')
      .select('id, entry_number, entry_date, fiscal_period_id, location_id, source_module, memo, status')
      .eq('status', 'POSTED')
      .order('entry_date', { ascending: false })
      .limit(limit);
    if (opts.sinceDate) q = q.gte('entry_date', opts.sinceDate);
    const { data, error } = await q;
    if (error) {
      console.warn('[controls/cutoff] entry load failed:', error.message);
      summary.errors += 1;
      return summary;
    }
    entries = (data ?? []) as GlEntryRow[];
  } catch (e) {
    console.warn('[controls/cutoff] entry load threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
    return summary;
  }
  summary.scanned.entries = entries.length;
  if (entries.length === 0) return summary;

  const entryIds = entries.map((e) => e.id);

  // 2. Lines, accounts, fiscal-period statuses, and source-document economic dates.
  const acctById = new Map<string, AccountRow>();
  const linesByEntry = new Map<string, GlLineRow[]>();
  const periodStatusByKey = new Map<string, string>(); // `${loc}:${YYYY-MM}` → status
  const statusByFiscalId = new Map<string, string>();
  const docDateByEntry = new Map<string, { dateISO: string; table: string; id: string }>();

  try {
    const [{ data: lineData }, { data: acctData }, { data: perData }] = await Promise.all([
      supabase
        .from('gl_entry_lines')
        .select('gl_entry_id, account_id, debit_cents, credit_cents')
        .in('gl_entry_id', entryIds.slice(0, 5000)),
      supabase.from('accounts').select('id, name, account_type'),
      supabase.from('fiscal_periods').select('id, location_id, period_year, period_month, status'),
    ]);
    for (const l of (lineData ?? []) as GlLineRow[]) {
      const arr = linesByEntry.get(l.gl_entry_id) ?? [];
      arr.push(l);
      linesByEntry.set(l.gl_entry_id, arr);
    }
    for (const a of (acctData ?? []) as AccountRow[]) acctById.set(a.id, a);
    for (const p of (perData ?? []) as Array<{
      id: string;
      location_id: string;
      period_year: number;
      period_month: number;
      status: string;
    }>) {
      const key = `${p.location_id}:${p.period_year}-${String(p.period_month).padStart(2, '0')}`;
      periodStatusByKey.set(key, p.status);
      statusByFiscalId.set(p.id, p.status);
    }
  } catch (e) {
    console.warn('[controls/cutoff] lines/accounts/periods load threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
    return summary;
  }

  // Source-document economic dates, linked by gl_entry_id (the definitive link).
  await Promise.all([
    loadDocDates(supabase, 'bills', 'bill_date', entryIds, docDateByEntry),
    loadDocDates(supabase, 'invoices', 'invoice_date', entryIds, docDateByEntry),
    loadDocDates(supabase, 'receipts', 'receipt_date', entryIds, docDateByEntry),
  ]);

  const targetIdx = opts.period ? periodToIndex(opts.period) : null;
  const buckets: CutoffBucket[] = [];

  // 3. Assess each entry.
  for (const e of entries) {
    const lines = linesByEntry.get(e.id) ?? [];
    if (lines.length === 0) continue;

    // P&L impact = the period result this entry shifts.
    let revenueCents = 0;
    let expenseCents = 0;
    let totalDebit = 0;
    for (const l of lines) {
      const acct = acctById.get(l.account_id);
      totalDebit += num(l.debit_cents);
      if (!acct) continue;
      if (acct.account_type === 'REVENUE') revenueCents += num(l.credit_cents);
      else if (acct.account_type === 'COGS' || acct.account_type === 'OPEX') expenseCents += num(l.debit_cents);
    }
    const pnlImpact = revenueCents + expenseCents;
    if (pnlImpact <= 0) continue; // pure balance-sheet entry — no period result to shift
    const amountAtRisk = pnlImpact;
    const sideWord = revenueCents >= expenseCents ? 'revenue' : 'expense';

    const postedPeriod = periodOf(e.entry_date);
    if (!postedPeriod) continue;
    const postedStatus =
      (e.fiscal_period_id ? statusByFiscalId.get(e.fiscal_period_id) : undefined) ??
      periodStatusByKey.get(`${e.location_id}:${postedPeriod}`);

    // Economic date: source document first, memo fallback.
    const doc = docDateByEntry.get(e.id);
    const memoDate = doc ? null : extractMemoDate(e.memo);
    const economicDateISO = doc?.dateISO ?? memoDate ?? null;
    const evidence: EconomicEvidence = doc ? 'document' : 'memo';

    if (economicDateISO) {
      const assessment = assessCutoff({
        economicDateISO,
        postedDateISO: e.entry_date,
        amountAtRiskCents: amountAtRisk,
        evidence,
      });
      if (!assessment) continue;

      // Period-of-interest filter (posted OR economic side matches the requested period).
      if (
        targetIdx != null &&
        periodToIndex(assessment.postedPeriod) !== targetIdx &&
        periodToIndex(assessment.economicPeriod) !== targetIdx
      ) {
        continue;
      }
      summary.scanned.nearBoundary += 1;

      const econStatus = periodStatusByKey.get(`${e.location_id}:${assessment.economicPeriod}`);
      const crossesClosed =
        (postedStatus != null && CLOSED_STATUSES.has(postedStatus)) ||
        (econStatus != null && CLOSED_STATUSES.has(econStatus));
      const tier = resolveCutoffTier(amountAtRisk, crossesClosed, assessment.confidence, policy);

      const entryLabel = e.entry_number ? `JE #${e.entry_number}` : 'This entry';
      const recog = assessment.direction === 'late' ? 'recognized late' : 'recognized early';
      const evidenceWord = doc ? `${doc.table.replace(/s$/, '')}-dated ${economicDateISO.slice(0, 10)}` : `memo-dated ${economicDateISO.slice(0, 10)}`;
      const closedNote = crossesClosed
        ? ` One of the periods is CLOSED/LOCKED — the correction needs a period reopen or an approved prior-period adjustment.`
        : '';

      const title = `${entryLabel} — ${sideWord} ${recog}: ${evidenceWord} but posted to ${assessment.postedPeriod} · ${formatMoney(amountAtRisk)} in the wrong period`;
      const reason =
        `${entryLabel} carries an economic date of ${economicDateISO.slice(0, 10)} (${assessment.economicPeriod}) but was posted to ${assessment.postedPeriod} ` +
        `(entry date ${e.entry_date}) — within ${assessment.daysFromCut} day(s) of the period cut. ` +
        `${formatMoney(amountAtRisk)} of ${sideWord} is ${recog}: it belongs in ${assessment.economicPeriod}, not ${assessment.postedPeriod}. ` +
        `Left uncorrected, ${assessment.postedPeriod}'s result is misstated (a classic cut-off error → audit adjustment / covenant / early tax).${closedNote}`;

      buckets.push(
        buildBucket({
          signal: 'date_mismatch',
          entry: e,
          postedPeriod: assessment.postedPeriod,
          economicPeriod: assessment.economicPeriod,
          direction: assessment.direction,
          amountAtRisk,
          crossesClosed,
          confidence: assessment.confidence,
          tier,
          title,
          reason,
          question:
            'Confirm the correct period and reverse-and-repost (respecting period locks), or confirm this entry belongs where it is?',
          lines,
          acctById,
          remediationType: 'CUTOFF_REVERSAL_REPOST',
          correctPeriod: assessment.economicPeriod,
        }),
      );
      continue;
    }

    // Signal B — large P&L entry at the cut with no document to verify against.
    if (amountAtRisk < CUTOFF_THRESHOLDS.materialNearCloseCents) continue;
    const prox = nearOwnBoundary(e.entry_date, CUTOFF_THRESHOLDS.boundaryWindowDays);
    if (!prox.near) continue;
    if (targetIdx != null && periodToIndex(postedPeriod) !== targetIdx) continue;
    summary.scanned.nearBoundary += 1;

    const crossesClosed = postedStatus != null && CLOSED_STATUSES.has(postedStatus);
    const tier = resolveCutoffTier(
      amountAtRisk,
      crossesClosed,
      CUTOFF_THRESHOLDS.proximityConfidence,
      policy,
    );
    const entryLabel = e.entry_number ? `JE #${e.entry_number}` : 'This entry';
    const whichEnd = prox.side === 'end' ? 'the last days of' : 'the first days of';
    const title = `${entryLabel} — ${formatMoney(amountAtRisk)} ${sideWord} posted at ${whichEnd} ${postedPeriod} · cut-off review`;
    const reason =
      `${entryLabel} posts ${formatMoney(amountAtRisk)} of ${sideWord} within ${prox.days} day(s) of the ${postedPeriod} period boundary with no source-document date to verify against ` +
      `(source: ${e.source_module ?? 'manual'}). A material entry landing right at the cut materially shifts the period result — confirm the economic/performance date genuinely falls in ${postedPeriod}.`;

    buckets.push(
      buildBucket({
        signal: 'material_near_close',
        entry: e,
        postedPeriod,
        economicPeriod: null,
        direction: null,
        amountAtRisk,
        crossesClosed,
        confidence: CUTOFF_THRESHOLDS.proximityConfidence,
        tier,
        title,
        reason,
        question:
          'Confirm the performance/economic date belongs in this period, or move it to the correct period (respecting period locks)?',
        lines,
        acctById,
        remediationType: 'CUTOFF_REVIEW',
        correctPeriod: null,
      }),
    );
  }

  // Highest $-at-risk first — the biggest period-result shift surfaces at the top.
  buckets.sort((a, b) => b.amountAtRiskCents - a.amountAtRiskCents);
  summary.buckets = buckets.length;
  for (const b of buckets) {
    summary.bySignal[b.signal] += 1;
    summary.totalAtRiskCents += b.amountAtRiskCents;
    summary.cutoffs.push({
      signal: b.signal,
      glEntryId: b.glEntryId,
      postedPeriod: b.postedPeriod,
      economicPeriod: b.economicPeriod,
      amountAtRiskCents: b.amountAtRiskCents,
      tier: b.tier,
      title: b.title,
    });
  }

  if (opts.dryRun) return summary;

  // ── Idempotency: load existing CUTOFF_ERROR rows keyed by dedup_key ──────────
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', CUTOFF_ERROR_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of data ?? []) {
      const r = row as { id: string; status: string; proposed_output?: { dedup_key?: string } };
      const key = r.proposed_output?.dedup_key;
      if (key) existing.set(key, { id: r.id, status: r.status });
    }
  } catch {
    /* best-effort — worst case we re-queue rather than refresh */
  }

  const liveKeys = new Set(buckets.map((b) => b.dedupKey));

  for (const b of buckets) {
    const confidence = toConfidence(b.confidence);
    const proposedOutput = {
      control: 'EC-12',
      signal: b.signal,
      dedup_key: b.dedupKey,
      gl_entry_id: b.glEntryId,
      entry_number: b.entryNumber,
      posted_period: b.postedPeriod,
      economic_period: b.economicPeriod,
      direction: b.direction,
      amount_shifted_cents: b.amountAtRiskCents,
      amount_at_risk_cents: b.amountAtRiskCents,
      crosses_closed_period: b.crossesClosedPeriod,
      tier: b.tier,
      remediation: b.remediation,
      reason: b.reason,
    };

    const prior = existing.get(b.dedupKey);
    if (prior && (prior.status === 'APPROVED' || prior.status === 'REJECTED')) continue; // human dispositioned

    if (prior && prior.status === 'PROPOSED') {
      const { error } = await supabase
        .from('ai_decisions')
        .update({
          input_summary: b.title,
          proposed_output: proposedOutput,
          confidence,
          reasoning: b.reason,
          clarifying_question: b.question,
        })
        .eq('id', prior.id);
      if (error) {
        console.warn('[controls/cutoff] refresh failed:', error.message);
        summary.errors += 1;
        continue;
      }
      summary.refreshed += 1;
      summary.byTier[b.tier] += 1;
      continue;
    }

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: b.locationId,
      feature: CUTOFF_ERROR_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: b.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/cutoff] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    summary.queued += 1;
    summary.byTier[b.tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.cutoff_error.detect',
      subjectTable: 'gl_entries',
      subjectId: b.glEntryId,
      summary: b.title,
      locationId: b.locationId,
      confidence,
      tier: b.tier,
      metadata: {
        signal: b.signal,
        dedup_key: b.dedupKey,
        posted_period: b.postedPeriod,
        economic_period: b.economicPeriod,
        amount_shifted_cents: b.amountAtRiskCents,
        crosses_closed_period: b.crossesClosedPeriod,
      },
    });
  }

  // ── Expire previously-open cut-offs no longer tripping (moved to the right period) ──
  for (const [key, prior] of existing) {
    if (prior.status !== 'PROPOSED' || liveKeys.has(key)) continue;
    const { error } = await supabase
      .from('ai_decisions')
      .update({ status: 'EXPIRED' })
      .eq('id', prior.id)
      .eq('status', 'PROPOSED');
    if (!error) summary.expired += 1;
  }

  return summary;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Load a source table's economic date, keyed by its gl_entry_id link. Best-effort. */
async function loadDocDates(
  supabase: SupabaseClient,
  table: string,
  dateCol: string,
  entryIds: string[],
  out: Map<string, { dateISO: string; table: string; id: string }>,
): Promise<void> {
  try {
    const { data } = await supabase
      .from(table)
      .select(`id, gl_entry_id, ${dateCol}`)
      .in('gl_entry_id', entryIds.slice(0, 5000));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const glId = row.gl_entry_id as string | null;
      const dt = row[dateCol] as string | null;
      const id = row.id as string;
      if (glId && dt && !out.has(glId)) out.set(glId, { dateISO: dt, table, id });
    }
  } catch (e) {
    console.warn(`[controls/cutoff] ${table} date load threw:`, e instanceof Error ? e.message : e);
  }
}

function buildBucket(args: {
  signal: CutoffSignal;
  entry: GlEntryRow;
  postedPeriod: string;
  economicPeriod: string | null;
  direction: CutoffDirection | null;
  amountAtRisk: number;
  crossesClosed: boolean;
  confidence: number;
  tier: Tier;
  title: string;
  reason: string;
  question: string;
  lines: GlLineRow[];
  acctById: Map<string, AccountRow>;
  remediationType: CutoffRemediation['type'];
  correctPeriod: string | null;
}): CutoffBucket {
  const draftLines: DraftJeLine[] = args.lines.map((l) => {
    const acct = args.acctById.get(l.account_id);
    return {
      account_id: l.account_id,
      account_name: acct?.name ?? null,
      account_type: acct?.account_type ?? 'OTHER',
      debit_cents: num(l.debit_cents),
      credit_cents: num(l.credit_cents),
      memo:
        args.correctPeriod != null
          ? `Re-post ${args.entry.entry_number ? `JE #${args.entry.entry_number}` : 'entry'} in ${args.correctPeriod} (cut-off correction)`
          : `Confirm period for ${args.entry.entry_number ? `JE #${args.entry.entry_number}` : 'entry'}`,
    };
  });

  const note =
    args.remediationType === 'CUTOFF_REVERSAL_REPOST'
      ? `Draft only — reverse ${args.entry.entry_number ? `JE #${args.entry.entry_number}` : 'the entry'} in ${args.postedPeriod} and re-post the same lines dated in ${args.correctPeriod}, through the deterministic engine, RESPECTING period locks. ` +
        (args.crossesClosed
          ? 'A closed/locked period is involved — a controller must reopen it or book an approved prior-period adjustment before this can post.'
          : 'A human confirms the correct period before anything posts (canon §3 — the AI never moves income between periods silently).')
      : `Draft only — this is a review flag, not a correction. Confirm the performance/economic date belongs in ${args.postedPeriod}; if it belongs in an adjacent period, reverse-and-repost respecting period locks.`;

  return {
    dedupKey: dedupKey(args.entry.id),
    signal: args.signal,
    glEntryId: args.entry.id,
    entryNumber: args.entry.entry_number,
    locationId: args.entry.location_id,
    postedPeriod: args.postedPeriod,
    economicPeriod: args.economicPeriod,
    direction: args.direction,
    amountAtRiskCents: args.amountAtRisk,
    crossesClosedPeriod: args.crossesClosed,
    confidence: args.confidence,
    tier: args.tier,
    title: args.title,
    reason: args.reason,
    question: args.question,
    remediation: {
      type: args.remediationType,
      correct_period: args.correctPeriod,
      posted_period: args.postedPeriod,
      amount_cents: args.amountAtRisk,
      respects_period_lock: true,
      lines: draftLines,
      note,
      source_ref: { table: 'gl_entries', id: args.entry.id },
    },
  };
}
