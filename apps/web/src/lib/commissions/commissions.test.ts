import { describe, it, expect } from 'vitest';
import {
  allocateByWeights,
  applyBps,
  assertStatementTransition,
  buildAccrualLines,
  buildPayoutReclassLines,
  buildStatement,
  computeTieredAmount,
  evaluateSource,
  isBalanced,
  prorate,
  reconcileSource,
  runCommissions,
  statementsToEarnings,
  validatePlan,
  StatementTransitionError,
  type CommissionLine,
  type CommissionPlan,
  type CommissionSource,
} from './index';

const NO_CLAWBACK = { onCancellation: false, onRefund: false, unpaidAfterDays: null, windowDays: null };
const STD_CLAWBACK = { onCancellation: true, onRefund: true, unpaidAfterDays: 90, windowDays: 180 };

const plan = (over: Partial<CommissionPlan>): CommissionPlan => ({
  id: 'plan-tech',
  name: 'Tech 5% of revenue',
  kind: 'PERCENT_REVENUE',
  basisEvent: 'INVOICED',
  rateBps: 500,
  clawback: STD_CLAWBACK,
  expenseClass: 'COGS',
  ...over,
});

const src = (over: Partial<CommissionSource>): CommissionSource => ({
  sourceType: 'JOB',
  sourceId: 'job-1',
  employeeId: 'tech-1',
  splitBps: 10_000,
  revenueCents: 1_200_000, // $12,000 HVAC install
  costCents: 700_000,
  quantity: 1,
  itemCode: null,
  soldOn: '2026-09-20',
  installedOn: '2026-10-05',
  invoicedOn: '2026-10-06',
  dueOn: '2026-11-05',
  paidCents: 0,
  paidOn: null,
  cancelledOn: null,
  refundedCents: 0,
  ...over,
});

