/**
 * Evaluator worked examples (FPB-reports-fpna AC-K3…AC-K7). All money in cents.
 */

import { describe, expect, it } from 'vitest';
import { company, dataset, flat, mappingAll } from './__fixtures__/dataset';
import { evaluateMetric, priorPeriodShift, requiredRange, windowMonths } from './evaluate';
import type { EvaluateRequest, MetricDataset, MetricResult, Outcome } from './types';

const SEP = '2026-09';

function req(metric: string, over: Partial<EvaluateRequest> = {}): EvaluateRequest {
  return { metric, scope: { companyIds: ['a'], weighting: 'full' }, periodEnd: SEP, basis: 'month', comparison: 'none', sparkline: 0, ...over };
}

function value(r: MetricResult): number {
  if (r.current.status !== 'ok') throw new Error(`expected ok, got ${r.current.reason}: ${r.current.message}`);
  return r.current.value;
}

function reason(o: Outcome): string {
  return o.status === 'ok' ? 'ok' : o.reason;
}

const pnl = dataset([
  company({
    id: 'a',
    flows: {
      revenue: { [SEP]: 1_000_000 },
      cogs: { [SEP]: 600_000 },
      opex: { [SEP]: 300_000 },
      da_operating: { [SEP]: 50_000 },
      da_opex: { [SEP]: 50_000 },
      da_total: { [SEP]: 50_000 },
      other_income: { [SEP]: 10_000 },
      other_expense: { [SEP]: 30_000 },
    },
  }),
]);

describe('windows', () => {
  it('fiscal-year aware YTD / QTD / TTM', () => {
    expect(windowMonths('2026-09', 'ytd', 7)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(windowMonths('2026-08', 'qtd', 1)).toEqual(['2026-07', '2026-08']);
    expect(windowMonths('2026-09', 'ttm', 1)).toHaveLength(12);
    expect(windowMonths('2026-09', 'ttm', 1)[0]).toBe('2025-10');
    expect(priorPeriodShift('month')).toBe(1);
    expect(priorPeriodShift('qtd')).toBe(3);
    expect(priorPeriodShift('ytd')).toBe(12);
  });
});

describe('AC-K3 worked examples — P&L', () => {
  it.each([
    ['revenue', 1_000_000],
    ['gross_profit', 400_000],
    ['gross_margin', 40],
    ['opex_pct_revenue', 30],
    ['operating_income', 100_000],
    ['ebitda', 150_000],
    ['ebitda_margin', 15],
    ['net_income', 80_000],
    ['net_margin', 8],
    ['sga', 250_000],
    ['depreciation_amortization', 50_000],
  ])('%s = %d', (key, expected) => {
    expect(value(evaluateMetric(pnl, req(key)))).toBe(expected);
  });

  it('adjusted EBITDA equals EBITDA (and says so) without an add-back schedule', () => {
    const r = evaluateMetric(pnl, req('adjusted_ebitda'));
    expect(value(r)).toBe(150_000);
    expect(r.notes.join(' ')).toMatch(/No add-backs on file/);
    const withAddbacks = dataset([company({ ...pnlSpec(), operational: { addbacks: { [SEP]: 20_000 } } })]);
    expect(value(evaluateMetric(withAddbacks, req('adjusted_ebitda')))).toBe(170_000);
  });

  it('drill names the statement lines and their accounts', () => {
    const r = evaluateMetric(pnl, req('gross_margin'));
    expect(r.drill.map((d) => d.input).sort()).toEqual(['cogs', 'revenue']);
    expect(r.drill.find((d) => d.input === 'revenue')).toMatchObject({ kind: 'gl_flow', statement: 'income_statement', accountIds: ['acct-revenue'] });
  });
});

function pnlSpec() {
  return {
    id: 'a',
    flows: {
      revenue: { [SEP]: 1_000_000 },
      cogs: { [SEP]: 600_000 },
      opex: { [SEP]: 300_000 },
      da_operating: { [SEP]: 50_000 },
      da_opex: { [SEP]: 50_000 },
      da_total: { [SEP]: 50_000 },
    },
  };
}

describe('AC-K3 worked examples — working capital', () => {
  const wc = (unmapped: Parameters<typeof mappingAll>[0] = []) =>
    dataset(
      [
        company({
          id: 'a',
          flows: { revenue: { [SEP]: 1_000_000 }, cogs: { [SEP]: 600_000 }, ar: { [SEP]: 1_500_000 }, inventory: { [SEP]: 450_000 }, ap: { [SEP]: 300_000 } },
        }),
      ],
      { classMapping: mappingAll(unmapped) },
    );

  it('DSO = AR ÷ revenue × days (September has 30 days)', () => {
    expect(value(evaluateMetric(wc(), req('dso')))).toBe(45);
  });
  it('DIO, DPO and CCC = DSO + DIO − DPO', () => {
    expect(value(evaluateMetric(wc(), req('dio')))).toBe(22.5);
    expect(value(evaluateMetric(wc(), req('dpo')))).toBe(15);
    expect(value(evaluateMetric(wc(), req('cash_conversion_cycle')))).toBe(52.5);
  });
  it('CCC counts DIO as 0 (with a note) when there are no inventory accounts', () => {
    const r = evaluateMetric(wc(['inventory']), req('cash_conversion_cycle'));
    expect(value(r)).toBe(30);
    expect(r.notes.join(' ')).toMatch(/No inventory accounts/);
  });
  it('DSO on a TTM basis uses 365 days and TTM revenue', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: flat('2025-10', SEP, 1_000_000), ar: { [SEP]: 200_000 } } })]);
    expect(value(evaluateMetric(ds, req('dso', { basis: 'ttm' })))).toBe(6.1); // 200k / 12M × 365
  });
  it('current ratio and zero denominator', () => {
    const ok = dataset([company({ id: 'a', flows: { current_assets: { [SEP]: 300_000 }, current_liabilities: { [SEP]: 150_000 } } })]);
    expect(value(evaluateMetric(ok, req('current_ratio')))).toBe(2);
    const zero = dataset([company({ id: 'a', flows: { current_assets: { [SEP]: 300_000 } } })]);
    const r = evaluateMetric(zero, req('current_ratio'));
    expect(reason(r.current)).toBe('zero_denominator');
    expect(r.current.status === 'cannot_compute' && r.current.message).toBe('Zero denominator — Current liabilities (end of period) is zero');
  });
});

