/**
 * Team Performance — pure math tests (FPB-team-performance Dim 8.3 acceptance).
 *
 * The three load-bearing fairness constructs:
 *   1. Difficulty-WEIGHTED composite (T7): a small volume of hard work beats a
 *      large volume of trivial work — volume alone can't win.
 *   2. The quality GATE (M1): a high-composite person over the rework threshold
 *      is flagged and CANNOT be the surfaced top performer.
 *   3. Cycle-time average: nulls (e.g. categorized_at unset on historical rows)
 *      are "n/a", never a misleading 0.
 */

import { describe, it, expect } from 'vitest';
import {
  computeThroughput,
  resolveWorkActions,
  resolveTargets,
  buildLeaderboard,
  averageLatencyMs,
  medianLatencyMs,
  latencyMs,
  safeRate,
  DEFAULT_WORK_ACTIONS,
  type ScorecardInput,
  type ThroughputResult,
} from './compute';

const catalog = resolveWorkActions(null);

function card(over: Partial<ScorecardInput> & { userId: string }): ScorecardInput {
  return {
    name: over.userId,
    throughput: { composite: 0, totalActions: 0, byFamily: computeThroughput([], catalog).byFamily },
    overrideRate: null,
    overrideSample: 0,
    reworkRate: null,
    reworkSample: 0,
    ...over,
  };
}

describe('computeThroughput — difficulty weighting (T7, anti-gaming)', () => {
  it('weights hard work above trivial volume', () => {
    // Junior: 100 one-click bank-feed approvals (weight 1 each) = 100.
    const junior = computeThroughput(Array(100).fill('bankfeed.approve'), catalog);
    // Senior: 34 accrual JEs (weight 3 each) = 102 — fewer actions, higher composite.
    const senior = computeThroughput(Array(34).fill('gl.post'), catalog);

    expect(junior.totalActions).toBe(100);
    expect(junior.composite).toBe(100);
    expect(senior.totalActions).toBe(34);
    expect(senior.composite).toBe(102);
    // The senior does FEWER actions but OUTSCORES on the composite — the whole point.
    expect(senior.composite).toBeGreaterThan(junior.composite);
    expect(senior.totalActions).toBeLessThan(junior.totalActions);
  });

  it('ignores unknown/unweighted actions (noise cannot inflate score)', () => {
    const r = computeThroughput(['bankfeed.approve', 'ai.categorize.proposed', 'login', 'accept'], catalog);
    expect(r.totalActions).toBe(1); // only bankfeed.approve counts
    expect(r.composite).toBe(1);
    expect(r.byFamily.categorize).toBe(1);
  });

  it('buckets by family and sums weights', () => {
    const r = computeThroughput(['bill.create', 'bill.approve', 'reconciliation.finalize'], catalog);
    expect(r.byFamily.bill).toBe(1);
    expect(r.byFamily.approve).toBe(1);
    expect(r.byFamily.reconcile).toBe(1);
    expect(r.composite).toBe(1 + 1.5 + 4);
  });
});

describe('resolveWorkActions — tenant weight overrides (fairness = config)', () => {
  it('overrides a default weight and can introduce a new action as "other"', () => {
    const custom = resolveWorkActions({ 'gl.post': 5, 'custom.workstream': 2 });
    expect(custom['gl.post'].weight).toBe(5);
    expect(custom['gl.post'].family).toBe('journal'); // family preserved
    expect(custom['custom.workstream']).toEqual({ family: 'other', weight: 2 });
    // Defaults untouched by the override object identity.
    expect(DEFAULT_WORK_ACTIONS['gl.post'].weight).toBe(3);
  });

  it('rejects invalid weights', () => {
    const custom = resolveWorkActions({ 'gl.post': -1, 'bill.create': Number.NaN });
    expect(custom['gl.post'].weight).toBe(3); // unchanged
    expect(custom['bill.create'].weight).toBe(1); // unchanged
  });
});

describe('buildLeaderboard — quality GATE (M1, anti-gaming)', () => {
  const targets = resolveTargets(null); // reworkGate 0.08

  const tp = (composite: number): ThroughputResult => ({
    composite,
    totalActions: composite,
    byFamily: computeThroughput([], catalog).byFamily,
  });

  it('ranks by composite but a flagged high-scorer cannot be top performer', () => {
    const cards: ScorecardInput[] = [
      card({ userId: 'sloppy', throughput: tp(100), reworkRate: 0.2, reworkSample: 50 }), // highest, but over gate
      card({ userId: 'solid', throughput: tp(80), reworkRate: 0.02, reworkSample: 50 }), // clean
      card({ userId: 'newbie', throughput: tp(10), reworkRate: null, reworkSample: 0 }),
    ];
    const lb = buildLeaderboard(cards, targets);

    expect(lb.entries[0].userId).toBe('sloppy'); // still ranked #1 by composite (transparency)
    expect(lb.entries[0].qualityFlag).toBe(true); // but flagged
    expect(lb.topPerformerUserId).toBe('solid'); // the GATE: winner is the highest CLEAN scorer
  });

  it('null rework (no data) does not trip the gate', () => {
    const cards = [card({ userId: 'a', throughput: tp(50), reworkRate: null })];
    const lb = buildLeaderboard(cards, targets);
    expect(lb.entries[0].qualityFlag).toBe(false);
    expect(lb.topPerformerUserId).toBe('a');
  });

  it('nobody with a positive clean composite => no top performer', () => {
    const cards = [card({ userId: 'z', throughput: tp(0), reworkRate: null })];
    expect(buildLeaderboard(cards, targets).topPerformerUserId).toBeNull();
  });
});

describe('cycle-time helpers — null is "n/a", never 0', () => {
  it('latencyMs returns null on missing/invalid/negative intervals', () => {
    expect(latencyMs(null, '2026-01-01T00:00:00Z')).toBeNull();
    expect(latencyMs('2026-01-01T00:00:00Z', null)).toBeNull();
    expect(latencyMs('2026-01-01T02:00:00Z', '2026-01-01T00:00:00Z')).toBeNull(); // negative
    expect(latencyMs('2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')).toBe(2 * 3_600_000);
  });

  it('averageLatencyMs skips nulls and is null when there is no datapoint', () => {
    expect(averageLatencyMs([])).toBeNull();
    expect(averageLatencyMs([null, null])).toBeNull(); // e.g. categorized_at unset everywhere
    expect(averageLatencyMs([1000, null, 3000])).toBe(2000); // nulls skipped, NOT counted as 0
  });

  it('medianLatencyMs handles even/odd and empties', () => {
    expect(medianLatencyMs([])).toBeNull();
    expect(medianLatencyMs([10, null, 30, 20])).toBe(20); // [10,20,30] odd
    expect(medianLatencyMs([10, 20, 30, 40])).toBe(25); // even => mean of middle two
  });
});

describe('safeRate — denominator 0 is n/a', () => {
  it('null when no sample, ratio otherwise', () => {
    expect(safeRate(0, 0)).toBeNull();
    expect(safeRate(3, 12)).toBe(0.25);
  });
});
