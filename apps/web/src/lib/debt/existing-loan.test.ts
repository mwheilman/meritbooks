/**
 * B9 — existing-loan mode vs new-loan mode on the create path.
 *
 *  - NEW loan (default): schedule from the original principal, origination JE posted.
 *  - EXISTING loan: schedule from the CURRENT balance as of cutover, remaining payments
 *    derived from term/origination (or maturity, or entered), NO origination JE — the
 *    opening trial balance already carries the liability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const recordDebtOrigination = vi.fn(async () => ({ gl_entry_id: 'je-1', entry_number: 'JE-1', interest_cents: 0, principal_cents: 0, alreadyPosted: false }));
vi.mock('./posting', async (orig) => {
  const actual = await orig<typeof import('./posting')>();
  return { ...actual, recordDebtOrigination: (...a: unknown[]) => recordDebtOrigination(...(a as [])) };
});

import { createDebtInstrument, planExistingLoan, wholeMonthsBetween } from './create';
import { createDebtSchema, type CreateDebtInput } from './schema';
import { AmortizationError } from './amortization';
import { EXISTING_LOAN_MARKER, isExistingLoanNotes } from './posting';

/** Minimal fake of the supabase builder chain create.ts uses. Records every insert. */
function fakeDb() {
  const inserts: Record<string, unknown[]> = {};
  const db = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          (inserts[table] ??= []).push(...(Array.isArray(rows) ? rows : [rows]));
          return {
            select: () => ({ single: async () => ({ data: { id: `${table}-id` }, error: null }) }),
            then: (res: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(res),
          };
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  };
  return { db: db as unknown as SupabaseClient, inserts };
}

function parse(raw: Record<string, unknown>): CreateDebtInput {
  return createDebtSchema.parse(raw);
}

const BASE = {
  loan_name: 'Term Loan A',
  location_id: '11111111-1111-4111-8111-111111111111',
  principal_cents: 12_000_000, // $120,000 original
  interest_rate: 6,
  payment_frequency: 'MONTHLY',
  term_periods: 60,
  origination_date: '2024-09-30',
};

beforeEach(() => recordDebtOrigination.mockClear());

describe('wholeMonthsBetween', () => {
  it('counts whole months only', () => {
    expect(wholeMonthsBetween('2024-09-30', '2026-09-30')).toBe(24);
    expect(wholeMonthsBetween('2024-09-30', '2026-09-29')).toBe(23);
    expect(wholeMonthsBetween('2026-01-15', '2026-01-31')).toBe(0);
    expect(wholeMonthsBetween('bad', '2026-01-31')).toBeNull();
  });
});

describe('schema — existing-loan fields', () => {
  it('defaults existing_loan to false (new loans keep today’s behavior)', () => {
    expect(parse(BASE).existing_loan).toBe(false);
  });

  it('requires the current balance and as-of date in existing mode', () => {
    expect(() => parse({ ...BASE, existing_loan: true })).toThrow();
    expect(() => parse({ ...BASE, existing_loan: true, current_balance_cents: 100 })).toThrow();
    expect(() => parse({ ...BASE, existing_loan: true, current_balance_cents: 100, balance_as_of_date: '2026-09-30' })).not.toThrow();
  });

  it('existing mode can be sized by maturity alone (no term, no payment)', () => {
    const v = parse({
      loan_name: 'LOC', principal_cents: 500_000, interest_rate: 8, existing_loan: true,
      current_balance_cents: 400_000, balance_as_of_date: '2026-09-30', maturity_date: '2028-09-30',
    });
    expect(v.existing_loan).toBe(true);
  });
});