describe('AC-K3 worked examples — cash and lender', () => {
  it('runway = cash ÷ 3-month average burn', () => {
    const ds = dataset([company({ id: 'a', opening: { cash: 900_000 }, flows: { cash: { '2026-07': -100_000, '2026-08': -100_000, [SEP]: -100_000 } } })], { rangeStart: '2026-01' });
    expect(value(evaluateMetric(ds, req('net_burn')))).toBe(100_000);
    expect(value(evaluateMetric(ds, req('cash_runway_months')))).toBe(6);
  });
  it('runway is not meaningful while cash is growing', () => {
    const ds = dataset([company({ id: 'a', opening: { cash: 900_000 }, flows: { cash: { '2026-07': 100_000, '2026-08': 100_000, [SEP]: 100_000 } } })], { rangeStart: '2026-01' });
    const r = evaluateMetric(ds, req('cash_runway_months'));
    expect(reason(r.current)).toBe('not_meaningful');
    expect(r.current.status === 'cannot_compute' && r.current.message).toMatch(/generating cash/);
  });

  const lender = dataset([
    company({
      id: 'a',
      flows: {
        revenue: flat('2025-10', SEP, 1_000_000),
        cogs: flat('2025-10', SEP, 500_000),
        opex: flat('2025-10', SEP, 400_000),
        interest_expense: { '2026-03': 100_000 },
        debt_repaid: { '2026-06': 300_000 },
        capex: { '2026-02': 200_000 },
        income_tax_expense: { '2026-04': 50_000 },
        distributions: { '2026-08': 150_000 },
        total_debt: { [SEP]: 2_400_000 },
      },
    }),
  ]);
  it('DSCR = TTM EBITDA ÷ (interest + principal) = 3.0×, regardless of the dashboard basis', () => {
    expect(value(evaluateMetric(lender, req('dscr', { basis: 'month' })))).toBe(3);
  });
  it('FCCR = (EBITDA − capex − taxes − distributions) ÷ debt service = 2.0×', () => {
    expect(value(evaluateMetric(lender, req('fccr')))).toBe(2);
  });
  it('interest coverage = EBIT ÷ interest; debt / EBITDA on TTM', () => {
    expect(value(evaluateMetric(lender, req('interest_coverage')))).toBe(12);
    expect(value(evaluateMetric(lender, req('debt_to_ebitda')))).toBe(2);
  });
});

