/**
 * Financial Control Exception EC-6 — Revenue not recognized on schedule.
 *
 * The book of record owns rev-rec (canon §3: method-per-job, 9 methods; `rev-rec.ts`
 * is the authority — the posting engine delegates timing to it). Revenue that is
 * EARNED but not yet RECOGNIZED is an ASC 606 misstatement: the period's income is
 * understated, deferred revenue (2410) sits overstated on the balance sheet, and if
 * it slips a close it becomes a restatement. Because MeritBooks holds the contract
 * inputs (contract value, cost estimate, actual cost, pct-complete, resolved method)
 * AND the GL, it can see this drift a bolt-on can't. This control DETECTS the gap and
 * DRAFTS the release entry (DR Deferred Revenue 2410 / CR Revenue) for a human — with
 * the right role, SoD — to review and post through the deterministic engine. It NEVER
 * posts: the rev-rec engine (or a human) books the recognition (canon §3).
 *
 * Three detection signals (all "earned this period but not recognized"):
 *   A. schedule       — a DEFERRED_REVENUE posting_schedule whose straight-line
 *                       recognition run for the target period is MISSING from
 *                       posting_schedule_runs (DR 2410 / CR Revenue never posted).
 *                       Near-certain by construction (the schedule is the promise).
 *   B. job_progress   — an in-progress POC / percentage-complete job whose
 *                       earned-to-date (contract × cost-to-cost, or × pct_complete,
 *                       per the RESOLVED method) exceeds recognized-to-date on the
 *                       GL by a MATERIAL amount for the period. The earned figure is
 *                       computed by the rev-rec engine's own `earnedToDate` — this
 *                       control never re-implements the 9-method math.
 *   C. completed_job  — a COMPLETE/CLOSED job whose performance obligation is
 *                       satisfied (fully earned = contract) but whose recognized
 *                       revenue is still short, and/or which still carries a residual
 *                       Deferred Revenue (2410) balance that was never released.
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each gap is
 * written as a PROPOSED row in public.ai_decisions with feature
 * 'REVENUE_NOT_RECOGNIZED'. The existing /exceptions route already folds PROPOSED
 * ai_decisions in as an `ai_proposal` source — mirrors EC-1/EC-2/EC-4/EC-10 exactly.
 * No aggregator change, no schema change, no new table.
 *
 * Idempotency: each gap carries a stable `dedup_key`
 * (`revrec:<kind>:<subjectId>:<period>`) in proposed_output, so a re-scan UPDATES the
 * open exception rather than duplicating it (migration 070 makes the DB the
 * guarantor: one open PROPOSED row per (org, feature, dedup_key)), leaves
 * human-resolved (APPROVED/REJECTED) rows untouched, and EXPIRES rows whose gap has
 * since been recognized.
 *
 * The pure math (`earnedRecognizedGap`, `isMaterial`, `pocConfidence`,
 * `resolveRevRecTier`, `scheduleRunDueForPeriod`, period helpers) is I/O-free and
 * unit-tested. `scanRevenueNotRecognized` does the RLS-scoped reads/writes and never
 * throws — a control must not break the pass it rides on.
 *
 * All money is bigint cents. EC-6 is fundamentally a REVIEW control (recognition
 * timing is judgment); a gap ESCALATEs when the target period is closing/closed
 * (SOFT_CLOSE/HARD_CLOSE — the window to fix it cleanly is shutting), when the amount
 * is very large, or when a COMPLETED job's revenue is materially unrecognized (a
 * clear misstatement). Accounts are role-resolved (Deferred Revenue 2410, the job's
 * revenue account), never invented (canon §2).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  earnedToDate,
  resolveRevRecMethod,
  type JobRevRecRow,
  type RevRecMethod,
} from '@/lib/services/rev-rec';
import { recognizesAtBilling } from '@/lib/posting/rev-rec-method';
import { formatMoney } from '@meritbooks/shared';

export const REVENUE_NOT_RECOGNIZED_FEATURE = 'REVENUE_NOT_RECOGNIZED';

/** Deferred Revenue (billings in excess) — the account we release FROM. */
const DEFERRED_ACCT = '2410';

