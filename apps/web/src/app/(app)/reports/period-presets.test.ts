import { describe, it, expect } from 'vitest';
import { PERIOD_OPTIONS, isPeriodKey, localIsoDate, periodRange, utcIsoDate } from './period-presets';

describe('report period presets — pure, from an explicit today (hydration-safe)', () => {
  it('computes every preset from the given date', () => {
    const t = '2026-10-21';
    expect(periodRange('this_month', t)).toEqual({ s: '2026-10-01', e: '2026-10-31' });
    expect(periodRange('last_month', t)).toEqual({ s: '2026-09-01', e: '2026-09-30' });
    expect(periodRange('this_qtr', t)).toEqual({ s: '2026-10-01', e: '2026-12-31' });
    expect(periodRange('last_qtr', t)).toEqual({ s: '2026-07-01', e: '2026-09-30' });
    expect(periodRange('ytd', t)).toEqual({ s: '2026-01-01', e: '2026-10-21' });
    expect(periodRange('ytd_closed', t)).toEqual({ s: '2026-01-01', e: '2026-09-30' });
    expect(periodRange('last_year', t)).toEqual({ s: '2025-01-01', e: '2025-12-31' });
    expect(periodRange('last_12', t)).toEqual({ s: '2025-10-22', e: '2026-10-21' });
    expect(periodRange('custom', t)).toEqual({ s: '', e: '' });
  });

  it('rolls over year boundaries and leap days', () => {
    expect(periodRange('last_month', '2026-01-15')).toEqual({ s: '2025-12-01', e: '2025-12-31' });
    expect(periodRange('last_qtr', '2026-02-10')).toEqual({ s: '2025-10-01', e: '2025-12-31' });
    expect(periodRange('ytd_closed', '2026-01-05')).toEqual({ s: '2026-01-01', e: '2025-12-31' });
    expect(periodRange('this_month', '2028-02-03')).toEqual({ s: '2028-02-01', e: '2028-02-29' });
    expect(periodRange('last_12', '2026-12-31')).toEqual({ s: '2026-01-01', e: '2026-12-31' });
  });

  it('is deterministic: the same today gives the same range on server and client', () => {
    for (const p of PERIOD_OPTIONS) expect(periodRange(p.key, '2026-03-31')).toEqual(periodRange(p.key, '2026-03-31'));
    expect(periodRange('this_month', 'garbage')).toEqual({ s: '', e: '' });
  });

  it('date helpers and the key guard', () => {
    const d = new Date(Date.UTC(2026, 9, 21, 23, 30));
    expect(utcIsoDate(d)).toBe('2026-10-21');
    expect(localIsoDate(new Date(2026, 0, 2, 12))).toBe('2026-01-02');
    expect(isPeriodKey('ytd')).toBe(true);
    expect(isPeriodKey('yesterday')).toBe(false);
    expect(isPeriodKey(undefined)).toBe(false);
  });
});