describe('AC-K3 worked examples — receivables (textbook CEI, BPDSO, ADD)', () => {
  const ar = dataset([
    company({
      id: 'a',
      operational: { ar_open: { '2026-08': 100_000, [SEP]: 90_000 }, ar_current: { [SEP]: 60_000 }, credit_sales: { [SEP]: 50_000 } },
      customerRevenue: { [SEP]: { c1: 500, c2: 300, c3: 200 } },
    }),
  ]);
  it('CEI = (begin AR + sales − end AR) ÷ (begin AR + sales − end current AR)', () => {
    expect(value(evaluateMetric(ar, req('collection_effectiveness_index')))).toBe(66.67);
  });
  it('BPDSO = current AR ÷ credit sales × days; ADD = DSO − BPDSO', () => {
    expect(value(evaluateMetric(ar, req('best_possible_dso')))).toBe(36);
    expect(value(evaluateMetric(ar, req('average_days_delinquent')))).toBe(18); // 54 − 36
  });
  it('concentration: top 1, top 5, HHI', () => {
    expect(value(evaluateMetric(ar, req('top_customer_concentration')))).toBe(50);
    expect(value(evaluateMetric(ar, req('top5_customer_concentration')))).toBe(100);
    expect(value(evaluateMetric(ar, req('customer_hhi')))).toBe(3800);
  });
});

describe('AC-K3 worked examples — growth', () => {
  it('YoY growth and TTM-to-TTM CAGR', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { '2025-09': 800_000, [SEP]: 1_000_000 } } })]);
    expect(value(evaluateMetric(ds, req('revenue_growth_yoy')))).toBe(25);
    const c = dataset([company({ id: 'a', flows: { revenue: { ...flat('2022-10', '2023-09', 1_000_000), ...flat('2025-10', SEP, 1_331_000) } } })]);
    expect(value(evaluateMetric(c, req('revenue_cagr_3y')))).toBe(10);
  });
  it('Rule of 40 = TTM revenue growth + TTM EBITDA margin', () => {
    const ds = dataset([
      company({
        id: 'a',
        flows: { revenue: { ...flat('2024-10', '2025-09', 1_000_000), ...flat('2025-10', SEP, 1_300_000) }, cogs: flat('2025-10', SEP, 650_000), opex: flat('2025-10', SEP, 455_000) },
      }),
    ]);
    expect(value(evaluateMetric(ds, req('rule_of_40')))).toBe(45);
  });
  it('months of backlog = backlog ÷ (TTM revenue ÷ 12)', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: flat('2025-10', SEP, 1_000_000) }, operational: { backlog: { [SEP]: 6_000_000 } } })]);
    expect(value(evaluateMetric(ds, req('months_of_backlog')))).toBe(6);
  });
  it('revenue per employee = TTM revenue ÷ average headcount', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: flat('2025-10', SEP, 1_000_000) }, operational: { headcount: flat('2025-10', SEP, 10) } })]);
    expect(value(evaluateMetric(ds, req('revenue_per_employee')))).toBe(1_200_000);
  });
});

