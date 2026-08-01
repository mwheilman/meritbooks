/**
 * Payroll run state machine — money-safety unit tests (GATE 12.3 Phase A).
 *
 * Pins the invariants a security review depends on:
 *   - legal/illegal status transitions (esp. no cancel/edit once money released),
 *   - separation of duties (an approver may not be the run's preparer),
 *   - the GL post is balanced (DR == CR) and posts at most once (idempotent).
 *
 * The state-machine + posting-line builders are pure; the DB-touching functions
 * are exercised against a tiny chainable Supabase fake. The engine is never hit
 * (these paths reject before any provider call).
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertRunTransition,
  InvalidRunTransitionError,
  RunPreparerCannotApproveError,
  RunStateError,
  approveRun,
  postRun,
  buildPayrollPostingLines,
  type PayrollRunRow,
  type PayrollPostingAccountIds,
} from './run';

// ── chainable Supabase fake ─────────────────────────────────────────────────
// Every builder method returns the chain; terminals (single/maybeSingle) and
// `await`ing the chain resolve to the configured result. Enough for the reject/
// idempotency paths, which never perform a second, differently-shaped read.
function makeDb(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit', 'delete', 'insert', 'update'];
  for (const m of passthrough) chain[m] = () => chain;
  chain.single = async () => result;
  chain.maybeSingle = async () => result;
  // Make the chain awaitable (for insert/delete/update terminals without .single).
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { from: () => chain } as unknown as SupabaseClient;
}

const baseRun = (over: Partial<PayrollRunRow>): PayrollRunRow => ({
  id: 'run1',
  org_id: 'org1',
  location_id: 'loc1',
  pay_schedule_id: null,
  provider: null,
  provider_run_id: null,
  period_start: '2026-08-01',
  period_end: '2026-08-15',
  pay_date: '2026-08-20',
  status: 'PREVIEWED',
  gross_cents: 1_000_00,
  net_cents: 700_00,
  employer_tax_cents: 100_00,
  employee_tax_cents: 200_00,
  benefits_cents: 50_00,
  deductions_cents: 50_00,
  approval_id: null,
  gl_entry_id: null,
  prepared_by: 'clerk_preparer',
  approved_by: null,
  released_by: null,
  memo: null,
  ...over,
});

// ── transitions (pure) ──────────────────────────────────────────────────────

describe('assertRunTransition', () => {
  it('allows the forward path draft -> previewed -> approved -> released', () => {
    expect(() => assertRunTransition('DRAFT', 'PREVIEWED')).not.toThrow();
    expect(() => assertRunTransition('PREVIEWED', 'APPROVED')).not.toThrow();
    expect(() => assertRunTransition('APPROVED', 'RELEASED')).not.toThrow();
    expect(() => assertRunTransition('RELEASED', 'PROCESSING')).not.toThrow();
    expect(() => assertRunTransition('PROCESSING', 'PAID')).not.toThrow();
  });

  it('rejects skipping preview/approval', () => {
    expect(() => assertRunTransition('DRAFT', 'APPROVED')).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition('DRAFT', 'RELEASED')).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition('PREVIEWED', 'RELEASED')).toThrow(InvalidRunTransitionError);
  });

  it('FORBIDS cancel/edit once money is released (in flight)', () => {
    expect(() => assertRunTransition('RELEASED', 'CANCELED')).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition('RELEASED', 'DRAFT')).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition('PROCESSING', 'CANCELED')).toThrow(InvalidRunTransitionError);
  });

  it('allows cancel only before release', () => {
    expect(() => assertRunTransition('DRAFT', 'CANCELED')).not.toThrow();
    expect(() => assertRunTransition('PREVIEWED', 'CANCELED')).not.toThrow();
    expect(() => assertRunTransition('APPROVED', 'CANCELED')).not.toThrow();
  });

  it('treats PAID / FAILED / CANCELED as terminal', () => {
    for (const to of ['DRAFT', 'PREVIEWED', 'APPROVED', 'RELEASED', 'PROCESSING'] as const) {
      expect(() => assertRunTransition('PAID', to)).toThrow(InvalidRunTransitionError);
      expect(() => assertRunTransition('FAILED', to)).toThrow(InvalidRunTransitionError);
      expect(() => assertRunTransition('CANCELED', to)).toThrow(InvalidRunTransitionError);
    }
  });
});

// ── separation of duties (approveRun) ───────────────────────────────────────

describe('approveRun — separation of duties', () => {
  it('rejects when the approver IS the preparer (before any approval is created)', async () => {
    const db = makeDb({ data: baseRun({ status: 'PREVIEWED', prepared_by: 'clerk_same' }), error: null });
    await expect(approveRun(db, 'org1', 'run1', 'clerk_same')).rejects.toBeInstanceOf(RunPreparerCannotApproveError);
  });

  it('rejects approving a run that is not previewed (invalid transition)', async () => {
    const db = makeDb({ data: baseRun({ status: 'DRAFT', prepared_by: 'clerk_preparer' }), error: null });
    await expect(approveRun(db, 'org1', 'run1', 'clerk_other')).rejects.toBeInstanceOf(InvalidRunTransitionError);
  });

  it('rejects when the run has no recorded preparer (cannot prove SoD)', async () => {
    const db = makeDb({ data: baseRun({ status: 'PREVIEWED', prepared_by: null }), error: null });
    await expect(approveRun(db, 'org1', 'run1', 'clerk_other')).rejects.toBeInstanceOf(RunStateError);
  });
});

// ── balanced GL post (pure builder) ─────────────────────────────────────────

const accounts: PayrollPostingAccountIds = {
  wagesExpenseId: 'a_wages',
  payrollTaxExpenseId: 'a_ertax_exp',
  paymentsInTransitId: 'a_transit',
  federalTaxPayableId: 'a_fed',
  benefitsPayableId: 'a_ben',
  garnishmentPayableId: 'a_garn',
  employerTaxPayableId: 'a_ertax_pay',
};

function dcTotals(lines: ReturnType<typeof buildPayrollPostingLines>) {
  const debits =
    lines.grossWagesCents + lines.employerTaxExpenses.reduce((s, e) => s + e.amount_cents, 0);
  const credits =
    lines.netPayCents +
    lines.withholdings.reduce((s, w) => s + w.amount_cents, 0) +
    lines.employerTaxLiabilities.reduce((s, l) => s + l.amount_cents, 0);
  return { debits, credits };
}

describe('buildPayrollPostingLines — balance identity', () => {
  it('produces a balanced entry (DR == CR) with net = gross - withholdings', () => {
    const lines = buildPayrollPostingLines(
      { grossCents: 100000, employeeTaxCents: 20000, employerTaxCents: 10000, benefitsCents: 5000, deductionsCents: 5000 },
      accounts,
    );
    expect(lines.netPayCents).toBe(100000 - 20000 - 5000 - 5000); // 70000
    const { debits, credits } = dcTotals(lines);
    expect(debits).toBe(credits);
    expect(debits).toBe(100000 + 10000); // gross + employer tax
  });

  it('omits zero-value components but still balances (wages + net only)', () => {
    const lines = buildPayrollPostingLines(
      { grossCents: 50000, employeeTaxCents: 0, employerTaxCents: 0, benefitsCents: 0, deductionsCents: 0 },
      accounts,
    );
    expect(lines.withholdings).toHaveLength(0);
    expect(lines.employerTaxExpenses).toHaveLength(0);
    expect(lines.netPayCents).toBe(50000);
    const { debits, credits } = dcTotals(lines);
    expect(debits).toBe(credits);
  });

  it('keeps employer-tax expense == employer-tax liability (required by recordPayrollRun)', () => {
    const lines = buildPayrollPostingLines(
      { grossCents: 80000, employeeTaxCents: 10000, employerTaxCents: 12345, benefitsCents: 0, deductionsCents: 0 },
      accounts,
    );
    const exp = lines.employerTaxExpenses.reduce((s, e) => s + e.amount_cents, 0);
    const liab = lines.employerTaxLiabilities.reduce((s, l) => s + l.amount_cents, 0);
    expect(exp).toBe(liab);
    expect(exp).toBe(12345);
  });
});

// ── idempotent GL post (postRun) ────────────────────────────────────────────

describe('postRun — idempotency', () => {
  it('does NOT re-post when a gl_entry_id already exists', async () => {
    const db = makeDb({ data: baseRun({ status: 'PAID', gl_entry_id: 'existing_entry' }), error: null });
    const result = await postRun(db, 'org1', 'run1');
    expect(result).toEqual({ glEntryId: 'existing_entry', alreadyPosted: true });
  });

  it('refuses to post a run that has not been released yet', async () => {
    const db = makeDb({ data: baseRun({ status: 'PREVIEWED', gl_entry_id: null }), error: null });
    await expect(postRun(db, 'org1', 'run1')).rejects.toBeInstanceOf(RunStateError);
  });
});
