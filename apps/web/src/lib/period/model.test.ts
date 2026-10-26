import { describe, expect, it } from 'vitest';
import { parsePeriodQuery, periodQueryEntries, sameSelection, withPeriodQuery } from './url';
import { fromPreferenceSample, parseRemembered, toPreferenceSample, toRemembered } from './memory';
import { summarizeClose } from './closed';
import { cellRole, comparisonOptions, isSelectable, presetMeta, presetOptions, previewWindow, selectionForMonth, stepSelection, windowOptions } from './picker-model';
import type { PeriodContext } from './resolve';

const CAL: PeriodContext = { fyStartMonth: 1, currentMonth: '2026-10', closedThrough: '2026-08' };
const q = (s: string) => new URLSearchParams(s);

describe('URL codec', () => {
  it('reads the documented shapes', () => {
    expect(parsePeriodQuery(q('period=2026-09'))).toEqual({ basis: 'month', end: '2026-09' });
    expect(parsePeriodQuery(q('period=2026-09&basis=ttm'))).toEqual({ basis: 'ttm', end: '2026-09' });
    expect(parsePeriodQuery(q('period=2026-03&basis=range&from=2026-01'))).toEqual({ basis: 'range', end: '2026-03', start: '2026-01' });
    expect(parsePeriodQuery(q('period=2026-09&basis=ytd&compare=prior_year'))).toEqual({ basis: 'ytd', end: '2026-09', compare: 'prior_year' });
  });
  it('rejects junk; unknown basis falls back to month', () => {
    expect(parsePeriodQuery(q('period=2026-13'))).toBeNull();
    expect(parsePeriodQuery(q(''))).toBeNull();
    expect(parsePeriodQuery(q('period=2026-09&basis=weekly'))).toEqual({ basis: 'month', end: '2026-09' });
  });
  it('round-trips and keeps unrelated keys', () => {
    const sel = { basis: 'range' as const, start: '2026-01', end: '2026-03', compare: 'prior_year' as const };
    const s = withPeriodQuery('?tab=reports&period=2025-01', sel);
    const back = parsePeriodQuery(q(s.slice(1)));
    expect(back).toEqual(sel);
    expect(s).toContain('tab=reports');
    // month basis drops the basis key; none drops compare
    expect(periodQueryEntries({ basis: 'month', end: '2026-09', compare: 'none' })).toEqual({ period: '2026-09', basis: null, from: null, compare: null });
  });
  it('supports a prefix for a second picker', () => {
    expect(parsePeriodQuery(q('cmp_period=2026-02&cmp_basis=quarter'), 'cmp_')).toEqual({ basis: 'quarter', end: '2026-02' });
  });
  it('sameSelection ignores preset', () => {
    expect(sameSelection({ basis: 'ytd', end: '2026-10', preset: 'ytd' }, { basis: 'ytd', end: '2026-10' })).toBe(true);
    expect(sameSelection({ basis: 'ytd', end: '2026-10' }, { basis: 'ttm', end: '2026-10' })).toBe(false);
  });
});

describe('per-page memory', () => {
  it('remembers a preset as the preset (stays relative)', () => {
    expect(toRemembered({ basis: 'ytd', end: '2026-10', preset: 'ytd', compare: 'prior_year' })).toEqual({ preset: 'ytd', compare: 'prior_year' });
  });
  it('remembers a concrete pick as its months', () => {
    expect(toRemembered({ basis: 'range', start: '2026-01', end: '2026-03', preset: 'custom' })).toEqual({ selection: { basis: 'range', start: '2026-01', end: '2026-03' } });
  });
  it('parses defensively', () => {
    expect(parseRemembered('{"preset":"ttm"}')).toEqual({ preset: 'ttm' });
    expect(parseRemembered('not json')).toBeNull();
    expect(parseRemembered('{"selection":{"basis":"nope","end":"2026-01"}}')).toBeNull();
    expect(parseRemembered(JSON.stringify({ selection: { basis: 'month', end: '2026-01', compare: 'budget' } }))).toEqual({ selection: { basis: 'month', end: '2026-01', compare: 'budget' } });
  });
  it('learned-preference samples are flat and only presets travel across devices', () => {
    const sample = toPreferenceSample({ preset: 'ytd', compare: 'prior_year' });
    expect(sample).toEqual({ preset: 'ytd', compare: 'prior_year' });
    expect(fromPreferenceSample(sample)).toEqual({ preset: 'ytd', compare: 'prior_year' });
    expect(fromPreferenceSample(toPreferenceSample({ selection: { basis: 'month', end: '2026-01' } }))).toBeNull();
  });
});

