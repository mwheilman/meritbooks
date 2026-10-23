import { describe, it, expect } from 'vitest';
import { buildPnlByDimension, plainPnlTotals, UNASSIGNED, type DimensionLine } from './pnl-by-dimension';

// Slice 1F — "P&L by Department / by Class" must truly split by the dimension, and
// the split must tie: every column sums to Total, and Total = the plain P&L.

const SALES = 'd-sales';
const OPS = 'd-ops';

function line(p: Partial<DimensionLine> & Pick<DimensionLine, 'accountNumber' | 'accountType'>): DimensionLine {
  const credit = p.accountType === 'REVENUE';
  return {
    accountId: `acct-${p.accountNumber}`,
    accountName: `Account ${p.accountNumber}`,
    groupName: p.accountType,
    groupOrder: 1,
    normalBalance: credit ? 'CREDIT' : 'DEBIT',
    dimensionId: null,
    debitCents: 0,
    creditCents: 0,
    ...p,
  };
}

const LINES: DimensionLine[] = [
  line({ accountNumber: '4000', accountType: 'REVENUE', dimensionId: SALES, creditCents: 100_000_00 }),
  line({ accountNumber: '4000', accountType: 'REVENUE', dimensionId: OPS, creditCents: 25_000_00 }),
  line({ accountNumber: '4000', accountType: 'REVENUE', dimensionId: null, creditCents: 5_000_00 }),
  // a revenue reversal (debit) on Sales
  line({ accountNumber: '4100', accountType: 'REVENUE', dimensionId: SALES, debitCents: 1_000_00 }),
  line({ accountNumber: '5000', accountType: 'COGS', dimensionId: SALES, debitCents: 40_000_00 }),
  line({ accountNumber: '5000', accountType: 'COGS', dimensionId: OPS, debitCents: 10_000_00 }),
  line({ accountNumber: '6000', accountType: 'OPEX', dimensionId: OPS, debitCents: 30_000_00 }),
  line({ accountNumber: '6100', accountType: 'OPEX', dimensionId: null, debitCents: 7_500_00, creditCents: 500_00 }),
  line({ accountNumber: '7000', accountType: 'OTHER', dimensionId: SALES, debitCents: 2_000_00 }),
];

const VALUES = [
  { id: SALES, name: 'Sales' },
  { id: OPS, name: 'Operations' },
];

describe('buildPnlByDimension', () => {
  const r = buildPnlByDimension('department', LINES, VALUES);

  it('has one column per department, sorted, with Unassigned last', () => {
    expect(r.columns.map((c) => c.name)).toEqual(['Operations', 'Sales', 'Unassigned']);
    expect(r.columns[2].id).toBe(UNASSIGNED);
  });

  it('splits each account by department', () => {
    const rev = r.sections.find((s) => s.type === 'REVENUE')!;
    const a4000 = rev.groups.flatMap((g) => g.accounts).find((a) => a.accountNumber === '4000')!;
    expect(a4000.byColumn).toEqual({ [OPS]: 25_000_00, [SALES]: 100_000_00, [UNASSIGNED]: 5_000_00 });
    expect(a4000.totalCents).toBe(130_000_00);
  });

  it('every row ties: the columns sum to Total', () => {
    const rows = [
      ...r.sections.flatMap((s) => [s, ...s.groups, ...s.groups.flatMap((g) => g.accounts)]),
      ...Object.values(r.summary),
    ];
    for (const row of rows) {
      const sum = Object.values(row.byColumn).reduce((n, v) => n + v, 0);
      expect(sum).toBe(row.totalCents);
    }
  });

  it('the Total column equals the plain P&L', () => {
    const plain = plainPnlTotals(LINES);
    expect(r.summary.revenue.totalCents).toBe(plain.revenueCents);
    expect(r.summary.cogs.totalCents).toBe(plain.cogsCents);
    expect(r.summary.opex.totalCents).toBe(plain.opexCents);
    expect(r.summary.other.totalCents).toBe(plain.otherCents);
    expect(r.summary.netIncome.totalCents).toBe(plain.netIncomeCents);
    // 129,000 revenue − 50,000 COGS − 37,000 opex − 2,000 other = 40,000
    expect(plain.netIncomeCents).toBe(40_000_00);
  });

  it('per-department net income: revenue − COGS − opex − other within the column', () => {
    expect(r.summary.netIncome.byColumn[SALES]).toBe(99_000_00 - 40_000_00 - 2_000_00);
    expect(r.summary.netIncome.byColumn[OPS]).toBe(25_000_00 - 10_000_00 - 30_000_00);
    expect(r.summary.netIncome.byColumn[UNASSIGNED]).toBe(5_000_00 - 7_000_00);
  });

  it('no untagged lines → no Unassigned column; a value with no activity still gets a zero column', () => {
    const tagged = LINES.filter((l) => l.dimensionId !== null);
    const r2 = buildPnlByDimension('class', tagged, [...VALUES, { id: 'd-idle', name: 'Idle' }]);
    expect(r2.columns.map((c) => c.name)).toEqual(['Idle', 'Operations', 'Sales']);
    expect(r2.summary.netIncome.byColumn['d-idle']).toBe(0);
    expect(r2.summary.netIncome.totalCents).toBe(plainPnlTotals(tagged).netIncomeCents);
  });

  it('an empty period is all zeros', () => {
    const r3 = buildPnlByDimension('department', [], VALUES);
    expect(r3.summary.netIncome.totalCents).toBe(0);
  });
});
