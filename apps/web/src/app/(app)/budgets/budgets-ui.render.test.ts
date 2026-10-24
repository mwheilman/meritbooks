/**
 * Budgets workspace (Wave 4B) — render contract for the grid (read-only state, keyboard grid
 * semantics, unsaved edits shown) and the bridge → chart-step conversion (anchors + deltas tie).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BridgeOut, GridRow } from '@/lib/budgets/types';
import { BudgetGrid, dirtyKey, effectiveValues } from './budget-grid';
import { bridgeTieCaption, centsToInput, gridMoney, toChartSteps } from './budget-format';

Object.assign(globalThis, { React });

const row = (over: Partial<GridRow>): GridRow => ({
  key: 'a1|', accountId: 'a1', accountNumber: '4000', accountName: 'Service revenue', accountType: 'REVENUE', groupName: 'Service Revenue',
  departmentId: null, months: Array(12).fill(100_000), adjustmentsCents: 0, totalCents: 1_200_000, pyActualCents: 1_000_000,
  pyMonths: Array(12).fill(83_333), driver: null, sources: ['MANUAL'], comments: 0, ...over,
});

const rows: GridRow[] = [
  row({}),
  row({ key: 'a2|', accountId: 'a2', accountNumber: '6100', accountName: 'Advertising', accountType: 'OPEX', groupName: 'Marketing', months: Array(12).fill(20_000), totalCents: 240_000, pyActualCents: 0 }),
];

describe('BudgetGrid', () => {
  it('renders a read-only grid: aria-readonly, no row edit actions, sections and net row', () => {
    const html = renderToStaticMarkup(h(BudgetGrid, { rows, dirty: new Map(), editable: false, onEdit: () => undefined, onRowAction: () => undefined }));
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-readonly="true"');
    expect(html).not.toContain('Fill →');
    expect(html).toContain('Total revenue');
    expect(html).toContain('Total operating expenses');
    expect(html).toContain('Net contribution');
    // one roving tab stop
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    // 12,000 revenue − 2,400 ads = 9,600 net for the year (whole dollars)
    expect(html).toContain('9,600');
  });

  it('shows unsaved edits and the row actions when editable', () => {
    const dirty = new Map([[dirtyKey('a1|', 3), 250_000]]);
    const html = renderToStaticMarkup(h(BudgetGrid, { rows, dirty, editable: true, onEdit: () => undefined, onRowAction: () => undefined }));
    expect(html).toContain('Fill →');
    expect(html).toContain('(unsaved)');
    expect(effectiveValues(rows[0], dirty)[2]).toBe(250_000);
  });
});

describe('budget-format', () => {
  it('converts a bridge to chart steps that tie', () => {
    const b: BridgeOut = {
      title: 'Last year → budget', measure: 'contribution', direction: 'higher_is_better',
      start: { label: 'Last year contribution', cents: 3000 }, end: { label: 'Budget contribution', cents: 3500 },
      steps: [{ key: 'volume', label: 'Volume', cents: -500 }, { key: 'rate', label: 'Rate / price', cents: 1000 }], ties: true, note: null,
    };
    const steps = toChartSteps(b);
    expect(steps.map((s) => s.kind)).toEqual(['start', 'delta', 'delta', 'end']);
    expect(steps[0].value + steps[1].value + steps[2].value).toBe(steps[3].value);
    expect(bridgeTieCaption(b)).toMatch(/to the cent/);
    expect(bridgeTieCaption({ ...b, end: { ...b.end, cents: 1 } })).toMatch(/do not tie/);
  });

  it('formats grid cells and edit text from cents', () => {
    expect(gridMoney(0)).toBe('–');
    expect(gridMoney(-123_456)).toBe('(1,235)');
    expect(centsToInput(123_450)).toBe('1234.5');
    expect(centsToInput(-5)).toBe('-0.05');
  });
});
