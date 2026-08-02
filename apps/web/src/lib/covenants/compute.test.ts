/**
 * Covenant compute engine — deterministic ratio / headroom / breach assertions.
 *
 * The engine is pure (no I/O). These tests pin the ratio math for DSCR / FCCR /
 * leverage / current-ratio / currency covenants, the pass/WARN/BREACH banding and
 * signed headroom, the empty-degrade path (missing/zero denominator → UNKNOWN),
 * and the projected-breach walk (first forward period across the threshold, with
 * linear crossing interpolation).
 */

import { describe, it, expect } from 'vitest';
import {
  computeValue,
  evaluateValue,
  evaluateCovenant,
  projectBreach,
  buildForecastSeries,
  type SeriesPoint,
} from './compute';

// $1.00 = 100 cents. Ratios: cents/cents cancels units, so use round numbers.
const M = (dollars: number) => Math.round(dollars * 100);

describe('computeValue — ratio wiring by covenant type', () => {
  it('DSCR = EBITDA / debt service', () => {
    const cv = computeValue('DSCR', { ebitdaCents: M(2_000_000), debtServiceCents: M(1_000_000) });
    expect(cv.value).toBe(2);
    expect(cv.unit).toBe('RATIO');
    expect(cv.numeratorCents).toBe(M(2_000_000));
    expect(cv.denominatorCents).toBe(M(1_000_000));
  });

  it('FCCR = EBITDA / fixed charges', () => {
    const cv = computeValue('FCCR', { ebitdaCents: M(1_500_000), fixedChargesCents: M(1_200_000) });
    expect(cv.value).toBe(1.25);
  });

  it('LEVERAGE = total (net) debt / EBITDA', () => {
    const cv = computeValue('LEVERAGE', { totalDebtCents: M(10_000_000), ebitdaCents: M(2_500_000) });
    expect(cv.value).toBe(4);
  });

  it('CURRENT_RATIO = current assets / current liabilities', () => {
    const cv = computeValue('CURRENT_RATIO', { currentAssetsCents: M(600_000), currentLiabilitiesCents: M(400_000) });
    expect(cv.value).toBe(1.5);
  });

  it('MIN_LIQUIDITY is a CURRENCY value in dollars', () => {
    const cv = computeValue('MIN_LIQUIDITY', { liquidityCents: M(3_250_000) });
    expect(cv.unit).toBe('CURRENCY');
    expect(cv.value).toBe(3_250_000);
    expect(cv.numeratorCents).toBe(M(3_250_000));
  });

  it('TNW is a CURRENCY value in dollars', () => {
    const cv = computeValue('TNW', { tangibleNetWorthCents: M(5_000_000) });
    expect(cv.unit).toBe('CURRENCY');
    expect(cv.value).toBe(5_000_000);
  });

  it('CUSTOM uses explicit numerator/denominator', () => {
    const cv = computeValue('CUSTOM', { numeratorCents: M(900), denominatorCents: M(300) });
    expect(cv.value).toBe(3);
  });
});

describe('computeValue — empty-degrade', () => {
  it('missing denominator → value null (not a throw)', () => {
    expect(computeValue('DSCR', { ebitdaCents: M(1000) }).value).toBeNull();
  });
  it('zero denominator → value null (no divide-by-zero)', () => {
    expect(computeValue('LEVERAGE', { totalDebtCents: M(1000), ebitdaCents: 0 }).value).toBeNull();
  });
  it('missing currency input → value null', () => {
    expect(computeValue('MIN_LIQUIDITY', {}).value).toBeNull();
  });
});

