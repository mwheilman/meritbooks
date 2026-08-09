/**
 * EC-14 out-of-policy expense — pure logic. Pins the report-level assessment folded
 * from the deterministic policy engine (WARN/BLOCK counting, $-out-of-policy, INFO
 * exclusion, null-on-clean), the escalate-on-authorized-block tiering, the dedup-key
 * stability (idempotency contract), and the reason composition. No Supabase, no
 * wall-clock in the scoring.
 */

import { describe, it, expect } from 'vitest';
import {
  toConfidence,
  outOfPolicyDedupKey,
  assessExpensePolicy,
  resolveOutOfPolicyExpenseTier,
  buildOutOfPolicyReason,
  OUT_OF_POLICY_THRESHOLDS,
} from './out-of-policy-expense';
import type { PolicyLineInput } from '@/lib/expenses/policy';
import { expensePolicyRulesetSchema, DEFAULT_RULESET } from '@/lib/expenses/policy-schema';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
const T = OUT_OF_POLICY_THRESHOLDS;

const WEEKDAY = '2026-08-05'; // Wednesday
const WEEKEND = '2026-08-08'; // Saturday

// A ruleset with: a WARN per-expense cap on MEALS, a BLOCK absolute ceiling, and a
// WARN receipt-required threshold. Built through the real schema so the shape is valid.
const RULESET = expensePolicyRulesetSchema.parse({
  categories: [
    {
      category: 'MEALS',
      label: 'Meals',
      matchKeywords: ['restaurant', 'meal'],
      perExpenseLimitCents: 5_000, // $50 WARN cap
      severity: 'WARN',
    },
  ],
  perExpenseCeilingCents: 100_000, // $1,000 absolute ceiling (BLOCK)
  perExpenseCeilingSeverity: 'BLOCK',
  receiptRequiredOverCents: 7_500, // $75 (WARN)
  receiptRuleSeverity: 'WARN',
});

function line(over: Partial<PolicyLineInput> & { id: string; amountCents: number }): PolicyLineInput {
  return {
    expenseDate: WEEKDAY,
    merchant: null,
    categoryKey: null,
    hasReceipt: true,
    paymentSource: 'OUT_OF_POCKET',
    ...over,
  };
}

describe('helpers', () => {
  it('toConfidence clamps into numeric(5,4)', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.951234)).toBe(0.9512);
    expect(toConfidence(NaN)).toBe(0);
  });

  it('outOfPolicyDedupKey is stable and report-scoped', () => {
    expect(outOfPolicyDedupKey('rep-1')).toBe('expensepolicy:rep-1');
    expect(outOfPolicyDedupKey('rep-1')).toBe(outOfPolicyDedupKey('rep-1'));
    expect(outOfPolicyDedupKey('rep-1')).not.toBe(outOfPolicyDedupKey('rep-2'));
  });
});

