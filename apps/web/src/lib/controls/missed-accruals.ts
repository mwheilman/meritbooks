/**
 * Financial Control Exception EC-2 — Missed / mis-estimated accruals & deferrals.
 *
 * The #1 audit adjustment: recurring economic activity that should be accrued at
 * period end but isn't. A vendor that bills every month goes silent this period;
 * a known recurring expense (rent / insurance / utilities / payroll) configured
 * as a recurring journal template is due but was never generated; a straight-line
 * prepaid amortization or deferred-revenue release is scheduled for the period but
 * has no run. Left alone, the period's P&L is understated (expense) or overstated
 * (unreleased deferral), and a single missed six-figure accrual can flip a
 * covenant. This control NEVER posts, pays, or edits anything — it DETECTS the gap
 * from real recurrence history, quantifies the run-rate estimate, and DRAFTS the
 * balanced accrual entry for a human (right role, SoD) to review and post through
 * the deterministic engine (canon §3: AI proposes a fact + drafts a fix; a human
 * books the estimate — the AI never books an estimate silently).
 *
 * Three detection signals (all "recurring activity expected this period, not booked"):
 *   A. vendor_recurrence  — a vendor with a regular billing cadence (detected from
 *                           its own bill history) whose TARGET period has no bill.
 *                           The novel, owned-ledger catch a bolt-on can't see: the
 *                           *absent* expected bill. Estimate = run-rate of history.
 *   B. recurring_template — an ACTIVE recurring_templates row that is due for the
 *                           target period (frequency-aligned, within its date span)
 *                           but was never generated up through that period. Covers
 *                           rent/insurance/utilities/payroll AND recurring revenue
 *                           accruals (the template already carries its own legs).
 *   C. scheduled_deferral — an ACTIVE posting_schedule (prepaid amortization /
 *                           deferred-revenue / straight-line) whose target-period
 *                           run is missing from posting_schedule_runs.
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each gap is
 * written as a PROPOSED row in public.ai_decisions with feature 'MISSED_ACCRUAL'.
 * The existing /exceptions route already folds PROPOSED ai_decisions in as an
 * `ai_proposal` source. This mirrors EC-1 / EC-4 / EC-10 exactly — no aggregator
 * change, no schema change, no new table.
 *
 * Idempotency: each gap carries a stable `dedup_key`
 * (`accrual:<kind>:<subjectId>:<period>`) in proposed_output, so a re-scan UPDATES
 * the open exception rather than duplicating it (migration 070 makes the DB the
 * guarantor: one open PROPOSED row per (org, feature, dedup_key)), leaves
 * human-resolved (APPROVED/REJECTED) rows untouched, and EXPIRES rows whose gap has
 * since been closed (the bill/entry finally posted).
 *
 * The pure recurrence / estimate math (`detectCadence`, `assessVendorRecurrence`,
 * `estimateAccrual`, `accrualConfidence`, `resolveAccrualTier`, `classifyGap`,
 * `templateDueForPeriod`, `scheduleDueForPeriod`, period helpers) is I/O-free and
 * unit-tested. `scanMissedAccruals` does the RLS-scoped reads/writes and never
 * throws — a control must not break the pass it rides on.
 *
 * All money is bigint cents. EC-2 is fundamentally a REVIEW control (an estimate is
 * judgment); only a very large missed accrual ESCALATEs (covenant risk). Accounts
 * are referenced by ROLE (the vendor's own default expense account; a liability
 * account whose name reads as "accrued"), never by hard-coded number (canon §2).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type AutonomyGovernance,
} from '@/lib/autonomy/disposition';
import { formatMoney } from '@meritbooks/shared';

export const MISSED_ACCRUAL_FEATURE = 'MISSED_ACCRUAL';

export type AccrualKind = 'vendor_recurrence' | 'recurring_template' | 'scheduled_deferral';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const ACCRUAL_THRESHOLDS = {
  /** a vendor needs at least this many billed periods to be "recurring". */
  minOccurrences: 3,
  /** only look this many months either side of the target when judging cadence. */
  lookbackMonths: 12,
  /** fraction of billing intervals that must match the modal cadence. */
  minRegularity: 0.6,
  /** the largest cadence interval (months) we treat as recurring (monthly..quarterly). */
  maxIntervalMonths: 3,
  /** run-rate estimate = mean of the most recent this-many billed periods. */
  estimateWindow: 3,
  /** a missed accrual at/above this run-rate $ ESCALATES (covenant risk). */
  escalateAtRiskCents: 10_000_000, // $100,000 — "a missed six-figure accrual can flip a covenant"
  /** configured recurrence (templates/schedules) is near-certain by construction. */
  configuredConfidence: 0.9,
  /** confidence ramp bounds for the *detected* vendor cadence. */
  confidenceFloor: 0.6,
  confidenceCeil: 0.95,
  /** cap subject ids persisted per exception (jsonb size guard). */
  maxSubjectsPerBucket: 250,
} as const;

