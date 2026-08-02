import { describe, it, expect } from 'vitest';
import {
  proposeArApMatches,
  proposeRevExpMatches,
  proposeMatches,
  type IcPosition,
} from './intercompany-match';

/**
 * Intercompany auto-match correctness (GATE 11a). Reciprocal pairing is by equal
 * magnitude within a period across DIFFERENT entities, deterministic, and never
 * posts — it proposes for a human to confirm and surfaces the unmatched residual.
 */

const pos = (
  entityId: string,
  side: IcPosition['side'],
  amountCents: number,
  periodKey = '2026-03',
): IcPosition => ({ entityId, entityName: entityId, periodKey, side, amountCents });

describe('AR ↔ AP matching', () => {
  it('pairs an equal due-from and due-to across two entities', () => {
    const r = proposeArApMatches([pos('A', 'AR', 75_000), pos('B', 'AP', 75_000)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].leftEntityId).toBe('A');
    expect(r.matched[0].rightEntityId).toBe('B');
    expect(r.matched[0].amountCents).toBe(75_000);
    expect(r.matchedCents).toBe(75_000);
    expect(r.unmatchedLeft).toHaveLength(0);
    expect(r.unmatchedRight).toHaveLength(0);
  });

  it('leaves an unequal pair unmatched (the residual an accountant must chase)', () => {
    const r = proposeArApMatches([pos('A', 'AR', 50_000), pos('B', 'AP', 40_000)]);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatchedLeft).toHaveLength(1);
    expect(r.unmatchedRight).toHaveLength(1);
  });

  it('does not match two sides on the SAME entity', () => {
    const r = proposeArApMatches([pos('A', 'AR', 10_000), pos('A', 'AP', 10_000)]);
    expect(r.matched).toHaveLength(0);
  });

  it('does not match across different periods', () => {
    const r = proposeArApMatches([pos('A', 'AR', 20_000, '2026-03'), pos('B', 'AP', 20_000, '2026-04')]);
    expect(r.matched).toHaveLength(0);
  });

  it('deterministically pairs when multiple equal amounts exist', () => {
    const r = proposeArApMatches([
      pos('A', 'AR', 30_000),
      pos('C', 'AR', 30_000),
      pos('B', 'AP', 30_000),
      pos('D', 'AP', 30_000),
    ]);
    expect(r.matched).toHaveLength(2);
    expect(r.matchedCents).toBe(60_000);
    expect(r.unmatchedLeft).toHaveLength(0);
    expect(r.unmatchedRight).toHaveLength(0);
  });
});

describe('REV ↔ EXP matching', () => {
  it('pairs equal interdept revenue and cost across entities', () => {
    const r = proposeRevExpMatches([pos('A', 'REV', 20_000), pos('B', 'EXP', 20_000)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].leftSide).toBe('REV');
    expect(r.matched[0].rightSide).toBe('EXP');
    expect(r.matchedCents).toBe(20_000);
  });
});

describe('proposeMatches generic', () => {
  it('ignores non-positive amounts', () => {
    const r = proposeMatches([pos('A', 'AR', 0), pos('B', 'AP', 0)], 'AR', 'AP');
    expect(r.matched).toHaveLength(0);
  });
});
