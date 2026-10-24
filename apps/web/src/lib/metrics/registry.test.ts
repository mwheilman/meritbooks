/**
 * Registry guard (FPB-reports-fpna AC-K1, AC-K2): enumerates every metric and fails on
 * a missing field, an undefined input, a cycle, or a missing family.
 */

import { describe, expect, it } from 'vitest';
import { ACCOUNT_CLASSES, isNetClass } from './classes';
import { walk } from './expr';
import { OPERATIONAL_INPUTS } from './operational-inputs';
import { DEFAULT_DASHBOARD, formulaOf, listMetrics, METRICS, metricsFor, UNIVERSAL_FINANCE_PACK } from './registry';

const all = listMetrics();

describe('metric registry — AC-K1 shape', () => {
  it('holds at least 80 metrics with unique keys', () => {
    expect(all.length).toBeGreaterThanOrEqual(80);
    expect(new Set(all.map((m) => m.key)).size).toBe(all.length);
  });

  it.each(all.map((m) => [m.key, m] as const))('%s has every required field and a generated formula', (_key, m) => {
    expect(m.name.trim().length).toBeGreaterThan(0);
    expect(m.definition.trim().length).toBeGreaterThan(10);
    expect(m.audiences.length).toBeGreaterThan(0);
    expect(m.requires.length).toBeGreaterThan(0);
    expect(['money', 'percent', 'ratio', 'days', 'count', 'times', 'months', 'points']).toContain(m.unit);
    expect(['higher_better', 'lower_better', 'neutral']).toContain(m.direction);
    const f = formulaOf(m.key);
    expect(f.length).toBeGreaterThan(2);
    expect(f).not.toMatch(/undefined|\[object/);
  });

  it('references only defined inputs and metrics, and balances only read net classes', () => {
    for (const m of all) {
      for (const n of walk(m.formula)) {
        if (n.op === 'metric') expect(METRICS.has(n.key), `${m.key} → ${n.key}`).toBe(true);
        if (n.op === 'flow' || n.op === 'budget' || n.op === 'balance') expect(ACCOUNT_CLASSES[n.cls], `${m.key} class ${n.cls}`).toBeDefined();
        if (n.op === 'balance') expect(isNetClass(n.cls), `${m.key} reads a balance of activity class ${n.cls}`).toBe(true);
        if (n.op === 'budget') expect(ACCOUNT_CLASSES[n.cls].statement).toBe('income_statement');
        if (n.op === 'operational') expect(OPERATIONAL_INPUTS[n.key], `${m.key} op ${n.key}`).toBeDefined();
      }
    }
  });

  it('has no cycles', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: string, path: string[]) => {
      if (done.has(key)) return;
      if (visiting.has(key)) throw new Error(`cycle: ${[...path, key].join(' → ')}`);
      visiting.add(key);
      for (const n of walk(METRICS.get(key)!.formula)) if (n.op === 'metric') visit(n.key, [...path, key]);
      visiting.delete(key);
      done.add(key);
    };
    for (const m of all) expect(() => visit(m.key, [])).not.toThrow();
  });

  it('benchmark bands are ordered and named with a source', () => {
    for (const m of all) {
      if (!m.benchmark) continue;
      expect(m.benchmark.source.length).toBeGreaterThan(3);
      for (const b of m.benchmark.bands) if (b.min !== undefined && b.max !== undefined) expect(b.min).toBeLessThan(b.max);
    }
  });

  it('the formula string is generated from the tree', () => {
    expect(formulaOf('gross_margin')).toBe('Gross profit ÷ Revenue');
    expect(formulaOf('ebitda')).toBe('Operating income (EBIT) + Depreciation & amortization (in operating costs)');
    expect(formulaOf('current_ratio')).toBe('Current assets (end of period) ÷ Current liabilities (end of period)');
    expect(formulaOf('cash_conversion_cycle')).toBe('DSO (days sales outstanding) + DIO (days inventory outstanding) − DPO (days payables outstanding)');
  });
});

describe('metric registry — AC-K2 coverage', () => {
  const families: Record<string, string[]> = {
    profit: ['revenue', 'gross_profit', 'ebitda', 'adjusted_ebitda', 'addbacks', 'net_income'],
    margins: ['gross_margin', 'operating_margin', 'net_margin', 'ebitda_margin'],
    growth: ['revenue_growth_mom', 'revenue_growth_yoy', 'revenue_cagr_1y', 'revenue_cagr_3y', 'revenue_cagr_5y', 'ebitda_cagr_3y', 'ebitda_cagr_5y'],
    liquidity: ['current_ratio', 'quick_ratio', 'cash_ratio', 'working_capital', 'cash_runway_months', 'net_burn', 'days_cash_on_hand', 'cash_conversion_cycle'],
    efficiency: ['dso', 'best_possible_dso', 'average_days_delinquent', 'collection_effectiveness_index', 'dpo', 'dio', 'ar_turnover', 'ap_turnover', 'inventory_turnover', 'revenue_per_employee', 'ebitda_per_employee', 'payroll_pct_revenue'],
    leverage: ['debt_to_ebitda', 'dscr', 'fccr', 'interest_coverage', 'covenant_headroom_min'],
    returns: ['roa', 'roe', 'contribution_margin'],
    arap: ['ar_current_pct', 'ar_1_30_pct', 'ar_31_60_pct', 'ar_61_90_pct', 'ar_over_90_pct', 'top_customer_concentration', 'top_vendor_concentration', 'customer_hhi', 'early_pay_discount_capture'],
    construction: ['backlog', 'months_of_backlog', 'underbillings', 'overbillings', 'net_over_under_billings', 'job_fade', 'cost_to_complete', 'retainage_receivable', 'retainage_payable', 'gp_in_backlog'],
    dealer: ['floor_plan_days', 'aged_units_pct', 'warranty_receivable_days'],
    practice: ['close_cycle_days', 'items_per_bookkeeper'],
    strategic: ['rule_of_40', 'operating_leverage'],
  };
  it.each(Object.entries(families))('%s family is present', (_f, keys) => {
    for (const k of keys) expect(METRICS.has(k), k).toBe(true);
  });

  it('packs and defaults only name real metrics', () => {
    for (const k of [...UNIVERSAL_FINANCE_PACK, ...DEFAULT_DASHBOARD]) expect(METRICS.has(k), k).toBe(true);
  });

  it('every audience has metrics', () => {
    for (const a of ['owner', 'cfo', 'controller', 'lender', 'construction', 'dealer', 'practice'] as const) expect(metricsFor(a).length).toBeGreaterThan(1);
  });

  it('EBITDA is computed from roles, never a typed-in figure (no constants in its tree)', () => {
    expect(walk(METRICS.get('ebitda')!.formula).some((n) => n.op === 'const')).toBe(false);
  });
});
