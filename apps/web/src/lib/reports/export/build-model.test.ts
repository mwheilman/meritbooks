import { describe, it, expect } from 'vitest';
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildTrialBalance,
  buildStatementSummary,
  resolveExportSpec,
  type ExportMeta,
} from './build-model';
import { derivePriorYear, derivePriorPeriod, derivePriorAsOf, variancePct } from './compare';
import { centsToDollars } from '@meritbooks/shared';

const meta: ExportMeta = {
  reportLabel: 'Profit & Loss',
  entityLabel: 'Acme Co',
  periodLabel: '2026-01-01 to 2026-01-31',
  accent: '#10b981',
};

// Minimal income-statement payloads (the SAME shape the API returns).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPayload(revenue: number, cogs: number, opex: number): any {
  return {
    sections: [
      { type: 'REVENUE', label: 'Revenue', totalCents: revenue, groups: [{ name: 'Sales', totalCents: revenue, accounts: [{ accountNumber: '4000', accountName: 'Sales', amountCents: revenue }] }] },
      { type: 'COGS', label: 'Cost of Goods Sold', totalCents: cogs, groups: [{ name: 'Materials', totalCents: cogs, accounts: [{ accountNumber: '5000', accountName: 'Materials', amountCents: cogs }] }] },
      { type: 'OPEX', label: 'Operating Expenses', totalCents: opex, groups: [{ name: 'Rent', totalCents: opex, accounts: [{ accountNumber: '6000', accountName: 'Rent', amountCents: opex }] }] },
    ],
    summary: {
      revenueCents: revenue, cogsCents: cogs, grossProfitCents: revenue - cogs,
      opexCents: opex, ebitdaCents: revenue - cogs - opex, otherCents: 0, netIncomeCents: revenue - cogs - opex,
    },
    filters: { startDate: '2026-01-01', endDate: '2026-01-31', basis: 'accrual' },
  };
}

