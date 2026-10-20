/**
 * Commission RECONCILIATION — pure, idempotent. Compares what an employee SHOULD
 * have earned on a source (evaluate.ts) with what was previously recorded, and
 * emits the single delta line:
 *
 *   delta > 0, nothing recorded yet      → EARNED
 *   delta > 0, after a prior clawback    → REINSTATED (e.g. the late invoice got paid)
 *   delta > 0, otherwise                 → EARNED (incremental, e.g. another PAID installment)
 *   delta < 0, inside the clawback window → CLAWBACK
 *   delta < 0, outside the window        → nothing (the employee keeps it)
 *   delta = 0                            → nothing (re-running is a no-op)
 *
 * Also batches a whole period: assignments → plans active on the basis date →
 * per (plan, source, employee) reconcile → TIERED period accelerators.
 */

import { evaluateSource, computeTieredAmount } from './evaluate';
import { allocateByWeights, daysBetween } from './money';
import type { CommissionLine, CommissionPlan, CommissionSource } from './types';

export interface PlanAssignment {
  employeeId: string;
  planId: string;
  /** Inclusive ISO dates; null `effectiveTo` = open-ended. */
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Stable key for (plan, source, employee) — the reconciliation unit. */
export function lineKey(planId: string, sourceType: string, sourceId: string, employeeId: string): string {
  return `${planId}|${sourceType}|${sourceId}|${employeeId}`;
}

/** Reconcile one (plan, source) for its employee. Returns the delta line or null. */
export function reconcileSource(
  plan: CommissionPlan,
  src: CommissionSource,
  prior: CommissionLine[],
  asOf: string,
): CommissionLine | null {
  const earnedPrior = prior.filter((l) => l.kind === 'EARNED' || l.kind === 'REINSTATED');
  // TIERED lines are re-valued at the rate they were originally earned at.
  const tieredRate = plan.kind === 'TIERED' ? earnedPrior.find((l) => l.rateBps > 0)?.rateBps : undefined;
  if (plan.kind === 'TIERED' && tieredRate == null) return null; // first earning happens at period level

  const ev = evaluateSource(plan, src, asOf, tieredRate);
  const priorNet = prior.reduce((s, l) => s + l.amountCents, 0);
  const delta = ev.amountCents - priorNet;
  if (delta === 0) return null;

  const base = {
    planId: plan.id,
    employeeId: src.employeeId,
    sourceType: src.sourceType,
    sourceId: src.sourceId,
    basisCents: ev.basisCents,
    rateBps: ev.rateBps,
    amountCents: delta,
  };

  if (delta < 0) {
    const firstEarnedOn = earnedPrior.map((l) => l.recognizedOn).sort()[0];
    if (plan.clawback.windowDays != null && firstEarnedOn && daysBetween(firstEarnedOn, asOf) > plan.clawback.windowDays) {
      return null; // outside the clawback window — the employee keeps it
    }
    const on = ev.reversalTriggerOn && ev.reversalTriggerOn <= asOf ? ev.reversalTriggerOn : asOf;
    return { ...base, kind: 'CLAWBACK', recognizedOn: on, explanation: `Clawback: ${ev.explanation}` };
  }

  const hadClawback = prior.some((l) => l.kind === 'CLAWBACK');
  return {
    ...base,
    kind: hadClawback ? 'REINSTATED' : 'EARNED',
    recognizedOn: prior.length === 0 && ev.basisOn ? ev.basisOn : asOf,
    explanation: hadClawback ? `Reinstated: ${ev.explanation}` : ev.explanation,
  };
}

/** Plans assigned to an employee and active on a date. */
export function activePlansFor(
  employeeId: string,
  onDate: string,
  assignments: PlanAssignment[],
  plans: Map<string, CommissionPlan>,
): CommissionPlan[] {
  return assignments
    .filter((a) => a.employeeId === employeeId && a.effectiveFrom <= onDate && (a.effectiveTo == null || onDate <= a.effectiveTo))
    .map((a) => plans.get(a.planId))
    .filter((p): p is CommissionPlan => !!p);
}

export interface RunCommissionsInput {
  plans: CommissionPlan[];
  assignments: PlanAssignment[];
  sources: CommissionSource[];
  /** Every previously recorded line (any period) for these sources. */
  priorLines: CommissionLine[];
  periodStart: string;
  periodEnd: string;
}

/**
 * Compute the proposed new lines for a period close (asOf = periodEnd):
 *  1. non-tiered: reconcile every (plan, source) pair whose plan was assigned on the
 *     basis date (or that already has history — clawbacks must still flow after an
 *     assignment ends);
 *  2. tiered: for lines whose basis falls in the period, measure Σ basis per
 *     (employee, plan), apply the tier table once, allocate the total back to the
 *     source lines (sums exactly), recording each line's effective rate;
 *  3. tiered history: later refunds/cancellations reconcile at the recorded rate.
 * Deterministic output order: employee, plan, source.
 */
export function runCommissions(input: RunCommissionsInput): CommissionLine[] {
  const asOf = input.periodEnd;
  const plans = new Map(input.plans.map((p) => [p.id, p]));
  const priorByKey = new Map<string, CommissionLine[]>();
  for (const l of input.priorLines) {
    const k = lineKey(l.planId, l.sourceType, l.sourceId, l.employeeId);
    const list = priorByKey.get(k) ?? [];
    list.push(l);
    priorByKey.set(k, list);
  }

  const out: CommissionLine[] = [];
  const tieredBuckets = new Map<string, { plan: CommissionPlan; employeeId: string; items: Array<{ src: CommissionSource; basis: number; basisOn: string }> }>();

  for (const src of input.sources) {
    const candidatePlans = new Map<string, CommissionPlan>();
    for (const p of input.plans) {
      const prior = priorByKey.get(lineKey(p.id, src.sourceType, src.sourceId, src.employeeId));
      if (prior && prior.length > 0) candidatePlans.set(p.id, p);
    }
    // Basis date differs by plan; check assignment on each plan's own basis date.
    for (const a of input.assignments.filter((x) => x.employeeId === src.employeeId)) {
      const p = plans.get(a.planId);
      if (!p) continue;
      const ev = evaluateSource(p, src, asOf, p.kind === 'TIERED' ? 0 : undefined);
      if (ev.basisOn && activePlansFor(src.employeeId, ev.basisOn, input.assignments, plans).some((x) => x.id === p.id)) {
        candidatePlans.set(p.id, p);
      }
    }

    for (const plan of candidatePlans.values()) {
      const prior = priorByKey.get(lineKey(plan.id, src.sourceType, src.sourceId, src.employeeId)) ?? [];
      if (plan.kind === 'TIERED' && prior.length === 0) {
        const ev = evaluateSource(plan, src, asOf, 0);
        if (ev.basisOn && ev.basisOn >= input.periodStart && ev.basisOn <= input.periodEnd && ev.basisCents > 0) {
          const k = `${src.employeeId}|${plan.id}`;
          const b = tieredBuckets.get(k) ?? { plan, employeeId: src.employeeId, items: [] };
          b.items.push({ src, basis: ev.basisCents, basisOn: ev.basisOn });
          tieredBuckets.set(k, b);
        }
        continue;
      }
      const line = reconcileSource(plan, src, prior, asOf);
      if (line) out.push(line);
    }
  }

  for (const { plan, employeeId, items } of tieredBuckets.values()) {
    const measure = items.reduce((s, i) => s + i.basis, 0);
    const { amountCents, topTierRateBps } = computeTieredAmount(measure, plan.tiers ?? [], plan.tierMode ?? 'MARGINAL');
    const parts = allocateByWeights(amountCents, items.map((i) => i.basis));
    items.forEach((it, idx) => {
      if (parts[idx] === 0) return;
      // Effective rate for this line (bps, rounded) so later clawbacks re-value consistently.
      const effBps = it.basis > 0 ? Math.round((parts[idx] * 10_000) / it.basis) : topTierRateBps;
      out.push({
        planId: plan.id,
        employeeId,
        sourceType: it.src.sourceType,
        sourceId: it.src.sourceId,
        kind: 'EARNED',
        basisCents: it.basis,
        rateBps: effBps,
        amountCents: parts[idx],
        recognizedOn: it.basisOn,
        explanation: `${plan.name}: period ${plan.tierMeasure === 'GROSS_PROFIT' ? 'gross profit' : 'revenue'} ${measure} cents → ${(
          topTierRateBps / 100
        ).toFixed(2)}% top tier (${plan.tierMode ?? 'MARGINAL'})`,
      });
    });
  }

  return out.sort(
    (a, b) =>
      a.employeeId.localeCompare(b.employeeId) ||
      a.planId.localeCompare(b.planId) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.kind.localeCompare(b.kind),
  );
}
