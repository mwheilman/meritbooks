import { describe, it, expect } from 'vitest';
import { computeInsuranceTieOut } from './amortize';
import type { InsuranceScheduleSummary } from './amortize';

type SchedLike = Pick<InsuranceScheduleSummary, 'prepaid_account_id' | 'prepaid_account_name' | 'status' | 'remaining_cents'>;

function sched(over: Partial<SchedLike>): SchedLike {
  return {
    prepaid_account_id: 'prepaid-1300',
    prepaid_account_name: 'Prepaid Insurance',
    status: 'ACTIVE',
    remaining_cents: 0,
    ...over,
  };
}

describe('computeInsuranceTieOut — prepaid-insurance subledger ⇄ GL', () => {
  it('ties when ACTIVE remainders equal the prepaid GL debit balance', () => {
    const schedules = [
      sched({ remaining_cents: 60_000 }),
      sched({ remaining_cents: 40_000 }),
    ];
    const gl = new Map([['prepaid-1300', 100_000]]);
    const tie = computeInsuranceTieOut(schedules, gl);

    expect(tie.subledger_remaining_cents).toBe(100_000);
    expect(tie.gl_balance_cents).toBe(100_000);
    expect(tie.difference_cents).toBe(0);
    expect(tie.in_balance).toBe(true);
    expect(tie.by_account).toHaveLength(1);
    expect(tie.by_account[0].in_balance).toBe(true);
  });

  it('flags drift when the premium was booked to a different prepaid account than the schedule amortizes', () => {
    // Schedule amortizes 50k against prepaid-1300, but the GL account holds only 30k
    // (e.g. the premium was booked elsewhere) → 20k out of balance.
    const schedules = [sched({ remaining_cents: 50_000 })];
    const gl = new Map([['prepaid-1300', 30_000]]);
    const tie = computeInsuranceTieOut(schedules, gl);

    expect(tie.difference_cents).toBe(20_000);
    expect(tie.in_balance).toBe(false);
    expect(tie.by_account[0].difference_cents).toBe(20_000);
  });

  it('excludes non-ACTIVE schedules and reconciles per prepaid account', () => {
    const schedules = [
      sched({ prepaid_account_id: 'prepaid-1300', remaining_cents: 60_000, status: 'ACTIVE' }),
      sched({ prepaid_account_id: 'prepaid-1300', remaining_cents: 999_999, status: 'COMPLETED' }), // ignored
      sched({ prepaid_account_id: 'prepaid-1305', prepaid_account_name: 'Prepaid Auto Ins', remaining_cents: 25_000, status: 'ACTIVE' }),
    ];
    const gl = new Map([
      ['prepaid-1300', 60_000],
      ['prepaid-1305', 25_000],
    ]);
    const tie = computeInsuranceTieOut(schedules, gl);

    expect(tie.subledger_remaining_cents).toBe(85_000); // COMPLETED excluded
    expect(tie.in_balance).toBe(true);
    expect(tie.by_account).toHaveLength(2);
    const auto = tie.by_account.find((a) => a.prepaid_account_id === 'prepaid-1305');
    expect(auto?.subledger_remaining_cents).toBe(25_000);
    expect(auto?.prepaid_account_name).toBe('Prepaid Auto Ins');
  });
});
