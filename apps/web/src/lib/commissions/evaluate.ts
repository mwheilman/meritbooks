/**
 * Commission PLAN EVALUATION — pure. Given a plan and one source fact, how much
 * commission SHOULD this employee have earned on it as of a date?
 *
 * "Should have earned" already reflects cancellations, refunds and unpaid-after-N-
 * days under the plan's clawback policy; reconcile.ts turns the difference between
 * should-have-earned and what was previously recorded into EARNED / CLAWBACK /
 * REINSTATED lines. That makes the whole engine idempotent: re-running it on the
 * same facts produces no new lines.
 *
 * TIERED plans are period-level (range bonuses / accelerators): see
 * `computeTieredAmount` and statement.ts. Per source, evaluateSource returns the
 * tier MEASURE (basis) with amount 0 unless an effective rate is supplied.
 */

import { addDays, applyBps, prorate } from './money';
import type { CommissionPlan, CommissionSource, CommissionTier, TierMode } from './types';

export interface SourceEvaluation {
  /** Cents the rate applies to (after split / paid share). */
  basisCents: number;
  /** Effective rate in bps (0 for flat amounts). */
  rateBps: number;
  /** Should-have-earned commission as of the date, cents (≥ 0). */
  amountCents: number;
  /** Date the basis event occurred (null = not yet commissionable). */
  basisOn: string | null;
  /** When the amount dropped to zero because of a clawback trigger, the trigger date. */
  reversalTriggerOn: string | null;
  explanation: string;
}

/** Structural validation; returns human-readable errors (empty = valid). */
export function validatePlan(plan: CommissionPlan): string[] {
  const errs: string[] = [];
  const intOk = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  switch (plan.kind) {
    case 'PERCENT_REVENUE':
    case 'PERCENT_GROSS_PROFIT':
      if (!intOk(plan.rateBps) || (plan.rateBps ?? 0) > 10_000) errs.push('rateBps must be an integer between 0 and 10000');
      break;
    case 'FLAT_PER_JOB':
      if (!intOk(plan.flatCents)) errs.push('flatCents must be a non-negative integer');
      break;
    case 'SPIFF':
      if (!intOk(plan.flatCents)) errs.push('flatCents must be a non-negative integer');
      if (!plan.spiffItemCodes || plan.spiffItemCodes.length === 0) errs.push('spiffItemCodes must list at least one item');
      break;
    case 'TIERED': {
      const tiers = plan.tiers ?? [];
      if (tiers.length === 0) errs.push('tiers must have at least one tier');
      if (tiers.length > 0 && tiers[0].fromCents !== 0) errs.push('the first tier must start at 0');
      for (let i = 0; i < tiers.length; i++) {
        if (!intOk(tiers[i].fromCents) || !intOk(tiers[i].rateBps) || tiers[i].rateBps > 10_000) errs.push(`tier ${i + 1} is invalid`);
        if (i > 0 && tiers[i].fromCents <= tiers[i - 1].fromCents) errs.push('tiers must be strictly ascending');
      }
      break;
    }
  }
  if (plan.minMarginBps != null && (!Number.isSafeInteger(plan.minMarginBps) || plan.minMarginBps > 10_000)) {
    errs.push('minMarginBps must be an integer ≤ 10000');
  }
  if (plan.capPerLineCents != null && !intOk(plan.capPerLineCents)) errs.push('capPerLineCents must be a non-negative integer');
  if (plan.clawback.unpaidAfterDays != null && !intOk(plan.clawback.unpaidAfterDays)) errs.push('unpaidAfterDays must be a non-negative integer');
  if (plan.clawback.windowDays != null && !intOk(plan.clawback.windowDays)) errs.push('windowDays must be a non-negative integer');
  return errs;
}

/** The date the plan's basis event happened for this source, if it has. */
export function basisDate(plan: CommissionPlan, src: CommissionSource): string | null {
  switch (plan.basisEvent) {
    case 'SOLD':
      return src.soldOn;
    case 'INSTALLED':
      return src.installedOn;
    case 'INVOICED':
      return src.invoicedOn;
    case 'PAID':
      // Earned as cash arrives; the latest payment date dates the earning.
      return src.paidCents > 0 ? src.paidOn : null;
  }
}

/** Revenue after refunds when the plan claws back refunds; never negative. */
function effectiveRevenue(plan: CommissionPlan, src: CommissionSource): number {
  const refunded = plan.clawback.onRefund ? Math.max(0, src.refundedCents) : 0;
  return Math.max(0, src.revenueCents - refunded);
}

/**
 * Commission on a period measure under a tier table.
 *   MARGINAL:    Σ slice × slice rate.
 *   RETROACTIVE: whole measure × rate of the highest tier reached.
 */
export function computeTieredAmount(measureCents: number, tiers: CommissionTier[], mode: TierMode): {
  amountCents: number;
  topTierRateBps: number;
} {
  if (measureCents <= 0 || tiers.length === 0) return { amountCents: 0, topTierRateBps: 0 };
  const sorted = [...tiers].sort((a, b) => a.fromCents - b.fromCents);
  let top = sorted[0];
  for (const t of sorted) if (measureCents >= t.fromCents) top = t;
  if (mode === 'RETROACTIVE') return { amountCents: applyBps(measureCents, top.rateBps), topTierRateBps: top.rateBps };
  let amount = 0;
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i].fromCents;
    const hi = i + 1 < sorted.length ? sorted[i + 1].fromCents : Number.MAX_SAFE_INTEGER;
    if (measureCents <= lo) break;
    amount += applyBps(Math.min(measureCents, hi) - lo, sorted[i].rateBps);
  }
  return { amountCents: amount, topTierRateBps: top.rateBps };
}

