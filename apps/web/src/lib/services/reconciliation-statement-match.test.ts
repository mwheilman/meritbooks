import { describe, it, expect } from 'vitest';
import {
  buildStatementMatchPlan,
  AUTO_CLEAR_THRESHOLD,
  REVIEW_THRESHOLD,
  type StatementLineInput,
  type BookLineInput,
} from './reconciliation-statement-match';

describe('buildStatementMatchPlan', () => {
  it('auto-clears an exact-ish match (same vendor, amount, date)', () => {
    const stmt: StatementLineInput[] = [
      { id: 's1', description: 'HOME DEPOT #4021', amountCents: -12500, transactionDate: '2026-06-10' },
    ];
    const book: BookLineInput[] = [
      { id: 'b1', description: 'Home Depot', amountCents: -12500, transactionDate: '2026-06-10' },
    ];
    const plan = buildStatementMatchPlan(stmt, book);
    expect(plan.autoCleared).toHaveLength(1);
    expect(plan.autoCleared[0].bookLineId).toBe('b1');
    expect(plan.autoCleared[0].score).toBeGreaterThanOrEqual(AUTO_CLEAR_THRESHOLD);
    expect(plan.needsReview).toHaveLength(0);
    expect(plan.unmatchedStatement).toHaveLength(0);
    expect(plan.unmatchedBookLineIds).toHaveLength(0);
  });

  it('never matches a deposit to a payment of equal magnitude (sign-gated)', () => {
    const stmt: StatementLineInput[] = [
      { id: 's1', description: 'ACME CORP', amountCents: 50000, transactionDate: '2026-06-15' },
    ];
    const book: BookLineInput[] = [
      { id: 'b1', description: 'ACME CORP', amountCents: -50000, transactionDate: '2026-06-15' },
    ];
    const plan = buildStatementMatchPlan(stmt, book);
    expect(plan.autoCleared).toHaveLength(0);
    expect(plan.needsReview).toHaveLength(0);
    expect(plan.unmatchedStatement).toHaveLength(1);
    expect(plan.unmatchedBookLineIds).toEqual(['b1']);
  });

  it('routes a partial-vendor match into needs-review, not auto', () => {
    // Exact amount + date + direction, but only one of the book vendor's two tokens
    // overlaps ("Shell" but not "Gas") → composite lands in the 70–89% review band.
    const stmt: StatementLineInput[] = [
      { id: 's1', description: 'SHELL OIL 9021', amountCents: -6000, transactionDate: '2026-06-01' },
    ];
    const book: BookLineInput[] = [
      { id: 'b1', description: 'Shell Gas', amountCents: -6000, transactionDate: '2026-06-01' },
    ];
    const plan = buildStatementMatchPlan(stmt, book);
    expect(plan.autoCleared).toHaveLength(0);
    expect(plan.needsReview).toHaveLength(1);
    expect(plan.needsReview[0].bookLineId).toBe('b1');
    expect(plan.needsReview[0].score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(plan.needsReview[0].score).toBeLessThan(AUTO_CLEAR_THRESHOLD);
    expect(plan.unmatchedStatement).toHaveLength(0);
  });

  it('assigns one-to-one greedily (no book line claimed twice)', () => {
    const stmt: StatementLineInput[] = [
      { id: 's1', description: 'Verizon Wireless', amountCents: -8000, transactionDate: '2026-06-10' },
      { id: 's2', description: 'Verizon Wireless', amountCents: -8000, transactionDate: '2026-06-11' },
    ];
    const book: BookLineInput[] = [
      { id: 'b1', description: 'Verizon Wireless', amountCents: -8000, transactionDate: '2026-06-10' },
      { id: 'b2', description: 'Verizon Wireless', amountCents: -8000, transactionDate: '2026-06-11' },
    ];
    const plan = buildStatementMatchPlan(stmt, book);
    const matchedBookIds = [...plan.autoCleared, ...plan.needsReview].map((p) => p.bookLineId);
    expect(new Set(matchedBookIds).size).toBe(matchedBookIds.length); // no dup book line
    expect(matchedBookIds.sort()).toEqual(['b1', 'b2']);
  });

  it('reports statement rows with no book entry as unmatchedStatement', () => {
    const stmt: StatementLineInput[] = [
      { id: 's1', description: 'MONTHLY SERVICE CHARGE', amountCents: -1500, transactionDate: '2026-06-30' },
    ];
    const book: BookLineInput[] = [
      { id: 'b1', description: 'Office Depot', amountCents: -9900, transactionDate: '2026-06-02' },
    ];
    const plan = buildStatementMatchPlan(stmt, book);
    expect(plan.autoCleared).toHaveLength(0);
    expect(plan.unmatchedStatement).toHaveLength(1);
    expect(plan.unmatchedStatement[0].statementId).toBe('s1');
    expect(plan.unmatchedBookLineIds).toEqual(['b1']);
  });

  it('handles empty inputs without throwing', () => {
    expect(buildStatementMatchPlan([], [])).toEqual({
      autoCleared: [],
      needsReview: [],
      unmatchedStatement: [],
      unmatchedBookLineIds: [],
    });
  });
});
