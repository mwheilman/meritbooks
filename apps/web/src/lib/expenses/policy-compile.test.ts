import { describe, it, expect } from 'vitest';
import { normalizePolicyExtraction, toCategoryToken } from './policy-compile';
import { expensePolicyRulesetSchema } from './policy-schema';

describe('policy-compile — toCategoryToken', () => {
  it('UPPER_SNAKE-cases free text and defaults empty to OTHER', () => {
    expect(toCategoryToken('Meals & Entertainment')).toBe('MEALS_AND_ENTERTAINMENT');
    expect(toCategoryToken('  air fare ')).toBe('AIR_FARE');
    expect(toCategoryToken('')).toBe('OTHER');
    expect(toCategoryToken(null)).toBe('OTHER');
  });
});

describe('policy-compile — normalizePolicyExtraction', () => {
  it('compiles a well-formed extraction into a schema-valid ruleset (dollars → cents)', () => {
    const { ruleset, documentNote } = normalizePolicyExtraction({
      categories: [
        {
          category: 'Meals',
          label: 'Meals',
          keywords: ['restaurant', 'Cafe'],
          per_expense_limit: 75,
          per_day_limit: 100,
          prohibited: false,
          pre_approval_required: false,
          severity: 'block',
        },
        { category: 'Alcohol', prohibited: 'yes' },
      ],
      receipt_required_over: 25,
      per_expense_ceiling: 5000,
      per_diem: { enabled: true, default_daily: 75, applies_to: ['Meals'], by_location: [{ location: 'NYC', daily: 120 }] },
      mileage_rate_dollars_per_mile: 0.67,
      alcohol_cap: 50,
      approval_tiers: [
        { upto: 500, tier: 'Manager' },
        { upto: 5000, tier: 'Director' },
        { upto: null, tier: 'CFO' },
      ],
      source_summary: 'Standard T&E policy',
      document_note: 'clean scan',
    });

    // Must validate against the fixed schema — the safety contract.
    expect(() => expensePolicyRulesetSchema.parse(ruleset)).not.toThrow();

    expect(documentNote).toBe('clean scan');
    expect(ruleset.categories).toHaveLength(2);
    const meals = ruleset.categories[0];
    expect(meals.category).toBe('MEALS');
    expect(meals.perExpenseLimitCents).toBe(7500); // $75 → cents
    expect(meals.perDayLimitCents).toBe(10000);
    expect(meals.matchKeywords).toEqual(['restaurant', 'cafe']); // lowercased
    expect(meals.severity).toBe('BLOCK');
    expect(ruleset.categories[1].prohibited).toBe(true); // 'yes' → true

    expect(ruleset.receiptRequiredOverCents).toBe(2500);
    expect(ruleset.perExpenseCeilingCents).toBe(500000);
    expect(ruleset.mileageRateCentsPerMile).toBe(67); // $0.67 → 67 cents
    expect(ruleset.alcoholCapCents).toBe(5000);

    expect(ruleset.perDiem.enabled).toBe(true);
    expect(ruleset.perDiem.defaultDailyCents).toBe(7500);
    expect(ruleset.perDiem.byLocation).toEqual([{ location: 'NYC', dailyCents: 12000 }]);
    expect(ruleset.perDiem.appliesToCategories).toContain('MEALS');

    expect(ruleset.approvalTiers).toEqual([
      { uptoCents: 50000, tier: 'Manager' },
      { uptoCents: 500000, tier: 'Director' },
      { uptoCents: null, tier: 'CFO' },
    ]);
  });

  it('captures free-text clauses that do not fit into unmappedClauses (human handling)', () => {
    const { ruleset } = normalizePolicyExtraction({
      categories: [],
      unmapped_clauses: [
        'Expense reports must be submitted within 30 days.',
        { text: 'First-class airfare requires VP approval.', note: 'no field for cabin class' },
      ],
    });
    expect(ruleset.unmappedClauses).toHaveLength(2);
    expect(ruleset.unmappedClauses[0].text).toContain('30 days');
    expect(ruleset.unmappedClauses[1].note).toContain('cabin class');
  });

  it('never throws on garbage input — degrades to a valid ruleset', () => {
    for (const bad of [null, undefined, 42, 'nope', { categories: 'not-an-array' }, {}]) {
      const { ruleset } = normalizePolicyExtraction(bad);
      expect(() => expensePolicyRulesetSchema.parse(ruleset)).not.toThrow();
    }
  });

  it('leaves unstated numeric fields null (never invents a limit)', () => {
    const { ruleset } = normalizePolicyExtraction({ categories: [{ category: 'Software' }] });
    expect(ruleset.categories[0].perExpenseLimitCents).toBeNull();
    expect(ruleset.receiptRequiredOverCents).toBeNull();
    expect(ruleset.perExpenseCeilingCents).toBeNull();
    expect(ruleset.mileageRateCentsPerMile).toBeNull();
  });

  it('rejects negative money by dropping it to null', () => {
    const { ruleset } = normalizePolicyExtraction({
      categories: [{ category: 'Meals', per_expense_limit: -50 }],
      receipt_required_over: -10,
    });
    expect(ruleset.categories[0].perExpenseLimitCents).toBeNull();
    expect(ruleset.receiptRequiredOverCents).toBeNull();
  });
});
