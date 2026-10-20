/**
 * Dealer Pack — role-level journal plans.
 *
 * Engines never pick accounts or debit/credit columns. They emit a JournalPlan: a list
 * of RoleLegs (role + increase/decrease + integer cents + department role). The DB
 * layer (service/posting.ts) resolves each role to the client's account, derives the
 * debit/credit from THAT account's type via debitCreditFor (canon §3), and posts through
 * postJournalEntry. `canonicalLines` derives the same DR/CR from each role's canonical
 * type — used by pure tests to assert the FPB's worked examples to the cent, and by
 * the DB layer as a cross-check that a mapped account can't silently invert a leg.
 */

import { debitCreditFor, type Effect } from '@/lib/posting/account-direction';
import { ROLE_SPEC, type DealerRole } from './roles';
import { DealerEngineError, type DeptRole } from './types';

/** gl_entries.entry_type values the pack posts (all added to the enum by mig 169). */
export type DealerEntryType =
  | 'FLOOR_PLAN'
  | 'FLOOR_PLAN_INTEREST'
  | 'UNIT_SALE'
  | 'TRADE_IN'
  | 'WARRANTY_CLAIM'
  | 'OEM_INCENTIVE'
  | 'UNIT_COST';

export const ENTRY_TYPE = {
  floorPlan: { entry_type: 'FLOOR_PLAN' },
  floorPlanInterest: { entry_type: 'FLOOR_PLAN_INTEREST' },
  unitSale: { entry_type: 'UNIT_SALE' },
  tradeIn: { entry_type: 'TRADE_IN' },
  warrantyClaim: { entry_type: 'WARRANTY_CLAIM' },
  oemIncentive: { entry_type: 'OEM_INCENTIVE' },
  unitCost: { entry_type: 'UNIT_COST' },
} as const satisfies Record<string, { entry_type: DealerEntryType }>;

export interface RoleLeg {
  role: DealerRole;
  effect: Effect;
  amountCents: number;
  /** Department role for this leg; null/undefined → the plan's primaryDept. */
  deptRole?: DeptRole | null;
  memo: string;
  /** A per-line account override (e.g. floor_plan_lines.liability_account_id). */
  accountOverrideId?: string | null;
}

export interface JournalPlan {
  entryType: DealerEntryType;
  memo: string;
  /** Department every leg without its own deptRole carries (AC14). */
  primaryDept: DeptRole;
  legs: RoleLeg[];
}

export interface CanonicalLine {
  role: DealerRole;
  debitCents: number;
  creditCents: number;
  deptRole: DeptRole;
  memo: string;
}

function assertCents(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) throw new DealerEngineError(`${what} must be a non-negative integer of cents (got ${n})`);
}

/** Drop zero legs; validate integers. */
export function compactLegs(legs: RoleLeg[]): RoleLeg[] {
  for (const l of legs) assertCents(l.amountCents, `Leg ${l.role}`);
  return legs.filter((l) => l.amountCents > 0);
}

/** DR/CR per leg from the role's canonical type (pure; no DB). */
export function canonicalLines(plan: JournalPlan): CanonicalLine[] {
  return compactLegs(plan.legs).map((l) => {
    const dc = debitCreditFor(ROLE_SPEC[l.role].canonicalType, l.effect, l.amountCents);
    return {
      role: l.role,
      debitCents: dc.debit_cents,
      creditCents: dc.credit_cents,
      deptRole: l.deptRole ?? plan.primaryDept,
      memo: l.memo,
    };
  });
}

export function totals(lines: { debitCents: number; creditCents: number }[]): { debit: number; credit: number } {
  return lines.reduce(
    (t, l) => ({ debit: t.debit + l.debitCents, credit: t.credit + l.creditCents }),
    { debit: 0, credit: 0 },
  );
}

/** Throw unless the plan balances and has ≥ 2 non-zero legs. Returns the canonical lines. */
export function assertBalanced(plan: JournalPlan): CanonicalLine[] {
  const lines = canonicalLines(plan);
  const t = totals(lines);
  if (lines.length < 2) throw new DealerEngineError(`${plan.memo}: entry needs at least two non-zero lines`);
  if (t.debit !== t.credit) {
    throw new DealerEngineError(`${plan.memo}: unbalanced (debits ${t.debit} ≠ credits ${t.credit})`);
  }
  return lines;
}

/** Net DR−CR by role across several plans (tests compare against FPB tables). */
export function netByRole(plans: JournalPlan[]): Map<DealerRole, number> {
  const m = new Map<DealerRole, number>();
  for (const p of plans) {
    for (const l of canonicalLines(p)) m.set(l.role, (m.get(l.role) ?? 0) + l.debitCents - l.creditCents);
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

/** Integer division rounded half-up (non-negative operands), in BigInt. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new DealerEngineError('denominator must be positive');
  if (numerator < 0n) return -divRoundHalfUp(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** amount × bps / 10,000, rounded half-up to the cent. */
export function applyBps(amountCents: number, bps: number): number {
  return Number(divRoundHalfUp(BigInt(amountCents) * BigInt(bps), 10_000n));
}
