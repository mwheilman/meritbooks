/**
 * Floor-plan journal plans (FPB §3.1–§3.4, §3.7) — pure, role-level.
 * Debit/credit come from each role's account type (journal.ts), never from here.
 */

import { compactLegs, type JournalPlan, type RoleLeg } from '../journal';
import type { DealerRole } from '../roles';
import { DealerEngineError, type DeptRole, type InventoryRole } from '../types';

function plan(entryType: JournalPlan['entryType'], memo: string, primaryDept: DeptRole, legs: RoleLeg[]): JournalPlan {
  return { entryType, memo, primaryDept, legs: compactLegs(legs) };
}

function positive(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new DealerEngineError(`${what} must be a positive integer of cents`);
}

/** §3.1 Unit floored: DR unit inventory / CR floor plan payable. No AP bill. */
export function flooringPlan(input: {
  principalCents: number;
  inventoryRole: InventoryRole;
  deptRole: DeptRole;
  lineLiabilityAccountId?: string | null;
  memo: string;
}): JournalPlan {
  positive(input.principalCents, 'Floored principal');
  return plan('FLOOR_PLAN', input.memo, input.deptRole, [
    { role: input.inventoryRole, effect: 'increase', amountCents: input.principalCents, memo: 'Unit floored (base invoice)' },
    {
      role: 'FLOOR_PLAN_PAYABLE',
      effect: 'increase',
      amountCents: input.principalCents,
      memo: 'Floor plan note',
      accountOverrideId: input.lineLiabilityAccountId ?? null,
    },
  ]);
}

/** §3.7 Parts floored on open account: DR parts inventory / CR floor plan payable. */
export function openAccountFlooringPlan(input: {
  principalCents: number;
  lineLiabilityAccountId?: string | null;
  memo: string;
}): JournalPlan {
  positive(input.principalCents, 'Open-account principal');
  return plan('FLOOR_PLAN', input.memo, 'PARTS', [
    { role: 'INVENTORY_ASSET', effect: 'increase', amountCents: input.principalCents, memo: 'Parts floored (open account)' },
    {
      role: 'FLOOR_PLAN_PAYABLE',
      effect: 'increase',
      amountCents: input.principalCents,
      memo: 'Floor plan note (open account)',
      accountOverrideId: input.lineLiabilityAccountId ?? null,
    },
  ]);
}

/** §3.3 / §3.4 Curtailment or payoff: DR floor plan payable / CR bank. Cost unchanged. */
export function principalPaymentPlan(input: {
  amountCents: number;
  deptRole: DeptRole;
  kind: 'CURTAILMENT' | 'PAYOFF';
  lineLiabilityAccountId?: string | null;
  memo: string;
}): JournalPlan {
  positive(input.amountCents, 'Payment');
  return plan('FLOOR_PLAN', input.memo, input.deptRole, [
    {
      role: 'FLOOR_PLAN_PAYABLE',
      effect: 'decrease',
      amountCents: input.amountCents,
      memo: input.kind === 'PAYOFF' ? 'Floor plan payoff' : 'Floor plan curtailment',
      accountOverrideId: input.lineLiabilityAccountId ?? null,
    },
    { role: 'OPERATING_BANK', effect: 'decrease', amountCents: input.amountCents, memo: 'Paid to floor-plan lender' },
  ]);
}

export interface AccrualRow {
  amountCents: number;
  deptRole: DeptRole;
}

/** §3.2 Month-end accrual: one batch JE, an expense line per department. */
export function interestAccrualPlan(rows: AccrualRow[], memo: string): JournalPlan {
  const byDept = new Map<DeptRole, number>();
  let total = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.amountCents) || r.amountCents < 0) throw new DealerEngineError('Accrual must be non-negative cents');
    if (r.amountCents === 0) continue;
    byDept.set(r.deptRole, (byDept.get(r.deptRole) ?? 0) + r.amountCents);
    total += r.amountCents;
  }
  if (total === 0) throw new DealerEngineError('Nothing to accrue');
  const legs: RoleLeg[] = [...byDept.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([deptRole, amountCents]) => ({
      role: 'FLOOR_PLAN_INTEREST' as DealerRole,
      effect: 'increase' as const,
      amountCents,
      deptRole,
      memo: `Floor plan interest accrual (${deptRole})`,
    }));
  legs.push({ role: 'FLOOR_PLAN_INTEREST_ACCRUED', effect: 'increase', amountCents: total, memo: 'Accrued floor plan interest' });
  const primary = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return plan('FLOOR_PLAN_INTEREST', memo, primary, legs);
}

/** §3.2.3 Lender interest billed/debited: clear accrual, true-up the difference, pay. */
export function interestBilledPlan(input: {
  billedCents: number;
  accrualClearedCents: number;
  deptRole: DeptRole;
  memo: string;
}): JournalPlan {
  positive(input.billedCents, 'Billed interest');
  if (!Number.isInteger(input.accrualClearedCents) || input.accrualClearedCents < 0) {
    throw new DealerEngineError('Cleared accrual must be non-negative cents');
  }
  const trueUp = input.billedCents - input.accrualClearedCents;
  const legs: RoleLeg[] = [
    { role: 'FLOOR_PLAN_INTEREST_ACCRUED', effect: 'decrease', amountCents: input.accrualClearedCents, memo: 'Clear accrued interest' },
  ];
  if (trueUp !== 0) {
    legs.push({
      role: 'FLOOR_PLAN_INTEREST',
      effect: trueUp > 0 ? 'increase' : 'decrease',
      amountCents: Math.abs(trueUp),
      memo: 'Interest true-up to lender bill',
    });
  }
  legs.push({ role: 'OPERATING_BANK', effect: 'decrease', amountCents: input.billedCents, memo: 'Interest paid to lender' });
  return plan('FLOOR_PLAN_INTEREST', input.memo, input.deptRole, legs);
}

/** Late / audit / other lender fees: DR floor plan fees / CR bank. */
export function feePlan(input: { feeCents: number; deptRole: DeptRole; memo: string }): JournalPlan {
  positive(input.feeCents, 'Fee');
  return plan('FLOOR_PLAN_INTEREST', input.memo, input.deptRole, [
    { role: 'FLOOR_PLAN_FEES', effect: 'increase', amountCents: input.feeCents, memo: 'Floor plan fee' },
    { role: 'OPERATING_BANK', effect: 'decrease', amountCents: input.feeCents, memo: 'Fee paid to lender' },
  ]);
}