describe('AC-K4 unavailable states', () => {
  it('not_enough_history names the books-start month', () => {
    const ds = dataset([company({ id: 'a', first: '2026-01', flows: { revenue: flat('2026-01', SEP, 1) } })]);
    const r = evaluateMetric(ds, req('revenue_growth_yoy'));
    expect(reason(r.current)).toBe('not_enough_history');
    expect(r.current.status === 'cannot_compute' && r.current.message).toBe('Not enough history — needs figures from Sep ’25; A’s books start Jan ’26'.replace('’s', "'s"));
  });
  it('not_mapped names the missing account role', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { [SEP]: 1 } } })], { classMapping: mappingAll(['ar']) });
    const r = evaluateMetric(ds, req('dso'));
    expect(reason(r.current)).toBe('not_mapped');
    expect(r.current.status === 'cannot_compute' && r.current.message).toMatch(/Accounts receivable \(account role AR_CONTROL\)/);
  });
  it('no_approved_budget on a budget comparison', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { [SEP]: 1_000 } }, budget: { revenue: { [SEP]: 900 } } })]);
    const r = evaluateMetric(ds, req('revenue', { comparison: 'budget' }));
    expect(r.comparison && reason(r.comparison.outcome)).toBe('no_approved_budget');
    expect(r.change).toBeNull();
  });
  it('no_jobs when a company has no job positions', () => {
    const r = evaluateMetric(dataset([company({ id: 'a' })]), req('backlog'));
    expect(reason(r.current)).toBe('no_jobs');
  });
  it('a month without a snapshot (jobs kept for the current month only) is not_on_file, not no_jobs', () => {
    const ds = dataset([company({ id: 'a', operational: { backlog: { [SEP]: 5_000 } } })]);
    const r = evaluateMetric(ds, req('backlog', { sparkline: 12 }));
    expect(value(r)).toBe(5_000);
    expect(r.sparkline[10]).toMatchObject({ month: '2026-08', value: null, reason: 'not_on_file' });
  });
  it('not_on_file when the source cannot supply an input', () => {
    const r = evaluateMetric(dataset([company({ id: 'a' })]), req('early_pay_discount_capture'));
    expect(reason(r.current)).toBe('not_on_file');
    expect(r.current.status === 'cannot_compute' && r.current.message).toBe('Not on file — no early-pay discount terms on file');
  });
  it('not_meaningful for growth from a loss', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { '2025-09': 100, [SEP]: 1_000 }, opex: { '2025-09': 500, [SEP]: 100 } } })]);
    const r = evaluateMetric(ds, req('ebitda_growth_yoy'));
    expect(reason(r.current)).toBe('not_meaningful');
  });
  it('not_enough_history when headcount covers too few months', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: flat('2025-10', SEP, 1) }, operational: { headcount: flat('2026-06', SEP, 10) } })]);
    const r = evaluateMetric(ds, req('revenue_per_employee'));
    expect(reason(r.current)).toBe('not_enough_history');
    expect(r.current.status === 'cannot_compute' && r.current.message).toMatch(/4 of 12 months/);
  });
  it('a company outside the dataset is excluded with a reason', () => {
    const r = evaluateMetric(pnl, req('revenue', { scope: { companyIds: ['a', 'zzz'], weighting: 'full' } }));
    expect(value(r)).toBe(1_000_000);
    expect(r.scope.excluded).toEqual([expect.objectContaining({ companyId: 'zzz', reason: 'not_on_file' })]);
  });
  it('a budget comparison is not offered on a measure that already uses the budget', () => {
    const r = evaluateMetric(pnl, req('revenue_budget_variance', { comparison: 'budget' }));
    expect(r.comparison && reason(r.comparison.outcome)).toBe('not_meaningful');
  });
  it('balances have no budget', () => {
    const ds = dataset([company({ id: 'a', flows: { current_assets: { [SEP]: 2 }, current_liabilities: { [SEP]: 1 } }, budgetApprovedFy: [2026] })]);
    const r = evaluateMetric(ds, req('current_ratio', { comparison: 'budget' }));
    expect(r.comparison && reason(r.comparison.outcome)).toBe('not_on_file');
  });
});

describe('AC-K5 change wording', () => {
  it('margins move in points and read improvement', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { '2025-09': 1_000_000, [SEP]: 1_000_000 }, cogs: { '2025-09': 630_000, [SEP]: 600_000 } } })]);
    const r = evaluateMetric(ds, req('gross_margin', { comparison: 'prior_year' }));
    expect(r.comparison?.outcome).toMatchObject({ status: 'ok', value: 37 });
    expect(r.change).toMatchObject({ delta: 3, inPoints: true, pct: null, verdict: 'improvement', arrow: 'up' });
    expect(r.change?.sentence).toBe('Improvement vs the same period last year');
  });
  it('a lower-is-better metric that falls is an improvement', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { '2025-09': 1_000_000, [SEP]: 1_000_000 }, ar: { '2025-09': 1_500_000, [SEP]: -500_000 } } })]);
    const r = evaluateMetric(ds, req('dso', { comparison: 'prior_year' }));
    expect(value(r)).toBe(30);
    expect(r.comparison?.outcome).toMatchObject({ value: 45 });
    expect(r.change).toMatchObject({ verdict: 'improvement', arrow: 'down', pct: -33.3 });
  });
  it('vs budget reads favourable / unfavourable', () => {
    const ds = dataset([company({ id: 'a', flows: { opex: { [SEP]: 300_000 } }, budget: { opex: { [SEP]: 320_000 } }, budgetApprovedFy: [2026] })]);
    const r = evaluateMetric(ds, req('opex', { comparison: 'budget' }));
    expect(r.change).toMatchObject({ delta: -20_000, verdict: 'favourable' });
    const over = dataset([company({ id: 'a', flows: { revenue: { [SEP]: 900 } }, budget: { revenue: { [SEP]: 1_000 } }, budgetApprovedFy: [2026] })]);
    expect(evaluateMetric(over, req('revenue', { comparison: 'budget' })).change?.verdict).toBe('unfavourable');
  });
  it('% change is n/m across a sign flip', () => {
    const ds = dataset([company({ id: 'a', flows: { revenue: { '2025-09': 100, [SEP]: 200 }, opex: { '2025-09': 300, [SEP]: 100 } } })]);
    const r = evaluateMetric(ds, req('net_income', { comparison: 'prior_year' }));
    expect(r.change).toMatchObject({ delta: 300, pct: null, pctNotMeaningful: true, verdict: 'improvement' });
  });
  it('neutral metrics read higher / lower', () => {
    const ds = dataset([company({ id: 'a', flows: { capex: { '2026-08': 100, [SEP]: 300 } } })]);
    expect(evaluateMetric(ds, req('capex', { comparison: 'prior_period' })).change?.verdict).toBe('higher');
  });
});