describe('assessExpensePolicy', () => {
  it('returns null when nothing trips a WARN/BLOCK rule', () => {
    const lines = [line({ id: 'l1', amountCents: 2_000, merchant: 'Corner Restaurant' })]; // under $50 cap
    expect(assessExpensePolicy(lines, RULESET)).toBeNull();
  });

  it('returns null under the empty default ruleset (nothing to enforce)', () => {
    const lines = [line({ id: 'l1', amountCents: 9_999_999, merchant: 'Anything' })];
    expect(assessExpensePolicy(lines, DEFAULT_RULESET)).toBeNull();
  });

  it('flags a WARN-only report at warn confidence with $-at-risk = the flagged line', () => {
    const lines = [
      line({ id: 'l1', amountCents: 8_000, merchant: 'Steakhouse Restaurant' }), // $80 > $50 MEALS cap → WARN
      line({ id: 'l2', amountCents: 1_000, merchant: 'Corner Restaurant' }), // compliant
    ];
    const a = assessExpensePolicy(lines, RULESET);
    expect(a).not.toBeNull();
    expect(a!.blockCount).toBe(0);
    expect(a!.warnCount).toBeGreaterThanOrEqual(1);
    expect(a!.flaggedLineCount).toBe(1);
    expect(a!.amountAtRiskCents).toBe(8_000); // only the flagged line counts
    expect(a!.reportTotalCents).toBe(9_000);
    expect(a!.confidence).toBe(T.warnConfidence);
  });

  it('flags a BLOCK report at block confidence (absolute ceiling breach)', () => {
    const lines = [line({ id: 'l1', amountCents: 150_000, merchant: 'Big Ticket' })]; // $1,500 > $1,000 ceiling → BLOCK
    const a = assessExpensePolicy(lines, RULESET);
    expect(a).not.toBeNull();
    expect(a!.blockCount).toBeGreaterThanOrEqual(1);
    expect(a!.flaggedLines[0].hasBlock).toBe(true);
    expect(a!.amountAtRiskCents).toBe(150_000);
    expect(a!.confidence).toBe(T.blockConfidence);
  });

  it('excludes INFO-only flags (a weekend-dated but otherwise compliant line raises nothing)', () => {
    const lines = [line({ id: 'l1', amountCents: 1_000, merchant: 'Corner Cafe', expenseDate: WEEKEND })];
    // Weekend is INFO under the engine; with no WARN/BLOCK breach there is no exception.
    expect(assessExpensePolicy(lines, RULESET)).toBeNull();
  });

  it('sums $-at-risk across multiple flagged lines only', () => {
    const lines = [
      line({ id: 'l1', amountCents: 8_000, merchant: 'A Restaurant' }), // WARN (over cap)
      line({ id: 'l2', amountCents: 150_000, merchant: 'Big Ticket' }), // BLOCK (ceiling)
      line({ id: 'l3', amountCents: 1_000, merchant: 'Corner Restaurant' }), // compliant
    ];
    const a = assessExpensePolicy(lines, RULESET)!;
    expect(a.flaggedLineCount).toBe(2);
    expect(a.amountAtRiskCents).toBe(158_000);
    expect(a.blockCount).toBeGreaterThanOrEqual(1);
    expect(a.confidence).toBe(T.blockConfidence); // any block → block confidence
  });
});

describe('resolveOutOfPolicyExpenseTier', () => {
  const block = { blockCount: 1, amountAtRiskCents: 150_000, confidence: T.blockConfidence };
  const warn = { blockCount: 0, amountAtRiskCents: 8_000, confidence: T.warnConfidence };

  it('escalates a hard-stop (BLOCK) that was APPROVED anyway', () => {
    expect(resolveOutOfPolicyExpenseTier(block, 'APPROVED', POLICY)).toBe('escalate');
  });

  it('escalates a hard-stop (BLOCK) that was REIMBURSED anyway', () => {
    expect(resolveOutOfPolicyExpenseTier(block, 'REIMBURSED', POLICY)).toBe('escalate');
  });

  it('reviews a still-pending (SUBMITTED) block below the $ escalate floor', () => {
    expect(resolveOutOfPolicyExpenseTier(block, 'SUBMITTED', POLICY)).toBe('review');
  });

  it('escalates a very large out-of-policy amount even while only SUBMITTED', () => {
    const huge = { blockCount: 1, amountAtRiskCents: T.escalateAtRiskCents, confidence: T.blockConfidence };
    expect(resolveOutOfPolicyExpenseTier(huge, 'SUBMITTED', POLICY)).toBe('escalate');
  });

  it('never auto-suppresses — a WARN-only report is at least review', () => {
    expect(resolveOutOfPolicyExpenseTier(warn, 'SUBMITTED', POLICY)).toBe('review');
    expect(resolveOutOfPolicyExpenseTier(warn, 'APPROVED', POLICY)).toBe('review');
  });
});

describe('buildOutOfPolicyReason', () => {
  it('names the $-at-risk, the status, and the hard-stop when a BLOCK is present', () => {
    const a = assessExpensePolicy(
      [line({ id: 'l1', amountCents: 150_000, merchant: 'Big Ticket' })],
      RULESET,
    )!;
    const reason = buildOutOfPolicyReason(a, 'REIMBURSED', "Ada's expense report");
    expect(reason).toContain('$1,500.00');
    expect(reason).toContain('hard-stop');
    expect(reason.toLowerCase()).toContain('reimbursed');
    expect(reason).toContain("Ada's expense report");
  });
});
