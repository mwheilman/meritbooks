/**
 * Unit cost build-up + status moves (FPB §3.6, §3.7) — pure.
 *
 * Setup / PDI labor is capitalized at ACTUAL cost as reported by the DMS internal
 * repair order — never an overhead rate, burden, labor classification or department
 * chargeback (canon §2: that engine is retired). There is deliberately no rate input.
 */

import { compactLegs, type JournalPlan, type RoleLeg } from '../journal';
import type { DealerRole } from '../roles';
import { DealerEngineError, type CostType, type DeptRole, type InventoryRole } from '../types';

const NEGATIVE_TYPES: readonly CostType[] = ['REBATE_REDUCTION', 'WRITE_DOWN'];

/** Mirrors the dealer_unit_costs sign CHECK. */
export function assertCostSign(costType: CostType, amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new DealerEngineError('Cost amount must be a non-zero integer of cents');
  const negative = NEGATIVE_TYPES.includes(costType);
  if (negative && amountCents > 0) throw new DealerEngineError(`${costType} must be negative`);
  if (!negative && amountCents < 0) throw new DealerEngineError(`${costType} must be positive`);
}

/** A unit's cost = the sum of its POSTED cost rows (the DB trigger does the same). */
export function unitCost(rows: { amount_cents: number; status: string }[]): number {
  return rows.filter((r) => r.status === 'POSTED').reduce((s, r) => s + Number(r.amount_cents), 0);
}

export interface SetupCostInput {
  inventoryRole: InventoryRole;
  laborCents: number;
  partsCents: number;
  /** Client setting capitalize_setup_labor AND the SETUP_LABOR_CAPITALIZED role resolves. */
  capitalizeLabor: boolean;
  memo: string;
}

export interface SetupCostResult {
  plan: JournalPlan | null;
  capitalizedCents: number;
  warnings: string[];
}

/** §3.6: DR unit inventory / CR setup labor capitalized (labor) / CR parts inventory (parts). */
export function setupCostPlan(input: SetupCostInput): SetupCostResult {
  for (const [k, v] of [['labor', input.laborCents], ['parts', input.partsCents]] as const) {
    if (!Number.isInteger(v) || v < 0) throw new DealerEngineError(`Setup ${k} must be non-negative cents`);
  }
  const warnings: string[] = [];
  const labor = input.capitalizeLabor ? input.laborCents : 0;
  if (!input.capitalizeLabor && input.laborCents > 0) {
    warnings.push(
      'Setup labor was not capitalized: map "Setup/PDI labor capitalized" (or turn the setting on) to add labor to unit cost. Labor stays in wages.',
    );
  }
  const total = labor + input.partsCents;
  if (total === 0) return { plan: null, capitalizedCents: 0, warnings };
  const legs: RoleLeg[] = [
    { role: input.inventoryRole, effect: 'increase', amountCents: total, memo: 'Setup / PDI capitalized to unit' },
    { role: 'SETUP_LABOR_CAPITALIZED', effect: 'decrease', amountCents: labor, deptRole: 'SERVICE', memo: 'Setup labor at actual cost (internal RO)' },
    { role: 'INVENTORY_ASSET', effect: 'decrease', amountCents: input.partsCents, deptRole: 'PARTS', memo: 'Parts used in setup (at cost)' },
  ];
  return {
    plan: { entryType: 'UNIT_COST', memo: input.memo, primaryDept: 'SERVICE', legs: compactLegs(legs) },
    capitalizedCents: total,
    warnings,
  };
}

/** Where the other side of a direct cost addition comes from. */
export type CostOffset = 'AP_CONTROL' | 'OPERATING_BANK' | 'INVENTORY_ASSET' | 'SETUP_LABOR_CAPITALIZED';

