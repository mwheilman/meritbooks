import { describe, it, expect } from 'vitest';
import {
  computeKpis,
  assembleBoardPackage,
  buildBoardNotes,
  deterministicExecutiveSummary,
  boardPackageSchema,
  BOARD_SECTION_LIST,
  type IncomeStatementPayload,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type AgingPayload,
  type DebtPayload,
} from './board-package';

// ── Fixtures ──────────────────────────────────────────────────────────────────
function makeIS(revenue: number, gp: number, ni: number, opex = 0): IncomeStatementPayload {
  return {
    sections: [
      { type: 'REVENUE', label: 'Revenue', groups: [{ name: 'Sales', accounts: [{ accountNumber: '4000', accountName: 'Sales', amountCents: revenue }], totalCents: revenue }], totalCents: revenue },
    ],
    summary: {
      revenueCents: revenue,
      cogsCents: revenue - gp,
      grossProfitCents: gp,
      opexCents: opex,
      ebitdaCents: gp - opex,
      otherCents: 0,
      netIncomeCents: ni,
      grossMarginPct: revenue > 0 ? Math.round((gp / revenue) * 10000) / 100 : 0,
      netMarginPct: revenue > 0 ? Math.round((ni / revenue) * 10000) / 100 : 0,
    },
    filters: { startDate: '2026-01-01', endDate: '2026-01-31', basis: 'accrual' },
  };
}

const currentIS = makeIS(1_000_000, 600_000, 400_000, 200_000);
const priorIS = makeIS(800_000, 500_000, 300_000, 200_000);

const balanceSheet: BalanceSheetPayload = {
  sections: [
    { type: 'ASSET', label: 'Assets', subTypes: [
      { name: 'Current Assets', groups: [], totalCents: 500_000 },
      { name: 'Fixed Assets', groups: [], totalCents: 500_000 },
    ], totalCents: 1_000_000 },
    { type: 'LIABILITY', label: 'Liabilities', subTypes: [
      { name: 'Current Liabilities', groups: [], totalCents: 250_000 },
      { name: 'Long-Term Liabilities', groups: [], totalCents: 250_000 },
    ], totalCents: 500_000 },
    { type: 'EQUITY', label: 'Equity', subTypes: [{ name: 'Equity', groups: [], totalCents: 500_000 }], totalCents: 500_000 },
  ],
  summary: { totalAssetsCents: 1_000_000, totalLiabilitiesCents: 500_000, totalEquityCents: 500_000, liabilitiesPlusEquityCents: 1_000_000, isBalanced: true, varianceCents: 0 },
  filters: { asOfDate: '2026-01-31' },
};

const cashFlow: CashFlowPayload = {
  period: { startDate: '2026-01-01', endDate: '2026-01-31' },
  operating: { netIncome: 400_000, adjustments: [], changesInWorkingCapital: [], totalCents: 60_000 },
  investing: { items: [], totalCents: -10_000 },
  financing: { items: [], totalCents: 0 },
  netChangeCents: 50_000,
  beginningCashCents: 250_000,
  endingCashCents: 300_000,
};

const arAging: AgingPayload = {
  buckets: {
    CURRENT: { count: 2, totalCents: 100_000 },
    '1-30': { count: 0, totalCents: 0 },
    '31-60': { count: 0, totalCents: 0 },
    '61-90': { count: 0, totalCents: 0 },
    '90+': { count: 1, totalCents: 20_000 },
  },
  totalOutstanding: 120_000,
};
const apAging: AgingPayload = { buckets: { CURRENT: { count: 1, totalCents: 80_000 } }, totalOutstanding: 80_000 };

const debt: DebtPayload = {
  data: [
    { name: 'Term Loan A', lender: 'First Bank', type: 'TERM_LOAN', balanceCents: 300_000, interestRate: 6, maturityDate: '2030-01-01', monthlyPaymentCents: 3_000, annualPaymentCents: 36_000 },
    { name: 'Line of Credit', lender: 'Second Bank', type: 'LINE_OF_CREDIT', balanceCents: 200_000, interestRate: 7, maturityDate: null, monthlyPaymentCents: 2_000, annualPaymentCents: 24_000 },
  ],
  summary: { totalBalanceCents: 500_000, totalMonthlyPaymentCents: 5_000, instrumentCount: 2, weightedAvgRate: 6.5 },
};

const baseInput = { currentIS, priorIS, balanceSheet, cashFlow, arAging, apAging, debt };

