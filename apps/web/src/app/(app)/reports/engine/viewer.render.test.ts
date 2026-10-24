/**
 * Viewer contract (server-rendered, no DB): a real engine result renders as a statement
 * table with a sticky label column, drillable account cells, F/U markers and collapsible
 * groups; URL state round-trips; legacy report keys stay on the classic viewer; the export
 * model carries exact cents.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildReport } from '@/lib/reports/engine/build';
import { planReport } from '@/lib/reports/engine/plan';
import { toStatementModel } from '@/lib/reports/engine/to-model';
import { toCsv } from '@/lib/reports/export/csv';
import type { AccountMeta, BalanceRow, EngineData, ReportRequest } from '@/lib/reports/engine/types';
import { StatementGrid, cellScope } from './statement-grid';
import { ENGINE_REPORTS, findEngineReport, isLegacyKey, searchReports } from './catalog';
import { defaultsFor, fromQuery, toQuery, toRequest } from './view-state';
import { formatOf, parseOf, templateRows } from './layout-designer';
import { validateLayout } from '@/lib/reports/engine/layout';

// vitest's esbuild uses the classic JSX runtime for .tsx; Next uses the automatic one.
Object.assign(globalThis, { React });

const CO = '11111111-1111-4111-8111-111111111111';
const acct = (id: string, number: string, name: string, type: AccountMeta['type'], subType: string, group: string, normal: 'DEBIT' | 'CREDIT', extra: Partial<AccountMeta> = {}): AccountMeta => ({
  id, number, name, type, subType, subTypeName: subType, subTypeOrder: 1, groupId: `g-${group}`, groupName: group, groupOrder: 1, order: Number(number),
  normalBalance: normal, isBank: false, isEliminating: false, isActive: true, roles: [], cashFlowCategory: null, ...extra,
});
const ACCOUNTS: AccountMeta[] = [
  acct('cash', '1000', 'Bank', 'ASSET', 'CURRENT_ASSET', 'Cash', 'DEBIT', { isBank: true }),
  acct('cap', '3000', 'Capital', 'EQUITY', 'EQUITY', 'Equity', 'CREDIT'),
  acct('rev', '4000', 'Sales', 'REVENUE', 'REVENUE', 'Revenue', 'CREDIT'),
  acct('rent', '6100', 'Rent', 'OPEX', 'OPERATING_EXPENSE', 'Occupancy', 'DEBIT'),
  acct('wage', '6200', 'Wages', 'OPEX', 'OPERATING_EXPENSE', 'Payroll', 'DEBIT'),
];
const row = (accountId: string, period: string | null, debit: number, credit: number): BalanceRow => ({
  companyId: CO, accountId, period, kind: 'STANDARD', departmentId: null, classId: null, jobId: null, itemId: null, counterpartyId: null, debit, credit,
});
function data(): EngineData {
  return {
    orgFiscalYearStartMonth: 1,
    accounts: ACCOUNTS,
    companies: [{ id: CO, name: 'Acme', shortCode: 'AC', fiscalYearStartMonth: 1 }],
    companyIds: [CO],
    balances: [
      row('cash', null, 1_000_000, 0), row('cap', null, 0, 1_000_000),
      row('cash', '2025-03-01', 500_000, 0), row('rev', '2025-03-01', 0, 500_000),
      row('cash', '2026-03-01', 900_000, 300_000), row('rev', '2026-03-01', 0, 900_000), row('rent', '2026-03-01', 200_000, 0), row('wage', '2026-03-01', 100_000, 0),
    ],
    budgets: [],
    basisDeltas: [],
    periodStatus: [],
    dimensions: {},
    ownership: [],
    accumulatedDepreciationIds: [],
    today: '2026-10-24',
  };
}
function run(req: Partial<ReportRequest>) {
  const r: ReportRequest = { statement: 'income_statement', scope: { companyIds: [CO] }, period: { preset: 'month', asOf: '2026-03-31' }, columns: 'single', compare: ['prior_year'], basis: 'ACCRUAL', rounding: 'units', ...req };
  const d = data();
  const plan = planReport(r, { companies: d.companies, companyIds: [CO], orgFiscalYearStartMonth: 1, dimensions: {} });
  return buildReport(r, plan, d, '2026-10-24T00:00:00Z');
}

describe('statement grid renders the engine result', () => {
  it('sticky header + label column, drillable account cells, F/U, collapsible groups', () => {
    const result = run({});
    const html = renderToStaticMarkup(h(StatementGrid, { result, onDrill: () => undefined, collapsed: new Set<string>(), onToggle: () => undefined }));
    expect(html).toContain('<table');
    expect(html).toContain('In US dollars (whole)');
    expect(html).toContain('6100 · Rent');
    expect(html).toMatch(/aria-label="6100 · Rent, Mar 2026: 2,000\. Open the lines\."/);
    expect(html).toContain('aria-label="favorable"'); // revenue up vs prior year
    expect(html).toMatch(/aria-expanded="true"/);
    const collapsedHtml = renderToStaticMarkup(h(StatementGrid, { result, onDrill: () => undefined, collapsed: new Set(['opex:g:g-Occupancy']), onToggle: () => undefined }));
    expect(collapsedHtml).not.toContain('6100 · Rent');
    expect(collapsedHtml).toContain('6200 · Wages');
  });

  it('variance and percent cells are never drillable; account cells drill with the column scope', () => {
    const result = run({});
    const rent = result.rows.find((r) => r.accountId === 'rent')!;
    const cur = result.columns.findIndex((c) => c.id === 'cur');
    const v = result.columns.findIndex((c) => c.kind === 'variance_pct');
    expect(cellScope(rent, result.columns[cur], cur)?.range).toEqual({ start: '2026-03-01', end: '2026-03-31' });
    expect(cellScope(rent, result.columns[v], v)).toBeNull();
    const gm = result.rows.find((r) => r.id === 'gm')!;
    expect(cellScope(gm, result.columns[cur], cur)).toBeNull();
  });

  it('balance sheet renders the earnings-not-yet-closed rows and balances', () => {
    const result = run({ statement: 'balance_sheet', compare: [] });
    expect(result.checks.every((c) => c.ok)).toBe(true);
    const html = renderToStaticMarkup(h(StatementGrid, { result, onDrill: () => undefined, collapsed: new Set<string>(), onToggle: () => undefined }));
    expect(html).toContain('Retained earnings — prior years (not yet closed)');
    expect(html).toContain('Net income (current year)');
  });

  it('export model carries exact cents (CSV in dollars, no rounding)', () => {
    const result = run({ rounding: 'thousands' });
    const model = toStatementModel(result);
    const rentRow = model.rows.find((r) => r.code === '6100')!;
    expect(rentRow.values[0]).toBe(200_000);
    expect(toCsv(model)).toContain('2000');
  });
});

describe('library + URL state', () => {
  it('legacy URLs keep working: engine keys open the engine viewer, others the classic viewer', () => {
    for (const k of ['pnl', 'pnl_month', 'pnl_dept', 'pnl_class', 'bs', 'cf', 'equity_changes', 'tb', 'consol', 'bva', 'gl']) expect(findEngineReport(k)?.key).toBe(k);
    for (const k of ['ar_aging', 'ap_aging', 'cf_direct', 'job_prof', 'wip']) expect(isLegacyKey(k)).toBe(true);
    expect(new Set(ENGINE_REPORTS.map((r) => r.key)).size).toBe(ENGINE_REPORTS.length);
  });

  it('search matches every term', () => {
    expect(searchReports('department').map((r) => r.key)).toContain('pnl_dept');
    expect(searchReports('budget month').map((r) => r.key)).toContain('bva_month');
    expect(searchReports('budget month').map((r) => r.key)).not.toContain('pnl');
  });

  it('state round-trips through the URL; a bare legacy link gets the report defaults', () => {
    const d = defaultsFor('pnl_month', '2026-10-24', CO);
    expect(d.columns).toBe('month');
    expect(d.ttm).toBe(true);
    const custom = { ...d, preset: 'custom' as const, start: '2026-01-01', end: '2026-06-30', compare: ['budget' as const], rounding: 'thousands' as const, consolidate: true };
    expect(fromQuery(toQuery(custom), '2026-10-24', CO)).toEqual({ ...custom, customBasisLabel: null });
    expect(fromQuery(new URLSearchParams('report=bs'), '2026-10-24', CO).asOf).toBe('2026-09-30');
    const req = toRequest(custom);
    expect(req.period).toEqual({ preset: 'custom', asOf: d.asOf, start: '2026-01-01', end: '2026-06-30' });
    expect(req.scope.consolidate).toBe(true);
  });
});

describe('row designer helpers', () => {
  it('templates are valid layouts; subtotal text round-trips', () => {
    expect(validateLayout(templateRows('PNL'), 'PNL')).toEqual([]);
    expect(validateLayout(templateRows('BS'), 'BS')).toEqual([]);
    expect(parseOf('rev, -cogs, +other')).toEqual([{ id: 'rev', sign: 1 }, { id: 'cogs', sign: -1 }, { id: 'other', sign: 1 }]);
    expect(formatOf(parseOf('rev, -cogs'))).toBe('rev, -cogs');
  });
});

describe('PeriodControl (swappable period picker)', () => {
  const today = '2026-10-24';
  it('maps quick choices to engine presets and recognises them back', async () => {
    const { quickKeyFor } = await import('./period-control');
    expect(quickKeyFor({ preset: 'month', asOf: '2026-09-30' }, today, false)).toBe('last_month');
    expect(quickKeyFor({ preset: 'quarter', asOf: '2026-07-31' }, today, false)).toBe('last_quarter');
    expect(quickKeyFor({ preset: 'year', asOf: '2025-10-31' }, today, false)).toBe('last_year');
    expect(quickKeyFor({ preset: 'ytd', asOf: today }, today, false)).toBe('ytd');
    expect(quickKeyFor({ preset: 'ytd', asOf: '2026-06-30' }, today, false)).toBe('ytd');
    expect(quickKeyFor({ preset: 'month', asOf: '2026-03-31' }, today, false)).toBe('month_of');
    expect(quickKeyFor({ preset: 'custom', asOf: '2026-03-31', start: '2026-01-15', end: '2026-03-31' }, today, false)).toBe('custom');
    expect(quickKeyFor({ preset: 'month', asOf: '2026-09-30' }, today, true)).toBe('pit_last_month');
    expect(quickKeyFor({ preset: 'month', asOf: '2026-05-31' }, today, true)).toBe('pit_month_of');
  });
  it('renders the date input only when the choice is not a plain relative period', async () => {
    const { PeriodControl } = await import('./period-control');
    const noop = () => undefined;
    const plain = renderToStaticMarkup(h(PeriodControl, { value: { preset: 'month', asOf: '2026-09-30' }, onChange: noop, today, pointInTime: false }));
    expect(plain).toContain('Last month');
    expect(plain).not.toContain('type="date"');
    const dated = renderToStaticMarkup(h(PeriodControl, { value: { preset: 'ytd', asOf: '2026-06-30' }, onChange: noop, today, pointInTime: false }));
    expect(dated).toContain('type="date"');
    const custom = renderToStaticMarkup(h(PeriodControl, { value: { preset: 'custom', asOf: '2026-03-31', start: '2026-01-15', end: '2026-03-31' }, onChange: noop, today, pointInTime: false }));
    expect((custom.match(/type="date"/g) ?? []).length).toBe(2);
  });
});

describe('governance in the viewer', () => {
  it('reads the 3D banner, watermark, closed-through and withheld columns defensively', async () => {
    const { governanceView } = await import('./statement-viewer');
    const base = { governance: null } as unknown as Parameters<typeof governanceView>[0];
    expect(governanceView(base)).toEqual({ banner: null, watermark: null, closedThrough: null, withheld: 0 });
    const g = governanceView({ ...base, governance: { banner: { tone: 'warn', text: 'Preview — not released.' }, watermark: 'preview', booksClosedThrough: '2026-08', withheldColumnIds: ['a', 'b'] } });
    expect(g).toEqual({ banner: 'Preview — not released.', watermark: 'preview', closedThrough: 'Aug 2026', withheld: 2 });
  });
});
