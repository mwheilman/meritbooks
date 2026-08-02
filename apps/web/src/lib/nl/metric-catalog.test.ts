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