describe('evaluateValue — MIN direction (DSCR-style)', () => {
  const cov = { threshold: 1.25, dir: 'MIN' as const };

  it('comfortably above → PASS with positive headroom', () => {
    const e = evaluateValue(computeValue('DSCR', { ebitdaCents: M(2000), debtServiceCents: M(1000) }), cov.threshold, cov.dir);
    expect(e.passed).toBe(true);
    expect(e.band).toBe('PASS');
    // (2 − 1.25)/1.25 = 0.6
    expect(e.headroomPct).toBeCloseTo(0.6, 4);
    expect(e.cushion).toBeCloseTo(0.75, 4);
  });

  it('just above but within warn band → WARN', () => {
    // value 1.30 vs 1.25 → headroom 0.04 < 0.10 warn
    const e = evaluateValue(computeValue('DSCR', { ebitdaCents: M(1300), debtServiceCents: M(1000) }), cov.threshold, cov.dir);
    expect(e.passed).toBe(true);
    expect(e.band).toBe('WARN');
  });

  it('below threshold → BREACH with negative headroom', () => {
    const e = evaluateValue(computeValue('DSCR', { ebitdaCents: M(1000), debtServiceCents: M(1000) }), cov.threshold, cov.dir);
    expect(e.passed).toBe(false);
    expect(e.band).toBe('BREACH');
    expect(e.headroomPct).toBeLessThan(0);
  });

  it('exactly at threshold → PASS (>= is satisfied)', () => {
    const e = evaluateValue(computeValue('DSCR', { ebitdaCents: M(1250), debtServiceCents: M(1000) }), cov.threshold, cov.dir, 0.001);
    expect(e.passed).toBe(true);
    expect(e.cushion).toBe(0);
  });
});

describe('evaluateValue — MAX direction (leverage-style)', () => {
  const threshold = 3.5;

  it('below the cap → PASS', () => {
    const e = evaluateCovenant('LEVERAGE', { totalDebtCents: M(3000), ebitdaCents: M(1000) }, threshold, 'MAX');
    expect(e.value).toBe(3);
    expect(e.passed).toBe(true);
    // (3.5 − 3)/3.5 ≈ 0.1428 → PASS (above 0.10 warn)
    expect(e.band).toBe('PASS');
  });

  it('above the cap → BREACH', () => {
    const e = evaluateCovenant('LEVERAGE', { totalDebtCents: M(4000), ebitdaCents: M(1000) }, threshold, 'MAX');
    expect(e.value).toBe(4);
    expect(e.passed).toBe(false);
    expect(e.band).toBe('BREACH');
  });

  it('just under the cap → WARN', () => {
    // value 3.45 vs 3.5 → headroom (3.5-3.45)/3.5 ≈ 0.0143 < 0.10
    const e = evaluateCovenant('LEVERAGE', { totalDebtCents: M(3450), ebitdaCents: M(1000) }, threshold, 'MAX');
    expect(e.band).toBe('WARN');
  });
});

describe('evaluateValue — not computable degrades to UNKNOWN', () => {
  it('null value → band UNKNOWN, passed null', () => {
    const e = evaluateValue(computeValue('DSCR', {}), 1.25, 'MIN');
    expect(e.band).toBe('UNKNOWN');
    expect(e.passed).toBeNull();
    expect(e.headroomPct).toBeNull();
  });
});

