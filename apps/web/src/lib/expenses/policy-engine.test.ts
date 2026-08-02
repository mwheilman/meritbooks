import { describe, it, expect } from 'vitest';
import {
  evaluateExpense,
  evaluateReport,
  pickApprovalTier,
  resolveCategory,
  mileageAmountCents,
  type EngineLine,
} from './policy-engine';
import { expensePolicyRulesetSchema, DEFAULT_RULESET, type ExpensePolicyRuleset } from './policy-schema';

/** Build a validated ruleset from a partial (fills defaults via the schema). */
function ruleset(partial: Record<string, unknown> = {}): ExpensePolicyRuleset {
  return expensePolicyRulesetSchema.parse(partial);
}

const line = (over: Partial<EngineLine> = {}): EngineLine => ({
  id: 'l1',
  amountCents: 2000,
  accountId: null,
  categoryLabel: 'Some Cafe',
  hasReceipt: true,
  paymentSource: 'OUT_OF_POCKET',
  expenseDate: '2026-08-03', // Monday
  ...over,
});

const ruleIds = (violations: { rule_id: string }[]) => violations.map((v) => v.rule_id).sort();

describe('policy-engine — no active policy (DEFAULT_RULESET)', () => {
  it('yields zero violations and a null tier — conservative, non-blocking', () => {
    const ev = evaluateExpense(line({ amountCents: 9_999_00 }), DEFAULT_RULESET);
    expect(ev.violations).toHaveLength(0);
    expect(ev.requiredApprovalTier).toBeNull();
  });
});

describe('policy-engine — category matching', () => {
  const rs = ruleset({
    categories: [
      { category: 'MEALS', matchKeywords: ['cafe', 'restaurant'], perExpenseLimitCents: 5000 },
      { category: 'LODGING', matchAccountIds: ['00000000-0000-0000-0000-000000000001'], perExpenseLimitCents: 30000 },
    ],
  });

  it('matches by GL account id (strongest signal)', () => {
    const c = resolveCategory({ accountId: '00000000-0000-0000-0000-000000000001', categoryLabel: null }, rs);
    expect(c?.category).toBe('LODGING');
  });

  it('matches by keyword against the label', () => {
    const c = resolveCategory({ accountId: null, categoryLabel: 'Downtown Cafe' }, rs);
    expect(c?.category).toBe('MEALS');
  });

  it('returns null when nothing matches', () => {
    const c = resolveCategory({ accountId: null, categoryLabel: 'Hardware Store' }, rs);
    expect(c).toBeNull();
  });
});

describe('policy-engine — category per-expense limit', () => {
  const rs = ruleset({ categories: [{ category: 'MEALS', matchKeywords: ['cafe'], perExpenseLimitCents: 5000, severity: 'BLOCK' }] });

  it('flags at over the cap with the category severity', () => {
    const ev = evaluateExpense(line({ amountCents: 6000, categoryLabel: 'Cafe' }), rs);
    expect(ruleIds(ev.violations)).toContain('CATEGORY_PER_EXPENSE_LIMIT');
    expect(ev.violations[0].severity).toBe('BLOCK');
    expect(ev.violations[0].limitCents).toBe(5000);
    expect(ev.violations[0].actualCents).toBe(6000);
  });

  it('does NOT flag exactly at the cap', () => {
    const ev = evaluateExpense(line({ amountCents: 5000, categoryLabel: 'Cafe' }), rs);
    expect(ruleIds(ev.violations)).not.toContain('CATEGORY_PER_EXPENSE_LIMIT');
  });
});

describe('policy-engine — receipt threshold', () => {
  const rs = ruleset({ receiptRequiredOverCents: 7500, receiptRuleSeverity: 'WARN' });

  it('warns when no receipt at/above the threshold', () => {
    const ev = evaluateExpense(line({ amountCents: 8000, hasReceipt: false }), rs);
    expect(ruleIds(ev.violations)).toContain('RECEIPT_REQUIRED');
    expect(ev.violations.find((v) => v.rule_id === 'RECEIPT_REQUIRED')!.severity).toBe('WARN');
  });

  it('does not warn below the threshold or when a receipt exists', () => {
    expect(evaluateExpense(line({ amountCents: 5000, hasReceipt: false }), rs).violations).toHaveLength(0);
    expect(evaluateExpense(line({ amountCents: 8000, hasReceipt: true }), rs).violations).toHaveLength(0);
  });
});

