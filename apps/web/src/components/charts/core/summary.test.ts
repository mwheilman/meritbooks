import { describe, expect, it } from 'vitest';
import {
  describeSparkline,
  summarizeAging,
  summarizeBridge,
  summarizeBullet,
  summarizeRuleOf40,
  summarizeShares,
  summarizeThreshold,
  summarizeTimeSeries,
  summarizeVariance,
  timeSeriesFootnotes,
} from './summary';
import type { TimeSeriesData } from './types';

const base: TimeSeriesData = {
  periods: [
    { key: '2026-07', label: 'Jul', longLabel: 'Jul 2026' },
    { key: '2026-08', label: 'Aug', longLabel: 'Aug 2026' },
  ],
  actual: [1_100_000_00, 1_240_000_00],
  priorYear: [1_000_000_00, 1_096_000_00],
  ttm: [12_900_000_00, 13_400_000_00],
};

describe('deterministic summary sentences', () => {
  it('time series: value, YoY with direction word, TTM', () => {
    expect(summarizeTimeSeries({ metric: 'Revenue', unit: 'money', direction: 'higher_is_better', data: base })).toBe(
      'Revenue was $1.2M in Aug 2026, up 13.1% on a year earlier (an improvement). The trailing twelve months total $13M.',
    );
  });

  it('lower-is-better metrics say erosion', () => {
    const s = summarizeTimeSeries({ metric: 'DSO', unit: 'days', direction: 'lower_is_better', data: { periods: base.periods, actual: [41, 48], priorYear: [40, 42] } });
    expect(s).toBe('DSO was 48 days in Aug 2026, up 14.3% on a year earlier (an erosion).');
  });

  it('margins move in points', () => {
    const s = summarizeTimeSeries({ metric: 'Gross margin', unit: 'percent', direction: 'higher_is_better', data: { periods: base.periods, actual: [0.3, 0.312], priorYear: [0.29, 0.298] } });
    expect(s).toContain('up 1.4 pts');
  });

  it('names the preliminary month and a trailing gap', () => {
    const s = summarizeTimeSeries({
      metric: 'Revenue',
      unit: 'money',
      direction: 'higher_is_better',
      data: { periods: [...base.periods.slice(0, 1).map((p) => ({ ...p, status: 'preliminary' as const })), base.periods[1]], actual: [1_100_000_00, null] },
    });
    expect(s).toContain('(preliminary — the month is not closed)');
    expect(s).toContain('Aug 2026 is not on file yet.');
  });

  it('n/m base: compares absolutely instead of a misleading %', () => {
    const s = summarizeTimeSeries({ metric: 'EBITDA', unit: 'money', direction: 'higher_is_better', data: { periods: base.periods, actual: [0, 50_000_00], priorYear: [0, -20_000_00] } });
    expect(s).toContain('compared with ($20K) a year earlier');
    expect(s).not.toMatch(/%/);
  });

  it('empty series', () => {
    expect(summarizeTimeSeries({ metric: 'Revenue', unit: 'money', direction: 'higher_is_better', data: { periods: base.periods, actual: [null, null] } })).toBe('Revenue has no figures for this period yet.');
  });

  it('bridge names the largest step and flags a bridge that does not tie', () => {
    const steps = [
      { key: 's', label: 'FY 2025', kind: 'start' as const, value: 1_800_000_00 },
      { key: 'gm', label: 'Gross margin', kind: 'delta' as const, value: 610_000_00 },
      { key: 'p', label: 'Payroll', kind: 'delta' as const, value: -190_000_00 },
      { key: 'e', label: 'FY 2026', kind: 'end' as const, value: 2_220_000_00 },
    ];
    expect(summarizeBridge('EBITDA', steps)).toBe('EBITDA rose $420K from $1.8M (FY 2025) to $2.2M (FY 2026). The largest step is gross margin (+$610K).');
    expect(summarizeBridge('EBITDA', steps.map((s) => (s.key === 'e' ? { ...s, value: 2_221_000_00 } : s)))).toContain('do not tie');
  });

  it('shares, aging, variance, threshold, bullet, rule of 40, sparkline', () => {
    expect(summarizeShares('Revenue', [{ key: 'a', label: 'Acme', value: 600 }, { key: 'b', label: 'Bolt', value: 300 }, { key: 'c', label: 'Cove', value: 100 }])).toBe(
      'Acme is 60.0% of revenue ($6); 2 customers are over 10% each.',
    );
    expect(summarizeAging([{ key: 'c', label: 'Current' }, { key: 'o', label: 'Over 90' }], [{ key: 'a', label: 'Acme', values: [700_00, 300_00] }])).toBe(
      '$1K is outstanding; $300 (30.0%) is over 90, most of it Acme.',
    );
    expect(summarizeVariance('Opex', [{ label: 'Payroll', actual: 152_000_00, plan: 100_000_00, direction: 'lower_is_better' }, { label: 'Rent', actual: 90_00, plan: 100_00, direction: 'lower_is_better' }])).toBe(
      'Opex is $52K worse than budget overall; the largest gap is payroll ($52K worse).',
    );
    expect(summarizeThreshold('Debt / EBITDA', 2.4, 3.5, 'max', 'multiple')).toBe('Debt / EBITDA is 2.4x against a 3.5x maximum: 31.4% headroom.');
    expect(summarizeThreshold('DSCR', 1.1, 1.25, 'min', 'multiple')).toBe('DSCR is 1.1x against a 1.25x minimum: in breach by 12.0%.');
    expect(summarizeBullet('Revenue', 8_100_000_00, 8_400_000_00, 'money', 'higher_is_better')).toBe('Revenue is $8.1M, 96.4% of the $8.4M target (behind).');
    expect(summarizeRuleOf40([{ label: 'Heritage', x: 0.3, y: 0.22 }, { label: 'Swan', x: 0.05, y: 0.1 }, { label: 'New', x: null, y: 0.1 }])).toBe(
      '1 of 2 companies clear the Rule of 40; Heritage leads at 52. 1 company has too little history to score.',
    );
    expect(describeSparkline('Revenue', [100_00, null, 300_00], 'money', ['Jun', 'Jul', 'Aug'])).toBe('Revenue, Jun – Aug: from $100 to $300; high $300 (Aug); 1 period missing.');
  });

  it('keeps acronyms mid-sentence (EBITDA, not ebitda)', () => {
    expect(summarizeShares('EBITDA', [{ key: 'a', label: 'Acme', value: 100 }])).toContain('of EBITDA');
    expect(summarizeShares('Gross Profit', [{ key: 'a', label: 'Acme', value: 100 }])).toContain('of gross profit');
  });

  it('footnotes name preliminary, forecast and gaps', () => {
    const notes = timeSeriesFootnotes({
      periods: [
        { key: 'a', label: 'Jun', longLabel: 'Jun 2026' },
        { key: 'b', label: 'Jul', longLabel: 'Jul 2026', status: 'preliminary' },
        { key: 'c', label: 'Aug', longLabel: 'Aug 2026', status: 'forecast' },
      ],
      actual: [null, 5, 6],
    });
    expect(notes).toEqual(['Jul 2026 is preliminary (hatched)', 'Aug 2026 forecast (dotted)', 'Jun 2026 not on file (gap, not zero)']);
  });
});
