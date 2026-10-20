/**
 * Commission STATEMENTS, approval lifecycle, payroll hand-off, and GL lines — pure.
 *
 *  - buildStatement: one employee × one period → totals that foot to the cent,
 *    with negative balances carried forward (or written off) per policy. This is
 *    what the employee sees in Merit Workforce and what the manager approves.
 *  - Statement lifecycle: DRAFT → PENDING_APPROVAL → APPROVED → EXPORTED → PAID,
 *    with REJECTED / VOID; preparer ≠ approver.
 *  - statementsToEarnings: APPROVED statements → provider-agnostic EarningsLine[]
 *    (Gusto API push or the earnings CSV for any other payroll system).
 *  - GL: period-end ACCRUAL (DR commission expense by class / CR accrued
 *    commissions payable) and the PAYOUT reclass when the payroll run that paid
 *    them posts (DR accrued commissions payable / CR the expense account the payroll
 *    run debited) — so the expense lands once, in the period it was earned.
 */

import type { EarningsLine } from '@/lib/payroll/providers/types';
import type { CommissionLine, CommissionPlan } from './types';

// ── Statements ───────────────────────────────────────────────────────────────────

export type NegativeBalancePolicy = 'CARRY_FORWARD' | 'WRITE_OFF';

export interface CommissionStatement {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  /** Prior period's carried (negative) balance, cents (≤ 0 normally). */
  openingBalanceCents: number;
  earnedCents: number;
  reinstatedCents: number;
  /** Negative. */
  clawbackCents: number;
  adjustmentCents: number;
  /** opening + Σ lines. */
  netCents: number;
  /** What payroll pays this period (≥ 0). */
  payableCents: number;
  /** Negative balance carried to next period (≤ 0). */
  carryForwardCents: number;
  /** Negative balance forgiven under WRITE_OFF (≥ 0). */
  writtenOffCents: number;
  lines: CommissionLine[];
}

export function buildStatement(input: {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  lines: CommissionLine[];
  openingBalanceCents?: number;
  negativeBalancePolicy?: NegativeBalancePolicy;
}): CommissionStatement {
  const lines = input.lines
    .filter((l) => l.employeeId === input.employeeId && l.recognizedOn >= input.periodStart && l.recognizedOn <= input.periodEnd)
    .sort((a, b) => a.recognizedOn.localeCompare(b.recognizedOn) || a.sourceId.localeCompare(b.sourceId));
  const sumKind = (k: CommissionLine['kind']) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amountCents, 0);
  const opening = Math.trunc(input.openingBalanceCents ?? 0);
  const netCents = opening + lines.reduce((s, l) => s + l.amountCents, 0);
  const policy = input.negativeBalancePolicy ?? 'CARRY_FORWARD';
  return {
    employeeId: input.employeeId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    openingBalanceCents: opening,
    earnedCents: sumKind('EARNED'),
    reinstatedCents: sumKind('REINSTATED'),
    clawbackCents: sumKind('CLAWBACK'),
    adjustmentCents: sumKind('ADJUSTMENT'),
    netCents,
    payableCents: Math.max(0, netCents),
    carryForwardCents: netCents < 0 && policy === 'CARRY_FORWARD' ? netCents : 0,
    writtenOffCents: netCents < 0 && policy === 'WRITE_OFF' ? -netCents : 0,
    lines,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────

export type StatementStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPORTED' | 'PAID' | 'VOID';

export const STATEMENT_TRANSITIONS: Readonly<Record<StatementStatus, readonly StatementStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'VOID'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  REJECTED: ['DRAFT', 'VOID'],
  APPROVED: ['EXPORTED', 'VOID'],
  EXPORTED: ['PAID'],
  PAID: [],
  VOID: [],
};

export class StatementTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementTransitionError';
  }
}

/** Throws on an illegal move or a self-approval (preparer ≠ approver). */
export function assertStatementTransition(
  from: StatementStatus,
  to: StatementStatus,
  actors?: { preparedBy: string | null; actingUser: string },
): void {
  if (!STATEMENT_TRANSITIONS[from].includes(to)) {
    throw new StatementTransitionError(`Cannot move a commission statement from ${from} to ${to}`);
  }
  if (to === 'APPROVED' && actors && actors.preparedBy && actors.preparedBy === actors.actingUser) {
    throw new StatementTransitionError('The preparer of a commission statement cannot approve it');
  }
}