const KIND_LABEL: Record<AccrualKind, string> = {
  vendor_recurrence: 'Missing recurring vendor bill / accrual',
  recurring_template: 'Recurring entry not generated',
  scheduled_deferral: 'Scheduled amortization / deferral not posted',
};

// ─────────────────────────────────────────────────────────────────────────────
// Period math (pure). Periods are 'YYYY-MM' strings; an "index" is months since
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

/** the period `n` months after `period` (n may be negative). */
export function addPeriods(period: string, n: number): string | null {
  const idx = periodToIndex(period);
  return idx == null ? null : indexToPeriod(idx + n);
}

/** the period immediately before `period`. */
export function previousPeriod(period: string): string | null {
  return addPeriods(period, -1);
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Deterministic, stable dedup key for an accrual gap. */
export function dedupKey(kind: AccrualKind, subjectId: string, period: string): string {
  return `accrual:${kind}:${subjectId}:${period}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence detection + gap classification (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface Cadence {
  /** the modal interval between billed periods, in months (1 = monthly, 3 = quarterly). */
  intervalMonths: number;
  /** fraction of intervals that match the modal interval (0..1) — regularity. */
  regularity: number;
  /** how many billed periods informed the cadence. */
  occurrences: number;
}

/**
 * Infer a billing cadence from the set of period indices a vendor has billed in.
 * Returns null when the history is too thin, too irregular, or too spread out to
 * be a "recurring" vendor (anti-cry-wolf: an occasional vendor never trips EC-2).
 * `billedIdx` must be unique + ascending and already bounded to the lookback.
 */
export function detectCadence(
  billedIdx: number[],
  thresholds: typeof ACCRUAL_THRESHOLDS = ACCRUAL_THRESHOLDS,
): Cadence | null {
  if (billedIdx.length < thresholds.minOccurrences) return null;
  const intervals: number[] = [];
  for (let i = 1; i < billedIdx.length; i++) intervals.push(billedIdx[i] - billedIdx[i - 1]);
  if (intervals.length < 2) return null;

  // Modal interval.
  const freq = new Map<number, number>();
  for (const d of intervals) freq.set(d, (freq.get(d) ?? 0) + 1);
  let modal = intervals[0];
  let modalCount = 0;
  for (const [d, c] of freq) {
    if (c > modalCount || (c === modalCount && d < modal)) {
      modal = d;
      modalCount = c;
    }
  }
  if (modal < 1 || modal > thresholds.maxIntervalMonths) return null;

  const regularity = modalCount / intervals.length;
  if (regularity < thresholds.minRegularity) return null;

  return { intervalMonths: modal, regularity, occurrences: billedIdx.length };
}

export type GapType = 'interior' | 'trailing' | 'none';

/**
 * Decide whether `targetIdx` is a genuine cadence gap given the billed period set.
 *   - interior: target sits squarely between billed periods (bill both before AND
 *     after) within normal spacing — unambiguous, the vendor resumed after skipping.
 *   - trailing: target is the immediate next expected period after the last bill,
 *     with nothing after — the classic accrual (expense incurred, invoice not yet
 *     received). Real, but slightly lower confidence than an interior gap.
 *   - none: already billed, or too far past the last bill (vendor likely churned —
 *     too speculative to flag; fail quiet on that side).
 */
export function classifyGap(billedIdx: number[], targetIdx: number, interval: number): GapType {
  if (billedIdx.includes(targetIdx)) return 'none';
  const grace = Math.max(interval, Math.round(interval * 1.5));
  const before = billedIdx.filter((i) => i < targetIdx);
  const after = billedIdx.filter((i) => i > targetIdx);
  const lastBefore = before.length ? Math.max(...before) : null;
  const firstAfter = after.length ? Math.min(...after) : null;

  if (lastBefore != null && firstAfter != null) {
    if (targetIdx - lastBefore <= grace && firstAfter - targetIdx <= grace) return 'interior';
    return 'none';
  }
  if (lastBefore != null && firstAfter == null) {
    const gap = targetIdx - lastBefore;
    if (gap >= interval && gap <= grace) return 'trailing';
  }
  return 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimate + confidence (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccrualEstimate {
  estimateCents: number; // run-rate estimate for the missing accrual
  low: number; // smallest amount in the window (a range for the reviewer)
  high: number; // largest amount in the window
  cv: number; // coefficient of variation of the window (0 = perfectly stable)
}

/**
 * Run-rate estimate of a missing accrual: the mean of the most recent `window`
 * billed-period amounts (each already a per-period sum). Robust enough for an
 * accrual a controller will review; the range (low/high) and stability (cv) travel
 * with it so the reviewer sees the spread, not just a point number.
 * `amountsChrono` must be per-period sums in chronological (oldest→newest) order.
 */
export function estimateAccrual(
  amountsChrono: number[],
  window: number = ACCRUAL_THRESHOLDS.estimateWindow,
): AccrualEstimate {
  const w = amountsChrono.slice(-Math.max(1, window)).map((n) => Math.abs(Number(n) || 0));
  if (w.length === 0) return { estimateCents: 0, low: 0, high: 0, cv: 1 };
  const mean = w.reduce((s, n) => s + n, 0) / w.length;
  const variance = w.reduce((s, n) => s + (n - mean) ** 2, 0) / w.length;
  const stdev = Math.sqrt(variance);
  const cv = mean > 0 ? stdev / mean : 1;
  return {
    estimateCents: Math.round(mean),
    low: Math.min(...w),
    high: Math.max(...w),
    cv: Number.isFinite(cv) ? cv : 1,
  };
}

/**
 * Confidence (0..1) that a detected vendor gap is a real missed accrual. Rewards a
 * regular cadence, a deep history, stable amounts, and an interior (resumed-after-
 * skip) gap; floors and ceils so no single input can drive it to certainty. Pure &
 * monotonic in each input.
 */
export function accrualConfidence(
  input: { regularity: number; occurrences: number; cv: number; gapType: GapType },
  thresholds: typeof ACCRUAL_THRESHOLDS = ACCRUAL_THRESHOLDS,
): number {
  const { confidenceFloor: floor, confidenceCeil: ceil, minRegularity } = thresholds;
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

  const regContrib = clamp01((input.regularity - minRegularity) / (1 - minRegularity)) * 0.2;
  const depthContrib = clamp01(Math.min(input.occurrences, 6) / 6) * 0.1;
  const stabilityContrib = clamp01(1 - Math.min(input.cv, 1)) * 0.1;
  const interiorBonus = input.gapType === 'interior' ? 0.05 : 0;

  const raw = floor + regContrib + depthContrib + stabilityContrib + interiorBonus;
  return Math.max(floor, Math.min(ceil, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor recurrence assessment (pure orchestration of the helpers above)
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorBill {
  period: string; // 'YYYY-MM'
  amountCents: number;
}

export interface AccrualAssessment {
  gapType: Exclude<GapType, 'none'>;
  intervalMonths: number;
  regularity: number;
  occurrences: number;
  estimateCents: number;
  low: number;
  high: number;
  cv: number;
  confidence: number; // 0..1, pre-clamp
}

/**
 * Assess whether `targetPeriod` is a missed accrual for a vendor given its bill
 * history. Returns null when the vendor isn't recurring, or the target is already
 * billed, or the gap is too speculative to surface. Pure — no I/O, no clock.
 */
export function assessVendorRecurrence(
  bills: VendorBill[],
  targetPeriod: string,
  thresholds: typeof ACCRUAL_THRESHOLDS = ACCRUAL_THRESHOLDS,
): AccrualAssessment | null {
  const targetIdx = periodToIndex(targetPeriod);
  if (targetIdx == null) return null;

  // Sum bills per period, keep only datable ones, bound to the lookback window.
  const perPeriod = new Map<number, number>();
  for (const b of bills) {
    const idx = periodToIndex(b.period);
    if (idx == null) continue;
    if (Math.abs(idx - targetIdx) > thresholds.lookbackMonths) continue;
    perPeriod.set(idx, (perPeriod.get(idx) ?? 0) + (Math.abs(Number(b.amountCents) || 0)));
  }
  const billedIdx = [...perPeriod.keys()].sort((a, b) => a - b);

  const cadence = detectCadence(billedIdx, thresholds);
  if (!cadence) return null;

  const gapType = classifyGap(billedIdx, targetIdx, cadence.intervalMonths);
  if (gapType === 'none') return null;

  // Estimate from the billed periods BEFORE the target (chronological).
  const priorIdx = billedIdx.filter((i) => i < targetIdx);
  const amountsChrono = priorIdx.map((i) => perPeriod.get(i) ?? 0);
  const est = estimateAccrual(amountsChrono, thresholds.estimateWindow);

  const confidence = accrualConfidence(
    { regularity: cadence.regularity, occurrences: cadence.occurrences, cv: est.cv, gapType },
    thresholds,
  );

  return {
    gapType,
    intervalMonths: cadence.intervalMonths,
    regularity: cadence.regularity,
    occurrences: cadence.occurrences,
    estimateCents: est.estimateCents,
    low: est.low,
    high: est.high,
    cv: est.cv,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configured-recurrence gap checks (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecurringTemplateRow {
  frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
  start_date: string;
  end_date: string | null;
  is_active: boolean;
  last_generated_at: string | null;
}

/**
 * True when an active recurring template is DUE for `targetPeriod` (frequency-
 * aligned to its start, within its date span) but has not been generated up through
 * that period. Pure.
 */
export function templateDueForPeriod(tpl: RecurringTemplateRow, targetPeriod: string): boolean {
  if (!tpl.is_active) return false;
  const targetIdx = periodToIndex(targetPeriod);
  const startIdx = periodToIndex(periodOf(tpl.start_date));
  if (targetIdx == null || startIdx == null) return false;
  if (targetIdx < startIdx) return false; // not started yet

  const endIdx = tpl.end_date ? periodToIndex(periodOf(tpl.end_date)) : null;
  if (endIdx != null && targetIdx > endIdx) return false; // past its span

  // Frequency alignment relative to the start period.
  const step = tpl.frequency === 'MONTHLY' ? 1 : tpl.frequency === 'QUARTERLY' ? 3 : 12;
  if ((targetIdx - startIdx) % step !== 0) return false; // this period isn't a scheduled run

  // Missed = never generated, or last generated in a period before the target.
  const lastGenIdx = tpl.last_generated_at ? periodToIndex(periodOf(tpl.last_generated_at)) : null;
  return lastGenIdx == null || lastGenIdx < targetIdx;
}

export interface PostingScheduleRow {
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  start_date: string;
  months: number;
}

/**
 * True when an active straight-line posting schedule should have a run in
 * `targetPeriod` (within [start, start+months-1]) but `hasRun` is false. Pure — the
 * caller supplies whether a posting_schedule_runs row exists for the period.
 */
export function scheduleDueForPeriod(
  sch: PostingScheduleRow,
  targetPeriod: string,
  hasRun: boolean,
): boolean {
  if (sch.status !== 'ACTIVE') return false;
  if (hasRun) return false;
  const targetIdx = periodToIndex(targetPeriod);
  const startIdx = periodToIndex(periodOf(sch.start_date));
  if (targetIdx == null || startIdx == null) return false;
  const months = Number(sch.months) || 0;
  if (months <= 0) return false;
  return targetIdx >= startIdx && targetIdx <= startIdx + months - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — EC-2 is a REVIEW control (an estimate is judgment); a control never
// auto-suppresses. Only a very large missed accrual escalates (covenant risk).
// ─────────────────────────────────────────────────────────────────────────────
export function resolveAccrualTier(
  amountAtRiskCents: number,
  confidence: number,
  policy: TierPolicy,
  escalateAtRiskCents: number = ACCRUAL_THRESHOLDS.escalateAtRiskCents,
): Tier {
  if (amountAtRiskCents >= escalateAtRiskCents) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafted remediation (never auto-applied — canon §3)
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftJeLine {
  account_id: string | null;
  account_role: string; // human-readable role, since accounts are referenced by role not number
  account_name: string | null;
  debit_cents: number;
  credit_cents: number;
  memo: string;
}

export interface AccrualRemediation {
  type: 'ACCRUAL_JE' | 'RECURRING_TEMPLATE_GENERATE' | 'SCHEDULE_RUN_POST';
  reversing: boolean;
  post_period: string;
  amount_cents: number;
  lines: DraftJeLine[];
  /** the accounting shown so the human approves the reasoning, not a black box. */
  note: string;
  /** the source object to act on (template/schedule id), when applicable. */
  source_ref?: { table: string; id: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccrualBucket {
  dedupKey: string;
  kind: AccrualKind;
  subjectId: string;
  subjectTable: string;
  locationId: string | null;
  period: string;
  amountAtRiskCents: number;
  confidence: number; // 0..1 pre-clamp
  tier: Tier;
  title: string;
  reason: string;
  question: string;
  subjectIds: string[];
  remediation: AccrualRemediation;
}

export interface AccrualScanSummary {
  targetPeriod: string;
  scanned: { vendors: number; bills: number; templates: number; schedules: number };
  buckets: number;
  byKind: Record<AccrualKind, number>;
  byTier: Record<Tier, number>;
  queued: number;
  refreshed: number;
  expired: number;
  totalAtRiskCents: number;
  errors: number;
  accruals: Array<{
    kind: AccrualKind;
    subjectId: string;
    period: string;
    amountAtRiskCents: number;
    tier: Tier;
    title: string;
  }>;
}

export interface AccrualScanOptions {
  /** injectable clock for deterministic tests; defaults to now. */
  asOfISO?: string;
  /** the period being closed ('YYYY-MM'); defaults to the month before asOf. */
  period?: string;
  /** compute + return the gaps WITHOUT persisting any exception rows. */
  dryRun?: boolean;
}

interface AccountRef {
  id: string;
  number: string | null;
  name: string;
  type: string;
}

const ACCRUED_LIABILITY_RE = /accru|accrued expense|accrued liab/i;

/**
 * Scan the ledger for EC-2 missed accruals for the target close period, queue /
 * refresh the exceptions into /exceptions (PROPOSED ai_decisions, feature
 * 'MISSED_ACCRUAL'), and return a summary. Never throws. Reads/writes run through
 * the RLS-scoped client; org isolation is enforced by the database, never by
 * hand-filtering org_id.
 */
export async function scanMissedAccruals(
  supabase: SupabaseClient,
  orgId: string,
  opts: AccrualScanOptions = {},
): Promise<AccrualScanSummary> {
  const asOfISO = opts.asOfISO ?? new Date().toISOString();
  const asOfPeriod = periodOf(asOfISO) ?? indexToPeriod(0);
  const targetPeriod = opts.period ?? previousPeriod(asOfPeriod) ?? asOfPeriod;

  const summary: AccrualScanSummary = {
    targetPeriod,
    scanned: { vendors: 0, bills: 0, templates: 0, schedules: 0 },
    buckets: 0,
    byKind: { vendor_recurrence: 0, recurring_template: 0, scheduled_deferral: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    queued: 0,
    refreshed: 0,
    expired: 0,
    totalAtRiskCents: 0,
    errors: 0,
    accruals: [],
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // Autonomy Control Plane: kill-switch + per-feature dial, resolved once; the
  // ADVISORY disposition is recorded on each queued exception (detect-only).
  const gov: AutonomyGovernance = await loadAutonomyGovernance(
    supabase,
    orgId,
    MISSED_ACCRUAL_FEATURE,
  );

  // Chart of accounts (for role-resolving the expense + accrued-liability legs).
  const acctById = new Map<string, AccountRef>();
  let accruedLiability: AccountRef | null = null;
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id, account_number, name, account_type');
    for (const a of (data ?? []) as Array<{
      id: string;
      account_number: string | null;
      name: string;
      account_type: string;
    }>) {
      const ref: AccountRef = { id: a.id, number: a.account_number, name: a.name, type: a.account_type };
      acctById.set(a.id, ref);
      if (!accruedLiability && a.account_type === 'LIABILITY' && ACCRUED_LIABILITY_RE.test(a.name)) {
        accruedLiability = ref;
      }
    }
  } catch (e) {
    console.warn('[controls/accruals] accounts load threw:', e instanceof Error ? e.message : e);
  }

  const buckets: AccrualBucket[] = [];

  // ── Signal A — vendor recurrence gap (the owned-ledger "absent bill" catch) ──
  try {
    const { data: billsRaw, error } = await supabase
      .from('bills')
      .select('id, vendor_id, location_id, bill_date, total_cents, status')
      .neq('status', 'VOIDED')
      .order('bill_date', { ascending: true })
      .limit(8000);
    if (error) {
      console.warn('[controls/accruals] bills load failed:', error.message);
    } else {
      const bills = (billsRaw ?? []) as Array<{
        id: string;
        vendor_id: string | null;
        location_id: string | null;
        bill_date: string | null;
        total_cents: number | string | null;
      }>;
      summary.scanned.bills = bills.length;

      // Group by vendor.
      const byVendor = new Map<
        string,
        { bills: VendorBill[]; ids: string[]; locCount: Map<string, number> }
      >();
      for (const b of bills) {
        if (!b.vendor_id) continue;
        const period = periodOf(b.bill_date);
        if (!period) continue;
        const g = byVendor.get(b.vendor_id) ?? { bills: [], ids: [], locCount: new Map() };
        g.bills.push({ period, amountCents: Number(b.total_cents) || 0 });
        g.ids.push(b.id);
        if (b.location_id) g.locCount.set(b.location_id, (g.locCount.get(b.location_id) ?? 0) + 1);
        byVendor.set(b.vendor_id, g);
      }
      summary.scanned.vendors = byVendor.size;

      // Vendor names + default expense accounts (core master data).
      const vendorMeta = new Map<string, { name: string; defaultAccountId: string | null }>();
      const vendorIds = [...byVendor.keys()];
      if (vendorIds.length > 0) {
        try {
          const { data: vRaw } = await supabase
            .schema('core')
            .from('vendors')
            .select('id, name, display_name, default_account_id')
            .in('id', vendorIds.slice(0, 2000));
          for (const v of (vRaw ?? []) as Array<{
            id: string;
            name: string;
            display_name: string | null;
            default_account_id: string | null;
          }>) {
            vendorMeta.set(v.id, {
              name: v.display_name || v.name,
              defaultAccountId: v.default_account_id,
            });
          }
        } catch {
          /* names are best-effort; the gap still surfaces with the vendor id */
        }
      }

      for (const [vendorId, g] of byVendor) {
        const assessment = assessVendorRecurrence(g.bills, targetPeriod);
        if (!assessment) continue;

        const meta = vendorMeta.get(vendorId);
        const vendorName = meta?.name ?? 'Vendor';
        const expenseAcct = meta?.defaultAccountId ? acctById.get(meta.defaultAccountId) ?? null : null;
        // Modal location among this vendor's bills.
        let locationId: string | null = null;
        let locBest = 0;
        for (const [loc, c] of g.locCount) {
          if (c > locBest) {
            locBest = c;
            locationId = loc;
          }
        }

        const est = assessment.estimateCents;
        const tier = resolveAccrualTier(est, assessment.confidence, policy);
        const cadenceWord =
          assessment.intervalMonths === 1 ? 'monthly' : assessment.intervalMonths === 3 ? 'quarterly' : `every ${assessment.intervalMonths} months`;
        const rangeNote = assessment.low === assessment.high ? '' : ` (range ${formatMoney(assessment.low)}–${formatMoney(assessment.high)})`;
        const gapWord = assessment.gapType === 'interior' ? 'skipped mid-stream' : 'no bill received yet';

        const title = `${vendorName} — ${cadenceWord} bill missing for ${targetPeriod} · ~${formatMoney(est)} likely un-accrued`;
        const reason =
          `${vendorName} has billed ${cadenceWord} in ${assessment.occurrences} of the last ${ACCRUAL_THRESHOLDS.lookbackMonths} months ` +
          `(regularity ${(assessment.regularity * 100).toFixed(0)}%), but ${targetPeriod} has no bill (${gapWord}). ` +
          `Run-rate estimate ${formatMoney(est)}${rangeNote}. This is a likely missed accrual — the period's expense is understated ` +
          `until it is accrued. Draft: DR ${expenseAcct?.name ?? 'the recurring expense account'} / CR ${accruedLiability?.name ?? 'Accrued Liabilities'} ${formatMoney(est)} (reversing next period).`;

        const remediation: AccrualRemediation = {
          type: 'ACCRUAL_JE',
          reversing: true,
          post_period: targetPeriod,
          amount_cents: est,
          lines: [
            {
              account_id: expenseAcct?.id ?? null,
              account_role: 'RECURRING_EXPENSE',
              account_name: expenseAcct?.name ?? null,
              debit_cents: est,
              credit_cents: 0,
              memo: `Accrue ${vendorName} — ${targetPeriod} (run-rate estimate)`,
            },
            {
              account_id: accruedLiability?.id ?? null,
              account_role: 'ACCRUED_LIABILITIES',
              account_name: accruedLiability?.name ?? null,
              debit_cents: 0,
              credit_cents: est,
              memo: `Accrued ${vendorName} — ${targetPeriod}`,
            },
          ],
          note:
            'Draft only — confirm the run-rate estimate and the accrued-liability account, then post through the engine (it reverses next period when the actual bill lands).' +
            (expenseAcct ? '' : ' No default expense account is set for this vendor — select one before posting.') +
            (accruedLiability ? '' : ' No accrued-liability account was found in the COA — select one before posting.'),
          source_ref: { table: 'vendors', id: vendorId },
        };

        buckets.push({
          dedupKey: dedupKey('vendor_recurrence', vendorId, targetPeriod),
          kind: 'vendor_recurrence',
          subjectId: vendorId,
          subjectTable: 'vendors',
          locationId,
          period: targetPeriod,
          amountAtRiskCents: est,
          confidence: assessment.confidence,
          tier,
          title,
          reason,
          question:
            'Book this run-rate accrual (reversing next period), adjust the estimate, or confirm no accrual is needed for this period?',
          subjectIds: g.ids.slice(0, ACCRUAL_THRESHOLDS.maxSubjectsPerBucket),
          remediation,
        });
      }
    }
  } catch (e) {
    console.warn('[controls/accruals] vendor scan threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
  }

  // ── Signal B — recurring template due but not generated ──────────────────────
  try {
    const { data, error } = await supabase
      .from('recurring_templates')
      .select('id, name, frequency, start_date, end_date, is_active, last_generated_at, template_lines, location_id')
      .eq('is_active', true)
      .limit(2000);
    if (error) {
      console.warn('[controls/accruals] templates load failed:', error.message);
    } else {
      const rows = (data ?? []) as Array<{
        id: string;
        name: string | null;
        frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
        start_date: string;
        end_date: string | null;
        is_active: boolean;
        last_generated_at: string | null;
        template_lines: Array<{ account_id?: string; debit_cents?: number | string; credit_cents?: number | string }> | null;
        location_id: string | null;
      }>;
      summary.scanned.templates = rows.length;

      for (const t of rows) {
        if (!templateDueForPeriod(t, targetPeriod)) continue;
        const lines = Array.isArray(t.template_lines) ? t.template_lines : [];
        const amount = lines.reduce((s, l) => s + (Number(l.debit_cents) || 0), 0);
        if (amount <= 0) continue; // nothing quantifiable to accrue
        const tier = resolveAccrualTier(amount, ACCRUAL_THRESHOLDS.configuredConfidence, policy);
        const name = t.name || 'Recurring entry';
        const title = `${name} — ${t.frequency.toLowerCase()} entry not generated for ${targetPeriod} · ${formatMoney(amount)}`;
        const reason =
          `The recurring template "${name}" (${t.frequency.toLowerCase()}) is due for ${targetPeriod} but was never generated ` +
          `(last generated ${t.last_generated_at ? periodOf(t.last_generated_at) : 'never'}). Its configured entry totals ${formatMoney(amount)}. ` +
          `Generate it so the recurring activity hits the ledger this period.`;
        buckets.push({
          dedupKey: dedupKey('recurring_template', t.id, targetPeriod),
          kind: 'recurring_template',
          subjectId: t.id,
          subjectTable: 'recurring_templates',
          locationId: t.location_id,
          period: targetPeriod,
          amountAtRiskCents: amount,
          confidence: ACCRUAL_THRESHOLDS.configuredConfidence,
          tier,
          title,
          reason,
          question: 'Generate this recurring entry for the period, or confirm it is intentionally skipped?',
          subjectIds: [t.id],
          remediation: {
            type: 'RECURRING_TEMPLATE_GENERATE',
            reversing: false,
            post_period: targetPeriod,
            amount_cents: amount,
            lines: lines.map((l) => ({
              account_id: l.account_id ?? null,
              account_role: 'TEMPLATE_LINE',
              account_name: l.account_id ? acctById.get(l.account_id)?.name ?? null : null,
              debit_cents: Number(l.debit_cents) || 0,
              credit_cents: Number(l.credit_cents) || 0,
              memo: `${name} — ${targetPeriod}`,
            })),
            note: 'Draft only — generate the template through the recurring-entry engine after confirming the period.',
            source_ref: { table: 'recurring_templates', id: t.id },
          },
        });
      }
    }
  } catch (e) {
    console.warn('[controls/accruals] template scan threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
  }

  // ── Signal C — scheduled amortization / deferral run missing for the period ──
  try {
    const targetIdx = periodToIndex(targetPeriod);
    const py = targetIdx != null ? Math.floor(targetIdx / 12) : null;
    const pm = targetIdx != null ? (targetIdx % 12) + 1 : null;

    const { data, error } = await supabase
      .from('posting_schedules')
      .select('id, schedule_type, status, start_date, months, amount_per_period_cents, debit_account_id, credit_account_id, location_id, memo')
      .eq('status', 'ACTIVE')
      .limit(2000);
    if (error) {
      console.warn('[controls/accruals] schedules load failed:', error.message);
    } else {
      const rows = (data ?? []) as Array<{
        id: string;
        schedule_type: string;
        status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
        start_date: string;
        months: number;
        amount_per_period_cents: number | string;
        debit_account_id: string;
        credit_account_id: string;
        location_id: string | null;
        memo: string | null;
      }>;
      summary.scanned.schedules = rows.length;

      // Which schedules already have a run for the target period?
      const runSet = new Set<string>();
      if (rows.length > 0 && py != null && pm != null) {
        try {
          const { data: runs } = await supabase
            .from('posting_schedule_runs')
            .select('schedule_id')
            .eq('period_year', py)
            .eq('period_month', pm)
            .in('schedule_id', rows.map((r) => r.id).slice(0, 2000));
          for (const r of (runs ?? []) as Array<{ schedule_id: string }>) runSet.add(r.schedule_id);
        } catch {
          /* best-effort — worst case we flag a schedule that was actually posted */
        }
      }

      for (const s of rows) {
        const hasRun = runSet.has(s.id);
        if (!scheduleDueForPeriod(s, targetPeriod, hasRun)) continue;
        const amount = Number(s.amount_per_period_cents) || 0;
        if (amount <= 0) continue;
        const tier = resolveAccrualTier(amount, ACCRUAL_THRESHOLDS.configuredConfidence, policy);
        const label = s.schedule_type.replace(/_/g, ' ').toLowerCase();
        const drAcct = acctById.get(s.debit_account_id);
        const crAcct = acctById.get(s.credit_account_id);
        const title = `${label} not posted for ${targetPeriod} · ${formatMoney(amount)}`;
        const reason =
          `An active ${label} schedule should post ${formatMoney(amount)} for ${targetPeriod} but has no run recorded. ` +
          `Draft: DR ${drAcct?.name ?? 'debit account'} / CR ${crAcct?.name ?? 'credit account'} ${formatMoney(amount)}. ` +
          `Post it so the period's ${label} is recognized.`;
        buckets.push({
          dedupKey: dedupKey('scheduled_deferral', s.id, targetPeriod),
          kind: 'scheduled_deferral',
          subjectId: s.id,
          subjectTable: 'posting_schedules',
          locationId: s.location_id,
          period: targetPeriod,
          amountAtRiskCents: amount,
          confidence: ACCRUAL_THRESHOLDS.configuredConfidence,
          tier,
          title,
          reason,
          question: 'Post this scheduled amortization/deferral for the period, or confirm it is intentionally deferred?',
          subjectIds: [s.id],
          remediation: {
            type: 'SCHEDULE_RUN_POST',
            reversing: false,
            post_period: targetPeriod,
            amount_cents: amount,
            lines: [
              {
                account_id: s.debit_account_id,
                account_role: 'SCHEDULE_DEBIT',
                account_name: drAcct?.name ?? null,
                debit_cents: amount,
                credit_cents: 0,
                memo: s.memo ?? `${label} — ${targetPeriod}`,
              },
              {
                account_id: s.credit_account_id,
                account_role: 'SCHEDULE_CREDIT',
                account_name: crAcct?.name ?? null,
                debit_cents: 0,
                credit_cents: amount,
                memo: s.memo ?? `${label} — ${targetPeriod}`,
              },
            ],
            note: 'Draft only — post the schedule run through the posting engine after confirming the period.',
            source_ref: { table: 'posting_schedules', id: s.id },
          },
        });
      }
    }
  } catch (e) {
    console.warn('[controls/accruals] schedule scan threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
  }

  // Highest $-at-risk first — the operator sees the biggest hole in the close top.
  buckets.sort((a, b) => b.amountAtRiskCents - a.amountAtRiskCents);
  summary.buckets = buckets.length;
  for (const b of buckets) {
    summary.byKind[b.kind] += 1;
    summary.totalAtRiskCents += b.amountAtRiskCents;
    summary.accruals.push({
      kind: b.kind,
      subjectId: b.subjectId,
      period: b.period,
      amountAtRiskCents: b.amountAtRiskCents,
      tier: b.tier,
      title: b.title,
    });
  }

  if (opts.dryRun) return summary;

  // ── Idempotency: load existing MISSED_ACCRUAL rows keyed by dedup_key ────────
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', MISSED_ACCRUAL_FEATURE)
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
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: b.tier,
      amountCents: b.amountAtRiskCents,
    });
    const proposedOutput = {
      control: 'EC-2',
      kind: b.kind,
      dedup_key: b.dedupKey,
      period: b.period,
      subject_table: b.subjectTable,
      subject_id: b.subjectId,
      amount_at_risk_cents: b.amountAtRiskCents,
      tier: b.tier,
      disposition,
      subject_ids: b.subjectIds,
      remediation: b.remediation,
      reason: b.reason,
    };

    const prior = existing.get(b.dedupKey);
    // A human already dispositioned this gap — do not resurface it.
    if (prior && (prior.status === 'APPROVED' || prior.status === 'REJECTED')) continue;

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
        console.warn('[controls/accruals] refresh failed:', error.message);
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
      feature: MISSED_ACCRUAL_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: b.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/accruals] could not queue exception:', error.message);
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
      action: 'controls.missed_accrual.detect',
      subjectTable: b.subjectTable,
      subjectId: b.subjectId,
      summary: b.title,
      locationId: b.locationId,
      confidence,
      tier: b.tier,
      metadata: {
        kind: b.kind,
        dedup_key: b.dedupKey,
        period: b.period,
        amount_at_risk_cents: b.amountAtRiskCents,
      },
    });
  }

  // ── Expire previously-open gaps that have since been closed (queue hygiene) ──
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
