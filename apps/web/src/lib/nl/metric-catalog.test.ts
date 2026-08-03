/**
 * NL analytical lane — safety-kernel tests.
 *
 * These prove the two properties the FPB (Dimension 5, AC5.1/AC5.2) demands of
 * the injection-safe query lane, WITHOUT any live model or gateway. We "mock the
 * gateway" by feeding `parseClassifierOutput` the exact JSON text the model would
 * have returned, then asserting `resolveMetric`'s decision:
 *   (a) a known finance prompt resolves to the RIGHT metric + validated params;
 *   (b) an out-of-scope / injection prompt ABSTAINS (never falls through to a query).
 */

import { describe, it, expect } from 'vitest';
import {
  buildClassifierPrompt,
  parseClassifierOutput,
  resolveMetric,
  abstainMessage,
  METRIC_CATALOG,
  METRIC_IDS,
  grossMarginPct,
  netMarginPct,
  ratioOf,
  daysOutstanding,
  runwayMonths,
} from './metric-catalog';

/** Simulate the gateway returning the model's JSON classification. */
function gatewayReturns(json: unknown): string {
  return JSON.stringify(json);
}

describe('NL classifier prompt', () => {
  it('constrains the model to the allowlist and forbids SQL', () => {
    const prompt = buildClassifierPrompt('what is my cash position?');
    // Every catalog id must be offered to the model.
    for (const id of METRIC_IDS) expect(prompt).toContain(`"${id}"`);
    // The instruction wall against SQL/other-tenant data must be present.
    expect(prompt).toMatch(/do NOT write SQL/i);
    expect(prompt).toMatch(/set "metric" to "none"/i);
  });
});

describe('(a) a known prompt resolves to the right metric + params', () => {
  it('routes a P&L question to pnl_summary with the given period', () => {
    const modelText = gatewayReturns({
      metric: 'pnl_summary',
      params: { start_date: '2026-04-01', end_date: '2026-06-30' },
      reasoning: 'income statement for Q2',
    });
    const resolved = resolveMetric(parseClassifierOutput(modelText));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.entry.id).toBe('pnl_summary');
      expect(resolved.params).toEqual({ start_date: '2026-04-01', end_date: '2026-06-30' });
    }
  });

  it('routes an AR question to ar_aging with no params (defaults apply)', () => {
    const resolved = resolveMetric(parseClassifierOutput(gatewayReturns({ metric: 'ar_aging', params: {} })));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.entry.id).toBe('ar_aging');
  });

  it('accepts a valid location_id uuid param on cash_position', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const resolved = resolveMetric(
      parseClassifierOutput(gatewayReturns({ metric: 'cash_position', params: { location_id: uuid } })),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.params).toEqual({ location_id: uuid });
  });
});