export type RevRecKind = 'schedule' | 'job_progress' | 'completed_job';

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const REVREC_THRESHOLDS = {
  /** absolute $ floor: below this an under-recognition is noise, not a finding. */
  materialFloorCents: 100_000, // $1,000
  /** …or this fraction of the contract, whichever is larger (scales with size). */
  materialFraction: 0.01, // 1% of contract
  /** an under-recognition at/above this ESCALATEs (restatement-scale). */
  escalateAtRiskCents: 10_000_000, // $100,000
  /** a configured deferred-revenue schedule run is near-certain by construction. */
  configuredConfidence: 0.9,
  /** a completed job's satisfied obligation is a clear-cut recognition event. */
  completedConfidence: 0.88,
  /** confidence bounds for a detected POC earned-vs-recognized gap. */
  pocFloor: 0.6,
  pocCeil: 0.9,
  /** cap subject ids persisted per exception (jsonb size guard). */
  maxSubjectsPerBucket: 250,
} as const;

const KIND_LABEL: Record<RevRecKind, string> = {
  schedule: 'Deferred-revenue release not posted',
  job_progress: 'Earned revenue not yet recognized (progress)',
  completed_job: 'Completed job — revenue not fully recognized',
};

// ─────────────────────────────────────────────────────────────────────────────
// Period math (pure). Periods are 'YYYY-MM'; an "index" is months since year 0
// (year*12 + month-1) so arithmetic is trivial and off-by-one-free.
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

