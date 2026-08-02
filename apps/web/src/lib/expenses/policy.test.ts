import { describe, it, expect } from 'vitest';
import {
  evaluateExpensePolicy,
  DEFAULT_EXPENSE_POLICY,
  type PolicyLineInput,
  type ExpensePolicyConfig,
} from './policy';

const line = (over: Partial<PolicyLineInput> = {}): PolicyLineInput => ({
  id: 'l1',
  expenseDate: '2026-08-03', // a Monday
  merchant: 'Acme Cafe',
  categoryKey: 'acct-meals',
  amountCents: 2000,
  hasReceipt: true,
  paymentSource: 'OUT_OF_POCKET',
  ...over,
});

const codes = (r: ReturnType<typeof evaluateExpensePolicy>, id: string) =>
  r.lines.find((x) => x.lineId === id)!.flags.map((f) => f.code).sort();

describe('evaluateExpensePolicy', () => {
  it('flags nothing for a clean, in-policy line', () => {
    const r = evaluateExpensePolicy([line()], DEFAULT_EXPENSE_POLICY);
    expect(r.flaggedCount).toBe(0);
    expect(codes(r, 'l1')).toEqual([]);
  });

  it('flags OVER_CATEGORY_LIMIT when a line exceeds its cap', () => {
    const cfg: ExpensePolicyConfig = {
      ...DEFAULT_EXPENSE_POLICY,
      categoryLimitsCents: { 'acct-meals': 5000 },
    };
    const r = evaluateExpensePolicy([line({ amountCents: 6000 })], cfg);
    expect(codes(r, 'l1')).toContain('OVER_CATEGORY_LIMIT');
  });

  it('does not flag at exactly the category cap', () => {
    const cfg: ExpensePolicyConfig = {
      ...DEFAULT_EXPENSE_POLICY,
      categoryLimitsCents: { 'acct-meals': 5000 },
    };
    const r = evaluateExpensePolicy([line({ amountCents: 5000 })], cfg);
    expect(codes(r, 'l1')).not.toContain('OVER_CATEGORY_LIMIT');
  });

  it('flags MISSING_RECEIPT at or above the threshold, not below', () => {
    const above = evaluateExpensePolicy([line({ id: 'a', hasReceipt: false, amountCents: 7500 })]);
    expect(codes(above, 'a')).toContain('MISSING_RECEIPT');
    const below = evaluateExpensePolicy([line({ id: 'b', hasReceipt: false, amountCents: 7499 })]);
    expect(codes(below, 'b')).not.toContain('MISSING_RECEIPT');
  });

  it('flags OVER_MAX above the per-expense ceiling as a block', () => {
    const r = evaluateExpensePolicy([line({ amountCents: 500001 })]);
    const flags = r.lines[0].flags;
    expect(flags.some((f) => f.code === 'OVER_MAX' && f.severity === 'block')).toBe(true);
  });

  it('flags WEEKEND_EXPENSE for a Saturday and a Sunday only', () => {
    const sat = evaluateExpensePolicy([line({ id: 's', expenseDate: '2026-08-01' })]); // Sat
    expect(codes(sat, 's')).toContain('WEEKEND_EXPENSE');
    const sun = evaluateExpensePolicy([line({ id: 'u', expenseDate: '2026-08-02' })]); // Sun
    expect(codes(sun, 'u')).toContain('WEEKEND_EXPENSE');
    const mon = evaluateExpensePolicy([line({ id: 'm', expenseDate: '2026-08-03' })]); // Mon
    expect(codes(mon, 'm')).not.toContain('WEEKEND_EXPENSE');
  });

  it('respects flagWeekend=false', () => {
    const r = evaluateExpensePolicy([line({ expenseDate: '2026-08-01' })], {
      ...DEFAULT_EXPENSE_POLICY,
      flagWeekend: false,
    });
    expect(codes(r, 'l1')).not.toContain('WEEKEND_EXPENSE');
  });

  it('flags DUPLICATE on identical merchant+amount+date, across differing case/space', () => {
    const r = evaluateExpensePolicy([
      line({ id: 'x', merchant: 'Acme Cafe', amountCents: 2000, expenseDate: '2026-08-03' }),
      line({ id: 'y', merchant: 'acme   cafe', amountCents: 2000, expenseDate: '2026-08-03' }),
      line({ id: 'z', merchant: 'Acme Cafe', amountCents: 2500, expenseDate: '2026-08-03' }),
    ]);
    expect(codes(r, 'x')).toContain('DUPLICATE');
    expect(codes(r, 'y')).toContain('DUPLICATE');
    expect(codes(r, 'z')).not.toContain('DUPLICATE');
  });

  it('flags PERSONAL_ON_CARD only for card-charged personal categories', () => {
    const cfg: ExpensePolicyConfig = {
      ...DEFAULT_EXPENSE_POLICY,
      personalCategoryKeys: ['acct-personal'],
    };
    const onCard = evaluateExpensePolicy(
      [line({ id: 'c', categoryKey: 'acct-personal', paymentSource: 'CORPORATE_CARD' })],
      cfg
    );
    expect(codes(onCard, 'c')).toContain('PERSONAL_ON_CARD');
    const outOfPocket = evaluateExpensePolicy(
      [line({ id: 'o', categoryKey: 'acct-personal', paymentSource: 'OUT_OF_POCKET' })],
      cfg
    );
    expect(codes(outOfPocket, 'o')).not.toContain('PERSONAL_ON_CARD');
  });

  it('is deterministic — identical input yields identical output', () => {
    const input = [line({ id: 'a' }), line({ id: 'b', amountCents: 999999 })];
    const a = JSON.stringify(evaluateExpensePolicy(input));
    const b = JSON.stringify(evaluateExpensePolicy(input));
    expect(a).toBe(b);
  });
});
