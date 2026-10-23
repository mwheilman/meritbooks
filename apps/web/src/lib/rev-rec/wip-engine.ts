/**
 * The CANONICAL month-end revenue-recognition / WIP engine — PURE, deterministic
 * (FPB-rev-rec-wip §4). One mechanism replaces the two overlapping 1180 paths (the batch
 * rev-rec run and the standalone unbilled accrual).
 *
 * Per job, as of the period end:
 *   earned        = earnedToDate(method)            (lib/rev-rec/earned.ts — the method authority)
 *   EAC           = max(estimated cost, cost to date)
 *   under / over  = max(0, earned − billed) / max(0, billed − earned)   (billed is gross of retainage)
 *   loss          = max(0, (EAC − contract) − max(0, cost to date − earned))   — the part of the
 *                   anticipated loss not already in the P&L (contract methods only)
 *   est. GP       = contract − EAC; fade / gain = est. GP − last month's est. GP
 *
 * Two entries per company per month (one proposal):
 *
 *   1. WIP ADJUSTMENT — self-reversing (entry_type ADJUSTING; a REVERSING twin is dated the
 *      1st of next month). Per job it moves the WIP-module balances to target:
 *        DR Unbilled receivable 1180 / CR Revenue        (under)
 *        DR Revenue / CR Deferred revenue 2410           (over)
 *        DR Contract losses (COGS) / CR Loss provision   (loss)
 *      "WIP-module balance" = lines from REV_REC_WIP entries dated ≤ the period end, so last
 *      month's entry and its reversal net to zero and a fresh month books the full position,
 *      while a re-run after posting books only the true-up.
 *
 *   2. BILLINGS RECLASS — permanent. Any OTHER balance on the job in 1180 / 2410 (deferred
 *      billings — canon §3 credits 2410 at invoice time for deferral methods — interim
 *      JOB_PROGRESS recognition, the retired manual accrual) is moved into revenue, so the
 *      reversing entry measures over / under against billings:
 *        DR 2410 (deferred billings) / CR 1180 (other contract asset) / CR (DR) Revenue
 *
 *   After both post: revenue on the job = earned to date, 1180 = under, 2410 = over (netted
 *   per contract), provision = loss. Every entry balances PER JOB, so it balances overall.
 *
 * INVARIANT (canon §3): every cent is authored here, in code. No I/O, no clock. Accounts
 * are passed in already resolved BY ROLE. All money is integer cents.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import type { JobRevRecRow, RevRecMethod } from '@/lib/services/rev-rec';
import { earnedToDate } from './earned';
import { isContractMethod, type ResolvedJobPolicy } from './policy';

/** source_module of the self-reversing WIP adjustment (and its reversal). */
export const WIP_SOURCE_MODULE = 'REV_REC_WIP';
/** source_module of the permanent billings reclass. */
export const WIP_RECLASS_SOURCE_MODULE = 'REV_REC_WIP_RECLASS';

const int = (x: number | null | undefined): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** GL balances for ONE job on the three WIP accounts, as of the period end. */
export interface JobWipBalances {
  /** 1180 from non-WIP entries, debit-positive. */
  permUnbilledCents: number;
  /** 2410 from non-WIP entries, CREDIT-positive. */
  permDeferredCents: number;
  /** 1180 from REV_REC_WIP entries (net of reversals ≤ as-of), debit-positive. */
  wipUnbilledCents: number;
  /** 2410 from REV_REC_WIP entries, credit-positive. */
  wipDeferredCents: number;
  /** Loss provision from REV_REC_WIP entries, credit-positive. */
  wipLossCents: number;
}

export const ZERO_BALANCES: Readonly<JobWipBalances> = {
  permUnbilledCents: 0, permDeferredCents: 0, wipUnbilledCents: 0, wipDeferredCents: 0, wipLossCents: 0,
};

export interface WipEngineJobInput {
  job: JobRevRecRow & { job_number?: string | null; name?: string | null; retainage_held_cents?: number | null };
  method: RevRecMethod;
  policy: ResolvedJobPolicy;
  balances: JobWipBalances;
  /** Cash collected to date (CASH method only). */
  collectedToDateCents?: number;
  /** Last month's estimated gross profit for this job (fade / gain), or null when unknown. */
  priorEstGrossProfitCents?: number | null;
}

export interface WipEngineOptions {
  asOf: string; // YYYY-MM-DD (period end)
  lossProvision: boolean;
  materialityCents: number;
}

export interface WipLine {
  jobId: string;
  jobNumber: string | null;
  jobName: string | null;
  locationId: string;
  revenueAccountId: string | null;
  method: RevRecMethod;
  status: string | null;