const zero = (basisOn: string | null, explanation: string, reversalTriggerOn: string | null = null): SourceEvaluation => ({
  basisCents: 0,
  rateBps: 0,
  amountCents: 0,
  basisOn,
  reversalTriggerOn,
  explanation,
});

/**
 * Should-have-earned commission for one source as of `asOf` (ISO date).
 * `tieredEffectiveRateBps` lets a TIERED line be re-valued at the rate it was
 * originally earned at (for later refunds / cancellations).
 */
export function evaluateSource(
  plan: CommissionPlan,
  src: CommissionSource,
  asOf: string,
  tieredEffectiveRateBps?: number,
): SourceEvaluation {
  const basisOn = basisDate(plan, src);
  if (!basisOn || basisOn > asOf) return zero(null, `Not yet commissionable (waiting for ${plan.basisEvent.toLowerCase()}).`);

  // Clawback triggers that zero the should-have-earned amount.
  if (plan.clawback.onCancellation && src.cancelledOn && src.cancelledOn <= asOf) {
    return zero(basisOn, `Cancelled on ${src.cancelledOn} — commission reversed per plan.`, src.cancelledOn);
  }
  const revenue = effectiveRevenue(plan, src);
  if (plan.basisEvent !== 'PAID' && plan.clawback.unpaidAfterDays != null && src.dueOn) {
    const trigger = addDays(src.dueOn, plan.clawback.unpaidAfterDays);
    if (src.paidCents < revenue && trigger < asOf) {
      return zero(basisOn, `Unpaid ${plan.clawback.unpaidAfterDays} days past due (${src.dueOn}) — commission held back until paid.`, trigger);
    }
  }
  if (revenue === 0 && plan.kind !== 'FLAT_PER_JOB' && plan.kind !== 'SPIFF') {
    return zero(basisOn, 'No net revenue (fully refunded or zero-dollar).', src.refundedCents > 0 ? asOf : null);
  }

  // Gross-margin floor.
  const grossProfit = revenue - Math.max(0, src.costCents);
  if (plan.minMarginBps != null && revenue > 0 && BigInt(grossProfit) * 10_000n < BigInt(plan.minMarginBps) * BigInt(revenue)) {
    return zero(basisOn, `Gross margin below the plan floor of ${(plan.minMarginBps / 100).toFixed(2)}% — no commission.`);
  }

  // PAID basis earns pro-rata to cash collected (flat kinds only when fully paid).
  const paidShare = (cents: number) =>
    plan.basisEvent === 'PAID' ? prorate(cents, Math.min(Math.max(0, src.paidCents), revenue), revenue) : cents;
  const fullyPaid = src.paidCents >= revenue;
  const split = (cents: number) => applyBps(cents, src.splitBps);
  const splitNote = src.splitBps !== 10_000 ? ` × ${(src.splitBps / 100).toFixed(2)}% split` : '';
  const cap = (cents: number) => (plan.capPerLineCents != null ? Math.min(cents, plan.capPerLineCents) : cents);

  let basisCents = 0;
  let rateBps = 0;
  let amountCents = 0;
  let explanation = '';
  switch (plan.kind) {
    case 'PERCENT_REVENUE':
      basisCents = split(paidShare(revenue));
      rateBps = plan.rateBps ?? 0;
      amountCents = applyBps(basisCents, rateBps);
      explanation = `${(rateBps / 100).toFixed(2)}% of revenue${splitNote}`;
      break;
    case 'PERCENT_GROSS_PROFIT':
      basisCents = split(paidShare(Math.max(0, grossProfit)));
      rateBps = plan.rateBps ?? 0;
      amountCents = applyBps(basisCents, rateBps);
      explanation = `${(rateBps / 100).toFixed(2)}% of gross profit${splitNote}`;
      break;
    case 'FLAT_PER_JOB':
      if (plan.basisEvent === 'PAID' && !fullyPaid) return zero(basisOn, 'Flat commission earns when the job is paid in full.');
      amountCents = split(plan.flatCents ?? 0);
      explanation = `Flat per job${splitNote}`;
      break;
    case 'SPIFF': {
      const codes = new Set((plan.spiffItemCodes ?? []).map((c) => c.trim().toLowerCase()));
      if (!src.itemCode || !codes.has(src.itemCode.trim().toLowerCase())) return zero(basisOn, 'Item does not qualify for this spiff.');
      if (plan.basisEvent === 'PAID' && !fullyPaid) return zero(basisOn, 'Spiff earns when the sale is paid in full.');
      const units = Math.max(0, Math.trunc(src.quantity));
      amountCents = split((plan.flatCents ?? 0) * units);
      explanation = `Spiff ${units} × ${src.itemCode}${splitNote}`;
      break;
    }
    case 'TIERED': {
      const measure = plan.tierMeasure === 'GROSS_PROFIT' ? Math.max(0, grossProfit) : revenue;
      basisCents = split(paidShare(measure));
      rateBps = tieredEffectiveRateBps ?? 0;
      amountCents = tieredEffectiveRateBps != null ? applyBps(basisCents, tieredEffectiveRateBps) : 0;
      explanation = `Counts toward ${plan.name} tiers (${plan.tierMeasure === 'GROSS_PROFIT' ? 'gross profit' : 'revenue'})${splitNote}`;
      break;
    }
  }
  return { basisCents, rateBps, amountCents: cap(Math.max(0, amountCents)), basisOn, reversalTriggerOn: null, explanation };
}
