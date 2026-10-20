/**
 * Dealer Pack — account roles (FPB §3.0).
 *
 * Accounts are addressed BY ROLE, never by number. Resolution (explicit map → the
 * role's standard default number → the FPB fallback role → refuse) lives in ONE place:
 * the SQL function public.dealer_role_account (migration 169), which both the enable
 * gate and the tie-out view use. The TS side calls it via RPC (service/accounts.ts), so
 * app and DB can never disagree. This file holds the static metadata the engines need:
 * the role's canonical account type (to state DR/CR in pure tests), the types a tenant
 * may map it to, its label (for the "map X first" error), and its default department.
 */

import type { AccountType } from '@/lib/posting/account-direction';
import type { DeptRole } from './types';

/** The 21 roles migration 169 adds to core.account_role_keys. */
export type NewDealerRole =
  | 'WHOLE_GOODS_INVENTORY'
  | 'USED_WHOLE_GOODS_INVENTORY'
  | 'RENTAL_INVENTORY'
  | 'FLOOR_PLAN_PAYABLE'
  | 'FLOOR_PLAN_INTEREST_ACCRUED'
  | 'FLOOR_PLAN_INTEREST'
  | 'FLOOR_PLAN_FEES'
  | 'WHOLE_GOODS_SALES'
  | 'WHOLE_GOODS_COGS'
  | 'USED_GOODS_SALES'
  | 'USED_GOODS_COGS'
  | 'TRADE_IN_OVER_ALLOWANCE'
  | 'TRADE_LIEN_PAYOFF'
  | 'SETUP_LABOR_CAPITALIZED'
  | 'INVENTORY_WRITEDOWN'
  | 'WARRANTY_RECEIVABLE'
  | 'WARRANTY_LABOR_SALES'
  | 'WARRANTY_PARTS_SALES'
  | 'WARRANTY_POLICY_EXPENSE'
  | 'OEM_INCENTIVE_RECEIVABLE'
  | 'CO_OP_ADVERTISING_RECOVERY';

/** Pre-existing roles the pack reuses. */
export type ReusedRole =
  | 'AR_CONTROL'
  | 'AP_CONTROL'
  | 'OPERATING_BANK'
  | 'CUSTOMER_DEPOSITS'
  | 'INVENTORY_ASSET'
  | 'INVENTORY_COGS'
  | 'INTEREST_EXPENSE'
  | 'ACCRUED_EXPENSES'
  | 'SALES_TAX_PAYABLE';

export type DealerRole = NewDealerRole | ReusedRole;

export interface RoleSpec {
  label: string;
  /** The type the FPB tables assume — fixes the economic DR/CR in pure tests. */
  canonicalType: AccountType;
  /** Types a tenant may map the role to (all share the canonical normal balance). */
  allowedTypes: readonly AccountType[];
  /** Required to switch the pack on (after fallbacks). */
  required: boolean;
  /** FPB §3.0 fallback role when unmapped (mirrors dealer_role_account). */
  fallback: DealerRole | null;
  /** Default department role for a P&L leg on this role (null = takes the txn's). */
  defaultDept: DeptRole | null;
  /** True for roles added by migration 169 (no default account number). */
  isNew: boolean;
}

const spec = (
  label: string,
  canonicalType: AccountType,
  allowedTypes: readonly AccountType[],
  required: boolean,
  fallback: DealerRole | null,
  defaultDept: DeptRole | null,
  isNew = true,
): RoleSpec => ({ label, canonicalType, allowedTypes, required, fallback, defaultDept, isNew });