  contractCents: number;
  estimatedCostCents: number;
  eacCents: number;
  costToDateCents: number;
  /** Fraction [0,1] the method earned (cost-to-cost / physical / time / milestones). */
  pctComplete: number;
  earnedCents: number;
  billedCents: number;
  retainageCents: number;
  /** Position before switches / materiality. */
  underCents: number;
  overCents: number;
  lossProvisionCents: number;
  estGrossProfitCents: number;
  priorEstGrossProfitCents: number | null;
  /** est. GP − prior est. GP (negative = fade). */
  fadeGainCents: number | null;

  /** What the entry books (after switches, exclusion, materiality). */
  targetUnderCents: number;
  targetOverCents: number;
  targetLossCents: number;
  belowMateriality: boolean;
  excluded: boolean;
  policy: ResolvedJobPolicy;

  balances: JobWipBalances;
  /** Self-reversing adjustment, per account. 1180 debit-positive; 2410 / loss credit-positive. */
  adjUnbilledCents: number;
  adjDeferredCents: number;
  adjLossCents: number;
  /** Revenue moved by the adjustment, credit-positive. = adjUnbilled − adjDeferred. */
  adjRevenueCents: number;
  /** Revenue moved by the permanent reclass, credit-positive. = permDeferred − permUnbilled. */
  reclassRevenueCents: number;
}