// ── computeKpis ─────────────────────────────────────────────────────────────
describe('computeKpis', () => {
  it('computes headline figures deterministically', () => {
    const k = computeKpis(baseInput);
    expect(k.revenueCents).toBe(1_000_000);
    expect(k.grossProfitCents).toBe(600_000);
    expect(k.grossMarginPct).toBe(60);
    expect(k.operatingIncomeCents).toBe(400_000);
    expect(k.netIncomeCents).toBe(400_000);
    expect(k.netMarginPct).toBe(40);
    expect(k.cashCents).toBe(300_000);
    expect(k.netChangeInCashCents).toBe(50_000);
    expect(k.arCents).toBe(120_000);
    expect(k.apCents).toBe(80_000);
  });

  it('derives liquidity & leverage ratios from BS structure', () => {
    const k = computeKpis(baseInput);
    expect(k.currentAssetsCents).toBe(500_000);
    expect(k.currentLiabilitiesCents).toBe(250_000);
    expect(k.workingCapitalCents).toBe(250_000);
    expect(k.currentRatio).toBe(2);
    expect(k.debtToEquity).toBe(1);
    expect(k.returnOnEquityPct).toBe(80);
    expect(k.totalDebtCents).toBe(500_000);
    expect(k.annualDebtServiceCents).toBe(60_000);
    expect(k.weightedAvgRatePct).toBe(6.5);
  });

  it('computes period-over-period deltas from the prior IS', () => {
    const k = computeKpis(baseInput);
    expect(k.deltas.revenuePct).toBe(25);
    expect(k.deltas.grossProfitPct).toBe(20);
    expect(k.deltas.netIncomePct).toBeCloseTo(33.3, 1);
    const rev = k.cards.find((c) => c.key === 'revenue');
    expect(rev?.deltaCents).toBe(200_000);
    expect(rev?.favorable).toBe(true);
  });

  it('returns null ratios / deltas when inputs are absent', () => {
    const noCurrentBs: BalanceSheetPayload = {
      ...balanceSheet,
      sections: [{ type: 'ASSET', label: 'Assets', subTypes: [{ name: 'Other Assets', groups: [], totalCents: 100 }], totalCents: 100 }],
      summary: { ...balanceSheet.summary, totalEquityCents: 0 },
    };
    const k = computeKpis({ ...baseInput, priorIS: null, balanceSheet: noCurrentBs });
    expect(k.currentRatio).toBeNull();
    expect(k.workingCapitalCents).toBeNull();
    expect(k.debtToEquity).toBeNull();
    expect(k.returnOnEquityPct).toBeNull();
    expect(k.deltas.revenuePct).toBeNull();
  });
});

// ── Notes ─────────────────────────────────────────────────────────────────────
describe('buildBoardNotes', () => {
  const notes = buildBoardNotes({
    entityLabel: 'Acme Holdings',
    periodLabel: '2026-01-01 to 2026-01-31',
    generatedAt: '2026-02-01T00:00:00.000Z',
    balanceSheet, cashFlow, arAging, apAging, debt,
    basisLabel: 'Accrual basis',
  });

  it('emits the five disclosure notes', () => {
    expect(notes.notes.map((n) => n.id)).toEqual(['basis', 'policies', 'debt', 'receivables', 'subsequent_events']);
  });

  it('builds a deterministic debt table from the instruments', () => {
    const debtNote = notes.notes.find((n) => n.id === 'debt')!;
    expect(debtNote.table?.rows.length).toBe(2);
    expect(debtNote.table?.rows[0][0]).toBe('Term Loan A');
  });

  it('marks subsequent events as a human-filled placeholder', () => {
    const se = notes.notes.find((n) => n.id === 'subsequent_events')!;
    expect(se.editable).toBe(true);
    expect(se.body.some((b) => b.startsWith('[PLACEHOLDER'))).toBe(true);
  });
});

// ── Assembly ────────────────────────────────────────────────────────────────
describe('assembleBoardPackage', () => {
  const meta = {
    entityLabel: 'Acme Holdings',
    periodLabel: '2026-01-01 to 2026-01-31',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    asOfDate: '2026-01-31',
    generatedAt: '2026-02-01T00:00:00.000Z',
    basisLabel: 'Accrual basis',
    accent: '#10b981',
  };

  it('assembles a schema-valid package with all sections', () => {
    const pkg = assembleBoardPackage({ meta, ...baseInput });
    expect(pkg.cover.sectionList).toEqual([...BOARD_SECTION_LIST]);
    expect(pkg.executiveSummary.source).toBe('deterministic');
    expect(pkg.notes.notes.length).toBe(5);
    expect(pkg.statements.incomeStatement.summary.revenueCents).toBe(1_000_000);
    // The full package round-trips through the PDF-route validation schema.
    expect(boardPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('honours a pre-generated AI executive summary', () => {
    const pkg = assembleBoardPackage({ meta, ...baseInput, executiveSummary: { text: 'AI phrasing.', source: 'ai', model: 'claude-x' } });
    expect(pkg.executiveSummary.source).toBe('ai');
    expect(pkg.executiveSummary.text).toBe('AI phrasing.');
  });
});

// ── Deterministic exec summary ────────────────────────────────────────────────
describe('deterministicExecutiveSummary', () => {
  it('states the computed figures with no invented numbers', () => {
    const k = computeKpis(baseInput);
    const text = deterministicExecutiveSummary(k, 'Acme Holdings', '2026-01-01 to 2026-01-31');
    expect(text).toContain('Acme Holdings');
    expect(text).toContain('$10,000.00'); // revenue 1,000,000 cents
    expect(text).toContain('60% margin');
    expect(text).toContain('2.00x'); // current ratio
  });
});
