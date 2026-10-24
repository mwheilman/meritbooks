/**
 * Data-source seam: load planning, the 3A stub adapter, and the current-queries
 * adapter end-to-end against a tiny in-memory PostgREST fake (wiring + column names).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { company, dataset } from './__fixtures__/dataset';
import { createGlQuerySource } from './adapters/gl-queries';
import { createPeriodBalanceSource, datasetFromFeed, type PeriodBalanceFeed } from './adapters/period-balances';
import { evaluateFromSource, planLoad, type MetricDataSource } from './data-source';
import { evaluateMetric } from './evaluate';
import type { EvaluateRequest } from './types';

const SEP = '2026-09';
const req = (metric: string, over: Partial<EvaluateRequest> = {}): EvaluateRequest => ({
  metric,
  scope: { companyIds: ['a'], weighting: 'full' },
  periodEnd: SEP,
  basis: 'month',
  comparison: 'none',
  sparkline: 0,
  ...over,
});

describe('planLoad', () => {
  it('unions ranges and needs across a batch', () => {
    const p = planLoad(
      [
        req('revenue_cagr_3y'),
        req('backlog', { scope: { companyIds: ['b'], weighting: 'full' } }),
        req('top_customer_concentration'),
        req('opex', { comparison: 'budget' }),
        req('adjusted_ebitda'),
      ],
      1,
    );
    expect(p.from).toBe('2022-10');
    expect(p.to).toBe(SEP);
    expect(p.companyIds.sort()).toEqual(['a', 'b']);
    expect(p.operational.sort()).toEqual(['addbacks', 'backlog']);
    expect(p.needsBudget).toBe(true);
    expect(p.customerRevenue).toBe(true);
    expect(p.vendorSpend).toBe(false);
  });
});

describe('evaluateFromSource', () => {
  it('loads once with the planned range and evaluates every request', async () => {
    const seen: string[] = [];
    const source: MetricDataSource = {
      id: 'fake',
      fiscalYearStartMonth: async () => 1,
      load: async (r) => {
        seen.push(`${r.from}..${r.to}`);
        return dataset([company({ id: 'a', flows: { revenue: { [SEP]: 500 }, cogs: { [SEP]: 200 } } })]);
      },
    };
    const { results } = await evaluateFromSource(source, [req('revenue'), req('gross_margin')]);
    expect(seen).toEqual([`${SEP}..${SEP}`]);
    expect(results.map((r) => (r.current.status === 'ok' ? r.current.value : null))).toEqual([500, 60]);
  });
});

const feed: PeriodBalanceFeed = {
  orgFiscalYearStartMonth: 1,
  accounts: [
    { id: 'bank', number: '1000', name: 'Operating Bank', type: 'ASSET', subType: 'CURRENT_ASSET', isBank: true, roles: ['OPERATING_BANK'] },
    { id: 'ar', number: '1105', name: 'Receivables', type: 'ASSET', subType: 'CURRENT_ASSET', isBank: false, roles: ['AR_CONTROL'] },
    { id: 'rev', number: '4000', name: 'Revenue', type: 'REVENUE', subType: 'REVENUE', isBank: false, roles: [] },
    { id: 'ap', number: '2000', name: 'Accounts Payable', type: 'LIABILITY', subType: 'CURRENT_LIABILITY', isBank: false, roles: ['AP_CONTROL'] },
  ],
  companies: [{ id: 'a', name: 'Heartland' }],
  balances: [
    { companyId: 'a', accountId: 'bank', period: null, kind: 'STANDARD', debit: 10_000, credit: 0 },
    { companyId: 'a', accountId: 'bank', period: '2026-09-01', kind: 'STANDARD', debit: 3_000, credit: 0 },
    { companyId: 'a', accountId: 'ar', period: '2026-09-01', kind: 'STANDARD', debit: 3_000, credit: 0 },
    { companyId: 'a', accountId: 'rev', period: '2026-09-01', kind: 'STANDARD', debit: 0, credit: 6_000 },
    { companyId: 'a', accountId: 'rev', period: '2026-09-01', kind: 'STANDARD', debit: 0, credit: 3_000 }, // second dimension row
    { companyId: 'a', accountId: 'ap', period: '2026-09-01', kind: 'STANDARD', debit: 0, credit: 3_000 },
  ],
  budgets: [{ companyId: 'a', accountId: 'rev', period: '2026-09-01', naturalCents: 10_000 }],
  periodStatus: [{ companyId: 'a', period: '2026-08-01', status: 'HARD_CLOSE' }],
  ownership: [{ entityId: 'a', method: 'FULL', ownershipPercent: 75 }],
};
const plan = { companyIds: ['a'], from: SEP, to: SEP, needsBudget: true, operational: [], customerRevenue: false, vendorSpend: false };

describe('3A period-balances adapter (stub)', () => {
  it('turns the engine feed into a dataset the evaluator reads', () => {
    const ds = datasetFromFeed(feed, plan, SEP, new Map([['a', [2026]]]));
    expect(ds.companies[0]).toMatchObject({ name: 'Heartland', ownershipPct: 75, closedThrough: '2026-08', firstMonthOnFile: '2026-08' });
    const r = evaluateMetric(ds, req('cash'));
    expect(r.current).toMatchObject({ status: 'ok', value: 13_000 });
    expect(evaluateMetric(ds, req('dso')).current).toMatchObject({ value: 10 }); // 3,000 / 9,000 × 30
    const bva = evaluateMetric(ds, req('revenue', { comparison: 'budget' }));
    expect(bva.change).toMatchObject({ delta: -1_000, verdict: 'unfavourable' });
    expect(evaluateMetric(ds, req('revenue')).preliminary).toBe(true);
  });
  it('delegates sub-ledger inputs to another source', async () => {
    const ops: MetricDataSource = {
      id: 'ops',
      fiscalYearStartMonth: async () => 1,
      load: async () => ({ ...dataset([company({ id: 'a', operational: { backlog: { [SEP]: 90_000 } } })]), operationalAvailable: ['backlog'] }),
    };
    const src = createPeriodBalanceSource({ loadFeed: async () => feed, operational: ops, today: '2026-09-30' });
    const { results } = await evaluateFromSource(src, [req('backlog'), req('cash')]);
    expect(results.map((r) => (r.current.status === 'ok' ? r.current.value : r.current.reason))).toEqual([90_000, 13_000]);
  });
});

// ── A tiny in-memory PostgREST fake ─────────────────────────────────────────

type Row = Record<string, unknown>;
type Cond = { col: string; op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'lt'; val: unknown };

function read(row: Row, col: string): unknown {
  const [head, tail] = col.split('.');
  if (!tail) return row[head];
  const nested = row[head];
  return nested && typeof nested === 'object' ? (nested as Row)[tail] : undefined;
}

class FakeQuery implements PromiseLike<{ data: Row[] | Row | null; error: null }> {
  private conds: Cond[] = [];
  private window: [number, number] | null = null;
  private lim: number | null = null;
  private single = false;
  constructor(private readonly rows: Row[], private readonly log: string[], private readonly table: string) {}
  select(cols: string) {
    this.log.push(`${this.table}: ${cols}`);
    return this;
  }
  private add(col: string, op: Cond['op'], val: unknown) {
    this.conds.push({ col, op, val });
    return this;
  }
  eq(c: string, v: unknown) { return this.add(c, 'eq', v); }
  neq(c: string, v: unknown) { return this.add(c, 'neq', v); }
  in(c: string, v: unknown[]) { return this.add(c, 'in', v); }
  gte(c: string, v: unknown) { return this.add(c, 'gte', v); }
  lte(c: string, v: unknown) { return this.add(c, 'lte', v); }
  lt(c: string, v: unknown) { return this.add(c, 'lt', v); }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.window = [a, b]; return this; }
  maybeSingle() { this.single = true; return this; }
  private result(): Row[] {
    let out = this.rows.filter((r) =>
      this.conds.every(({ col, op, val }) => {
        const v = read(r, col) as string | number;
        switch (op) {
          case 'eq': return v === val;
          case 'neq': return v !== val;
          case 'in': return (val as unknown[]).includes(v);
          case 'gte': return v >= (val as string | number);
          case 'lte': return v <= (val as string | number);
          case 'lt': return v < (val as string | number);
          default: return true;
        }
      }),
    );
    if (this.window) out = out.slice(this.window[0], this.window[1] + 1);
    if (this.lim !== null) out = out.slice(0, this.lim);
    return out;
  }
  then<T1 = { data: Row[] | Row | null; error: null }, T2 = never>(ok?: ((v: { data: Row[] | Row | null; error: null }) => T1 | PromiseLike<T1>) | null, bad?: ((e: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    const rows = this.result();
    return Promise.resolve({ data: this.single ? rows[0] ?? null : rows, error: null }).then(ok, bad);
  }
}

function fakeDb(tables: Record<string, Row[]>, log: string[]): SupabaseClient {
  const from = (t: string) => new FakeQuery(tables[t] ?? [], log, t);
  return { from, schema: () => ({ from }) } as unknown as SupabaseClient;
}

describe('current-queries adapter (gl-queries-v1) against a fake PostgREST', () => {
  const entry = (date: string, type = 'STANDARD') => ({ entry_date: date, status: 'POSTED', entry_type: type });
  const tables: Record<string, Row[]> = {
    organizations: [{ id: 'org', fiscal_year_start_month: 1 }],
    locations: [{ id: 'a', name: 'Heartland' }],
    accounts: [
      { id: 'bank', account_number: '1000', name: 'Operating Bank', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', is_bank_account: true, is_credit_card: false },
      { id: 'ar', account_number: '1100', name: 'Accounts Receivable', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', is_bank_account: false, is_credit_card: false },
      { id: 'rev', account_number: '4000', name: 'Revenue', account_type: 'REVENUE', account_sub_type: 'REVENUE', is_bank_account: false, is_credit_card: false },
      { id: 'cogs', account_number: '5000', name: 'Materials', account_type: 'COGS', account_sub_type: 'COST_OF_GOODS_SOLD', is_bank_account: false, is_credit_card: false },
    ],
    account_roles: [],
    gl_entries: [{ id: 'e0', location_id: 'a', entry_date: '2025-12-31', status: 'POSTED' }],
    gl_entry_lines: [
      { id: 'l0', account_id: 'bank', location_id: 'a', debit_cents: 50_000, credit_cents: 0, gl_entries: entry('2025-12-31') },
      { id: 'l1', account_id: 'ar', location_id: 'a', debit_cents: 30_000, credit_cents: 0, gl_entries: entry('2026-09-15') },
      { id: 'l2', account_id: 'rev', location_id: 'a', debit_cents: 0, credit_cents: 30_000, gl_entries: entry('2026-09-15') },
      { id: 'l3', account_id: 'cogs', location_id: 'a', debit_cents: 12_000, credit_cents: 0, gl_entries: entry('2026-09-20') },
      { id: 'l4', account_id: 'bank', location_id: 'a', debit_cents: 0, credit_cents: 12_000, gl_entries: entry('2026-09-20') },
    ],
    fiscal_periods: [{ id: 'p8', location_id: 'a', period_year: 2026, period_month: 8, status: 'HARD_CLOSE', closed_at: '2026-09-10T12:00:00Z' }],
    entity_ownership: [],
    invoices: [{ id: 'i1', location_id: 'a', customer_id: 'c1', invoice_date: '2026-09-15', due_date: '2026-10-15', total_cents: 30_000, amount_paid_cents: 0, status: 'SENT', updated_at: '2026-09-15T00:00:00Z' }],
    payment_applications: [],
    jobs: [{ id: 'j1', location_id: 'a', status: 'ACTIVE', contract_amount_cents: 100_000, estimated_revenue_cents: null, estimated_cost_cents: 60_000, budget_labor_cents: 0, budget_materials_cents: 0, budget_subcontractor_cents: 0, budget_other_cents: 0, actual_cost_cents: 30_000, billed_to_date_cents: 40_000, pct_complete: null }],
  };

  it('reads posted GL by class, sub-ledgers and jobs through the RLS client', async () => {
    const log: string[] = [];
    const src = createGlQuerySource(fakeDb(tables, log), { orgId: 'org', today: '2026-09-30' });
    const { dataset: ds, results } = await evaluateFromSource(src, [req('gross_margin'), req('cash'), req('dso'), req('ar_current_pct'), req('backlog'), req('close_cycle_days', { periodEnd: '2026-08' })]);
    expect(ds.source).toBe('gl-queries-v1');
    expect(ds.companies[0]).toMatchObject({ name: 'Heartland', firstMonthOnFile: '2025-12', closedThrough: '2026-08' });
    expect(results.map((r) => (r.current.status === 'ok' ? r.current.value : r.current.reason))).toEqual([
      60, // (30,000 − 12,000) ÷ 30,000
      38_000, // 50,000 opening − 12,000
      30, // 30,000 ÷ 30,000 × 30
      100,
      50_000, // contract 100,000 − earned 50% (cost-to-cost)
      10, // Aug 31 → Sep 10
    ]);
    expect(log.some((l) => l.startsWith('gl_entry_lines') && l.includes('gl_entries!inner(entry_date, status, entry_type)'))).toBe(true);
  });
});