/** last calendar day of a 'YYYY-MM' period as 'YYYY-MM-DD' (the rev-rec asOf). */
export function periodEndDate(period: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of m
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(
    last.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Deterministic, stable dedup key for a rev-rec gap. */
export function dedupKey(kind: RevRecKind, subjectId: string, period: string): string {
  return `revrec:${kind}:${subjectId}:${period}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Earned-vs-recognized gap + materiality + confidence (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The under-recognition for a period: how much MORE revenue is earned-to-date than
 * has been recognized-to-date. Never negative — over-recognition is a different
 * exception class (EC-6 is "not recognized", not "over-recognized"). Pure.
 */
export function earnedRecognizedGap(earnedToDateCents: number, recognizedToDateCents: number): number {
  const gap = Math.round((Number(earnedToDateCents) || 0) - (Number(recognizedToDateCents) || 0));
  return gap > 0 ? gap : 0;
}

/**
 * Is an under-recognition material? Above an absolute $ floor OR above a fraction of
 * the contract, whichever is larger — so a small rounding delta on a huge contract
 * doesn't cry wolf, while a small contract still trips on an absolute dollar floor.
 * Pure.
 */
export function isMaterial(
  underCents: number,
  contractCents: number,
  thresholds: typeof REVREC_THRESHOLDS = REVREC_THRESHOLDS,
): boolean {
  if (underCents <= 0) return false;
  const fractional = Math.abs(Number(contractCents) || 0) * thresholds.materialFraction;
  const threshold = Math.max(thresholds.materialFloorCents, fractional);
  return underCents >= threshold;
}

/**
 * Confidence (0..1) that a detected POC earned-vs-recognized gap is a real missed
 * recognition. Rewards a larger relative gap (a big earned/recognized divergence is
 * unambiguous) and complete inputs; floors/ceils so no single input drives certainty.
 * Pure & monotonic. `hasInputs` is false when the method's drivers are missing
 * (e.g. PCT_COSTS_INCURRED with a zero cost estimate) — then the caller should skip.
 */
export function pocConfidence(
  input: { underCents: number; contractCents: number; hasInputs: boolean },
  thresholds: typeof REVREC_THRESHOLDS = REVREC_THRESHOLDS,
): number {
  if (!input.hasInputs) return 0;
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const contract = Math.abs(Number(input.contractCents) || 0);
  const gapFraction = contract > 0 ? clamp01(input.underCents / contract) : 0.5;
  // a gap that is >=20% of the contract is a strong signal; ramp to the ceiling.
  const raw = thresholds.pocFloor + clamp01(gapFraction / 0.2) * (thresholds.pocCeil - thresholds.pocFloor);
  return Math.max(thresholds.pocFloor, Math.min(thresholds.pocCeil, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule gap (pure, unit-tested) — mirrors the schedule-run ledger semantics
// ─────────────────────────────────────────────────────────────────────────────

export interface DeferredScheduleRow {
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  start_date: string;
  months: number;
}

/**
 * True when an ACTIVE deferred-revenue schedule should have a recognition run in
 * `targetPeriod` (within [start, start+months-1]) but `hasRun` is false. Pure — the
 * caller supplies whether a posting_schedule_runs row exists for the period.
 */
export function scheduleRunDueForPeriod(
  sch: DeferredScheduleRow,
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
// Tiering — EC-6 is a REVIEW control; escalate on a closing/closed period, a very
// large amount, or a completed-job misstatement. A control never auto-suppresses.
// ─────────────────────────────────────────────────────────────────────────────

export function resolveRevRecTier(
  amountAtRiskCents: number,
  confidence: number,
  policy: TierPolicy,
  opts: { periodStatus?: PeriodStatus | null; forceEscalate?: boolean } = {},
  escalateAtRiskCents: number = REVREC_THRESHOLDS.escalateAtRiskCents,
): Tier {
  if (opts.forceEscalate) return 'escalate';
  if (opts.periodStatus === 'SOFT_CLOSE' || opts.periodStatus === 'HARD_CLOSE') return 'escalate';
  if (amountAtRiskCents >= escalateAtRiskCents) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafted remediation (never auto-applied — canon §3)
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftJeLine {
  account_id: string | null;
  account_role: string; // role, since accounts are referenced by role not number
  account_name: string | null;
  debit_cents: number;
  credit_cents: number;
  memo: string;
}

export interface RevRecRemediation {
  type: 'RECOGNITION_JE' | 'SCHEDULE_RUN_POST';
  post_period: string;
  amount_cents: number;
  lines: DraftJeLine[];
  /** the accounting shown so the human approves the reasoning, not a black box. */
  note: string;
  /** the source object to act on (job/schedule id). */
  source_ref?: { table: string; id: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

export interface RevRecBucket {
  dedupKey: string;
  kind: RevRecKind;
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
  remediation: RevRecRemediation;
}

export interface RevRecScanSummary {
  targetPeriod: string;
  asOfDate: string;
  scanned: { schedules: number; jobs: number };
  buckets: number;
  byKind: Record<RevRecKind, number>;
  byTier: Record<Tier, number>;
  queued: number;
  refreshed: number;
  expired: number;
  totalAtRiskCents: number;
  errors: number;
  findings: Array<{
    kind: RevRecKind;
    subjectId: string;
    period: string;
    amountAtRiskCents: number;
    tier: Tier;
    title: string;
  }>;
}

export interface RevRecScanOptions {
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

/**
 * Scan the ledger for EC-6 revenue that is earned but not recognized for the target
 * period, queue / refresh the exceptions into /exceptions (PROPOSED ai_decisions,
 * feature 'REVENUE_NOT_RECOGNIZED'), and return a summary. Never throws. Reads/writes
 * run through the RLS-scoped client; org isolation is enforced by the database, never
 * by hand-filtering org_id. Earned-to-date is computed by the rev-rec engine's own
 * `earnedToDate` — this control never re-implements the 9-method math.
 */
export async function scanRevenueNotRecognized(
  supabase: SupabaseClient,
  orgId: string,
  opts: RevRecScanOptions = {},
): Promise<RevRecScanSummary> {
  const asOfISO = opts.asOfISO ?? new Date().toISOString();
  const asOfPeriod = periodOf(asOfISO) ?? indexToPeriod(0);
  const targetPeriod = opts.period ?? previousPeriod(asOfPeriod) ?? asOfPeriod;
  const asOfDate = periodEndDate(targetPeriod) ?? `${targetPeriod}-28`;

  const summary: RevRecScanSummary = {
    targetPeriod,
    asOfDate,
    scanned: { schedules: 0, jobs: 0 },
    buckets: 0,
    byKind: { schedule: 0, job_progress: 0, completed_job: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    queued: 0,
    refreshed: 0,
    expired: 0,
    totalAtRiskCents: 0,
    errors: 0,
    findings: [],
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  const targetIdx = periodToIndex(targetPeriod);
  const py = targetIdx != null ? Math.floor(targetIdx / 12) : null;
  const pm = targetIdx != null ? (targetIdx % 12) + 1 : null;

  // Chart of accounts (role-resolve the deferred-revenue + revenue legs).
  const acctById = new Map<string, AccountRef>();
  let deferredAcct: AccountRef | null = null;
  let fallbackRevenue: AccountRef | null = null;
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id, account_number, name, account_type, is_active')
      .order('account_number', { ascending: true });
    for (const a of (data ?? []) as Array<{
      id: string;
      account_number: string | null;
      name: string;
      account_type: string;
      is_active: boolean | null;
    }>) {
      const ref: AccountRef = { id: a.id, number: a.account_number, name: a.name, type: a.account_type };
      acctById.set(a.id, ref);
      if (!deferredAcct && a.account_number === DEFERRED_ACCT) deferredAcct = ref;
      if (
        !fallbackRevenue &&
        a.account_type === 'REVENUE' &&
        a.is_active !== false &&
        /service|sales|contract|operating|revenue/i.test(a.name)
      ) {
        fallbackRevenue = ref;
      }
    }
    if (!fallbackRevenue) {
      for (const ref of acctById.values()) {
        if (ref.type === 'REVENUE') {
          fallbackRevenue = ref;
          break;
        }
      }
    }
  } catch (e) {
    console.warn('[controls/revrec] accounts load threw:', e instanceof Error ? e.message : e);
  }

  // Fiscal-period status per location for the target period (drives escalation).
  const periodStatusByLoc = new Map<string, PeriodStatus>();
  if (py != null && pm != null) {
    try {
      const { data } = await supabase
        .from('fiscal_periods')
        .select('location_id, status')
        .eq('period_year', py)
        .eq('period_month', pm);
      for (const r of (data ?? []) as Array<{ location_id: string; status: PeriodStatus }>) {
        periodStatusByLoc.set(r.location_id, r.status);
      }
    } catch {
      /* best-effort — absence just means we don't escalate on close status */
    }
  }
  const statusFor = (loc: string | null): PeriodStatus | null => (loc ? periodStatusByLoc.get(loc) ?? null : null);

  const buckets: RevRecBucket[] = [];

  // ── Signal A — deferred-revenue schedule run missing for the period ──────────
  try {
    const { data, error } = await supabase
      .from('posting_schedules')
      .select('id, schedule_type, status, start_date, months, amount_per_period_cents, debit_account_id, credit_account_id, location_id, memo')
      .eq('status', 'ACTIVE')
      .eq('schedule_type', 'DEFERRED_REVENUE')
      .limit(2000);
    if (error) {
      console.warn('[controls/revrec] schedules load failed:', error.message);
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

      // Which schedules already recognized for the target period?
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
          /* best-effort — worst case we flag a schedule already posted */
        }
      }

      for (const s of rows) {
        const hasRun = runSet.has(s.id);
        if (!scheduleRunDueForPeriod(s, targetPeriod, hasRun)) continue;
        const amount = Number(s.amount_per_period_cents) || 0;
        if (amount <= 0) continue;
        const drAcct = acctById.get(s.debit_account_id) ?? deferredAcct; // DR 2410
        const crAcct = acctById.get(s.credit_account_id) ?? fallbackRevenue; // CR Revenue
        const tier = resolveRevRecTier(amount, REVREC_THRESHOLDS.configuredConfidence, policy, {
          periodStatus: statusFor(s.location_id),
        });
        const title = `Deferred revenue not released for ${targetPeriod} · ${formatMoney(amount)}`;
        const reason =
          `An active deferred-revenue schedule should recognize ${formatMoney(amount)} for ${targetPeriod} ` +
          `but has no recognition run recorded. Revenue is understated and Deferred Revenue (2410) is overstated by ` +
          `${formatMoney(amount)} until it is released. Draft: DR ${drAcct?.name ?? 'Deferred Revenue (2410)'} / ` +
          `CR ${crAcct?.name ?? 'Revenue'} ${formatMoney(amount)}.`;
        buckets.push({
          dedupKey: dedupKey('schedule', s.id, targetPeriod),
          kind: 'schedule',
          subjectId: s.id,
          subjectTable: 'posting_schedules',
          locationId: s.location_id,
          period: targetPeriod,
          amountAtRiskCents: amount,
          confidence: REVREC_THRESHOLDS.configuredConfidence,
          tier,
          title,
          reason,
          question:
            'Post this deferred-revenue release for the period, or confirm recognition is intentionally deferred?',
          subjectIds: [s.id],
          remediation: {
            type: 'SCHEDULE_RUN_POST',
            post_period: targetPeriod,
            amount_cents: amount,
            lines: [
              {
                account_id: s.debit_account_id,
                account_role: 'DEFERRED_REVENUE',
                account_name: drAcct?.name ?? null,
                debit_cents: amount,
                credit_cents: 0,
                memo: s.memo ?? `Release deferred revenue — ${targetPeriod}`,
              },
              {
                account_id: s.credit_account_id,
                account_role: 'REVENUE',
                account_name: crAcct?.name ?? null,
                debit_cents: 0,
                credit_cents: amount,
                memo: s.memo ?? `Recognize revenue — ${targetPeriod}`,
              },
            ],
            note: 'Draft only — post the schedule run through the posting/rev-rec engine after confirming the period.',
            source_ref: { table: 'posting_schedules', id: s.id },
          },
        });
      }
    }
  } catch (e) {
    console.warn('[controls/revrec] schedule scan threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
  }

  // ── Signals B & C — job earned-vs-recognized (reuse the rev-rec engine math) ──
  try {
    const JOB_SELECT =
      'id, job_number, name, location_id, job_type, archetype, status, rev_rec_method, rev_rec_method_override, ' +
      'revenue_account_id, contract_amount_cents, estimated_cost_cents, actual_cost_cents, billed_to_date_cents, ' +
      'pct_complete, revenue_recognized_cents, service_start_date, service_end_date';
    const { data: jobsRaw, error } = await supabase
      .schema('core')
      .from('jobs')
      .select(JOB_SELECT)
      .eq('org_id', orgId)
      .in('status', ['ACTIVE', 'ON_HOLD', 'COMPLETE', 'CLOSED'])
      .limit(5000);
    if (error) {
      console.warn('[controls/revrec] jobs load failed:', error.message);
    } else {
      const jobs = (jobsRaw ?? []) as Array<
        JobRevRecRow & { id: string; job_number: string | null; name: string | null }
      >;
      summary.scanned.jobs = jobs.length;

      // Company defaults + per-company method maps (cache by location).
      const locIds = [...new Set(jobs.map((j) => j.location_id).filter(Boolean))];
      const defaultByLoc = new Map<string, RevRecMethod>();
      const jobTypeMapByLoc = new Map<string, Map<string, RevRecMethod>>();
      const revTypeMapByLoc = new Map<string, Map<string, RevRecMethod>>();
      for (const lid of locIds) {
        try {
          const { data: loc } = await supabase
            .schema('core')
            .from('locations')
            .select('rev_rec_method')
            .eq('id', lid)
            .maybeSingle();
          defaultByLoc.set(lid, ((loc as { rev_rec_method: RevRecMethod } | null)?.rev_rec_method ?? 'PCT_COSTS_INCURRED'));
        } catch {
          defaultByLoc.set(lid, 'PCT_COSTS_INCURRED');
        }
        try {
          const { data: jt } = await supabase
            .from('rev_rec_method_map')
            .select('job_type, method')
            .eq('org_id', orgId)
            .eq('location_id', lid);
          jobTypeMapByLoc.set(lid, new Map((jt ?? []).map((r) => [(r as { job_type: string }).job_type, (r as { method: RevRecMethod }).method])));
        } catch {
          jobTypeMapByLoc.set(lid, new Map());
        }
        try {
          const { data: rt } = await supabase
            .from('revenue_type_methods')
            .select('revenue_account_id, method')
            .eq('org_id', orgId)
            .eq('location_id', lid);
          revTypeMapByLoc.set(lid, new Map((rt ?? []).map((r) => [(r as { revenue_account_id: string }).revenue_account_id, (r as { method: RevRecMethod }).method])));
        } catch {
          revTypeMapByLoc.set(lid, new Map());
        }
      }

      // Resolve method for each job; collect CASH jobs + completed jobs for enrichment.
      const resolved = jobs.map((j) => ({
        job: j,
        method: resolveRevRecMethod(
          j,
          jobTypeMapByLoc.get(j.location_id) ?? new Map(),
          defaultByLoc.get(j.location_id) ?? 'PCT_COSTS_INCURRED',
          revTypeMapByLoc.get(j.location_id),
        ),
      }));

      // CASH earned-to-date needs collected cash per job (batched).
      const cashJobIds = resolved.filter((r) => r.method === 'CASH').map((r) => r.job.id);
      const collectedByJob = new Map<string, number>();
      if (cashJobIds.length > 0) {
        try {
          const { data: inv } = await supabase
            .from('invoices')
            .select('job_id, amount_paid_cents')
            .in('job_id', cashJobIds.slice(0, 2000));
          for (const r of (inv ?? []) as Array<{ job_id: string | null; amount_paid_cents: number | string | null }>) {
            if (!r.job_id) continue;
            collectedByJob.set(r.job_id, (collectedByJob.get(r.job_id) ?? 0) + (Number(r.amount_paid_cents) || 0));
          }
        } catch {
          /* best-effort — CASH jobs without collected data simply won't trip */
        }
      }

      // Residual Deferred Revenue (2410) balance per completed/closed job (batched).
      const doneJobIds = resolved
        .filter((r) => r.job.status === 'COMPLETE' || r.job.status === 'CLOSED')
        .map((r) => r.job.id);
      const deferredBalByJob = new Map<string, number>();
      if (doneJobIds.length > 0 && deferredAcct) {
        try {
          const { data: lines } = await supabase
            .from('gl_entry_lines')
            .select('job_id, debit_cents, credit_cents')
            .eq('account_id', deferredAcct.id)
            .in('job_id', doneJobIds.slice(0, 2000));
          for (const l of (lines ?? []) as Array<{ job_id: string | null; debit_cents: number | string; credit_cents: number | string }>) {
            if (!l.job_id) continue;
            const bal = (Number(l.credit_cents) || 0) - (Number(l.debit_cents) || 0);
            deferredBalByJob.set(l.job_id, (deferredBalByJob.get(l.job_id) ?? 0) + bal);
          }
        } catch {
          /* best-effort — residual balance only enriches the finding */
        }
      }

      for (const { job, method } of resolved) {
        // Billing-recognized methods (POINT_OF_SALE / AS_BILLED) can't have rev-rec
        // drift — billing IS recognition. Skip them entirely.
        if (recognizesAtBilling(method)) continue;

        const contract = Number(job.contract_amount_cents ?? 0);
        const recognized = Number(job.revenue_recognized_cents ?? 0);
        const done = job.status === 'COMPLETE' || job.status === 'CLOSED';
        const locStatus = statusFor(job.location_id);

        if (done) {
          // ── Signal C — completed obligation, revenue still short ──────────────
          // A satisfied performance obligation is fully earned = contract value.
          const earnedFull = contract;
          const under = earnedRecognizedGap(earnedFull, recognized);
          const residualDeferred = Math.max(0, deferredBalByJob.get(job.id) ?? 0);
          const atRisk = Math.max(under, residualDeferred);
          if (atRisk <= 0) continue;
          if (!isMaterial(atRisk, contract)) continue;

          const drawFromDeferred = Math.min(under > 0 ? under : residualDeferred, residualDeferred);
          const jobLabel = job.name || job.job_number || `Job ${job.id.slice(0, 8)}`;
          const title = `${jobLabel} completed — ${formatMoney(atRisk)} revenue not recognized`;
          const reason =
            `${jobLabel} is ${String(job.status).toLowerCase()} (${method}) — its performance obligation is satisfied, so all ` +
            `${formatMoney(contract)} of contract value should be recognized, but only ${formatMoney(recognized)} has been. ` +
            `${formatMoney(under)} of revenue is unrecognized` +
            (residualDeferred > 0 ? ` and ${formatMoney(residualDeferred)} of Deferred Revenue (2410) remains on this job un-released.` : '.') +
            ` Draft: DR Deferred Revenue (2410) / CR Revenue ${formatMoney(atRisk)} to close out the obligation.`;
          const remediation = draftRecognitionJe(
            targetPeriod,
            atRisk,
            drawFromDeferred,
            deferredAcct,
            resolveJobRevenue(job, acctById, fallbackRevenue),
            job,
          );
          buckets.push({
            dedupKey: dedupKey('completed_job', job.id, targetPeriod),
            kind: 'completed_job',
            subjectId: job.id,
            subjectTable: 'core.jobs',
            locationId: job.location_id,
            period: targetPeriod,
            amountAtRiskCents: atRisk,
            confidence: REVREC_THRESHOLDS.completedConfidence,
            // A completed job with materially unrecognized revenue is a clear
            // misstatement — escalate (also escalates automatically if closing/closed).
            tier: resolveRevRecTier(atRisk, REVREC_THRESHOLDS.completedConfidence, policy, {
              periodStatus: locStatus,
              forceEscalate: true,
            }),
            title,
            reason,
            question: 'Recognize the remaining revenue and release the residual deferred balance, or confirm the obligation is not yet complete?',
            subjectIds: [job.id],
            remediation,
          });
          continue;
        }

        // ── Signal B — in-progress POC/percentage-complete under-recognized ─────
        const collected = method === 'CASH' ? collectedByJob.get(job.id) ?? 0 : 0;
        const { earnedCents } = earnedToDate(method, job, asOfDate, collected);
        const under = earnedRecognizedGap(earnedCents, recognized);
        if (under <= 0) continue;
        if (!isMaterial(under, contract)) continue;

        // Inputs present for the resolved method? (guards divide-by-zero cases)
        const hasInputs = methodHasInputs(method, job);
        if (!hasInputs) continue;

        const confidence = pocConfidence({ underCents: under, contractCents: contract, hasInputs });
        const residualDeferred = Math.max(0, deferredBalByJob.get(job.id) ?? 0); // (0 — done-only map)
        const drawFromDeferred = Math.min(under, residualDeferred);
        const jobLabel = job.name || job.job_number || `Job ${job.id.slice(0, 8)}`;
        const methodWord = method === 'PCT_COSTS_INCURRED' ? 'cost-to-cost' : method === 'PCT_COMPLETE' ? 'percentage-complete' : method.toLowerCase();
        const title = `${jobLabel} — ${formatMoney(under)} earned but not recognized (${targetPeriod})`;
        const reason =
          `${jobLabel} recognizes on ${methodWord} (${method}). Earned-to-date at ${asOfDate} is ${formatMoney(earnedCents)}, ` +
          `but only ${formatMoney(recognized)} has been recognized — ${formatMoney(under)} of revenue is earned but unrecognized this period. ` +
          `The period's revenue is understated until the rev-rec engine catches up. ` +
          `Draft: DR Deferred Revenue (2410) / CR Revenue ${formatMoney(under)} for the earned delta.`;
        const remediation = draftRecognitionJe(
          targetPeriod,
          under,
          drawFromDeferred,
          deferredAcct,
          resolveJobRevenue(job, acctById, fallbackRevenue),
          job,
        );
        buckets.push({
          dedupKey: dedupKey('job_progress', job.id, targetPeriod),
          kind: 'job_progress',
          subjectId: job.id,
          subjectTable: 'core.jobs',
          locationId: job.location_id,
          period: targetPeriod,
          amountAtRiskCents: under,
          confidence,
          tier: resolveRevRecTier(under, confidence, policy, { periodStatus: locStatus }),
          title,
          reason,
          question: 'Run rev-rec for this job (recognize the earned delta), or adjust the progress inputs if they are overstated?',
          subjectIds: [job.id],
          remediation,
        });
      }
    }
  } catch (e) {
    console.warn('[controls/revrec] job scan threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
  }

  // Highest $-at-risk first — the operator sees the biggest hole in the close top.
  buckets.sort((a, b) => b.amountAtRiskCents - a.amountAtRiskCents);
  summary.buckets = buckets.length;
  for (const b of buckets) {
    summary.byKind[b.kind] += 1;
    summary.totalAtRiskCents += b.amountAtRiskCents;
    summary.findings.push({
      kind: b.kind,
      subjectId: b.subjectId,
      period: b.period,
      amountAtRiskCents: b.amountAtRiskCents,
      tier: b.tier,
      title: b.title,
    });
  }

  if (opts.dryRun) return summary;

  // ── Idempotency: load existing REVENUE_NOT_RECOGNIZED rows keyed by dedup_key ─
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', REVENUE_NOT_RECOGNIZED_FEATURE)
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
      control: 'EC-6',
      kind: b.kind,
      kind_label: KIND_LABEL[b.kind],
      dedup_key: b.dedupKey,
      period: b.period,
      as_of_date: asOfDate,
      subject_table: b.subjectTable,
      subject_id: b.subjectId,
      amount_at_risk_cents: b.amountAtRiskCents,
      tier: b.tier,
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
        console.warn('[controls/revrec] refresh failed:', error.message);
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
      feature: REVENUE_NOT_RECOGNIZED_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: b.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/revrec] could not queue exception:', error.message);
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
      action: 'controls.revenue_not_recognized.detect',
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

  // ── Expire previously-open gaps that have since been recognized (queue hygiene) ─
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

