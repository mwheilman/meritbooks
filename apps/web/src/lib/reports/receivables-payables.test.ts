/**
 * Wave-3 audit fix #3: ONE definition of receivables / payables (GL control balances by role),
 * used by the board package KPIs + summaries and the Home "Money" widget; the subledger gap is
 * named, never silently swapped in. Plus #10: no "—" margin placeholders in summaries.
 */
import { describe, expect, it } from 'vitest';
import { foldControlBalances, roleAccountIds, subledgerDifferenceText } from './control-balances';
import {
  buildExecutiveSummaryFacts,
  computeKpis,
  deterministicExecutiveSummary,
  marginClause,
  subledgerTieNotes,
  type AgingPayload,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type DebtPayload,
  type IncomeStatementPayload,
} from './board-package';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

describe('control balances', () => {
  const accounts = [
    { id: 'ar', account_number: '1100' },
    { id: 'icar', account_number: '1160' },
    { id: 'ap', account_number: '2000' },
    { id: 'icap', account_number: '2020' },
  ];
  it('by role — mapped first, else the standard number; intercompany never counts', () => {
    expect([...roleAccountIds(accounts, [{ role_key: 'AR_CONTROL', account_id: 'ar' }], ['AR_CONTROL'])]).toEqual(['ar']);
    expect([...roleAccountIds(accounts, [], ['AP_CONTROL'])]).toEqual(['ap']);
  });
  it('folds GL lines: AR debit-normal, AP credit-normal, as of the date, by company', () => {
    const lines = [
      { accountId: 'ar', locationId: 'nw', entryDate: '2026-06-30', debitCents: 15_000_000, creditCents: 0 },
      { accountId: 'ar', locationId: 'nw', entryDate: '2026-07-02', debitCents: 0, creditCents: 10_000 },
      { accountId: 'ap', locationId: 'nw', entryDate: '2026-06-30', debitCents: 0, creditCents: 20_000 },
      { accountId: 'icap', locationId: 'nw', entryDate: '2026-06-30', debitCents: 0, creditCents: 5_000_000 },
    ];
    const b = foldControlBalances(lines, new Set(['ar']), new Set(['ap']), '2026-10-26');
    expect(b.arCents).toBe(14_990_000);
    expect(b.apCents).toBe(20_000);
    expect(b.byLocation.nw).toEqual({ arCents: 14_990_000, apCents: 20_000 });
    expect(foldControlBalances(lines, new Set(['ar']), new Set(['ap']), '2026-06-30').arCents).toBe(15_000_000);
  });
  it('names a subledger gap instead of hiding it', () => {
    expect(subledgerDifferenceText('receivables', 14_990_000, 15_000_000, money)).toBe('Open invoices total $150000.00 — $100.00 more than the GL control account.');
    expect(subledgerDifferenceText('payables', 0, 0, money)).toBeNull();
  });
});

// ── board package ────────────────────────────────────────────────────────────
const IS = (revenue: number, gp: number, ni: number): IncomeStatementPayload => ({
  sections: [],
  summary: {
    revenueCents: revenue, cogsCents: revenue - gp, grossProfitCents: gp, opexCents: 0, ebitdaCents: gp, otherCents: 0, netIncomeCents: ni,
    grossMarginPct: revenue ? Math.round((gp / revenue) * 10000) / 100 : 0, netMarginPct: revenue ? Math.round((ni / revenue) * 10000) / 100 : 0,
  },
});
const BS: BalanceSheetPayload = {
  sections: [
    { type: 'ASSET', label: 'Assets', subTypes: [{ name: 'Current Assets', groups: [], totalCents: 500_000 }], totalCents: 500_000 },
    { type: 'LIABILITY', label: 'Liabilities', subTypes: [{ name: 'Current Liabilities', groups: [], totalCents: 800_000 }], totalCents: 800_000 },
    { type: 'EQUITY', label: 'Equity', subTypes: [], totalCents: -300_000 },
  ],
  summary: { totalAssetsCents: 500_000, totalLiabilitiesCents: 800_000, totalEquityCents: -300_000, liabilitiesPlusEquityCents: 500_000, isBalanced: true, varianceCents: 0 },
};
const CF: CashFlowPayload = {
  operating: { netIncome: 0, adjustments: [], changesInWorkingCapital: [], totalCents: 0 },
  investing: { items: [], totalCents: 0 },
  financing: { items: [], totalCents: 0 },
  netChangeCents: 0,
  beginningCashCents: 0,
  endingCashCents: 0,
} as CashFlowPayload;
const aging = (total: number): AgingPayload => ({ buckets: { CURRENT: { count: 1, totalCents: total } }, totalOutstanding: total });
const DEBT: DebtPayload = { data: [], summary: { totalBalanceCents: 0, totalMonthlyPaymentCents: 0, instrumentCount: 0, weightedAvgRate: 0 } };

describe('board package KPIs use the GL control balances', () => {
  const base = { currentIS: IS(0, 0, -50_000), balanceSheet: BS, cashFlow: CF, arAging: aging(15_000_000), apAging: aging(0), debt: DEBT };
  it('AR / AP = GL control (not open invoices / bills) when given', () => {
    const k = computeKpis({ ...base, control: { arCents: 14_990_000, apCents: 20_000 } });
    expect(k.arCents).toBe(14_990_000);
    expect(k.apCents).toBe(20_000);
    expect(k.cards.find((c) => c.key === 'ap')!.valueCents).toBe(20_000);
  });
  it('ratios print as ×, never %', () => {
    const k = computeKpis({ ...base, control: { arCents: 0, apCents: 0 } });
    expect(k.cards.find((c) => c.key === 'current_ratio')!.valueText).toBe('0.63×');
  });
  it('no revenue → summaries omit margins instead of printing "—"', () => {
    const k = computeKpis({ ...base, control: { arCents: 0, apCents: 0 } });
    const facts = buildExecutiveSummaryFacts(k, 'Northwind', 'Jun 2026');
    const text = deterministicExecutiveSummary(k, 'Northwind', 'Jun 2026');
    expect(facts).not.toContain('—');
    expect(facts).toContain('Margins: not meaningful');
    expect(text).not.toContain('—');
    expect(marginClause(0, 0, 'gross margin')).toBe('');
    expect(marginClause(60, 1_000_000, 'gross margin')).toBe(' at 60% gross margin');
  });
  it('the notes name a GL vs subledger gap', () => {
    const notes = subledgerTieNotes({ arCents: 14_990_000, apCents: 0 }, 15_000_000, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/open invoices differ by \$100\.00 \(more than the ledger\)/);
  });
});
