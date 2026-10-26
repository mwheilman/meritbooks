/**
 * Wave-3 audit fix #1: ONE close resolver. The live tenant had every 2024 month OPEN (set up
 * before the books went live) and every 2025 month HARD_CLOSE — the month grid said "Closed"
 * twelve times while the legend, the report engine and the Freshness tab said "No month is
 * closed yet", and the picker offered "Last 12 closed months (Oct '25–Sep '26)".
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE_STATE_LABEL,
  closeStatusLabel,
  closedThroughText,
  companyCloseRun,
  lastClosedPresetLabel,
  summarizeClose,
} from './closed';
import { presetLabel, presetMeta } from './picker-model';
import { PERIOD_PRESETS, presetSelection, resolvePeriod, type PeriodContext } from './resolve';
import { closedThrough as governanceClosedThrough } from '@/lib/reports/governance/policy';
import type { CompanyFacts, FiscalPeriodFact } from '@/lib/reports/governance/types';
import { DEFAULT_RELEASE_SETTINGS } from '@/lib/reports/governance/types';

type Row = { locationId: string; year: number; month: number; status: string };
const year = (loc: string, y: number, status: string | ((m: number) => string)): Row[] =>
  Array.from({ length: 12 }, (_, i) => ({ locationId: loc, year: y, month: i + 1, status: typeof status === 'string' ? status : status(i + 1) }));
// The live shape: 2024 open, 2025 hard-closed, Jan–May 2026 soft-closed, the rest open.
const live = (loc: string): Row[] => [
  ...year(loc, 2024, 'OPEN'),
  ...year(loc, 2025, 'HARD_CLOSE'),
  ...year(loc, 2026, (m) => (m <= 5 ? 'SOFT_CLOSE' : 'OPEN')),
  ...year(loc, 2027, 'OPEN'),
];

describe('companyCloseRun / summarizeClose', () => {
  it('open months before the first close do not hide a closed year', () => {
    const s = summarizeClose([...live('a'), ...live('b')]);
    expect(s.closedThrough).toBe('2025-12');
    expect(s.openBefore).toHaveLength(12);
    expect(s.openBefore[0]).toBe('2024-01');
    expect(s.months['2025-06']).toBe('closed');
    expect(s.months['2026-03']).toBe('soft');
  });
  it('a reopened month after the first close pulls closed-through back', () => {
    const r = companyCloseRun([
      { key: '2025-01', status: 'HARD_CLOSE' },
      { key: '2025-02', status: 'OPEN' },
      { key: '2025-03', status: 'HARD_CLOSE' },
    ]);
    expect(r).toEqual({ closedThrough: '2025-01', openBefore: [] });
  });
  it('nothing hard-closed → null; SOFT_CLOSE minimum gives "actuals locked through"', () => {
    const rows = year('a', 2026, (m) => (m <= 5 ? 'SOFT_CLOSE' : 'OPEN')).map((r) => ({ key: `2026-${String(r.month).padStart(2, '0')}`, status: r.status }));
    expect(companyCloseRun(rows).closedThrough).toBeNull();
    expect(companyCloseRun(rows, 'SOFT_CLOSE').closedThrough).toBe('2026-05');
  });
  it('scope = the earliest company', () => {
    const late = [...year('b', 2025, (m) => (m <= 6 ? 'HARD_CLOSE' : 'OPEN'))];
    expect(summarizeClose([...live('a'), ...late]).closedThrough).toBe('2025-06');
  });
});

describe('governance uses the same resolver', () => {
  const facts = (rows: Row[]): CompanyFacts => ({
    locationId: 'a',
    name: 'A',
    fiscalYearStartMonth: 1,
    periods: rows.map<FiscalPeriodFact>((r) => ({ year: r.year, month: r.month, status: r.status as FiscalPeriodFact['status'], endDate: `${r.year}-${String(r.month).padStart(2, '0')}-28`, closedAt: null, reopenReason: null })),
    releases: [],
    restatements: [],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
  });
  it('report engine / Freshness / calendar read Dec 2025, like the picker', () => {
    expect(governanceClosedThrough(facts(live('a')))).toBe('2025-12');
    expect(summarizeClose(live('a')).closedThrough).toBe('2025-12');
  });
});

describe('plain-English states and labels', () => {
  it('one vocabulary', () => {
    expect(CLOSE_STATE_LABEL).toEqual({ open: 'Open', soft: 'Soft-closed', closed: 'Closed', released: 'Released' });
    expect(closeStatusLabel('HARD_CLOSE')).toBe('Closed');
    expect(closeStatusLabel('SOFT_CLOSE')).toBe('Soft-closed');
    expect(closeStatusLabel('OPEN')).toBe('Open');
    expect(closeStatusLabel('NO_PERIOD')).toBe('No period');
  });
  it('closed-through line names earlier open months instead of contradicting the grid', () => {
    expect(closedThroughText(null)).toBe('No month is closed yet');
    expect(closedThroughText('2025-12')).toBe('Books closed through Dec 2025');
    expect(closedThroughText('2025-12', 12)).toBe('Books closed through Dec 2025 · 12 earlier months still open');
    expect(closedThroughText('2025-12', 1)).toBe('Books closed through Dec 2025 · 1 earlier month still open');
  });
  it('"Last 12 closed months" only when something is closed — and then it ends at closed-through', () => {
    const none: PeriodContext = { fyStartMonth: 1, currentMonth: '2026-10', closedThrough: null };
    const dec: PeriodContext = { fyStartMonth: 1, currentMonth: '2026-10', closedThrough: '2025-12' };
    const def = PERIOD_PRESETS.find((p) => p.id === 'last_12_closed')!;
    expect(lastClosedPresetLabel(null)).toBe('Last 12 months');
    expect(presetLabel(def, none)).toBe('Last 12 months');
    expect(presetLabel(def, dec)).toBe('Last 12 closed months');
    expect(presetMeta('last_12_closed', dec)).toBe('Jan–Dec 2025');
    const p = resolvePeriod(presetSelection('last_12_closed', dec), dec);
    expect(p.includesOpenMonths).toBe(false);
  });
});
