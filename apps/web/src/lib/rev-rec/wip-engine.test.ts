/**
 * The canonical WIP engine (FPB-rev-rec-wip §7 AC 1–3, 5). Pure — no database.
 *
 * The simulated ledger at the bottom posts the engine's entries month after month into an
 * in-memory GL and proves the accounting end to end: revenue each month = Δ earned, the
 * month-end 1180 / 2410 balances = under / over, the reversal lands on the 1st, and a
 * re-run after posting books nothing (idempotent adjust-to-target).
 */

import { describe, it, expect } from 'vitest';
import type { JobRevRecRow, RevRecMethod } from '@/lib/services/rev-rec';
import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import {
  buildWipEntries,
  computeTieOut,
  computeWipLine,
  nextPeriodStart,
  periodEnd,
  priorPeriodKey,
  totalsOf,
  wipSourceRefs,
  ZERO_BALANCES,
  type JobWipBalances,
  type WipAccounts,
  type WipLine,
} from './wip-engine';
import { resolveJobPolicy, DEFAULT_POLICY, type ResolvedJobPolicy } from './policy';
import { exampleFor } from './examples';

const LOC = 'loc-1';
const ACCTS: WipAccounts = {
  unbilledId: 'A1180', deferredId: 'L2410', lossProvisionId: 'L2450', lossExpenseId: 'C5250', fallbackRevenueId: 'R4000',
};
const ON: ResolvedJobPolicy = resolveJobPolicy({ company: DEFAULT_POLICY, companyRowExists: true });

function job(over: Partial<JobRevRecRow> = {}): JobRevRecRow & { job_number: string; name: string } {
  return {
    id: 'job-1', job_number: 'J-1', name: 'Clinic remodel', location_id: LOC, job_type: null, archetype: null,
    status: 'ACTIVE', rev_rec_method: null, rev_rec_method_override: null, revenue_account_id: 'R4100',
    contract_amount_cents: 10_000_000, estimated_cost_cents: 8_000_000, actual_cost_cents: 4_800_000,
    billed_to_date_cents: 5_000_000, pct_complete: 60, revenue_recognized_cents: 0,
    service_start_date: null, service_end_date: null, ...over,
  };
}

const sum = (ls: JournalEntryLineInput[], k: 'debit_cents' | 'credit_cents') => ls.reduce((s, l) => s + l[k], 0);
const opts = { asOf: '2026-10-31', lossProvision: true, materialityCents: 0 };

function line(method: RevRecMethod, j = job(), b: JobWipBalances = ZERO_BALANCES, extra: Partial<Parameters<typeof computeWipLine>[0]> = {}) {
  return computeWipLine({ job: j, method, policy: ON, balances: b, ...extra }, opts);
}