// ─────────────────────────────────────────────────────────────────────────────
// Small internal helpers (I/O-free)
// ─────────────────────────────────────────────────────────────────────────────

/** The revenue account a job should credit: its own, else the fallback. */
function resolveJobRevenue(
  job: JobRevRecRow,
  acctById: Map<string, AccountRef>,
  fallback: AccountRef | null,
): AccountRef | null {
  if (job.revenue_account_id) {
    const own = acctById.get(job.revenue_account_id);
    if (own) return own;
  }
  return fallback;
}

/** Whether the resolved method's drivers are present (avoids meaningless flags). */
export function methodHasInputs(method: RevRecMethod, job: Pick<JobRevRecRow, 'estimated_cost_cents' | 'pct_complete' | 'contract_amount_cents' | 'service_start_date' | 'service_end_date'>): boolean {
  const contract = Number(job.contract_amount_cents ?? 0);
  if (contract <= 0) return false;
  switch (method) {
    case 'PCT_COSTS_INCURRED':
      return Number(job.estimated_cost_cents ?? 0) > 0;
    case 'PCT_COMPLETE':
      return job.pct_complete != null && Number(job.pct_complete) > 0;
    case 'RATABLY':
    case 'SUBSCRIPTION':
      return !!job.service_start_date && !!job.service_end_date;
    default:
      // COMPLETED_CONTRACT/MILESTONE/CASH have their own drivers; treat as usable.
      return true;
  }
}