/** Compute one job's WIP line. Pure. */
export function computeWipLine(input: WipEngineJobInput, opts: WipEngineOptions): WipLine {
  const j = input.job;
  const contract = Math.max(0, int(j.contract_amount_cents));
  const estimate = Math.max(0, int(j.estimated_cost_cents));
  const cost = Math.max(0, int(j.actual_cost_cents));
  const billed = Math.max(0, int(j.billed_to_date_cents));
  const eac = Math.max(estimate, cost);

  const { earnedCents, fraction } = earnedToDate(input.method, j, opts.asOf, int(input.collectedToDateCents));
  const earned = Math.max(0, int(earnedCents));
  const under = Math.max(0, earned - billed);
  const over = Math.max(0, billed - earned);

  const anticipatedLoss = contract > 0 && eac > contract ? eac - contract : 0;
  const lossInPL = Math.max(0, cost - earned);
  const loss = isContractMethod(input.method) ? Math.max(0, anticipatedLoss - lossInPL) : 0;

  const estGP = contract - eac;
  const prior = input.priorEstGrossProfitCents ?? null;

  let tUnder = input.policy.accrueUnderbillings ? under : 0;
  let tOver = input.policy.deferOverbillings ? over : 0;
  let tLoss = opts.lossProvision ? loss : 0;
  const excluded = input.policy.excluded;
  const materiality = Math.max(0, int(opts.materialityCents));
  const gross = tUnder + tOver + tLoss;
  const belowMateriality = !excluded && gross > 0 && materiality > 0 && gross < materiality;
  if (excluded || belowMateriality) { tUnder = 0; tOver = 0; tLoss = 0; }

  const b = input.balances;
  const adjUnbilled = excluded ? 0 : tUnder - int(b.wipUnbilledCents);
  const adjDeferred = excluded ? 0 : tOver - int(b.wipDeferredCents);
  const adjLoss = excluded ? 0 : tLoss - int(b.wipLossCents);
  const reclass = excluded ? 0 : int(b.permDeferredCents) - int(b.permUnbilledCents);

  return {
    jobId: j.id,
    jobNumber: j.job_number ?? null,
    jobName: j.name ?? null,
    locationId: j.location_id,
    revenueAccountId: j.revenue_account_id,
    method: input.method,
    status: j.status,
    contractCents: contract,
    estimatedCostCents: estimate,
    eacCents: eac,
    costToDateCents: cost,
    pctComplete: Math.round(fraction * 1_000_000) / 1_000_000,
    earnedCents: earned,
    billedCents: billed,
    retainageCents: Math.max(0, int(j.retainage_held_cents)),
    underCents: under,
    overCents: over,
    lossProvisionCents: loss,
    estGrossProfitCents: estGP,
    priorEstGrossProfitCents: prior,
    fadeGainCents: prior == null ? null : estGP - prior,
    targetUnderCents: tUnder,
    targetOverCents: tOver,
    targetLossCents: tLoss,
    belowMateriality,
    excluded,
    policy: input.policy,
    balances: { ...b },
    adjUnbilledCents: adjUnbilled,
    adjDeferredCents: adjDeferred,
    adjLossCents: adjLoss,
    adjRevenueCents: adjUnbilled - adjDeferred,
    reclassRevenueCents: reclass,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entries
// ─────────────────────────────────────────────────────────────────────────────

export interface WipAccounts {
  unbilledId: string;
  deferredId: string;
  /** Null when the tenant has no loss-provision accounts (loss lines are then skipped + reported). */
  lossProvisionId: string | null;
  lossExpenseId: string | null;
  /** Used when a job has no revenue account of its own. */
  fallbackRevenueId: string | null;
}

export interface WipEntries {
  /** The self-reversing WIP adjustment (dated the period end). */
  adjustment: JournalEntryLineInput[];
  /** Its reversal (dated the 1st of next month) — every adjustment line, sides flipped. */
  reversal: JournalEntryLineInput[];
  /** The permanent billings reclass (dated the period end). */
  reclass: JournalEntryLineInput[];
  /** Jobs that could not be fully booked, with the plain-English reason. */
  issues: { jobId: string; jobNumber: string | null; reason: string }[];
}

/** Append a signed amount (debit-positive) as one line; zero adds nothing. */
function pushSigned(
  out: JournalEntryLineInput[],
  accountId: string,
  signedDebit: number,
  base: { location_id: string; job_id: string },
  memo: string,
): void {
  if (signedDebit === 0) return;
  out.push({
    account_id: accountId,
    debit_cents: signedDebit > 0 ? signedDebit : 0,
    credit_cents: signedDebit < 0 ? -signedDebit : 0,
    location_id: base.location_id,
    job_id: base.job_id,
    memo,
  });
}

/** Build the three entries for a company's WIP lines. Pure. Each job's lines balance. */
export function buildWipEntries(lines: readonly WipLine[], accts: WipAccounts): WipEntries {
  const adjustment: JournalEntryLineInput[] = [];
  const reclass: JournalEntryLineInput[] = [];
  const issues: WipEntries['issues'] = [];

  for (const l of lines) {
    if (l.excluded) continue;
    const label = l.jobNumber ?? l.jobId.slice(0, 8);
    const base = { location_id: l.locationId, job_id: l.jobId };
    const revenueId = l.revenueAccountId ?? accts.fallbackRevenueId;

    const needsRevenue = l.adjRevenueCents !== 0 || l.reclassRevenueCents !== 0;
    if (needsRevenue && !revenueId) {
      issues.push({ jobId: l.jobId, jobNumber: l.jobNumber, reason: 'No revenue account — set the job’s revenue account or add a revenue account to the chart' });
      continue;
    }

    // ── self-reversing adjustment ──
    pushSigned(adjustment, accts.unbilledId, l.adjUnbilledCents, base, `WIP ${label}: costs and earnings in excess of billings`);
    pushSigned(adjustment, accts.deferredId, -l.adjDeferredCents, base, `WIP ${label}: billings in excess of costs and earnings`);
    if (l.adjRevenueCents !== 0 && revenueId) {
      pushSigned(adjustment, revenueId, -l.adjRevenueCents, base, `WIP ${label}: revenue earned vs billed`);
    }
    if (l.adjLossCents !== 0) {
      if (accts.lossProvisionId && accts.lossExpenseId) {
        pushSigned(adjustment, accts.lossExpenseId, l.adjLossCents, base, `WIP ${label}: anticipated contract loss`);
        pushSigned(adjustment, accts.lossProvisionId, -l.adjLossCents, base, `WIP ${label}: provision for anticipated loss`);
      } else {
        issues.push({ jobId: l.jobId, jobNumber: l.jobNumber, reason: 'Loss provision not booked — map the contract-loss accounts (2450 / 5250) on Account roles' });
      }
    }

    // ── permanent billings reclass ──
    pushSigned(reclass, accts.deferredId, l.balances.permDeferredCents, base, `WIP ${label}: billings moved from deferred revenue`);
    pushSigned(reclass, accts.unbilledId, -l.balances.permUnbilledCents, base, `WIP ${label}: prior contract asset reclassified`);
    if (l.reclassRevenueCents !== 0 && revenueId) {
      pushSigned(reclass, revenueId, -l.reclassRevenueCents, base, `WIP ${label}: billed revenue`);
    }
  }

  const reversal = adjustment.map((x) => ({
    ...x,
    debit_cents: x.credit_cents,
    credit_cents: x.debit_cents,
    memo: `Reverse: ${x.memo ?? 'WIP adjustment'}`,
  }));

  return { adjustment, reversal, reclass, issues };
}

export interface WipTotals {
  jobs: number;
  underbilledJobs: number;
  overbilledJobs: number;
  lossJobs: number;
  contractCents: number;
  eacCents: number;
  costToDateCents: number;
  earnedCents: number;
  billedCents: number;
  retainageCents: number;
  /** Position before switches (what the schedule shows). */
  underCents: number;
  overCents: number;
  lossProvisionCents: number;
  /** What the entry books. */
  targetUnderCents: number;
  targetOverCents: number;
  targetLossCents: number;
  /** Revenue effect of the adjustment (credit-positive) and of the reclass. */
  adjRevenueCents: number;
  reclassRevenueCents: number;
  /** Σ debits of the adjustment entry — the size the autonomy cap is checked against. */
  grossAdjustmentCents: number;
  fadeGainCents: number;
  fadeJobs: number;
}

export function totalsOf(lines: readonly WipLine[], entries?: WipEntries): WipTotals {
  const t: WipTotals = {
    jobs: lines.length, underbilledJobs: 0, overbilledJobs: 0, lossJobs: 0,
    contractCents: 0, eacCents: 0, costToDateCents: 0, earnedCents: 0, billedCents: 0, retainageCents: 0,
    underCents: 0, overCents: 0, lossProvisionCents: 0,
    targetUnderCents: 0, targetOverCents: 0, targetLossCents: 0,
    adjRevenueCents: 0, reclassRevenueCents: 0, grossAdjustmentCents: 0, fadeGainCents: 0, fadeJobs: 0,
  };
  for (const l of lines) {
    if (l.underCents > 0) t.underbilledJobs++;
    if (l.overCents > 0) t.overbilledJobs++;
    if (l.lossProvisionCents > 0) t.lossJobs++;
    t.contractCents += l.contractCents;
    t.eacCents += l.eacCents;
    t.costToDateCents += l.costToDateCents;
    t.earnedCents += l.earnedCents;
    t.billedCents += l.billedCents;
    t.retainageCents += l.retainageCents;
    t.underCents += l.underCents;
    t.overCents += l.overCents;
    t.lossProvisionCents += l.lossProvisionCents;
    t.targetUnderCents += l.targetUnderCents;
    t.targetOverCents += l.targetOverCents;
    t.targetLossCents += l.targetLossCents;
    t.adjRevenueCents += l.adjRevenueCents;
    t.reclassRevenueCents += l.reclassRevenueCents;
    if (l.fadeGainCents != null) {
      t.fadeGainCents += l.fadeGainCents;
      if (l.fadeGainCents < 0) t.fadeJobs++;
    }
  }
  if (entries) t.grossAdjustmentCents = entries.adjustment.reduce((s, x) => s + x.debit_cents, 0);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tie-out to the GL
// ─────────────────────────────────────────────────────────────────────────────

export interface TieOutSide {
  /** What the schedule says should be on the books (after switches / materiality). */
  scheduleCents: number;
  /** What the GL carries on this account for the company's jobs, as of the period end. */
  glJobsCents: number;
  /** schedule − GL (0 = tied). */
  differenceCents: number;
  /** Balance on the account NOT attributed to any job (shown, never netted). */
  glOtherCents: number;
}

export interface TieOut {
  unbilled: TieOutSide;
  deferred: TieOutSide;
  lossProvision: TieOutSide;
  tied: boolean;
}

/** Tie the schedule to the GL. GL figures: 1180 debit-positive, 2410 / provision credit-positive. Pure. */
export function computeTieOut(args: {
  lines: readonly WipLine[];
  gl: { unbilledJobs: number; unbilledOther: number; deferredJobs: number; deferredOther: number; lossJobs: number; lossOther: number };
}): TieOut {
  const t = totalsOf(args.lines);
  const side = (schedule: number, jobs: number, other: number): TieOutSide => ({
    scheduleCents: schedule, glJobsCents: int(jobs), differenceCents: schedule - int(jobs), glOtherCents: int(other),
  });
  const unbilled = side(t.targetUnderCents, args.gl.unbilledJobs, args.gl.unbilledOther);
  const deferred = side(t.targetOverCents, args.gl.deferredJobs, args.gl.deferredOther);
  const lossProvision = side(t.targetLossCents, args.gl.lossJobs, args.gl.lossOther);
  return {
    unbilled, deferred, lossProvision,
    tied: unbilled.differenceCents === 0 && deferred.differenceCents === 0 && lossProvision.differenceCents === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates + references
// ─────────────────────────────────────────────────────────────────────────────

/** Last day of the month for 'YYYY-MM'. */
export function periodEnd(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** First day of the month AFTER 'YYYY-MM' — the reversal date. */
export function nextPeriodStart(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the month before. */
export function priorPeriodKey(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function isPeriodKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** Idempotency keys (migration 064 UNIQUE(org_id, source_ref, entry_type)). */
export function wipSourceRefs(locationId: string, periodKey: string, revision: number) {
  const base = `rev_rec_wip:${locationId}:${periodKey}:r${revision}`;
  return { adjustment: base, reversal: `${base}:reversal`, reclass: `${base}:reclass` };
}
