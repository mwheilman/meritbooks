/** Zod building blocks for the dealer routes (validated before any database call). */
import { z } from 'zod';
import { Cents, Day, Text, Uuid } from '@/lib/pm/ops/schemas';
import { ADDABLE_COST_TYPES, CONDITIONS, DEAL_LINE_TYPES, FI_PRODUCT_TYPES, FINANCE_TYPES, PAYMENT_METHODS, PAYOFF_GUARDS, RO_PAY_TYPES, UNIT_STATUSES } from './types';

export { Cents, Day, Text, Uuid };

export const Rate = z.number().min(0).max(0.25);
export const Year = z.number().int().min(1900).max(2200);
export const Meter = z.number().min(0).max(1e9);
export const Qty4 = z.number().positive().max(1e8);
export const PartNumber = z.string().trim().min(1, 'Key a part number').max(40).transform((s) => s.toUpperCase());

export const ConditionZ = z.enum(CONDITIONS);
export const UnitStatusZ = z.enum(UNIT_STATUSES);
export const AddableCostZ = z.enum(ADDABLE_COST_TYPES as unknown as [string, ...string[]]);
export const LineTypeZ = z.enum(DEAL_LINE_TYPES);
export const FinanceZ = z.enum(FINANCE_TYPES);
export const FiTypeZ = z.enum(FI_PRODUCT_TYPES);
export const PaymentZ = z.enum(PAYMENT_METHODS);
export const PayoffGuardZ = z.enum(PAYOFF_GUARDS);
export const RoPayTypeZ = z.enum(RO_PAY_TYPES);
export const RoleZ = z.enum(['pm', 'superintendent', 'service_manager', 'ops_manager', 'principal', 'controller', 'owner']);

/** Strip undefined / empty-string keys before a jsonb p_attrs. */
export function attrs(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}
