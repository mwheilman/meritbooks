import { describe, it, expect } from 'vitest';
import {
  planUnbilledAccrual,
  buildUnbilledAccrualLines,
  buildUnbilledAccrual,
} from './unbilled-accrual';

const ACCTS = {
  unbilledAccountId: 'acct-1180',
  revenueAccountId: 'acct-4000',
  locationId: 'loc-1',
  jobId: 'job-1',
};

function totals(lines: { debit_cents: number; credit_cents: number }[]) {
  return lines.reduce(
    (t, l) => ({ dr: t.dr + l.debit_cents, cr: t.cr + l.credit_cents }),
    { dr: 0, cr: 0 },
  );
}

describe('planUnbilledAccrual', () => {
  it('targets the WIP under-billing (earned − billed) as the contract-asset balance', () => {
    // Earned 100k, billed 60k, nothing yet on 1180 → target 40k, accrue 40k.
    const plan = planUnbilledAccrual({
      earnedRevenueCents: 100_000_00,
      billedToDateCents: 60_000_00,
      existingContractAssetCents: 0,
    });
    expect(plan.targetContractAssetCents).toBe(40_000_00);
    expect(plan.deltaCents).toBe(40_000_00);
    expect(plan.amountCents).toBe(40_000_00);
    expect(plan.action).toBe('ACCRUE');
  });

  it('is a no-op when the job is not underbilled and nothing is carried', () => {
    // Billed >= earned → target 0, nothing carried → NONE.
    const plan = planUnbilledAccrual({
      earnedRevenueCents: 50_000_00,
      billedToDateCents: 80_000_00, // overbilled — a liability, not a contract asset
      existingContractAssetCents: 0,
    });
    expect(plan.targetContractAssetCents).toBe(0);
    expect(plan.deltaCents).toBe(0);
    expect(plan.action).toBe('NONE');
    expect(buildUnbilledAccrualLines(plan, ACCTS)).toEqual([]);
  });

  it('books only the DELTA when some contract asset is already carried', () => {
    // Target 40k, but 25k already on 1180 (prior accrual / rev-rec engine) → top up 15k.
    const plan = planUnbilledAccrual({
      earnedRevenueCents: 100_000_00,
      billedToDateCents: 60_000_00,
      existingContractAssetCents: 25_000_00,
    });
    expect(plan.targetContractAssetCents).toBe(40_000_00);
    expect(plan.deltaCents).toBe(15_000_00);
    expect(plan.action).toBe('ACCRUE');
  });

  it('REVERSES when billing has caught up and 1180 is over-carried', () => {
    // Now billed exceeds earned; but 40k is still carried on 1180 → unwind it.
    const plan = planUnbilledAccrual({
      earnedRevenueCents: 100_000_00,
      billedToDateCents: 100_000_00, // caught up → target 0
      existingContractAssetCents: 40_000_00,
    });
    expect(plan.targetContractAssetCents).toBe(0);
    expect(plan.deltaCents).toBe(-40_000_00);
    expect(plan.amountCents).toBe(40_000_00);
    expect(plan.action).toBe('REVERSE');
  });
});

describe('buildUnbilledAccrualLines', () => {
  it('ACCRUE posts a balanced DR 1180 / CR Revenue for the delta', () => {
    const { plan, lines } = buildUnbilledAccrual(
      { earnedRevenueCents: 100_000_00, billedToDateCents: 60_000_00, existingContractAssetCents: 0 },
      ACCTS,
    );
    expect(plan.action).toBe('ACCRUE');
    expect(lines).toHaveLength(2);

    const dr = lines.find((l) => l.debit_cents > 0)!;
    const cr = lines.find((l) => l.credit_cents > 0)!;
    // DR side is the contract asset (1180); CR side is Revenue.
    expect(dr.account_id).toBe('acct-1180');
    expect(dr.debit_cents).toBe(40_000_00);
    expect(cr.account_id).toBe('acct-4000');
    expect(cr.credit_cents).toBe(40_000_00);

    // Balances to zero (check_journal_balance would accept it).
    const t = totals(lines);
    expect(t.dr).toBe(t.cr);
    expect(t.dr).toBe(40_000_00);

    // Job + location dimensions are stamped so the 1180 balance ties per job.
    expect(dr.job_id).toBe('job-1');
    expect(dr.location_id).toBe('loc-1');
  });

  it('REVERSE flips the sides: DR Revenue / CR 1180, still balanced', () => {
    const { plan, lines } = buildUnbilledAccrual(
      { earnedRevenueCents: 100_000_00, billedToDateCents: 100_000_00, existingContractAssetCents: 40_000_00 },
      ACCTS,
    );
    expect(plan.action).toBe('REVERSE');
    const dr = lines.find((l) => l.debit_cents > 0)!;
    const cr = lines.find((l) => l.credit_cents > 0)!;
    expect(dr.account_id).toBe('acct-4000'); // revenue debited (reduced)
    expect(cr.account_id).toBe('acct-1180'); // contract asset relieved
    const t = totals(lines);
    expect(t.dr).toBe(t.cr);
    expect(t.dr).toBe(40_000_00);
  });

  it('NONE produces no lines (idempotent no-op)', () => {
    const { lines } = buildUnbilledAccrual(
      { earnedRevenueCents: 40_000_00, billedToDateCents: 40_000_00, existingContractAssetCents: 0 },
      ACCTS,
    );
    expect(lines).toEqual([]);
  });
});