/** Generic cost addition (accessory, recon, other): DR unit inventory / CR offset. */
export function costAdditionPlan(input: {
  inventoryRole: InventoryRole;
  amountCents: number;
  offset: CostOffset;
  deptRole: DeptRole;
  memo: string;
}): JournalPlan {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DealerEngineError('Cost must be positive cents');
  const offsetEffect = input.offset === 'AP_CONTROL' ? 'increase' : 'decrease';
  return {
    entryType: 'UNIT_COST',
    memo: input.memo,
    primaryDept: input.deptRole,
    legs: compactLegs([
      { role: input.inventoryRole, effect: 'increase', amountCents: input.amountCents, memo: 'Cost added to unit' },
      {
        role: input.offset as DealerRole,
        effect: offsetEffect,
        amountCents: input.amountCents,
        deptRole: input.offset === 'INVENTORY_ASSET' ? 'PARTS' : input.offset === 'SETUP_LABOR_CAPITALIZED' ? 'SERVICE' : null,
        memo: 'Cost source',
      },
    ]),
  };
}

/** §3.7 Aged-unit write-down to NRV (controller-approved). */
export function writeDownPlan(input: { inventoryRole: InventoryRole; amountCents: number; deptRole: DeptRole; memo: string }): JournalPlan {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DealerEngineError('Write-down must be positive cents');
  return {
    entryType: 'UNIT_COST',
    memo: input.memo,
    primaryDept: input.deptRole,
    legs: compactLegs([
      { role: 'INVENTORY_WRITEDOWN', effect: 'increase', amountCents: input.amountCents, memo: 'Write-down to net realizable value' },
      { role: input.inventoryRole, effect: 'decrease', amountCents: input.amountCents, memo: 'Unit cost reduced' },
    ]),
  };
}

/** §3.7 Moved to rental: DR rental inventory / CR whole-goods inventory at cost. */
export function rentalMovePlan(input: { fromRole: InventoryRole; costCents: number; memo: string }): JournalPlan {
  if (input.fromRole === 'RENTAL_INVENTORY') throw new DealerEngineError('Unit is already in rental inventory');
  if (!Number.isInteger(input.costCents) || input.costCents <= 0) throw new DealerEngineError('Unit has no posted cost to move');
  return {
    entryType: 'UNIT_COST',
    memo: input.memo,
    primaryDept: 'RENTAL',
    legs: compactLegs([
      { role: 'RENTAL_INVENTORY', effect: 'increase', amountCents: input.costCents, memo: 'Unit moved to rental fleet' },
      { role: input.fromRole, effect: 'decrease', amountCents: input.costCents, memo: 'Unit moved out of stock' },
    ]),
  };
}

/**
 * §3.7 Returned to manufacturer, lender credits the note:
 * DR floor plan payable (credit) / CR inventory (cost), difference to write-down.
 */
export function returnToOemPlan(input: {
  inventoryRole: InventoryRole;
  costCents: number;
  lenderCreditCents: number;
  deptRole: DeptRole;
  lineLiabilityAccountId?: string | null;
  memo: string;
}): JournalPlan {
  const { costCents, lenderCreditCents } = input;
  if (!Number.isInteger(costCents) || costCents < 0 || !Number.isInteger(lenderCreditCents) || lenderCreditCents < 0) {
    throw new DealerEngineError('Return amounts must be non-negative cents');
  }
  const diff = costCents - lenderCreditCents;
  return {
    entryType: 'UNIT_COST',
    memo: input.memo,
    primaryDept: input.deptRole,
    legs: compactLegs([
      {
        role: 'FLOOR_PLAN_PAYABLE',
        effect: 'decrease',
        amountCents: lenderCreditCents,
        memo: 'Lender credit for returned unit',
        accountOverrideId: input.lineLiabilityAccountId ?? null,
      },
      { role: 'INVENTORY_WRITEDOWN', effect: diff > 0 ? 'increase' : 'decrease', amountCents: Math.abs(diff), memo: 'Return difference' },
      { role: input.inventoryRole, effect: 'decrease', amountCents: costCents, memo: 'Unit returned to manufacturer' },
    ]),
  };
}
