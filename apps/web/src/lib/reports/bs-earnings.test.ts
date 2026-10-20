import { describe, it, expect } from 'vitest';
import {
  applyEarningsToBalanceSheet,
  CY_NI_LABEL,
  PRIOR_RE_LABEL,
  splitUnclosedEarnings,
  type BsPayloadLike,
  type PnlLine,
} from './bs-earnings';
import { fiscalYearStartFor } from '@/lib/dates/org-date';

// Live case (audit L5): [SANDBOX] Coho Flooring as of 2026-10-19.
// Assets $1,460,488.00, liabilities $1,460,000.00, booked equity $0 → "Off by $488.00".
function cohoBooked(): BsPayloadLike {
  return {
    sections: [
      { type: 'ASSET', label: 'Assets', subTypes: [{ name: 'Current', groups: [{ name: 'Cash', accounts: [{ accountNumber: '1000', accountName: 'Operating Checking', balanceCents: 141_000_000 }, { accountNumber: '1010', accountName: 'Payroll Checking', balanceCents: 48_800 }], totalCents: 141_048_800 }, { name: 'IC', accounts: [{ accountNumber: '1160', accountName: 'Intercompany Receivable', balanceCents: 5_000_000 }], totalCents: 5_000_000 }], totalCents: 146_048_800 }], totalCents: 146_048_800 },
      { type: 'LIABILITY', label: 'Liabilities', subTypes: [{ name: 'Long-term', groups: [{ name: 'Loans', accounts: [{ accountNumber: '2500', accountName: 'Term Loan', balanceCents: 146_000_000 }], totalCents: 146_000_000 }], totalCents: 146_000_000 }], totalCents: 146_000_000 },
      { type: 'EQUITY', label: 'Equity', subTypes: [], totalCents: 0 },
    ],
    summary: {
      totalAssetsCents: 146_048_800,
      totalLiabilitiesCents: 146_000_000,
      totalEquityCents: 0,
      liabilitiesPlusEquityCents: 146_000_000,
      isBalanced: false,
      varianceCents: 48_800,
    },
  };
}

// Coho's P&L lines (Travel / Meals) — credit-positive earnings net +$488.00.
const COHO_PNL: PnlLine[] = [
  { entryDate: '2026-04-12', debitCents: 0, creditCents: 50_000 },
  { entryDate: '2026-05-11', debitCents: 1_200, creditCents: 0 },
  { entryDate: '2026-05-12', debitCents: 0, creditCents: 50_000 },
  { entryDate: '2026-05-29', debitCents: 50_000, creditCents: 0 },
];

describe('balance sheet presents unclosed earnings in equity (audit L5)', () => {
  it('Coho (FY starts July): $488 is prior-year unclosed earnings; current-year NI $0; balances', () => {
    const fy = fiscalYearStartFor('2026-10-19', 7);
    const e = splitUnclosedEarnings(COHO_PNL, { asOfDate: '2026-10-19', fiscalYearStart: fy });
    expect(e).toEqual({ fiscalYearStart: '2026-07-01', priorYearsCents: 48_800, currentYearCents: 0 });

    const bs = applyEarningsToBalanceSheet(cohoBooked(), e);
    expect(bs.summary.totalEquityCents).toBe(48_800);
    expect(bs.summary.varianceCents).toBe(0);
    expect(bs.summary.isBalanced).toBe(true);
    expect(bs.summary.totalAssetsCents).toBe(bs.summary.totalLiabilitiesCents + bs.summary.totalEquityCents);
    const eq = bs.sections.find((s) => s.type === 'EQUITY')!;
    const names = eq.subTypes.flatMap((st) => st.groups.flatMap((g) => g.accounts.map((a) => a.accountName)));
    expect(names).toEqual([PRIOR_RE_LABEL, CY_NI_LABEL]);
  });

  it('calendar fiscal year: the same $488 is current-year net income', () => {
    const e = splitUnclosedEarnings(COHO_PNL, { asOfDate: '2026-10-19', fiscalYearStart: '2026-01-01' });
    expect(e.currentYearCents).toBe(48_800);
    expect(e.priorYearsCents).toBe(0);
    const bs = applyEarningsToBalanceSheet(cohoBooked(), e);
    expect(bs.summary.currentYearNetIncomeCents).toBe(48_800);
    expect(bs.summary.isBalanced).toBe(true);
    const eq = bs.sections.find((s) => s.type === 'EQUITY')!;
    // Prior-years line omitted when zero; current-year line always shown.
    expect(eq.subTypes[0].groups[0].accounts.map((a) => a.accountName)).toEqual([CY_NI_LABEL]);
    expect(eq.subTypes[0].groups[0].accounts[0].synthetic).toBe(true);
  });

  it('after a year-end CLOSING entry the prior-year P&L nets to zero (no double count)', () => {
    const closed: PnlLine[] = [
      { entryDate: '2025-06-01', debitCents: 0, creditCents: 100_000 }, // FY25 revenue
      { entryDate: '2025-12-31', debitCents: 100_000, creditCents: 0 }, // closing entry zeroes it
      { entryDate: '2026-03-01', debitCents: 0, creditCents: 7_500 },
    ];
    const e = splitUnclosedEarnings(closed, { asOfDate: '2026-10-19', fiscalYearStart: '2026-01-01' });
    expect(e.priorYearsCents).toBe(0);
    expect(e.currentYearCents).toBe(7_500);
  });

  it('lines after the as-of date are ignored; a net loss reduces equity', () => {
    const e = splitUnclosedEarnings(
      [
        { entryDate: '2026-02-01', debitCents: 25_000, creditCents: 0 },
        { entryDate: '2026-11-01', debitCents: 0, creditCents: 999_999 },
      ],
      { asOfDate: '2026-10-19', fiscalYearStart: '2026-01-01' },
    );
    expect(e.currentYearCents).toBe(-25_000);
  });
});
