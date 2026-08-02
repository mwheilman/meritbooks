/**
 * Intercompany auto-match for consolidation (GATE 11a).
 *
 * PURE, deterministic, side-effect free. Given the per-entity intercompany
 * positions in a period, it PROPOSES reciprocal pairs to eliminate — a due-from
 * (receivable) on entity X paired against an equal due-to (payable) on entity Y, and
 * eliminating interdept REVENUE on one entity paired against equal interdept COST on
 * another. It NEVER posts anything: the consolidation engine already eliminates by
 * role/flag; this surface tells a human WHICH sides reconcile so an out-of-balance
 * residual is obvious and confirmable (canon §3: AI proposes; a human confirms).
 *
 * Matching is by equal magnitude within a period across two DIFFERENT entities,
 * greedily and deterministically (both sides sorted by amount desc, then entityId),
 * so the same inputs always yield the same pairing. Whatever does not pair is
 * surfaced as an unmatched residual — the thing an accountant must chase.
 *
 * All money is bigint cents (positive magnitudes on both sides).
 */

export type IcSide = 'AR' | 'AP' | 'REV' | 'EXP';

/** One entity's net intercompany position for a period (positive magnitude). */
export interface IcPosition {
  entityId: string;
  entityName: string;
  periodKey: string; // YYYY-MM
  side: IcSide;
  amountCents: number; // > 0
  accountNumber?: string | null;
}

export interface IcMatchPair {
  periodKey: string;
  leftSide: IcSide;
  rightSide: IcSide;
  leftEntityId: string;
  leftEntityName: string;
  rightEntityId: string;
  rightEntityName: string;
  amountCents: number;
  confidence: number; // 0..1
  reason: string;
}

export interface IcMatchResult {
  matched: IcMatchPair[];
  unmatchedLeft: IcPosition[];
  unmatchedRight: IcPosition[];
  matchedCents: number;
  leftSide: IcSide;
  rightSide: IcSide;
}

/** Exact-amount cross-entity reciprocal match earns this confidence. */
export const IC_MATCH_EXACT_CONFIDENCE = 0.95;

const bySize = (a: IcPosition, b: IcPosition): number =>
  b.amountCents - a.amountCents || a.entityId.localeCompare(b.entityId);

/**
 * Propose reciprocal matches between two sides within each period. A left position
 * matches the first still-unused right position of EQUAL amount on a DIFFERENT
 * entity. Deterministic (both sides sorted). Returns matched pairs plus the
 * unmatched residual on each side.
 */
export function proposeMatches(
  positions: IcPosition[],
  leftSide: IcSide,
  rightSide: IcSide,
): IcMatchResult {
  const left = positions.filter((p) => p.side === leftSide && p.amountCents > 0).sort(bySize);
  const right = positions.filter((p) => p.side === rightSide && p.amountCents > 0).sort(bySize);

  const usedRight = new Set<number>();
  const usedLeft = new Set<number>();
  const matched: IcMatchPair[] = [];
  let matchedCents = 0;

  for (let li = 0; li < left.length; li++) {
    const l = left[li];
    let hitIndex = -1;
    for (let i = 0; i < right.length; i++) {
      if (usedRight.has(i)) continue;
      const r = right[i];
      if (r.periodKey !== l.periodKey) continue;
      if (r.entityId === l.entityId) continue; // reciprocal must be a different entity
      if (r.amountCents !== l.amountCents) continue;
      hitIndex = i;
      break;
    }
    if (hitIndex < 0) continue;
    const r = right[hitIndex];
    usedRight.add(hitIndex);
    usedLeft.add(li);
    matchedCents += l.amountCents;
    matched.push({
      periodKey: l.periodKey,
      leftSide,
      rightSide,
      leftEntityId: l.entityId,
      leftEntityName: l.entityName,
      rightEntityId: r.entityId,
      rightEntityName: r.entityName,
      amountCents: l.amountCents,
      confidence: IC_MATCH_EXACT_CONFIDENCE,
      reason:
        `${l.entityName} ${sideLabel(leftSide)} of ${dollars(l.amountCents)} reciprocates ` +
        `${r.entityName} ${sideLabel(rightSide)} of ${dollars(r.amountCents)} for ${l.periodKey} — ` +
        `an exact cross-entity pair that eliminates on consolidation.`,
    });
  }

  const unmatchedLeft = left.filter((_l, i) => !usedLeft.has(i));
  const unmatchedRight = right.filter((_r, i) => !usedRight.has(i));

  return { matched, unmatchedLeft, unmatchedRight, matchedCents, leftSide, rightSide };
}

/** Propose intercompany AR ↔ AP (due-from ↔ due-to) matches. */
export function proposeArApMatches(positions: IcPosition[]): IcMatchResult {
  return proposeMatches(positions, 'AR', 'AP');
}

/** Propose interdept eliminating REVENUE ↔ COST matches. */
export function proposeRevExpMatches(positions: IcPosition[]): IcMatchResult {
  return proposeMatches(positions, 'REV', 'EXP');
}

function sideLabel(side: IcSide): string {
  switch (side) {
    case 'AR':
      return 'receivable (due-from)';
    case 'AP':
      return 'payable (due-to)';
    case 'REV':
      return 'interdept revenue';
    case 'EXP':
      return 'interdept cost';
  }
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