describe('earned revenue per method, in cents (AC 1)', () => {
  it('PCT_COSTS_INCURRED: contract × cost ÷ estimate', () => {
    expect(line('PCT_COSTS_INCURRED').earnedCents).toBe(6_000_000);
  });
  it('PCT_COMPLETE: contract × physical %', () => {
    expect(line('PCT_COMPLETE', job({ pct_complete: 37.5 })).earnedCents).toBe(3_750_000);
  });
  it('COMPLETED_CONTRACT: nothing until complete, everything when complete', () => {
    expect(line('COMPLETED_CONTRACT').earnedCents).toBe(0);
    expect(line('COMPLETED_CONTRACT', job({ status: 'COMPLETE' })).earnedCents).toBe(10_000_000);
  });
  it('MILESTONE: accepted milestones earn their share; without milestones it follows billing', () => {
    expect(line('MILESTONE', job({ total_milestones: 4, completed_milestones: 1 })).earnedCents).toBe(2_500_000);
    expect(line('MILESTONE').earnedCents).toBe(5_000_000);
  });
  it('AS_BILLED and POINT_OF_SALE: earned = billed (nothing to accrue)', () => {
    for (const m of ['AS_BILLED', 'POINT_OF_SALE'] as const) {
      const l = line(m);
      expect(l.earnedCents).toBe(5_000_000);
      expect(l.underCents + l.overCents).toBe(0);
    }
  });
  it('RATABLY / SUBSCRIPTION: straight-line over the service term', () => {
    const j = job({ contract_amount_cents: 1_200_000, service_start_date: '2026-01-01', service_end_date: '2027-01-01' });
    const l = computeWipLine({ job: j, method: 'RATABLY', policy: ON, balances: ZERO_BALANCES }, { ...opts, asOf: '2026-07-02' });
    // 182 of 365 days → 1,200,000 × 182 / 365, rounded to the cent
    expect(l.earnedCents).toBe(Math.round(1_200_000 * (182 / 365)));
    expect(computeWipLine({ job: j, method: 'SUBSCRIPTION', policy: ON, balances: ZERO_BALANCES }, { ...opts, asOf: '2026-07-02' }).earnedCents)
      .toBe(l.earnedCents);
  });
  it('CASH: earned = collected', () => {
    expect(line('CASH', job(), ZERO_BALANCES, { collectedToDateCents: 4_000_000 }).earnedCents).toBe(4_000_000);
  });
  it('every result is an integer number of cents', () => {
    const j = job({ contract_amount_cents: 1_000_001, estimated_cost_cents: 333_333, actual_cost_cents: 111_111 });
    for (const m of ['PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'MILESTONE', 'RATABLY', 'CASH'] as const) {
      expect(Number.isInteger(line(m, j).earnedCents)).toBe(true);
    }
  });
});

describe('underbilling / overbilling entries (AC 2)', () => {
  it('underbilled job: DR 1180 / CR Revenue, balanced, reversal flips every line', () => {
    const l = line('PCT_COSTS_INCURRED');
    expect(l.underCents).toBe(1_000_000);
    const e = buildWipEntries([l], ACCTS);
    expect(e.adjustment).toEqual([
      expect.objectContaining({ account_id: 'A1180', debit_cents: 1_000_000, credit_cents: 0, job_id: 'job-1' }),
      expect.objectContaining({ account_id: 'R4100', debit_cents: 0, credit_cents: 1_000_000, job_id: 'job-1' }),
    ]);
    expect(sum(e.adjustment, 'debit_cents')).toBe(sum(e.adjustment, 'credit_cents'));
    expect(e.reversal.map((x) => [x.account_id, x.debit_cents, x.credit_cents])).toEqual([
      ['A1180', 0, 1_000_000],
      ['R4100', 1_000_000, 0],
    ]);
    expect(e.reclass).toEqual([]);
  });

  it('overbilled job: DR Revenue / CR 2410, balanced', () => {
    const l = line('PCT_COSTS_INCURRED', job({ billed_to_date_cents: 7_500_000 }));
    expect(l.overCents).toBe(1_500_000);
    const e = buildWipEntries([l], ACCTS);
    expect(e.adjustment.map((x) => [x.account_id, x.debit_cents, x.credit_cents])).toEqual([
      ['L2410', 0, 1_500_000],
      ['R4100', 1_500_000, 0],
    ]);
  });

  it('billings sitting in 2410 (deferral method) are reclassed to revenue permanently', () => {
    const l = line('PCT_COSTS_INCURRED', job(), { ...ZERO_BALANCES, permDeferredCents: 5_000_000 });
    const e = buildWipEntries([l], ACCTS);
    expect(e.reclass.map((x) => [x.account_id, x.debit_cents, x.credit_cents])).toEqual([
      ['L2410', 5_000_000, 0],
      ['R4100', 0, 5_000_000],
    ]);
    expect(sum(e.reclass, 'debit_cents')).toBe(sum(e.reclass, 'credit_cents'));
  });

  it('a re-run after posting books only the true-up (adjust-to-target on WIP balances)', () => {
    const posted = { ...ZERO_BALANCES, wipUnbilledCents: 1_000_000 };
    expect(buildWipEntries([line('PCT_COSTS_INCURRED', job(), posted)], ACCTS).adjustment).toEqual([]);
    const trueUp = line('PCT_COSTS_INCURRED', job({ actual_cost_cents: 5_200_000 }), posted); // 65% → earned 6.5M
    expect(trueUp.adjUnbilledCents).toBe(500_000);
  });

  it('switches off: underbillings / overbillings stay at billed', () => {
    const off = resolveJobPolicy({ company: { ...DEFAULT_POLICY, accrueUnderbillings: false, deferOverbillings: false }, companyRowExists: true });
    const under = computeWipLine({ job: job(), method: 'PCT_COSTS_INCURRED', policy: off, balances: ZERO_BALANCES }, opts);
    expect(under.underCents).toBe(1_000_000);
    expect(under.targetUnderCents).toBe(0);
    expect(buildWipEntries([under], ACCTS).adjustment).toEqual([]);
  });

  it('materiality: a job adjustment below the threshold is left out and flagged', () => {
    const l = computeWipLine({ job: job(), method: 'PCT_COSTS_INCURRED', policy: ON, balances: ZERO_BALANCES }, { ...opts, materialityCents: 1_500_000 });
    expect(l.belowMateriality).toBe(true);
    expect(l.targetUnderCents).toBe(0);
  });

  it('an excluded job books nothing at all', () => {
    const ex = resolveJobPolicy({ company: DEFAULT_POLICY, companyRowExists: true, job: { excludeFromWip: true } });
    const l = computeWipLine({ job: job(), method: 'PCT_COSTS_INCURRED', policy: ex, balances: { ...ZERO_BALANCES, permDeferredCents: 9 } }, opts);
    const e = buildWipEntries([l], ACCTS);
    expect([...e.adjustment, ...e.reclass]).toEqual([]);
  });

  it('a job without a revenue account uses the fallback; with none it is reported, not guessed', () => {
    const l = line('PCT_COSTS_INCURRED', job({ revenue_account_id: null }));
    expect(buildWipEntries([l], ACCTS).adjustment[1].account_id).toBe('R4000');
    const none = buildWipEntries([l], { ...ACCTS, fallbackRevenueId: null });
    expect(none.adjustment).toEqual([]);
    expect(none.issues[0].reason).toMatch(/revenue account/);
  });
});

describe('loss provision (AC 3)', () => {
  // Contract 100k, EAC 120k (cost 60k = 50%) → earned 50k, GP to date −10k already in the P&L,
  // anticipated loss 20k → provision the remaining 10k.
  const loser = job({ estimated_cost_cents: 12_000_000, actual_cost_cents: 6_000_000, billed_to_date_cents: 5_000_000 });

  it('books the remaining anticipated loss: DR contract losses / CR provision', () => {
    const l = line('PCT_COSTS_INCURRED', loser);
    expect(l.earnedCents).toBe(5_000_000);
    expect(l.lossProvisionCents).toBe(1_000_000);
    expect(l.estGrossProfitCents).toBe(-2_000_000);
    const e = buildWipEntries([l], ACCTS);
    expect(e.adjustment.map((x) => [x.account_id, x.debit_cents, x.credit_cents])).toEqual([
      ['C5250', 1_000_000, 0],
      ['L2450', 0, 1_000_000],
    ]);
  });

  it('policy off → no loss lines; non-contract methods never provision', () => {
    const l = computeWipLine({ job: loser, method: 'PCT_COSTS_INCURRED', policy: ON, balances: ZERO_BALANCES }, { ...opts, lossProvision: false });
    expect(l.targetLossCents).toBe(0);
    expect(line('AS_BILLED', loser).lossProvisionCents).toBe(0);
  });

  it('missing loss accounts are reported, and the entry still balances', () => {
    const e = buildWipEntries([line('PCT_COSTS_INCURRED', loser)], { ...ACCTS, lossProvisionId: null });
    expect(e.issues[0].reason).toMatch(/loss/i);
    expect(sum(e.adjustment, 'debit_cents')).toBe(sum(e.adjustment, 'credit_cents'));
  });
});

describe('fade / gain, totals, tie-out (AC 5)', () => {
  it('fade = est. GP now − last month', () => {
    const l = line('PCT_COSTS_INCURRED', job(), ZERO_BALANCES, { priorEstGrossProfitCents: 2_500_000 });
    expect(l.fadeGainCents).toBe(-500_000); // est GP 2.0M vs 2.5M last month
    expect(totalsOf([l]).fadeJobs).toBe(1);
  });

  it('tie-out shows the difference before posting and zero after', () => {
    const l = line('PCT_COSTS_INCURRED');
    const before = computeTieOut({ lines: [l], gl: { unbilledJobs: 0, unbilledOther: 0, deferredJobs: 0, deferredOther: 12_345, lossJobs: 0, lossOther: 0 } });
    expect(before.unbilled.differenceCents).toBe(1_000_000);
    expect(before.deferred.glOtherCents).toBe(12_345);
    expect(before.tied).toBe(false);
    const after = computeTieOut({ lines: [l], gl: { unbilledJobs: 1_000_000, unbilledOther: 0, deferredJobs: 0, deferredOther: 12_345, lossJobs: 0, lossOther: 0 } });
    expect(after.tied).toBe(true);
  });

  it('period helpers + idempotency refs', () => {
    expect(periodEnd('2026-02')).toBe('2026-02-28');
    expect(nextPeriodStart('2026-12')).toBe('2027-01-01');
    expect(priorPeriodKey('2026-01')).toBe('2025-12');
    expect(wipSourceRefs('L', '2026-10', 2)).toEqual({
      adjustment: 'rev_rec_wip:L:2026-10:r2', reversal: 'rev_rec_wip:L:2026-10:r2:reversal', reclass: 'rev_rec_wip:L:2026-10:r2:reclass',
    });
  });
});

describe('worked examples come from the engine', () => {
  it('the cost-to-cost example is the $10,000 Unbilled AR entry', () => {
    const ex = exampleFor('PCT_COSTS_INCURRED', DEFAULT_POLICY);
    expect(ex.entry).toEqual([
      { side: 'DR', account: '1180 Unbilled receivable', amountCents: 1_000_000 },
      { side: 'CR', account: 'Revenue', amountCents: 1_000_000 },
    ]);
    expect(ex.sentence).toMatch(/\$10,000 to Unbilled AR/);
  });
  it('completed contract holds the billing as deferred revenue; as-billed has nothing', () => {
    expect(exampleFor('COMPLETED_CONTRACT', DEFAULT_POLICY).entry[1]).toEqual({ side: 'CR', account: '2410 Deferred revenue', amountCents: 5_000_000 });
    expect(exampleFor('AS_BILLED', DEFAULT_POLICY).entry).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Simulated ledger: two months, reversal on the 1st, invoices crediting 2410
// ─────────────────────────────────────────────────────────────────────────────

interface GlLine { date: string; module: string; account: string; job: string; dr: number; cr: number }

class Ledger {
  lines: GlLine[] = [];
  post(date: string, module: string, ls: JournalEntryLineInput[]) {
    expect(sum(ls, 'debit_cents')).toBe(sum(ls, 'credit_cents'));
    for (const l of ls) this.lines.push({ date, module, account: l.account_id, job: l.job_id ?? '', dr: l.debit_cents, cr: l.credit_cents });
  }
  bal(account: string, asOf: string, filter: (l: GlLine) => boolean = () => true) {
    return this.lines.filter((l) => l.account === account && l.date <= asOf && filter(l)).reduce((s, l) => s + l.dr - l.cr, 0);
  }
  revenueBetween(from: string, to: string) {
    return -this.lines.filter((l) => l.account === 'R4100' && l.date >= from && l.date <= to).reduce((s, l) => s + l.dr - l.cr, 0);
  }
  balances(asOf: string): JobWipBalances {
    const wip = (l: GlLine) => l.module === 'REV_REC_WIP';
    const perm = (l: GlLine) => l.module !== 'REV_REC_WIP';
    return {
      permUnbilledCents: this.bal('A1180', asOf, perm),
      permDeferredCents: -this.bal('L2410', asOf, perm),
      wipUnbilledCents: this.bal('A1180', asOf, wip),
      wipDeferredCents: -this.bal('L2410', asOf, wip),
      wipLossCents: -this.bal('L2450', asOf, wip),
    };
  }
}

function close(gl: Ledger, periodKey: string, j: JobRevRecRow): WipLine {
  const asOf = periodEnd(periodKey);
  const l = computeWipLine({ job: j, method: 'PCT_COSTS_INCURRED', policy: ON, balances: gl.balances(asOf) }, { ...opts, asOf });
  const e = buildWipEntries([l], ACCTS);
  if (e.reclass.length) gl.post(asOf, 'REV_REC_WIP_RECLASS', e.reclass);
  if (e.adjustment.length) {
    gl.post(asOf, 'REV_REC_WIP', e.adjustment);
    gl.post(nextPeriodStart(periodKey), 'REV_REC_WIP', e.reversal);
  }
  return l;
}

describe('simulated ledger across months (AC 2: self-reversing, revenue = Δ earned)', () => {
  it('Sep underbilled → Oct overbilled: monthly revenue and month-end balances are right', () => {
    const gl = new Ledger();
    // September: invoice $30k (deferral method → CR 2410), costs to 40% → earned $40k.
    gl.post('2026-09-15', 'INVOICE', [
      { account_id: 'A1100', debit_cents: 3_000_000, credit_cents: 0, location_id: LOC, job_id: 'job-1' },
      { account_id: 'L2410', debit_cents: 0, credit_cents: 3_000_000, location_id: LOC, job_id: 'job-1' },
    ]);
    close(gl, '2026-09', job({ actual_cost_cents: 3_200_000, billed_to_date_cents: 3_000_000 }));
    expect(gl.revenueBetween('2026-09-01', '2026-09-30')).toBe(4_000_000);
    expect(gl.bal('A1180', '2026-09-30')).toBe(1_000_000);
    expect(gl.bal('L2410', '2026-09-30')).toBe(0);

    // The reversal lands on Oct 1 and unwinds September's adjustment.
    expect(gl.bal('A1180', '2026-10-01')).toBe(0);

    // October: invoice another $45k (billed $75k), costs to 60% → earned $60k → overbilled $15k.
    gl.post('2026-10-20', 'INVOICE', [
      { account_id: 'A1100', debit_cents: 4_500_000, credit_cents: 0, location_id: LOC, job_id: 'job-1' },
      { account_id: 'L2410', debit_cents: 0, credit_cents: 4_500_000, location_id: LOC, job_id: 'job-1' },
    ]);
    const oct = job({ actual_cost_cents: 4_800_000, billed_to_date_cents: 7_500_000 });
    close(gl, '2026-10', oct);
    expect(gl.revenueBetween('2026-10-01', '2026-10-31')).toBe(2_000_000); // 60k − 40k
    expect(gl.revenueBetween('2026-01-01', '2026-10-31')).toBe(6_000_000); // = earned to date
    expect(gl.bal('A1180', '2026-10-31')).toBe(0);
    expect(gl.bal('L2410', '2026-10-31')).toBe(-1_500_000); // credit 15k = overbilling

    // Re-running October after posting proposes nothing (idempotent).
    const again = computeWipLine({ job: oct, method: 'PCT_COSTS_INCURRED', policy: ON, balances: gl.balances('2026-10-31') }, { ...opts, asOf: '2026-10-31' });
    const e = buildWipEntries([again], ACCTS);
    expect([...e.adjustment, ...e.reclass]).toEqual([]);
  });

  it('a legacy permanent 1180 accrual (retired path) is swept, not double counted', () => {
    const gl = new Ledger();
    gl.post('2026-09-30', 'REV_REC_ACCRUAL', [
      { account_id: 'A1180', debit_cents: 700_000, credit_cents: 0, location_id: LOC, job_id: 'job-1' },
      { account_id: 'R4100', debit_cents: 0, credit_cents: 700_000, location_id: LOC, job_id: 'job-1' },
    ]);
    // Billed $50k straight to revenue (as-billed history), earned $60k.
    gl.post('2026-10-05', 'INVOICE', [
      { account_id: 'A1100', debit_cents: 5_000_000, credit_cents: 0, location_id: LOC, job_id: 'job-1' },
      { account_id: 'R4100', debit_cents: 0, credit_cents: 5_000_000, location_id: LOC, job_id: 'job-1' },
    ]);
    close(gl, '2026-10', job());
    expect(gl.revenueBetween('2026-01-01', '2026-10-31')).toBe(6_000_000);
    expect(gl.bal('A1180', '2026-10-31')).toBe(1_000_000);
  });
});