describe('(b) an out-of-scope / unsafe prompt ABSTAINS', () => {
  it('abstains when the model picks "none"', () => {
    const resolved = resolveMetric(parseClassifierOutput(gatewayReturns({ metric: 'none', params: {} })));
    expect(resolved.ok).toBe(false);
  });

  it('abstains on an unknown / injected metric id (never in the allowlist)', () => {
    const resolved = resolveMetric(
      parseClassifierOutput(gatewayReturns({ metric: 'all_orgs_revenue', params: {} })),
    );
    expect(resolved.ok).toBe(false);
    // The injected id is not a real catalog entry.
    expect(METRIC_CATALOG['all_orgs_revenue']).toBeUndefined();
  });

  it('abstains when params fail typed validation (bad date, non-uuid location)', () => {
    const badDate = resolveMetric(
      parseClassifierOutput(gatewayReturns({ metric: 'pnl_summary', params: { start_date: 'last quarter' } })),
    );
    expect(badDate.ok).toBe(false);

    const badLoc = resolveMetric(
      parseClassifierOutput(gatewayReturns({ metric: 'ap_aging', params: { location_id: 'Heartland' } })),
    );
    expect(badLoc.ok).toBe(false);
  });

  it('abstains on a raw-SQL injection attempt (unparseable / non-metric)', () => {
    const sqlish = resolveMetric(parseClassifierOutput("'; DROP TABLE gl_entries; --"));
    expect(sqlish.ok).toBe(false);
    // And the human-facing abstain lists supported metrics rather than guessing.
    expect(abstainMessage()).toMatch(/I can't answer that from the ledger/i);
  });
});

describe('expanded catalog — allowlist membership & safe routing', () => {
  const NEW_IDS = [
    'gross_margin',
    'net_margin',
    'current_ratio',
    'days_sales_outstanding',
    'days_payable_outstanding',
    'cash_runway',
    'revenue_by_department',
    'expense_by_department',
    'top_customers_by_receivable',
    'top_vendors_by_payable',
    'revenue_trend',
    'expense_trend',
    'overdue_receivables',
    'overdue_payables',
  ];

  it('registers every new metric in the allowlist and the classifier menu', () => {
    const menu = buildClassifierPrompt('anything');
    for (const id of NEW_IDS) {
      expect(METRIC_CATALOG[id]).toBeDefined();
      expect(METRIC_IDS).toContain(id);
      expect(menu).toContain(`"${id}"`);
    }
  });

  it('routes a gross-margin ask with a period to gross_margin (validated params)', () => {
    const resolved = resolveMetric(
      parseClassifierOutput(
        JSON.stringify({ metric: 'gross_margin', params: { start_date: '2026-01-01', end_date: '2026-03-31' } }),
      ),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.entry.id).toBe('gross_margin');
      expect(resolved.params).toEqual({ start_date: '2026-01-01', end_date: '2026-03-31' });
    }
  });

  it('coerces & validates DSO period_days and top-N limit', () => {
    const dso = resolveMetric(parseClassifierOutput(JSON.stringify({ metric: 'days_sales_outstanding', params: { period_days: 30 } })));
    expect(dso.ok).toBe(true);
    if (dso.ok) expect(dso.params).toEqual({ period_days: 30 });

    const top = resolveMetric(parseClassifierOutput(JSON.stringify({ metric: 'top_vendors_by_payable', params: { limit: 3 } })));
    expect(top.ok).toBe(true);
    if (top.ok) expect(top.params).toEqual({ limit: 3 });
  });

  it('still abstains when a new metric gets a malformed param (non-uuid location)', () => {
    const bad = resolveMetric(parseClassifierOutput(JSON.stringify({ metric: 'current_ratio', params: { location_id: 'Heartland' } })));
    expect(bad.ok).toBe(false);
  });

  it('rejects an out-of-range top-N limit (guards the query)', () => {
    const bad = resolveMetric(parseClassifierOutput(JSON.stringify({ metric: 'top_customers_by_receivable', params: { limit: 9999 } })));
    expect(bad.ok).toBe(false);
  });
});

describe('deterministic KPI math (pure — no DB, no model)', () => {
  it('gross margin %: (rev − cogs) / rev', () => {
    expect(grossMarginPct(100_00, 40_00)).toBeCloseTo(60);
    expect(grossMarginPct(0, 10_00)).toBeNull(); // no revenue → undefined margin
    expect(grossMarginPct(-5_00, 1_00)).toBeNull();
  });

  it('net margin %: net income / rev', () => {
    expect(netMarginPct(25_00, 100_00)).toBeCloseTo(25);
    expect(netMarginPct(-10_00, 100_00)).toBeCloseTo(-10);
    expect(netMarginPct(10_00, 0)).toBeNull();
  });

  it('ratioOf guards a zero/negative denominator', () => {
    expect(ratioOf(200_00, 100_00)).toBeCloseTo(2);
    expect(ratioOf(50_00, 0)).toBeNull();
  });

  it('daysOutstanding: balance × days / flow', () => {
    // $30k AR, $90k revenue over 90 days → 30 days
    expect(daysOutstanding(30_000_00, 90_000_00, 90)).toBeCloseTo(30);
    expect(daysOutstanding(10_00, 0, 90)).toBeNull(); // no flow → undefined
  });

  it('runwayMonths: cash / monthly burn, unlimited when not burning', () => {
    expect(runwayMonths(120_000_00, 10_000_00)).toBeCloseTo(12);
    expect(runwayMonths(120_000_00, 0)).toBeNull(); // profitable → no finite runway
    expect(runwayMonths(120_000_00, -5_00)).toBeNull();
  });
});
