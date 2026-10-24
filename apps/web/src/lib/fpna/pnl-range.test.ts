import { describe, expect, it } from 'vitest';
import { bucketBudgetByMonth, bucketPnlByMonth, netIncomeOf, sumPnl } from './pnl-range';
import { resolvePeriod } from '@/lib/period/resolve';

const line = (entryDate: string, accountType: string, debitCents: number, creditCents: number) => ({ entryDate, accountType, debitCents, creditCents });

describe('bucketPnlByMonth', () => {
  it('natural sign by account type; balance-sheet lines ignored', () => {
    const b = bucketPnlByMonth([
      line('2026-01-15', 'REVENUE', 0, 100_00),
      line('2026-01-20', 'COGS', 40_00, 0),
      line('2026-01-31', 'OPEX', 25_00, 5_00),
      line('2026-01-31', 'OTHER', 0, 10_00), // other income → negative "other expense"
      line('2026-01-31', 'ASSET', 999_00, 0),
      line('2026-02-01', 'REVENUE', 3_00, 50_00),
    ]);
    expect(b['2026-01']).toEqual({ revenueCents: 100_00, cogsCents: 40_00, opexCents: 20_00, otherCents: -10_00 });
    expect(netIncomeOf(b['2026-01'])).toBe(50_00);
    expect(b['2026-02'].revenueCents).toBe(47_00);
  });
});

describe('sumPnl over a picked window', () => {
  const byMonth = bucketPnlByMonth([
    line('2025-11-03', 'REVENUE', 0, 10_00),
    line('2025-12-03', 'REVENUE', 0, 20_00),
    line('2026-01-03', 'REVENUE', 0, 30_00),
    line('2026-09-03', 'REVENUE', 0, 40_00),
  ]);
  const ctx = { fyStartMonth: 1, currentMonth: '2026-10', closedThrough: null };
  it('YTD spans only this fiscal year', () => {
    expect(sumPnl(byMonth, resolvePeriod({ basis: 'ytd', end: '2026-09' }, ctx).months).revenueCents).toBe(70_00);
  });
  it('TTM crosses the year boundary', () => {
    expect(sumPnl(byMonth, resolvePeriod({ basis: 'ttm', end: '2026-09' }, ctx).months).revenueCents).toBe(100_00);
  });
  it('a July fiscal year puts Nov–Dec 2025 in FY 2026', () => {
    const p = resolvePeriod({ basis: 'fy', end: '2025-12' }, { ...ctx, fyStartMonth: 7 });
    expect(p.label).toBe('FY 2026');
    expect(sumPnl(byMonth, p.months).revenueCents).toBe(60_00);
  });
});

describe('bucketBudgetByMonth', () => {
  it('maps fiscal period numbers onto calendar months (end-year convention)', () => {
    const b = bucketBudgetByMonth(
      [
        { fiscalYear: 2027, periodNumber: 1, accountType: 'REVENUE', amountCents: 5_00 }, // Jul 2026
        { fiscalYear: 2027, periodNumber: 12, accountType: 'OPEX', amountCents: 2_00 }, // Jun 2027
        { fiscalYear: 2027, periodNumber: 13, accountType: 'OPEX', amountCents: 1_00 }, // adjustment → last month
      ],
      7,
    );
    expect(b['2026-07'].revenueCents).toBe(5_00);
    expect(b['2027-06'].opexCents).toBe(3_00);
  });
  it('calendar tenants: period n = month n', () => {
    expect(Object.keys(bucketBudgetByMonth([{ fiscalYear: 2026, periodNumber: 3, accountType: 'COGS', amountCents: 1 }], 1))).toEqual(['2026-03']);
  });
});