/**
 * Build the DRAFT recognition JE for an earned delta: the clean two-line headline the
 * FPB calls for — DR Deferred Revenue (2410) / CR Revenue for the full delta. When we
 * KNOW the job's deferred balance is smaller than the delta (`drawFromDeferred` <
 * amount), the excess is shown as DR Unbilled Receivable / Contract Asset (1180) so
 * the draft ties out to what the engine will actually post; otherwise it's the simple
 * DR 2410 / CR Revenue. The note always explains the engine's real relieve-vs-1180
 * split so a human approves the *reasoning*, not a black box. DRAFT ONLY — never
 * posted here; the rev-rec engine (or a human via postJournalEntry) books it.
 */
function draftRecognitionJe(
  period: string,
  amount: number,
  drawFromDeferred: number,
  deferredAcct: AccountRef | null,
  revenueAcct: AccountRef | null,
  job: JobRevRecRow & { id: string },
): RevRecRemediation {
  // Only split off Unbilled 1180 when we have POSITIVE knowledge the deferred balance
  // is short (drawFromDeferred > 0 but < amount). When drawFromDeferred is 0 (unknown
  // / not queried), keep the headline DR 2410 / CR Revenue the FPB specifies.
  const relieve = drawFromDeferred > 0 && drawFromDeferred < amount ? drawFromDeferred : amount;
  const excess = amount - relieve;
  const lines: DraftJeLine[] = [
    {
      account_id: deferredAcct?.id ?? null,
      account_role: 'DEFERRED_REVENUE',
      account_name: deferredAcct?.name ?? null,
      debit_cents: relieve,
      credit_cents: 0,
      memo: `Release deferred revenue — ${period}`,
    },
  ];
  if (excess > 0) {
    lines.push({
      account_id: null,
      account_role: 'UNBILLED_RECEIVABLE',
      account_name: 'Unbilled Receivable (contract asset, 1180)',
      debit_cents: excess,
      credit_cents: 0,
      memo: `Unbilled receivable (contract asset) — ${period}`,
    });
  }
  lines.push({
    account_id: revenueAcct?.id ?? null,
    account_role: 'REVENUE',
    account_name: revenueAcct?.name ?? null,
    debit_cents: 0,
    credit_cents: amount,
    memo: `Recognize revenue — ${period}`,
  });
  return {
    type: 'RECOGNITION_JE',
    post_period: period,
    amount_cents: amount,
    lines,
    note:
      'Draft only — do NOT post directly. Run the rev-rec engine for this job (or book this entry through postJournalEntry). ' +
      "The engine relieves Deferred Revenue (2410) up to the job's deferred balance and books any earned-beyond-billed amount to " +
      'Unbilled Receivable (1180); confirm the split before posting.' +
      (deferredAcct ? '' : ' No Deferred Revenue (2410) account was found in the COA — select one before posting.') +
      (revenueAcct ? '' : ' No revenue account resolved for this job — select one before posting.'),
    source_ref: { table: 'core.jobs', id: job.id },
  };
}