describe('policy-engine — prohibited & pre-approval', () => {
  it('BLOCKs a prohibited category', () => {
    const rs = ruleset({ categories: [{ category: 'ALCOHOL', matchKeywords: ['bar'], prohibited: true }] });
    const ev = evaluateExpense(line({ categoryLabel: 'Corner Bar', amountCents: 3000 }), rs);
    const v = ev.violations.find((x) => x.rule_id === 'CATEGORY_PROHIBITED');
    expect(v?.severity).toBe('BLOCK');
  });

  it('WARNs a pre-approval-required category unless pre-approved', () => {
    const rs = ruleset({ categories: [{ category: 'CONFERENCES', matchKeywords: ['conference'], preApprovalRequired: true }] });
    const notApproved = evaluateExpense(line({ categoryLabel: 'Conference', preApproved: false }), rs);
    expect(ruleIds(notApproved.violations)).toContain('PREAPPROVAL_REQUIRED');
    const approved = evaluateExpense(line({ categoryLabel: 'Conference', preApproved: true }), rs);
    expect(ruleIds(approved.violations)).not.toContain('PREAPPROVAL_REQUIRED');
  });
});

describe('policy-engine — absolute ceiling & discretionary caps', () => {
  it('BLOCKs over the absolute per-expense ceiling', () => {
    const rs = ruleset({ perExpenseCeilingCents: 500000, perExpenseCeilingSeverity: 'BLOCK' });
    const ev = evaluateExpense(line({ amountCents: 600000 }), rs);
    expect(ev.violations.find((v) => v.rule_id === 'ABSOLUTE_CEILING')?.severity).toBe('BLOCK');
  });

  it('caps alcohol only for the ALCOHOL category', () => {
    const rs = ruleset({
      alcoholCapCents: 5000,
      discretionaryCapSeverity: 'WARN',
      categories: [{ category: 'ALCOHOL', matchKeywords: ['bar'] }, { category: 'MEALS', matchKeywords: ['cafe'] }],
    });
    expect(ruleIds(evaluateExpense(line({ categoryLabel: 'Bar', amountCents: 6000 }), rs).violations)).toContain('ALCOHOL_CAP');
    expect(ruleIds(evaluateExpense(line({ categoryLabel: 'Cafe', amountCents: 6000 }), rs).violations)).not.toContain('ALCOHOL_CAP');
  });
});

describe('policy-engine — per-diem', () => {
  const rs = ruleset({
    perDiem: { enabled: true, defaultDailyCents: 7500, appliesToCategories: ['MEALS'], byLocation: [{ location: 'New York', dailyCents: 12000 }] },
    categories: [{ category: 'MEALS', matchKeywords: ['cafe'] }],
  });

  it('flags over the default daily allowance', () => {
    const ev = evaluateExpense(line({ categoryLabel: 'Cafe', amountCents: 9000 }), rs);
    expect(ruleIds(ev.violations)).toContain('PER_DIEM_EXCEEDED');
  });

  it('uses a location override when present', () => {
    const ev = evaluateExpense(line({ categoryLabel: 'Cafe', amountCents: 9000, locationName: 'New York' }), rs);
    expect(ruleIds(ev.violations)).not.toContain('PER_DIEM_EXCEEDED'); // 9000 < 12000
  });
});