describe('comparative P&L export model', () => {
  it('emits a single money column when there is no comparison', () => {
    const m = buildIncomeStatement(isPayload(1000_00, 400_00, 200_00), meta);
    expect(m.columns).toHaveLength(1);
    expect(m.columns[0]).toMatchObject({ money: true });
  });

  it('emits amount / prior / var$ / var% columns and correct variance when comparing', () => {
    const cur = isPayload(1000_00, 400_00, 200_00);   // NI = 400_00
    const prior = isPayload(800_00, 300_00, 200_00);  // NI = 300_00
    const m = buildIncomeStatement(cur, meta, { data: prior, label: 'Prior Yr' });

    expect(m.columns.map((c) => c.key)).toEqual(['amount', 'prior', 'var', 'varpct']);
    expect(m.columns[1].label).toBe('Prior Yr');
    expect(m.columns[3].money).toBeFalsy(); // var% is a display string, not currency

    // Revenue account row: 1000 current, 800 prior, +200 var, +25%.
    const rev = m.rows.find((r) => r.code === '4000')!;
    expect(rev.values[0]).toBe(1000_00);
    expect(rev.values[1]).toBe(800_00);
    expect(rev.values[2]).toBe(200_00);
    expect(rev.values[3]).toBe('+25%');

    // Net Income total row ties to the summary variance.
    const ni = m.rows.find((r) => r.kind === 'total' && r.label === 'Net Income')!;
    expect(ni.values[0]).toBe(400_00);
    expect(ni.values[1]).toBe(300_00);
    expect(ni.values[2]).toBe(100_00);
  });

  it('handles a fresh/empty company without crashing (all-zero statement)', () => {
    const empty = { sections: [], summary: { revenueCents: 0, cogsCents: 0, grossProfitCents: 0, opexCents: 0, ebitdaCents: 0, otherCents: 0, netIncomeCents: 0 }, filters: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = buildIncomeStatement(empty as any, meta);
    expect(m.rows.some((r) => r.kind === 'total' && r.label === 'Net Income')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withCmp = buildIncomeStatement(empty as any, meta, { data: empty as any, label: 'Prior Yr' });
    expect(withCmp.columns).toHaveLength(4);
    const ni = withCmp.rows.find((r) => r.kind === 'total')!;
    expect(ni.values[2]).toBe(0); // variance is zero, no divide-by-zero blowup
    expect(ni.values[3]).toBe('—'); // pct undefined on a zero base
  });
});

describe('comparative Balance Sheet export model', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bsPayload(assets: number, liab: number, equity: number): any {
    return {
      sections: [
        { type: 'ASSET', label: 'Assets', totalCents: assets, subTypes: [{ name: 'Current', totalCents: assets, groups: [{ name: 'Cash', totalCents: assets, accounts: [{ accountNumber: '1000', accountName: 'Cash', balanceCents: assets }] }] }] },
        { type: 'LIABILITY', label: 'Liabilities', totalCents: liab, subTypes: [{ name: 'Current', totalCents: liab, groups: [{ name: 'AP', totalCents: liab, accounts: [{ accountNumber: '2000', accountName: 'AP', balanceCents: liab }] }] }] },
        { type: 'EQUITY', label: 'Equity', totalCents: equity, subTypes: [{ name: 'Equity', totalCents: equity, groups: [{ name: 'RE', totalCents: equity, accounts: [{ accountNumber: '3000', accountName: 'Retained Earnings', balanceCents: equity }] }] }] },
      ],
      summary: { totalAssetsCents: assets, totalLiabilitiesCents: liab, totalEquityCents: equity, liabilitiesPlusEquityCents: liab + equity, isBalanced: assets === liab + equity, varianceCents: assets - (liab + equity) },
      filters: { asOfDate: '2026-01-31' },
    };
  }

  it('adds prior / change / change% columns keyed by account number', () => {
    const m = buildBalanceSheet(bsPayload(500_00, 200_00, 300_00), meta, { data: bsPayload(400_00, 200_00, 200_00), label: 'Prior Yr' });
    expect(m.columns.map((c) => c.key)).toEqual(['balance', 'prior', 'change', 'changepct']);
    const cash = m.rows.find((r) => r.code === '1000')!;
    expect(cash.values[0]).toBe(500_00);
    expect(cash.values[1]).toBe(400_00);
    expect(cash.values[2]).toBe(100_00);
    expect(cash.values[3]).toBe('+25%');
  });
});

describe('trial-balance refinement', () => {
  it('drops all-zero accounts and appends an in-balance note', () => {
    const m = buildTrialBalance({ data: [
      { account_number: '1000', account_name: 'Cash', total_debits: 500_00, total_credits: 0, net_balance: 500_00 },
      { account_number: '2000', account_name: 'AP', total_debits: 0, total_credits: 500_00, net_balance: -500_00 },
      { account_number: '9999', account_name: 'Dormant', total_debits: 0, total_credits: 0, net_balance: 0 },
    ] }, meta);
    expect(m.rows.find((r) => r.code === '9999')).toBeUndefined(); // zero row dropped
    const totals = m.rows.find((r) => r.kind === 'total')!;
    expect(totals.values).toEqual([500_00, 500_00, 0]);
    const note = m.rows.find((r) => r.kind === 'note')!;
    expect(String(note.label)).toMatch(/in balance/i);
  });
});

describe('executive summary sheet', () => {
  it('keeps section/subtotal/total rows and drops account detail, preserving columns', () => {
    const full = buildIncomeStatement(isPayload(1000_00, 400_00, 200_00), meta, { data: isPayload(800_00, 300_00, 200_00), label: 'Prior Yr' });
    const summary = buildStatementSummary(full);
    expect(summary.columns).toEqual(full.columns);
    expect(summary.rows.every((r) => r.kind !== 'account')).toBe(true);
    expect(summary.rows.some((r) => r.kind === 'total')).toBe(true);
    expect(summary.title).toMatch(/Summary$/);
  });
});

describe('resolveExportSpec comparison legs', () => {
  const ctx = { sd: '2026-01-01', ed: '2026-01-31', locIds: '', basis: 'accrual' as const };

  it('attaches a prior-year P&L comparison window', () => {
    const spec = resolveExportSpec('pnl', { ...ctx, compareMode: 'prior_year' })!;
    expect(spec.compare?.url).toBe('/api/reports/income-statement');
    expect(spec.compare?.query.start_date).toBe('2025-01-01');
    expect(spec.compare?.query.end_date).toBe('2025-01-31');
    expect(spec.compare?.label).toBe('Prior Yr');
  });

  it('attaches a prior-period Balance Sheet as-of date', () => {
    const spec = resolveExportSpec('bs', { sd: '', ed: '2026-02-28', locIds: '', basis: 'accrual', compareMode: 'prior_period' })!;
    expect(spec.compare?.url).toBe('/api/reports/balance-sheet');
    expect(spec.compare?.query.as_of_date).toBe('2026-01-31');
  });

  it('omits the comparison leg when compareMode is none or budget', () => {
    expect(resolveExportSpec('pnl', { ...ctx, compareMode: 'none' })!.compare).toBeUndefined();
    expect(resolveExportSpec('pnl', { ...ctx, compareMode: 'budget' })!.compare).toBeUndefined();
  });
});

describe('compare window math', () => {
  it('derivePriorYear shifts a whole month back one year', () => {
    expect(derivePriorYear('2026-01-01', '2026-01-31')).toEqual({ s: '2025-01-01', e: '2025-01-31' });
  });
  it('derivePriorPeriod on a full month gives the prior full month', () => {
    expect(derivePriorPeriod('2026-03-01', '2026-03-31')).toEqual({ s: '2026-02-01', e: '2026-02-28' });
  });
  it('derivePriorAsOf gives the prior month-end for prior_period', () => {
    expect(derivePriorAsOf('2026-03-31', 'prior_period')).toBe('2026-02-28');
  });
  it('variancePct returns em-dash on a zero base', () => {
    expect(variancePct(100, 0)).toBe('—');
    expect(variancePct(25, 100)).toBe('+25%');
  });
  it('sanity: centsToDollars edge conversion still applies at the writer, not the model', () => {
    // The model carries cents; this pins the contract the xlsx/csv writers rely on.
    expect(centsToDollars(150099)).toBeCloseTo(1500.99, 2);
  });
});