describe('projectBreach — first forward period across the threshold', () => {
  it('no breach across horizon → null', () => {
    const s: SeriesPoint[] = [
      { date: '2026-08-01', value: 1.6 },
      { date: '2026-09-01', value: 1.55 },
      { date: '2026-10-01', value: 1.5 },
    ];
    const p = projectBreach(s, 1.25, 'MIN');
    expect(p.breachDate).toBeNull();
    expect(p.breachIndex).toBe(-1);
  });

  it('declining DSCR crosses the minimum → returns first failing period + interpolated crossing', () => {
    const s: SeriesPoint[] = [
      { date: '2026-08-01', value: 1.5 },
      { date: '2026-09-01', value: 1.3 },
      { date: '2026-10-01', value: 1.1 }, // first < 1.25
      { date: '2026-11-01', value: 0.9 },
    ];
    const p = projectBreach(s, 1.25, 'MIN');
    expect(p.breachDate).toBe('2026-10-01');
    expect(p.breachIndex).toBe(2);
    expect(p.breachedAtStart).toBe(false);
    // Between 1.3 (Sep) and 1.1 (Oct): crossing at frac (1.25−1.3)/(1.1−1.3)=0.25 → late Sep.
    expect(p.crossingDate).not.toBeNull();
    expect(p.crossingDate! >= '2026-09-01').toBe(true);
    expect(p.crossingDate! <= '2026-10-01').toBe(true);
  });

  it('rising leverage crosses the MAX cap', () => {
    const s: SeriesPoint[] = [
      { date: '2026-08-01', value: 3.0 },
      { date: '2026-09-01', value: 3.6 }, // first > 3.5
    ];
    const p = projectBreach(s, 3.5, 'MAX');
    expect(p.breachDate).toBe('2026-09-01');
  });

  it('already in breach at period 0 → breachedAtStart', () => {
    const p = projectBreach([{ date: '2026-08-01', value: 1.0 }], 1.25, 'MIN');
    expect(p.breachedAtStart).toBe(true);
    expect(p.breachIndex).toBe(0);
  });

  it('non-computable points are skipped', () => {
    const s: SeriesPoint[] = [
      { date: '2026-08-01', value: null },
      { date: '2026-09-01', value: 1.5 },
      { date: '2026-10-01', value: 1.0 },
    ];
    const p = projectBreach(s, 1.25, 'MIN');
    expect(p.breachDate).toBe('2026-10-01');
  });
});

describe('buildForecastSeries — cash trajectory drives the covenant', () => {
  it('draining cash pushes liquidity below the minimum on a real date', () => {
    const periods = [
      { date: '2026-08-10', cumulativeCashDeltaCents: 0 },
      { date: '2026-08-17', cumulativeCashDeltaCents: M(-1_000_000) },
      { date: '2026-08-24', cumulativeCashDeltaCents: M(-2_500_000) },
    ];
    const s = buildForecastSeries('MIN_LIQUIDITY', { liquidityCents: M(3_000_000) }, 1_000_000, 'MIN', periods);
    // dollars: 3,000,000 → 2,000,000 → 500,000
    expect(s[0].value).toBe(3_000_000);
    expect(s[2].value).toBe(500_000);
    const p = projectBreach(s, 1_000_000, 'MIN');
    expect(p.breachDate).toBe('2026-08-24');
  });

  it('rising cash reduces net debt, keeping leverage under the cap', () => {
    const periods = [
      { date: '2026-08-10', cumulativeCashDeltaCents: 0 },
      { date: '2026-08-17', cumulativeCashDeltaCents: M(500_000) },
    ];
    // Starts compliant at 3.0x (net debt 3.0M / EBITDA 1.0M); cash inflow pulls it to 2.5x.
    const s = buildForecastSeries('LEVERAGE', { totalDebtCents: M(3_000_000), ebitdaCents: M(1_000_000) }, 3.5, 'MAX', periods);
    expect(s[0].value).toBe(3);
    expect(s[1].value).toBe(2.5); // net debt 2.5M / 1M
    const p = projectBreach(s, 3.5, 'MAX');
    expect(p.breachDate).toBeNull(); // both periods pass the MAX cap
  });

  it('flat-EBITDA covenants (DSCR) hold value across the horizon', () => {
    const periods = [
      { date: '2026-08-10', cumulativeCashDeltaCents: 0 },
      { date: '2026-08-17', cumulativeCashDeltaCents: M(-9_000_000) },
    ];
    const s = buildForecastSeries('DSCR', { ebitdaCents: M(2000), debtServiceCents: M(1000) }, 1.25, 'MIN', periods);
    expect(s[0].value).toBe(2);
    expect(s[1].value).toBe(2); // unchanged by cash — DSCR is trailing EBITDA-based
  });
});