describe('summarizeClose', () => {
  const rows = (loc: string, states: Array<[number, number, string]>) => states.map(([year, month, status]) => ({ locationId: loc, year, month, status }));
  it('closed through the earliest company in scope', () => {
    const s = summarizeClose([
      ...rows('a', [[2026, 7, 'HARD_CLOSE'], [2026, 8, 'HARD_CLOSE'], [2026, 9, 'SOFT_CLOSE']]),
      ...rows('b', [[2026, 7, 'HARD_CLOSE'], [2026, 8, 'OPEN'], [2026, 9, 'OPEN']]),
    ]);
    expect(s.closedThrough).toBe('2026-07');
    expect(s.months).toEqual({ '2026-07': 'closed', '2026-08': 'open', '2026-09': 'open' });
  });
  it('soft when every company is at least soft-closed', () => {
    const s = summarizeClose(rows('a', [[2026, 1, 'HARD_CLOSE'], [2026, 2, 'SOFT_CLOSE']]));
    expect(s.months['2026-02']).toBe('soft');
    expect(s.closedThrough).toBe('2026-01');
  });
  it('a gap ends the contiguous run', () => {
    expect(summarizeClose(rows('a', [[2026, 1, 'HARD_CLOSE'], [2026, 3, 'HARD_CLOSE']])).closedThrough).toBe('2026-01');
  });
  it('a company with nothing hard-closed → null; empty → null', () => {
    expect(summarizeClose([...rows('a', [[2026, 1, 'HARD_CLOSE']]), ...rows('b', [[2026, 1, 'OPEN']])]).closedThrough).toBeNull();
    expect(summarizeClose([])).toEqual({ closedThrough: null, months: {}, companies: 0, openBefore: [] });
  });
});

describe('picker model', () => {
  it('a month click under each window', () => {
    expect(selectionForMonth('2026-06', 'ytd', 'prior_year')).toEqual({ basis: 'ytd', end: '2026-06', compare: 'prior_year' });
    expect(selectionForMonth('2026-02', 'range', 'none', '2026-05')).toEqual({ basis: 'range', start: '2026-02', end: '2026-05', preset: 'custom' });
  });
  it('future months are inert; a started quarter / year is not', () => {
    expect(isSelectable('2026-11', 'month', CAL)).toBe(false);
    expect(isSelectable('2026-11', 'quarter', CAL)).toBe(true);
    expect(isSelectable('2027-01', 'quarter', CAL)).toBe(false);
    expect(isSelectable('2026-12', 'fy', CAL)).toBe(true);
  });
  it('stepper moves by the natural length and never past today', () => {
    expect(stepSelection({ basis: 'month', end: '2026-10' }, 1, CAL)).toBeNull();
    expect(stepSelection({ basis: 'month', end: '2026-10' }, -1, CAL)).toMatchObject({ end: '2026-09' });
    expect(stepSelection({ basis: 'quarter', end: '2026-08' }, 1, CAL)).toMatchObject({ basis: 'quarter', end: '2026-12' });
    expect(stepSelection({ basis: 'quarter', end: '2026-12' }, 1, CAL)).toBeNull();
    expect(stepSelection({ basis: 'fy', end: '2025-12' }, -1, CAL)).toMatchObject({ end: '2024-12' });
    expect(stepSelection({ basis: 'range', start: '2026-01', end: '2026-03' }, 1, CAL)).toMatchObject({ start: '2026-04', end: '2026-06' });
  });
  it('preview window + cell roles', () => {
    const w = previewWindow('2026-09', 'ytd', CAL);
    expect(w).toEqual({ start: '2026-01', end: '2026-09' });
    expect(cellRole('2026-01', w)).toBe('end');
    expect(cellRole('2026-05', w)).toBe('in');
    expect(cellRole('2026-10', w)).toBe('out');
  });
  it('preset meta reads today\'s months, short years across a boundary', () => {
    expect(presetMeta('ytd', CAL)).toBe('Jan–Oct 2026');
    expect(presetMeta('ttm', CAL)).toBe('Nov ’25–Oct ’26');
    expect(presetMeta('last_month', CAL)).toBe('Sep 2026');
  });
  it('host capability filters', () => {
    expect(presetOptions(['month']).map((p) => p.id)).toEqual(['this_month', 'last_month']);
    expect(windowOptions(['month'])).toEqual(['month']);
    expect(comparisonOptions(undefined)).toEqual([]);
    expect(comparisonOptions(['prior_year'])).toEqual(['none', 'prior_year']);
  });
});