describe('policy-engine — approval tier selection', () => {
  const tiers = [
    { uptoCents: 50000, tier: 'MANAGER' },
    { uptoCents: 500000, tier: 'DIRECTOR' },
    { uptoCents: null, tier: 'CFO' },
  ];

  it('picks the first tier whose bound covers the amount', () => {
    expect(pickApprovalTier(40000, tiers)).toBe('MANAGER');
    expect(pickApprovalTier(50000, tiers)).toBe('MANAGER'); // inclusive
    expect(pickApprovalTier(300000, tiers)).toBe('DIRECTOR');
    expect(pickApprovalTier(900000, tiers)).toBe('CFO');
  });

  it('returns null when there are no tiers', () => {
    expect(pickApprovalTier(999999, [])).toBeNull();
  });

  it('falls back to the highest finite tier when no catch-all exists', () => {
    expect(pickApprovalTier(999999, [{ uptoCents: 50000, tier: 'MANAGER' }])).toBe('MANAGER');
  });
});

describe('policy-engine — report aggregates (per-day / per-trip)', () => {
  const rs = ruleset({
    categories: [{ category: 'MEALS', matchKeywords: ['cafe'], perDayLimitCents: 10000, perTripLimitCents: 20000, severity: 'WARN' }],
    approvalTiers: [{ uptoCents: 50000, tier: 'MANAGER' }, { uptoCents: null, tier: 'CFO' }],
  });

  it('flags every line of a day-group that exceeds the per-day limit', () => {
    const lines: EngineLine[] = [
      line({ id: 'a', categoryLabel: 'Cafe', amountCents: 6000, expenseDate: '2026-08-03' }),
      line({ id: 'b', categoryLabel: 'Cafe', amountCents: 6000, expenseDate: '2026-08-03' }),
      line({ id: 'c', categoryLabel: 'Cafe', amountCents: 3000, expenseDate: '2026-08-04' }),
    ];
    const rep = evaluateReport(lines, rs);
    const byId = new Map(rep.lines.map((l) => [l.lineId, l]));
    expect(ruleIds(byId.get('a')!.violations)).toContain('CATEGORY_PER_DAY_LIMIT');
    expect(ruleIds(byId.get('b')!.violations)).toContain('CATEGORY_PER_DAY_LIMIT');
    expect(ruleIds(byId.get('c')!.violations)).not.toContain('CATEGORY_PER_DAY_LIMIT');
  });

  it('flags per-trip when the whole-report category total exceeds the cap', () => {
    const lines: EngineLine[] = [
      line({ id: 'a', categoryLabel: 'Cafe', amountCents: 9000, expenseDate: '2026-08-03' }),
      line({ id: 'b', categoryLabel: 'Cafe', amountCents: 9000, expenseDate: '2026-08-04' }),
      line({ id: 'c', categoryLabel: 'Cafe', amountCents: 9000, expenseDate: '2026-08-05' }),
    ];
    const rep = evaluateReport(lines, rs);
    expect(rep.lines.every((l) => ruleIds(l.violations).includes('CATEGORY_PER_TRIP_LIMIT'))).toBe(true);
  });

  it('reports the tier for the report TOTAL and counts blocks/warns', () => {
    const lines: EngineLine[] = [
      line({ id: 'a', categoryLabel: 'Cafe', amountCents: 30000, expenseDate: '2026-08-03' }),
      line({ id: 'b', categoryLabel: 'Cafe', amountCents: 30000, expenseDate: '2026-08-04' }),
    ];
    const rep = evaluateReport(lines, rs); // total 60000 > 50000 → CFO
    expect(rep.requiredApprovalTier).toBe('CFO');
    expect(rep.warnCount).toBeGreaterThan(0);
  });
});

describe('policy-engine — mileage', () => {
  it('computes reimbursable mileage in integer cents', () => {
    const rs = ruleset({ mileageRateCentsPerMile: 67 });
    expect(mileageAmountCents(100, rs)).toBe(6700);
    expect(mileageAmountCents(10.5, rs)).toBe(704); // rounds
  });

  it('returns null with no rate or a bad distance', () => {
    expect(mileageAmountCents(100, DEFAULT_RULESET)).toBeNull();
    expect(mileageAmountCents(-5, ruleset({ mileageRateCentsPerMile: 67 }))).toBeNull();
  });
});
