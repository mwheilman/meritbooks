/**
 * Unbilled-revenue (contract-asset) accrual — PURE, deterministic.
 *
 * Answers the controller question directly: "when a job is UNDER-billed (we've
 * EARNED more revenue than we've BILLED), give me the option to accrue the earned
 * revenue and the contract-asset receivable, because it's earned revenue."
 *
 * The WIP schedule (lib/jobcost/wip.ts) already COMPUTES the under-billing:
 *   underBilling = earned − billed  (costs & estimated earnings in excess of billings)
 * This module turns that number into a BALANCED accounting action:
 *   DR Unbilled Receivable / Contract Asset (role UNBILLED_RECEIVABLE, acct 1180)
 *   CR Revenue                              (the job's revenue stream)
 * …for the amount needed to bring the contract-asset balance up to the earned-but-
 * unbilled position.
 *
 * ── ADJUST-TO-TARGET (self-reversing) ────────────────────────────────────────
 * We do NOT blindly re-accrue the full under-billing every period (that would
 * double-count). The TARGET contract-asset balance for a job is its current WIP
 * under-billing. We look at what is ALREADY carried on 1180 for that job (from any
 * prior accrual AND from the method-driven rev-rec engine, which also books 1180)
 * and post only the DELTA:
 *   delta > 0  → ACCRUE   : DR 1180 / CR Revenue   (earned more than carried)
 *   delta < 0  → REVERSE  : DR Revenue / CR 1180    (billing has caught up — unwind)
 *   delta = 0  → NONE     : nothing to post (already tied out)
 * So each period books only the incremental move, the mechanism is naturally
 * period-aware and reversing, and after posting the 1180 balance TIES to the WIP
 * under-billing by construction. Every entry balances (debits == credits).
 *
 * INVARIANT (canon §3): every cent is authored here, in code — no I/O, no clock,
 * no randomness. unbilled-accrual.test.ts is the correctness guarantee. All money
 * is integer cents.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';

export interface UnbilledAccrualInput {
  /** Earned revenue to date (WIP: contract × %-complete), cents. */
  earnedRevenueCents: number;
  /** Amount billed to the customer to date, cents. */
  billedToDateCents: number;
  /**
   * Net contract-asset (1180) already carried for THIS job across ALL sources
   * (prior accruals + the method-driven rev-rec engine), as a debit-positive
   * balance in cents. Positive = an asset already on the books.
   */
  existingContractAssetCents: number;
}

export type AccrualAction = 'ACCRUE' | 'REVERSE' | 'NONE';

export interface UnbilledAccrualPlan {
  /** WIP under-billing = max(0, earned − billed). The TARGET 1180 balance, cents. */
  targetContractAssetCents: number;
  /** Contract-asset already carried (echoed from input), cents. */
  existingContractAssetCents: number;
  /** target − existing. >0 accrue, <0 reverse, 0 no-op. Cents. */
  deltaCents: number;
  /** Absolute size of the entry to post (|delta|), cents. */
  amountCents: number;
  action: AccrualAction;
}

function int(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : 0;
}

/**
 * Compute the accrual plan for one job. Pure.
 *
 * The target contract-asset balance is the WIP under-billing (earned − billed,
 * floored at 0 — an OVER-billed job is a liability handled by Deferred Revenue,
 * never a contract asset). The delta to post moves the existing 1180 balance to
 * that target.
 */
export function planUnbilledAccrual(input: UnbilledAccrualInput): UnbilledAccrualPlan {
  const earned = int(input.earnedRevenueCents);
  const billed = int(input.billedToDateCents);
  const existing = int(input.existingContractAssetCents);

  const target = Math.max(0, earned - billed);
  const delta = target - existing;

  const action: AccrualAction = delta > 0 ? 'ACCRUE' : delta < 0 ? 'REVERSE' : 'NONE';

  return {
    targetContractAssetCents: target,
    existingContractAssetCents: existing,
    deltaCents: delta,
    amountCents: Math.abs(delta),
    action,
  };
}

export interface AccrualAccounts {
  /** Resolved Unbilled Receivable / Contract Asset account id (role UNBILLED_RECEIVABLE, 1180). */
  unbilledAccountId: string;
  /** Resolved Revenue account id for the job's stream. */
  revenueAccountId: string;
  locationId: string;
  jobId: string;
  /** Optional memo override for the lines. */
  memo?: string;
}

/**
 * Build the balanced journal lines for an accrual plan. Pure.
 *
 *   ACCRUE  (delta > 0): DR Unbilled Receivable (1180) / CR Revenue
 *   REVERSE (delta < 0): DR Revenue / CR Unbilled Receivable (1180)
 *   NONE    (delta = 0): [] — nothing to post
 *
 * Debits always equal credits, so postJournalEntry / check_journal_balance accept it.
 */
export function buildUnbilledAccrualLines(
  plan: UnbilledAccrualPlan,
  accts: AccrualAccounts,
): JournalEntryLineInput[] {
  if (plan.action === 'NONE' || plan.amountCents <= 0) return [];

  const amt = plan.amountCents;
  const assetMemo = accts.memo ?? 'Unbilled receivable (contract asset) — earned not billed';
  const revMemo = accts.memo ?? 'Accrued unbilled revenue (earned not billed)';

  if (plan.action === 'ACCRUE') {
    return [
      {
        account_id: accts.unbilledAccountId,
        debit_cents: amt,
        credit_cents: 0,
        location_id: accts.locationId,
        job_id: accts.jobId,
        memo: assetMemo,
      },
      {
        account_id: accts.revenueAccountId,
        debit_cents: 0,
        credit_cents: amt,
        location_id: accts.locationId,
        job_id: accts.jobId,
        memo: revMemo,
      },
    ];
  }

  // REVERSE: billing has caught up — unwind part of the contract asset.
  return [
    {
      account_id: accts.revenueAccountId,
      debit_cents: amt,
      credit_cents: 0,
      location_id: accts.locationId,
      job_id: accts.jobId,
      memo: 'Reverse unbilled revenue — billing caught up',
    },
    {
      account_id: accts.unbilledAccountId,
      debit_cents: 0,
      credit_cents: amt,
      location_id: accts.locationId,
      job_id: accts.jobId,
      memo: 'Relieve unbilled receivable (contract asset) — billed',
    },
  ];
}

/** Convenience: plan + lines in one call. Pure. */
export function buildUnbilledAccrual(
  input: UnbilledAccrualInput,
  accts: AccrualAccounts,
): { plan: UnbilledAccrualPlan; lines: JournalEntryLineInput[] } {
  const plan = planUnbilledAccrual(input);
  return { plan, lines: buildUnbilledAccrualLines(plan, accts) };
}