// ── Payroll hand-off ─────────────────────────────────────────────────────────────

export interface StatementForPayout {
  statementId: string;
  status: StatementStatus;
  statement: CommissionStatement;
  employeeName: string;
  providerEmployeeId: string | null;
}

/**
 * APPROVED statements with a positive payable → one COMMISSION earnings line each.
 * sourceRef = `commission-statement:<id>` is the idempotency key end-to-end.
 */
export function statementsToEarnings(rows: StatementForPayout[]): EarningsLine[] {
  return rows
    .filter((r) => r.status === 'APPROVED' && r.statement.payableCents > 0)
    .map((r) => ({
      employeeId: r.statement.employeeId,
      providerEmployeeId: r.providerEmployeeId,
      employeeName: r.employeeName,
      earningType: 'COMMISSION' as const,
      amountCents: r.statement.payableCents,
      memo: `Commissions ${r.statement.periodStart} to ${r.statement.periodEnd}`,
      sourceRef: `commission-statement:${r.statementId}`,
    }));
}

// ── GL ───────────────────────────────────────────────────────────────────────────

export interface CommissionGlAccounts {
  /** COGS account for direct (technician / installer) commissions. */
  cogsCommissionExpenseId: string;
  /** OPEX account for selling commissions. */
  opexCommissionExpenseId: string;
  /** Liability: Accrued Commissions Payable. */
  accruedCommissionsPayableId: string;
}

export interface GlLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

function signedLine(accountId: string, signedDebitCents: number, memo: string): GlLine | null {
  if (signedDebitCents === 0) return null;
  return signedDebitCents > 0
    ? { accountId, debitCents: signedDebitCents, creditCents: 0, memo }
    : { accountId, debitCents: 0, creditCents: -signedDebitCents, memo };
}

/**
 * Period-end accrual for the period's commission lines (earned − clawbacks), split
 * by the plan's expense class. Balanced by construction; an all-clawback period
 * flips sides rather than posting negatives. Written-off negative balances are
 * not booked here (they were never expense) — see the FPB.
 */
export function buildAccrualLines(
  lines: CommissionLine[],
  plans: Map<string, CommissionPlan>,
  accounts: CommissionGlAccounts,
  periodLabel: string,
): GlLine[] {
  let cogs = 0;
  let opex = 0;
  for (const l of lines) {
    const cls = plans.get(l.planId)?.expenseClass ?? 'OPEX';
    if (cls === 'COGS') cogs += l.amountCents;
    else opex += l.amountCents;
  }
  const out = [
    signedLine(accounts.cogsCommissionExpenseId, cogs, `Commission expense (direct) — ${periodLabel}`),
    signedLine(accounts.opexCommissionExpenseId, opex, `Commission expense (selling) — ${periodLabel}`),
    signedLine(accounts.accruedCommissionsPayableId, -(cogs + opex), `Accrued commissions payable — ${periodLabel}`),
  ];
  return out.filter((x): x is GlLine => x !== null);
}

/**
 * Payout reclass when the payroll run that paid the commissions posts: the
 * payroll run debits its wages/earnings expense account for the commission
 * earnings; this clears the accrual against that same account so the expense is
 * recognized ONCE (in the earned period, via the accrual).
 */
export function buildPayoutReclassLines(
  paidCents: number,
  accounts: { accruedCommissionsPayableId: string; payrollEarningsExpenseId: string },
  payrollRunLabel: string,
): GlLine[] {
  if (!Number.isSafeInteger(paidCents) || paidCents <= 0) return [];
  return [
    { accountId: accounts.accruedCommissionsPayableId, debitCents: paidCents, creditCents: 0, memo: `Commissions paid via payroll ${payrollRunLabel}` },
    { accountId: accounts.payrollEarningsExpenseId, debitCents: 0, creditCents: paidCents, memo: `Reclass commissions accrued in prior period — ${payrollRunLabel}` },
  ];
}

/** Σ debits === Σ credits. */
export function isBalanced(lines: GlLine[]): boolean {
  const d = lines.reduce((s, l) => s + l.debitCents, 0);
  const c = lines.reduce((s, l) => s + l.creditCents, 0);
  return d === c;
}
