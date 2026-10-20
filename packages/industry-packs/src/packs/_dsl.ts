/**
 * Tiny constructors that keep the manifests readable. They only build plain data; nothing here
 * runs at install time and nothing here can express logic.
 */
import type { z } from 'zod';
import type {
  AccountRoleHint, CoreJobStatus, CostCodeSchema, CostType, GuardName, ModuleKey,
  PriceBookItemSchema, StageDefSchema, TransitionSchema,
} from '../types';
import { DEFAULT_COST_TYPE_ROLES } from '../constants';

type CostCodeInput = z.input<typeof CostCodeSchema>;
type StageInput = z.input<typeof StageDefSchema>;
type TransitionInput = z.input<typeof TransitionSchema>;
type PriceBookInput = z.input<typeof PriceBookItemSchema>;

/** Cost code. The role hint defaults from the cost type so every code carries one. */
export function cc(code: string, name: string, costType: CostType, parent?: string, roleHint?: AccountRoleHint): CostCodeInput {
  const out: CostCodeInput = { code, name, costType, roleHint: roleHint ?? DEFAULT_COST_TYPE_ROLES[costType] };
  if (parent !== undefined) out.parent = parent;
  return out;
}

export function st(key: string, label: string, coreStatus: CoreJobStatus, terminal = false): StageInput {
  return { key, label, coreStatus, terminal };
}

export function tr(from: string, to: string, guards: GuardName[] = [], approval?: string): TransitionInput {
  const out: TransitionInput = { from, to, guards };
  if (approval !== undefined) out.approval = approval;
  return out;
}

/** Price book item. Money in cents; labor in minutes. */
export function pb(
  code: string, name: string, unit: string, priceCents: number,
  opts: { costCents?: number; laborMinutes?: number; costCode?: string } = {},
): PriceBookInput {
  return { code, name, unit, priceCents, ...opts };
}

/** Module map: every key listed true, plus explicit falses. */
export function mods(on: ModuleKey[], off: ModuleKey[] = []): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of off) out[k] = false;
  for (const k of on) out[k] = true;
  return out;
}

/** Dollars → cents for readable sample budgets (integers only). */
export const usd = (dollars: number): number => Math.round(dollars * 100);