describe('AC-K6 sparklines and preliminary months', () => {
  const ds = dataset([company({ id: 'a', first: '2026-03', closedThrough: '2026-07', flows: { revenue: { '2026-03': 10, '2026-04': 20, '2026-06': 40, '2026-07': 50, '2026-08': 60, [SEP]: 70 } } })]);
  const r = evaluateMetric(ds, req('revenue', { sparkline: 12 }));
  it('months before the books start are null, never 0', () => {
    expect(r.sparkline).toHaveLength(12);
    expect(r.sparkline.slice(0, 5).map((p) => p.value)).toEqual([null, null, null, null, null]);
    expect(r.sparkline[0].reason).toBe('not_enough_history');
  });
  it('an on-file month with no activity is a real 0', () => {
    expect(r.sparkline.find((p) => p.month === '2026-05')?.value).toBe(0);
  });
  it('months after books-closed-through are preliminary', () => {
    expect(r.sparkline.find((p) => p.month === '2026-07')?.preliminary).toBe(false);
    expect(r.sparkline.find((p) => p.month === '2026-08')?.preliminary).toBe(true);
    expect(r.preliminary).toBe(true);
  });
});

describe('AC-K7 ownership weighting and like-for-like scope', () => {
  const two: MetricDataset = dataset([
    company({ id: 'a', flows: { revenue: { [SEP]: 1_000_000 }, cogs: { [SEP]: 600_000 } } }),
    company({ id: 'b', ownershipPct: 60, flows: { revenue: { [SEP]: 500_000 }, cogs: { [SEP]: 100_000 } } }),
  ]);
  const scope = (weighting: 'full' | 'ownership') => ({ companyIds: ['a', 'b'], weighting });
  it('combined = A + 0.6·B; ratios use the weighted inputs', () => {
    expect(value(evaluateMetric(two, req('revenue', { scope: scope('full') })))).toBe(1_500_000);
    expect(value(evaluateMetric(two, req('revenue', { scope: scope('ownership') })))).toBe(1_300_000);
    expect(value(evaluateMetric(two, req('gross_margin', { scope: scope('ownership') })))).toBe(49.23);
  });
  it('a company with no ownership row is counted at 100% and named', () => {
    const r = evaluateMetric(two, req('revenue', { scope: scope('ownership') }));
    expect(r.scope.assumedFullOwnership).toEqual(['a']);
    expect(r.notes.join(' ')).toMatch(/No ownership on file for A; counted at 100%/);
  });
  it('growth compares like-for-like when a company joined mid-way', () => {
    const ds = dataset([
      company({ id: 'a', flows: { revenue: flat('2025-01', SEP, 1_000_000) } }),
      company({ id: 'b', first: '2026-01', flows: { revenue: flat('2026-01', SEP, 500_000) } }),
    ]);
    const r = evaluateMetric(ds, req('revenue', { scope: scope('full'), comparison: 'prior_year' }));
    expect(value(r)).toBe(1_500_000);
    expect(r.comparison).toMatchObject({ likeForLike: true, outcome: { status: 'ok', value: 1_000_000 } });
    expect(r.change?.verdict).toBe('unchanged');
    expect(r.notes.join(' ')).toMatch(/like-for-like on the 1 of 2 companies/);
    const g = evaluateMetric(ds, req('revenue_growth_yoy', { scope: scope('full') }));
    expect(value(g)).toBe(0);
    expect(g.scope.excluded[0]).toMatchObject({ companyId: 'b', reason: 'not_enough_history' });
  });
});

describe('requiredRange', () => {
  it('a 5-year CAGR needs six years of flows', () => {
    expect(requiredRange(req('revenue_cagr_5y'), 1)).toEqual({ from: '2020-10', to: SEP });
  });
  it('an average balance needs the opening month', () => {
    expect(requiredRange(req('ar_turnover'), 1)).toEqual({ from: '2025-09', to: SEP });
  });
  it('sparklines extend the range', () => {
    expect(requiredRange(req('revenue', { sparkline: 12 }), 1).from).toBe('2025-10');
  });
});