describe('integer money helpers', () => {
  it('applies basis points with half-away-from-zero rounding and no float drift', () => {
    expect(applyBps(10_000, 500)).toBe(500);
    expect(applyBps(1, 5_000)).toBe(1); // 0.5 → 1
    expect(applyBps(-1, 5_000)).toBe(-1);
    expect(applyBps(333, 3_333)).toBe(111); // 110.9889 → 111
    expect(applyBps(9_000_000_000_000, 9_999)).toBe(8_999_100_000_000); // > 2^53 intermediate
  });

  it('prorates and allocates so parts sum exactly', () => {
    expect(prorate(1_000, 1, 3)).toBe(333);
    const parts = allocateByWeights(1_000, [1, 1, 1]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(1_000);
    expect(parts).toEqual([334, 333, 333]);
    expect(allocateByWeights(-100, [1, 3]).reduce((s, x) => s + x, 0)).toBe(-100);
  });
});

describe('plan validation', () => {
  it('rejects bad rates and non-ascending tiers', () => {
    expect(validatePlan(plan({ rateBps: 12_000 }))).not.toHaveLength(0);
    expect(validatePlan(plan({ kind: 'TIERED', tiers: [{ fromCents: 100, rateBps: 100 }] }))).toContain('the first tier must start at 0');
    expect(validatePlan(plan({}))).toEqual([]);
  });
});

describe('evaluateSource — plan kinds', () => {
  it('HVAC tech 5% of revenue on invoice post, split 50/50 between two techs', () => {
    const ev = evaluateSource(plan({}), src({ splitBps: 5_000 }), '2026-10-31');
    expect(ev.basisCents).toBe(600_000);
    expect(ev.amountCents).toBe(30_000); // $300 each
    expect(ev.basisOn).toBe('2026-10-06');
  });

  it('is not commissionable before the basis event', () => {
    expect(evaluateSource(plan({}), src({ invoicedOn: null }), '2026-10-31').amountCents).toBe(0);
    expect(evaluateSource(plan({ basisEvent: 'INSTALLED' }), src({}), '2026-10-04').amountCents).toBe(0);
  });

  it('salesperson 10% of gross profit on SOLD, with a margin floor', () => {
    const p = plan({ kind: 'PERCENT_GROSS_PROFIT', basisEvent: 'SOLD', rateBps: 1_000, expenseClass: 'OPEX' });
    expect(evaluateSource(p, src({}), '2026-10-31').amountCents).toBe(50_000); // GP $5,000 → $500
    expect(evaluateSource({ ...p, minMarginBps: 4_000 }, src({}), '2026-10-31').amountCents).toBe(50_000); // 41.67% ≥ 40%
    const floored = evaluateSource({ ...p, minMarginBps: 4_500 }, src({}), '2026-10-31');
    expect(floored.amountCents).toBe(0);
    expect(floored.explanation).toMatch(/margin/);
  });

  it('PAID basis earns pro-rata to cash collected', () => {
    const p = plan({ basisEvent: 'PAID' });
    expect(evaluateSource(p, src({ paidCents: 400_000, paidOn: '2026-10-20' }), '2026-10-31').amountCents).toBe(20_000);
    expect(evaluateSource(p, src({ paidCents: 1_200_000, paidOn: '2026-11-03' }), '2026-11-30').amountCents).toBe(60_000);
  });

  it('flat per job on INSTALLED, capped', () => {
    const p = plan({ kind: 'FLAT_PER_JOB', basisEvent: 'INSTALLED', flatCents: 7_500, capPerLineCents: 5_000 });
    expect(evaluateSource(p, src({}), '2026-10-31').amountCents).toBe(5_000);
  });

  it('spiff per qualifying unit (e.g. maintenance agreements sold)', () => {
    const p = plan({ kind: 'SPIFF', basisEvent: 'SOLD', flatCents: 2_500, spiffItemCodes: ['MAINT-PLAN'] });
    expect(evaluateSource(p, src({ itemCode: 'maint-plan', quantity: 3 }), '2026-10-31').amountCents).toBe(7_500);
    expect(evaluateSource(p, src({ itemCode: 'FILTER', quantity: 3 }), '2026-10-31').amountCents).toBe(0);
  });
});

describe('tiers', () => {
  const tiers = [
    { fromCents: 0, rateBps: 200 },
    { fromCents: 5_000_000, rateBps: 300 },
    { fromCents: 10_000_000, rateBps: 500 },
  ];
  it('MARGINAL: each slice at its own rate', () => {
    // $120k: $50k×2% + $50k×3% + $20k×5% = $1,000 + $1,500 + $1,000 = $3,500
    expect(computeTieredAmount(12_000_000, tiers, 'MARGINAL')).toEqual({ amountCents: 350_000, topTierRateBps: 500 });
  });
  it('RETROACTIVE: whole amount at the top tier reached', () => {
    expect(computeTieredAmount(12_000_000, tiers, 'RETROACTIVE').amountCents).toBe(600_000);
    expect(computeTieredAmount(4_999_999, tiers, 'RETROACTIVE').amountCents).toBe(100_000);
  });
  it('runCommissions allocates the tiered period total back to jobs, summing exactly', () => {
    const p = plan({ id: 'plan-tier', name: 'Sales accelerator', kind: 'TIERED', tiers, tierMode: 'MARGINAL', tierMeasure: 'REVENUE', rateBps: undefined });
    const sources = [
      src({ sourceId: 'j1', revenueCents: 7_000_000, invoicedOn: '2026-10-02' }),
      src({ sourceId: 'j2', revenueCents: 3_000_000, invoicedOn: '2026-10-10' }),
      src({ sourceId: 'j3', revenueCents: 2_000_000, invoicedOn: '2026-10-25' }),
    ];
    const lines = runCommissions({
      plans: [p],
      assignments: [{ employeeId: 'tech-1', planId: 'plan-tier', effectiveFrom: '2026-01-01', effectiveTo: null }],
      sources,
      priorLines: [],
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    });
    expect(lines).toHaveLength(3);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(350_000);
    expect(lines.every((l) => l.kind === 'EARNED' && l.rateBps > 0)).toBe(true);
  });
});

describe('reconcile — clawbacks, reinstatement, idempotency', () => {
  const p = plan({});
  const earned: CommissionLine = {
    planId: p.id,
    employeeId: 'tech-1',
    sourceType: 'JOB',
    sourceId: 'job-1',
    kind: 'EARNED',
    basisCents: 1_200_000,
    rateBps: 500,
    amountCents: 60_000,
    recognizedOn: '2026-10-06',
    explanation: '5.00% of revenue',
  };

  it('first run earns; re-running with that line recorded is a no-op', () => {
    const first = reconcileSource(p, src({}), [], '2026-10-31');
    expect(first).toMatchObject({ kind: 'EARNED', amountCents: 60_000, recognizedOn: '2026-10-06' });
    expect(reconcileSource(p, src({}), [first!], '2026-10-31')).toBeNull();
  });

  it('claws back the full amount on cancellation inside the window, dated on the cancellation', () => {
    const line = reconcileSource(p, src({ cancelledOn: '2026-11-15' }), [earned], '2026-11-30');
    expect(line).toMatchObject({ kind: 'CLAWBACK', amountCents: -60_000, recognizedOn: '2026-11-15' });
  });

  it('keeps the commission when the cancellation is outside the clawback window', () => {
    expect(reconcileSource(p, src({ cancelledOn: '2027-06-01' }), [earned], '2027-06-30')).toBeNull();
  });

  it('claws back when unpaid 90 days past due, then REINSTATES when the customer pays', () => {
    const claw = reconcileSource(p, src({}), [earned], '2027-02-28');
    expect(claw).toMatchObject({ kind: 'CLAWBACK', amountCents: -60_000, recognizedOn: '2027-02-03' });
    const back = reconcileSource(p, src({ paidCents: 1_200_000, paidOn: '2027-03-10' }), [earned, claw!], '2027-03-31');
    expect(back).toMatchObject({ kind: 'REINSTATED', amountCents: 60_000 });
  });

  it('claws back pro-rata on a partial refund', () => {
    const line = reconcileSource(p, src({ refundedCents: 200_000, paidCents: 1_200_000, paidOn: '2026-10-20' }), [earned], '2026-11-30');
    expect(line).toMatchObject({ kind: 'CLAWBACK', amountCents: -10_000 });
  });

  it('no clawback at all when the plan does not claw back', () => {
    expect(reconcileSource(plan({ clawback: NO_CLAWBACK }), src({ cancelledOn: '2026-11-01' }), [earned], '2026-11-30')).toBeNull();
  });
});

describe('runCommissions — assignments', () => {
  it('only pays plans assigned on the basis date, and still claws back after the assignment ends', () => {
    const p = plan({});
    const assignments = [{ employeeId: 'tech-1', planId: p.id, effectiveFrom: '2026-10-10', effectiveTo: '2026-10-31' }];
    // Invoiced 10/06, before the assignment started → nothing.
    expect(runCommissions({ plans: [p], assignments, sources: [src({})], priorLines: [], periodStart: '2026-10-01', periodEnd: '2026-10-31' })).toEqual([]);
    // A job with history still reconciles after the assignment ends.
    const prior: CommissionLine[] = [
      { planId: p.id, employeeId: 'tech-1', sourceType: 'JOB', sourceId: 'job-9', kind: 'EARNED', basisCents: 1_200_000, rateBps: 500, amountCents: 60_000, recognizedOn: '2026-10-15', explanation: '' },
    ];
    const out = runCommissions({
      plans: [p],
      assignments,
      sources: [src({ sourceId: 'job-9', invoicedOn: '2026-10-15', cancelledOn: '2026-12-01' })],
      priorLines: prior,
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'CLAWBACK', amountCents: -60_000 });
  });
});

describe('statements, approval, payroll hand-off', () => {
  const lines: CommissionLine[] = [
    { planId: 'plan-tech', employeeId: 'tech-1', sourceType: 'JOB', sourceId: 'a', kind: 'EARNED', basisCents: 0, rateBps: 500, amountCents: 20_000, recognizedOn: '2026-10-06', explanation: '' },
    { planId: 'plan-tech', employeeId: 'tech-1', sourceType: 'JOB', sourceId: 'b', kind: 'CLAWBACK', basisCents: 0, rateBps: 500, amountCents: -3_000, recognizedOn: '2026-10-20', explanation: '' },
    { planId: 'plan-tech', employeeId: 'tech-1', sourceType: 'JOB', sourceId: 'c', kind: 'EARNED', basisCents: 0, rateBps: 500, amountCents: 9_999, recognizedOn: '2026-11-02', explanation: '' },
    { planId: 'plan-tech', employeeId: 'tech-2', sourceType: 'JOB', sourceId: 'd', kind: 'EARNED', basisCents: 0, rateBps: 500, amountCents: 1, recognizedOn: '2026-10-06', explanation: '' },
  ];

  it('foots: opening carry-forward + earned + clawbacks = net = payable', () => {
    const s = buildStatement({ employeeId: 'tech-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', lines, openingBalanceCents: -5_000 });
    expect(s.lines).toHaveLength(2);
    expect(s.earnedCents).toBe(20_000);
    expect(s.clawbackCents).toBe(-3_000);
    expect(s.netCents).toBe(12_000);
    expect(s.payableCents).toBe(12_000);
    expect(s.carryForwardCents).toBe(0);
  });

  it('carries a negative balance forward, or writes it off by policy', () => {
    const carry = buildStatement({ employeeId: 'tech-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', lines, openingBalanceCents: -50_000 });
    expect(carry).toMatchObject({ payableCents: 0, carryForwardCents: -33_000, writtenOffCents: 0 });
    const wo = buildStatement({ employeeId: 'tech-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', lines, openingBalanceCents: -50_000, negativeBalancePolicy: 'WRITE_OFF' });
    expect(wo).toMatchObject({ payableCents: 0, carryForwardCents: 0, writtenOffCents: 33_000 });
  });

  it('enforces the lifecycle and preparer ≠ approver', () => {
    expect(() => assertStatementTransition('DRAFT', 'APPROVED')).toThrow(StatementTransitionError);
    expect(() => assertStatementTransition('PENDING_APPROVAL', 'APPROVED', { preparedBy: 'u1', actingUser: 'u1' })).toThrow(/preparer/);
    expect(() => assertStatementTransition('PENDING_APPROVAL', 'APPROVED', { preparedBy: 'u1', actingUser: 'u2' })).not.toThrow();
    expect(() => assertStatementTransition('PAID', 'VOID')).toThrow();
  });

  it('hands only APPROVED, positive statements to payroll as COMMISSION earnings', () => {
    const s = buildStatement({ employeeId: 'tech-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', lines });
    const zero = buildStatement({ employeeId: 'tech-3', periodStart: '2026-10-01', periodEnd: '2026-10-31', lines });
    const earnings = statementsToEarnings([
      { statementId: 's1', status: 'APPROVED', statement: s, employeeName: 'Dana', providerEmployeeId: 'gusto-emp-1' },
      { statementId: 's2', status: 'PENDING_APPROVAL', statement: s, employeeName: 'Dana', providerEmployeeId: null },
      { statementId: 's3', status: 'APPROVED', statement: zero, employeeName: 'Eli', providerEmployeeId: null },
    ]);
    expect(earnings).toEqual([
      expect.objectContaining({ earningType: 'COMMISSION', amountCents: 17_000, sourceRef: 'commission-statement:s1', providerEmployeeId: 'gusto-emp-1' }),
    ]);
  });
});

describe('GL — accrual at period end, reclass on payout', () => {
  const plans = new Map<string, CommissionPlan>([
    ['tech', plan({ id: 'tech', expenseClass: 'COGS' })],
    ['sales', plan({ id: 'sales', expenseClass: 'OPEX' })],
  ]);
  const accounts = { cogsCommissionExpenseId: 'acct-5400', opexCommissionExpenseId: 'acct-6150', accruedCommissionsPayableId: 'acct-2160' };
  const mk = (planId: string, amountCents: number): CommissionLine => ({
    planId, employeeId: 'e', sourceType: 'JOB', sourceId: `${planId}-${amountCents}`, kind: amountCents < 0 ? 'CLAWBACK' : 'EARNED', basisCents: 0, rateBps: 0, amountCents, recognizedOn: '2026-10-31', explanation: '',
  });

  it('accrues by expense class and balances', () => {
    const gl = buildAccrualLines([mk('tech', 60_000), mk('tech', -10_000), mk('sales', 25_000)], plans, accounts, 'Oct 2026');
    expect(isBalanced(gl)).toBe(true);
    expect(gl).toEqual([
      expect.objectContaining({ accountId: 'acct-5400', debitCents: 50_000 }),
      expect.objectContaining({ accountId: 'acct-6150', debitCents: 25_000 }),
      expect.objectContaining({ accountId: 'acct-2160', creditCents: 75_000 }),
    ]);
  });

  it('an all-clawback period flips sides instead of posting negatives', () => {
    const gl = buildAccrualLines([mk('sales', -8_000)], plans, accounts, 'Nov 2026');
    expect(isBalanced(gl)).toBe(true);
    expect(gl.every((l) => l.debitCents >= 0 && l.creditCents >= 0)).toBe(true);
    expect(gl.find((l) => l.accountId === 'acct-2160')?.debitCents).toBe(8_000);
  });

  it('payout reclass clears the accrual against the payroll earnings account', () => {
    const gl = buildPayoutReclassLines(75_000, { accruedCommissionsPayableId: 'acct-2160', payrollEarningsExpenseId: 'acct-6000' }, 'run 2026-11-07');
    expect(isBalanced(gl)).toBe(true);
    expect(gl[0]).toMatchObject({ accountId: 'acct-2160', debitCents: 75_000 });
    expect(buildPayoutReclassLines(0, { accruedCommissionsPayableId: 'a', payrollEarningsExpenseId: 'b' }, 'x')).toEqual([]);
  });
});