export const ROLE_SPEC: Record<DealerRole, RoleSpec> = {
  WHOLE_GOODS_INVENTORY: spec('Whole goods inventory', 'ASSET', ['ASSET'], true, null, 'WG_NEW'),
  USED_WHOLE_GOODS_INVENTORY: spec('Used whole goods inventory', 'ASSET', ['ASSET'], true, 'WHOLE_GOODS_INVENTORY', 'WG_USED'),
  RENTAL_INVENTORY: spec('Rental inventory', 'ASSET', ['ASSET'], false, 'WHOLE_GOODS_INVENTORY', 'RENTAL'),
  FLOOR_PLAN_PAYABLE: spec('Floor plan payable', 'LIABILITY', ['LIABILITY'], true, null, null),
  FLOOR_PLAN_INTEREST_ACCRUED: spec('Accrued floor plan interest', 'LIABILITY', ['LIABILITY'], true, 'ACCRUED_EXPENSES', null),
  FLOOR_PLAN_INTEREST: spec('Floor plan interest expense', 'OPEX', ['OPEX', 'OTHER'], true, 'INTEREST_EXPENSE', null),
  FLOOR_PLAN_FEES: spec('Floor plan fees', 'OPEX', ['OPEX', 'OTHER'], false, 'FLOOR_PLAN_INTEREST', null),
  WHOLE_GOODS_SALES: spec('Whole goods sales', 'REVENUE', ['REVENUE'], true, null, 'WG_NEW'),
  WHOLE_GOODS_COGS: spec('Whole goods cost of sales', 'COGS', ['COGS'], true, null, 'WG_NEW'),
  USED_GOODS_SALES: spec('Used whole goods sales', 'REVENUE', ['REVENUE'], false, 'WHOLE_GOODS_SALES', 'WG_USED'),
  USED_GOODS_COGS: spec('Used whole goods cost of sales', 'COGS', ['COGS'], false, 'WHOLE_GOODS_COGS', 'WG_USED'),
  TRADE_IN_OVER_ALLOWANCE: spec('Trade-in over-allowance', 'REVENUE', ['REVENUE'], true, null, 'WG_NEW'),
  TRADE_LIEN_PAYOFF: spec('Trade-in lien payoff payable', 'LIABILITY', ['LIABILITY'], true, null, null),
  SETUP_LABOR_CAPITALIZED: spec('Setup/PDI labor capitalized', 'COGS', ['COGS', 'OPEX'], false, null, 'SERVICE'),
  INVENTORY_WRITEDOWN: spec('Unit inventory write-down', 'COGS', ['COGS', 'OPEX'], false, 'WHOLE_GOODS_COGS', null),
  WARRANTY_RECEIVABLE: spec('Warranty claims receivable', 'ASSET', ['ASSET'], true, null, null),
  WARRANTY_LABOR_SALES: spec('Warranty labor sales', 'REVENUE', ['REVENUE'], true, null, 'SERVICE'),
  WARRANTY_PARTS_SALES: spec('Warranty parts sales', 'REVENUE', ['REVENUE'], false, 'WARRANTY_LABOR_SALES', 'PARTS'),
  WARRANTY_POLICY_EXPENSE: spec('Warranty policy expense', 'OPEX', ['OPEX', 'COGS'], true, null, 'SERVICE'),
  OEM_INCENTIVE_RECEIVABLE: spec('Manufacturer incentives receivable', 'ASSET', ['ASSET'], true, null, null),
  CO_OP_ADVERTISING_RECOVERY: spec('Co-op advertising recovery', 'OPEX', ['OPEX'], false, null, 'ADMIN'),
  // reused
  AR_CONTROL: spec('Accounts receivable', 'ASSET', ['ASSET'], true, null, null, false),
  AP_CONTROL: spec('Accounts payable', 'LIABILITY', ['LIABILITY'], true, null, null, false),
  OPERATING_BANK: spec('Operating bank', 'ASSET', ['ASSET'], true, null, null, false),
  CUSTOMER_DEPOSITS: spec('Customer deposits', 'LIABILITY', ['LIABILITY'], true, null, null, false),
  INVENTORY_ASSET: spec('Parts inventory', 'ASSET', ['ASSET'], true, null, 'PARTS', false),
  INVENTORY_COGS: spec('Parts cost of sales', 'COGS', ['COGS'], true, null, 'PARTS', false),
  INTEREST_EXPENSE: spec('Interest expense', 'OPEX', ['OPEX', 'OTHER'], false, null, null, false),
  ACCRUED_EXPENSES: spec('Accrued expenses', 'LIABILITY', ['LIABILITY'], false, null, null, false),
  SALES_TAX_PAYABLE: spec('Sales tax payable', 'LIABILITY', ['LIABILITY'], true, null, null, false),
};

/** Roles that must resolve before the pack can switch on (mirrors the SQL gate). */
export const REQUIRED_ROLES: readonly DealerRole[] = (Object.keys(ROLE_SPEC) as DealerRole[]).filter(
  (r) => ROLE_SPEC[r].required,
);

/** The new roles a client maps on the role-map screen (D2 renders this list). */
export const NEW_DEALER_ROLES: readonly NewDealerRole[] = (Object.keys(ROLE_SPEC) as DealerRole[]).filter(
  (r): r is NewDealerRole => ROLE_SPEC[r].isNew,
);

/** The plain-English refusal used whenever a role can't be resolved. */
export function unmappedRoleMessage(role: DealerRole): string {
  return `Map '${ROLE_SPEC[role].label}' (${role}) for this client before using the dealer pack.`;
}

/** Inventory role → its sales / COGS roles (new vs used). */
export function salesRolesFor(inventoryRole: string, condition: string): { sales: DealerRole; cogs: DealerRole } {
  const used = inventoryRole === 'USED_WHOLE_GOODS_INVENTORY' || condition === 'USED';
  return used
    ? { sales: 'USED_GOODS_SALES', cogs: 'USED_GOODS_COGS' }
    : { sales: 'WHOLE_GOODS_SALES', cogs: 'WHOLE_GOODS_COGS' };
}

/** Starting inventory role + department for a newly registered unit. */
export function initialUnitRoles(condition: string): { inventoryRole: 'WHOLE_GOODS_INVENTORY' | 'USED_WHOLE_GOODS_INVENTORY' | 'RENTAL_INVENTORY'; departmentRole: DeptRole } {
  switch (condition) {
    case 'USED':
      return { inventoryRole: 'USED_WHOLE_GOODS_INVENTORY', departmentRole: 'WG_USED' };
    case 'RENTAL':
      return { inventoryRole: 'RENTAL_INVENTORY', departmentRole: 'RENTAL' };
    default:
      return { inventoryRole: 'WHOLE_GOODS_INVENTORY', departmentRole: 'WG_NEW' };
  }
}
