import { describe, expect, it } from 'vitest';
import { addMonths } from './months';
import type { MonthlySeries } from './series';
import { bestWorstMonth, quarterShares, seasonalityIndex, seasonalOverlay } from './seasonality';
import { leagueTable } from './league';
import { hhi, overThreshold, paretoCount, topNShare } from './concentration';
import { detectAnomalies, zScore } from './anomaly';
import { linearForecast, seasonalNaive } from './forecast';

const series = (from: string, values: (number | null)[]): MonthlySeries => values.map((value, i) => ({ month: addMonths(from, i), value }));
const pattern = [80, 80, 100, 110, 120, 130, 130, 120, 110, 100, 60, 60];

describe('seasonality (AC-K8)', () => {
  it('index averages exactly 1.00 over complete years and ignores incomplete ones', () => {
    const s = series('2023-01', [...pattern, ...pattern.map((v) => v * 2), ...pattern.slice(0, 5)]); // 2 complete years + 5 months
    const idx = seasonalityIndex(s);
    expect(idx.yearsUsed).toEqual([2023, 2024]);
    const values = idx.index as number[];
    expect(values.reduce((a, b) => a + b, 0) / 12).toBeCloseTo(1, 12);
    expect(values[0]).toBeCloseTo(0.8, 12);
    expect(values[6]).toBeCloseTo(1.3, 12);
    expect(idx.referenceAverage).toBe(200);
  });
  it('a year with a gap is skipped, never padded', () => {
    const gapped = [...pattern];
    gapped[3] = null as unknown as number;
    const idx = seasonalityIndex(series('2023-01', [...pattern, ...(gapped as (number | null)[])]));
    expect(idx.yearsUsed).toEqual([2023]);
    expect(idx.yearsSkipped).toEqual([2024]);
  });
  it('no complete year → all null', () => {
    expect(seasonalityIndex(series('2026-01', [1, 2, 3])).index.every((v) => v === null)).toBe(true);
  });
  it('fiscal-year blocks and the current-year overlay', () => {
    const s = series('2023-07', [...pattern, 100, 100]);
    const idx = seasonalityIndex(s, { fyStartMonth: 7 });
    expect(idx.yearsUsed).toEqual([2024]);
    const overlay = seasonalOverlay(s, idx, '2024-07', '2024-09');
    expect(overlay[0].ratio).toBeCloseTo(1, 12);
    expect(overlay[2].ratio).toBeNull();
  });
  it('quarter shares sum to 1', () => {
    const q = quarterShares(series('2023-01', [...pattern, ...pattern]));
    expect((q.shares as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(q.shares[0]).toBeCloseTo(260 / 1200, 12);
  });
  it('best / worst month skips gaps', () => {
    const r = bestWorstMonth(series('2026-01', [5, null, 9, 1, 9]), '2026-01', '2026-05');
    expect(r.best).toEqual({ month: '2026-03', value: 9 });
    expect(r.worst).toEqual({ month: '2026-04', value: 1 });
    expect(r.monthsConsidered).toBe(4);
  });
});

describe('league tables', () => {
  it('competition ranking, direction aware, nulls last, weighted shares', () => {
    const t = leagueTable(
      [
        { id: 'a', label: 'Alpha', value: 300, weight: 1 },
        { id: 'b', label: 'Bravo', value: 500, weight: 0.6 },
        { id: 'c', label: 'Charlie', value: 300, weight: 1 },
        { id: 'd', label: 'Delta', value: null, reason: 'Not enough history' },
      ],
      { share: true },
    );
    expect(t.rows.map((r) => [r.id, r.rank])).toEqual([['b', 1], ['a', 2], ['c', 2], ['d', null]]);
    expect(t.weightedTotal).toBe(900);
    expect(t.rows[0].share).toBeCloseTo(300 / 900, 12);
    expect(t.rows[3]).toMatchObject({ share: null, reason: 'Not enough history' });
    const asc = leagueTable([{ id: 'x', label: 'X', value: 40 }, { id: 'y', label: 'Y', value: 30 }], { direction: 'lower_better' });
    expect(asc.rows[0].id).toBe('y');
  });
  it('stale flags', () => {
    const t = leagueTable([{ id: 'a', label: 'A', value: 1, asOf: '2026-07' }], { latestMonth: '2026-09' });
    expect(t.rows[0].stale).toBe(true);
  });
});

describe('concentration', () => {
  const amounts = [
    { key: 'c1', cents: 500 },
    { key: 'c2', cents: 300 },
    { key: 'c3', cents: 200 },
    { key: 'refund', cents: -50 },
  ];
  it('top-N share and HHI match hand calculations', () => {
    expect(topNShare(amounts, 1)).toBe(0.5);
    expect(topNShare(amounts, 2)).toBe(0.8);
    expect(hhi(amounts)).toEqual({ value: 3800, band: 'high', participants: 3 });
    expect(hhi(Array.from({ length: 10 }, (_, i) => ({ key: String(i), cents: 1 }))).band).toBe('unconcentrated');
    expect(hhi([])).toEqual({ value: null, band: null, participants: 0 });
  });
  it('flags customers over 10% and counts the Pareto set', () => {
    expect(overThreshold(amounts).map((r) => r.key)).toEqual(['c1', 'c2', 'c3']);
    expect(paretoCount(amounts, 0.8)).toBe(2);
  });
});

describe('anomalies', () => {
  it('z-score vs the trailing window, excluding the point itself', () => {
    expect(zScore(10, [1, 2, 3])).toBeCloseTo(8, 12);
    const s = series('2025-01', [100, 102, 98, 101, 99, 100, 103, 97, 100, 250]);
    const pts = detectAnomalies(s, { minHistory: 6, threshold: 3 });
    expect(pts[9].flagged).toBe(true);
    expect(pts[9].direction).toBe('above');
    expect(pts[3]).toMatchObject({ flagged: false, reason: 'not_enough_history' });
  });
  it('gaps are skipped, not zeroed; a flat baseline flags any change without a z', () => {
    const pts = detectAnomalies(series('2025-01', [5, 5, null, 5, 5, 5, 5, 9]), { minHistory: 6 });
    expect(pts[2].reason).toBe('gap');
    expect(pts[7]).toMatchObject({ flagged: true, z: null, flatBaseline: true });
  });
});

describe('forecast bands widen monotonically (AC-K8)', () => {
  const noisy = series('2024-01', [100, 108, 103, 115, 111, 120, 118, 129, 124, 133, 131, 140, 138, 147, 142, 155, 151, 160]);
  it('linear trend: honest band that widens with horizon', () => {
    const f = linearForecast(noisy, { horizon: 12, confidence: 0.8 });
    if (!f.ok) throw new Error('expected ok');
    expect(f.slopePerMonth).toBeGreaterThan(0);
    const widths = f.points.map((p) => p.upper - p.lower);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    expect(f.points[0].month).toBe('2025-07');
    for (const p of f.points) expect(p.lower).toBeLessThanOrEqual(p.value);
  });
  it('95% bands are wider than 80% bands', () => {
    const a = linearForecast(noisy, { horizon: 3, confidence: 0.8 });
    const b = linearForecast(noisy, { horizon: 3, confidence: 0.95 });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(b.points[2].upper - b.points[2].lower).toBeGreaterThan(a.points[2].upper - a.points[2].lower);
  });
  it('seasonal naive repeats last year and widens each season', () => {
    const s = series('2023-01', [...pattern, ...pattern.map((v) => v + 10)]);
    const f = seasonalNaive(s, { horizon: 24 });
    if (!f.ok) throw new Error('expected ok');
    expect(f.points[0].value).toBe(90); // Jan of the last year
    const widths = f.points.map((p) => p.upper - p.lower);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    expect(widths[12]).toBeGreaterThan(widths[11]);
  });
  it('refuses to forecast from too little history', () => {
    expect(linearForecast(series('2026-01', [1, 2, 3]), { horizon: 3 })).toMatchObject({ ok: false, reason: 'not_enough_history', monthsOnFile: 3 });
    expect(seasonalNaive(series('2026-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), { horizon: 3 })).toMatchObject({ ok: false });
  });
});