describe('planExistingLoan', () => {
  it('derives payments left from term minus elapsed periods', () => {
    const plan = planExistingLoan(parse({
      ...BASE, existing_loan: true, current_balance_cents: 7_700_000, balance_as_of_date: '2026-09-30',
    }));
    expect(plan.remainingPeriods).toBe(36); // 60 − 24 elapsed
    expect(plan.remainingBasis).toBe('term');
    expect(plan.scheduleInput.principalCents).toBe(7_700_000);
    expect(plan.scheduleInput.originationDate).toBe('2026-09-30');
    expect(plan.note.startsWith(EXISTING_LOAN_MARKER)).toBe(true);
    expect(plan.note).toMatch(/original amount \$120,000\.00/);
  });

  it('an entered "payments left" wins; maturity is the next fallback', () => {
    expect(planExistingLoan(parse({ ...BASE, existing_loan: true, current_balance_cents: 1_000, balance_as_of_date: '2026-09-30', remaining_periods: 12 })).remainingPeriods).toBe(12);
    const byMaturity = planExistingLoan(parse({
      loan_name: 'X', principal_cents: 1_000_000, interest_rate: 5, existing_loan: true,
      current_balance_cents: 900_000, balance_as_of_date: '2026-09-30', maturity_date: '2027-09-30',
    }));
    expect(byMaturity.remainingPeriods).toBe(12);
    expect(byMaturity.remainingBasis).toBe('maturity');
  });

  it('refuses a loan whose term ended before the cutover', () => {
    expect(() => planExistingLoan(parse({
      ...BASE, term_periods: 12, existing_loan: true, current_balance_cents: 1_000, balance_as_of_date: '2026-09-30',
    }))).toThrow(AmortizationError);
  });
});

describe('createDebtInstrument — new vs existing', () => {
  it('NEW loan: schedule from original principal and the origination JE is posted', async () => {
    const { db, inserts } = fakeDb();
    const res = await createDebtInstrument(db, 'org-1', 'user_1', parse(BASE));
    expect(recordDebtOrigination).toHaveBeenCalledTimes(1);
    expect(res.existingLoan).toBe(false);
    expect(res.originationPosted).toBe(true);
    const inst = inserts.debt_instruments[0] as Record<string, unknown>;
    expect(inst.original_amount_cents).toBe(12_000_000);
    expect(inst.origination_date).toBe('2024-09-30');
    expect(res.schedule.periods).toBe(60);
    const lines = inserts.debt_schedule_lines as Array<{ principal_cents: number; principal_balance_cents: number }>;
    expect(lines[0].principal_balance_cents + lines[0].principal_cents).toBe(12_000_000);
  });

  it('EXISTING loan: forward schedule from the current balance, NO origination JE', async () => {
    const { db, inserts } = fakeDb();
    const res = await createDebtInstrument(db, 'org-1', 'user_1', parse({
      ...BASE, existing_loan: true, current_balance_cents: 7_700_000, balance_as_of_date: '2026-09-30',
    }));
    expect(recordDebtOrigination).not.toHaveBeenCalled();
    expect(res.existingLoan).toBe(true);
    expect(res.originationPosted).toBe(false);

    const inst = inserts.debt_instruments[0] as Record<string, unknown>;
    // The register opens at the cutover balance so every consumer ties to the opening TB.
    expect(inst.original_amount_cents).toBe(7_700_000);
    expect(inst.current_balance_cents).toBe(7_700_000);
    expect(inst.origination_date).toBe('2026-09-30');
    expect(inst.term_periods).toBe(36);
    expect(isExistingLoanNotes(inst.notes as string)).toBe(true);

    expect(res.schedule.periods).toBe(36);
    const lines = inserts.debt_schedule_lines as Array<{ period_date: string; principal_cents: number; principal_balance_cents: number }>;
    expect(lines[0].principal_balance_cents + lines[0].principal_cents).toBe(7_700_000);
    expect(lines[0].period_date).toBe('2026-10-30');
    expect(lines[lines.length - 1].principal_balance_cents).toBe(0);
    // Principal across the forward schedule repays exactly the balance brought over.
    expect(lines.reduce((s, l) => s + l.principal_cents, 0)).toBe(7_700_000);
  });

  it('EXISTING loan: an explicit postOrigination option still never posts', async () => {
    const { db } = fakeDb();
    await createDebtInstrument(db, 'org-1', null, parse({
      ...BASE, existing_loan: true, current_balance_cents: 5_000_000, balance_as_of_date: '2026-09-30', remaining_periods: 24,
    }), { postOrigination: true });
    expect(recordDebtOrigination).not.toHaveBeenCalled();
  });
});
