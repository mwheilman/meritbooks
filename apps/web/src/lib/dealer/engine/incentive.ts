/**
 * Manufacturer incentives (FPB §3.9) — pure. The program's TREATMENT (not its name)
 * decides the GL effect. Treatments are [U] in the FPB, so the program row carries the
 * choice (per client, per program) and the in-stock cost-reduction behaviour is the
 * client setting cost_reduction_in_stock.
 *
 *   TRANSACTION_PRICE      retail rebate — booked inside the unit sale (sale.ts), never here
 *   COST_REDUCTION         CR unit COGS if sold; in stock → CR unit inventory (REBATE_REDUCTION
 *                          cost row) or CR COGS immediately per setting; no unit → CR WG COGS
 *   EXPENSE_REIMBURSEMENT  co-op → CR Co-op advertising recovery (unmapped → falls back to
 *                          cost reduction, with a warning); interest subsidy → CR floor plan interest
 *   PASS_THROUGH           CR Accrued expenses (paid out via commissions/payroll)
 * A program the manufacturer pays directly (paid_direct) creates no dealer entry.
 */

import { compactLegs, type JournalPlan } from '../journal';
import { salesRolesFor, type DealerRole } from '../roles';
import { DealerEngineError, type CostReductionInStock, type IncentiveTreatment, type InventoryRole, type ProgramType } from '../types';

/** Suggested treatment for a program type (the program row may override). */
export function defaultTreatment(programType: ProgramType): IncentiveTreatment {
  switch (programType) {
    case 'RETAIL_REBATE':
      return 'TRANSACTION_PRICE';
    case 'CO_OP':
    case 'INTEREST_SUBSIDY':
      return 'EXPENSE_REIMBURSEMENT';
    case 'SPIFF':
      return 'PASS_THROUGH';
    default:
      return 'COST_REDUCTION';
  }
}

export interface AccrualInput {
  treatment: IncentiveTreatment;
  programType: ProgramType;
  paidDirect: boolean;
  amountCents: number;
  unit: { inventoryRole: InventoryRole; condition: string; sold: boolean } | null;
  costReductionInStock: CostReductionInStock;
  coOpRoleMapped: boolean;
  memo: string;
}

export interface AccrualResult {
  plan: JournalPlan;
  /** The role the accrual credited — a later write-off reverses into it. */
  targetRole: DealerRole;
  /** When set, a negative REBATE_REDUCTION cost row is added to the unit. */
  unitCostReductionCents: number;
  warnings: string[];
}

export function incentiveAccrualPlan(input: AccrualInput): AccrualResult {
  if (input.paidDirect) {
    throw new DealerEngineError('This program is paid by the manufacturer directly — it creates no dealer entry.');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DealerEngineError('Incentive must be positive cents');
  if (input.treatment === 'TRANSACTION_PRICE') {
    throw new DealerEngineError('Retail (transaction-price) rebates are recorded on the unit sale, not accrued separately.');
  }
  const warnings: string[] = [];
  let target: DealerRole;
  let costReduction = 0;
  let treatment = input.treatment;

  if (treatment === 'EXPENSE_REIMBURSEMENT') {
    if (input.programType === 'INTEREST_SUBSIDY' || input.programType === 'FLOOR_PLAN_SUPPORT') {
      target = 'FLOOR_PLAN_INTEREST';
    } else if (input.coOpRoleMapped) {
      target = 'CO_OP_ADVERTISING_RECOVERY';
    } else {
      warnings.push('Co-op recovery account is not mapped — the co-op credit is treated as a cost reduction.');
      treatment = 'COST_REDUCTION';
      target = 'WHOLE_GOODS_COGS';
    }
  } else if (treatment === 'PASS_THROUGH') {
    target = 'ACCRUED_EXPENSES';
  } else {
    target = 'WHOLE_GOODS_COGS';
  }

  if (treatment === 'COST_REDUCTION' && input.unit) {
    const cogs = salesRolesFor(input.unit.inventoryRole, input.unit.condition).cogs;
    if (input.unit.sold || input.costReductionInStock === 'REDUCE_COGS') {
      target = cogs;
    } else {
      target = input.unit.inventoryRole;
      costReduction = input.amountCents;
    }
  }

  const targetEffect = target === 'ACCRUED_EXPENSES' ? 'increase' : 'decrease';
  return {
    plan: {
      entryType: 'OEM_INCENTIVE',
      memo: input.memo,
      primaryDept: input.unit?.inventoryRole === 'USED_WHOLE_GOODS_INVENTORY' ? 'WG_USED' : target === 'CO_OP_ADVERTISING_RECOVERY' ? 'ADMIN' : 'WG_NEW',
      legs: compactLegs([
        { role: 'OEM_INCENTIVE_RECEIVABLE', effect: 'increase', amountCents: input.amountCents, memo: 'Manufacturer incentive receivable' },
        { role: target, effect: targetEffect, amountCents: input.amountCents, memo: `Incentive (${treatment})` },
      ]),
    },
    targetRole: target,
    unitCostReductionCents: costReduction,
    warnings,
  };
}

/**
 * Short-pay / rejection write-off: reverse into the account the accrual credited.
 * If the accrual reduced a unit's inventory and the unit has since sold, the cost now
 * sits in that unit's COGS — write off there.
 */
export function incentiveWriteOffPlan(input: {
  targetRole: DealerRole;
  amountCents: number;
  unit: { inventoryRole: InventoryRole; condition: string; sold: boolean } | null;
  memo: string;
}): { plan: JournalPlan; addBackToUnitCents: number; role: DealerRole } {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DealerEngineError('Write-off must be positive cents');
  let role = input.targetRole;
  let addBack = 0;
  const isInventory = role === 'WHOLE_GOODS_INVENTORY' || role === 'USED_WHOLE_GOODS_INVENTORY' || role === 'RENTAL_INVENTORY';
  if (isInventory) {
    if (input.unit?.sold) role = salesRolesFor(input.unit.inventoryRole, input.unit.condition).cogs;
    else addBack = input.amountCents;
  }
  // Reverse the accrual's effect on the target. Accruals INCREASED accrued expenses
  // (pass-through) and unit sales (transaction-price retail rebate, booked in the deal);
  // every other target (COGS, inventory, expense recoveries) was DECREASED.
  const increasedAtAccrual = role === 'ACCRUED_EXPENSES' || role === 'WHOLE_GOODS_SALES' || role === 'USED_GOODS_SALES';
  const effect = increasedAtAccrual ? 'decrease' : 'increase';
  return {
    plan: {
      entryType: 'OEM_INCENTIVE',
      memo: input.memo,
      primaryDept: 'WG_NEW',
      legs: [
        { role, effect, amountCents: input.amountCents, memo: 'Incentive not collected' },
        { role: 'OEM_INCENTIVE_RECEIVABLE', effect: 'decrease', amountCents: input.amountCents, memo: 'Incentive receivable written off' },
      ],
    },
    addBackToUnitCents: addBack,
    role,
  };
}
