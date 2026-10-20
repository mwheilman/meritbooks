/**
 * Floor-plan note lifecycle (FPB §3.1, §3.3, §3.4) — pure.
 *
 *   flooring        → OPEN (free-floor end, maturity, curtailment schedule)
 *   unit sale       → SOLD_UNPAID (payoff due = sale date + payoff days; 0 = pay-as-sold)
 *   payoff released → PAID_OFF (balance 0)
 *
 * Payoff money NEVER leaves on its own: a payoff is PROPOSED by one person (or the
 * engine on sale) and RELEASED by a different person. `canAutoRelease` is the single
 * answer to "may the autonomy dial release this?" and it is always no (FPB §2.2,
 * canon §3 money movement) — tests pin it.
 */

import { addDays, dayNumber } from '../dates';
import { applyBps } from '../journal';
import { DealerEngineError, type NoteStatus, type PayoffTerms } from '../types';

export interface ProgramTerms {
  free_floor_days: number;
  max_term_days: number | null;
  payoff_terms: PayoffTerms;
  payoff_days: number;
  curtailment_schedule: unknown;
}

export interface CurtailmentRule {
  after_days: number;
  pct_bps?: number;
  amount_cents?: number;
}

/** Validate a program's curtailment_schedule jsonb. Throws on a malformed rule. */
export function parseCurtailmentRules(raw: unknown): CurtailmentRule[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new DealerEngineError('curtailment_schedule must be an array');
  return raw.map((r, i) => {
    if (typeof r !== 'object' || r === null) throw new DealerEngineError(`curtailment rule ${i + 1} must be an object`);
    const o = r as Record<string, unknown>;
    const after = o.after_days;
    if (typeof after !== 'number' || !Number.isInteger(after) || after <= 0) {
      throw new DealerEngineError(`curtailment rule ${i + 1}: after_days must be a positive integer`);
    }
    const pct = o.pct_bps;
    const amt = o.amount_cents;
    const hasPct = typeof pct === 'number';
    const hasAmt = typeof amt === 'number';
    if (hasPct === hasAmt) throw new DealerEngineError(`curtailment rule ${i + 1}: give exactly one of pct_bps or amount_cents`);
    if (hasPct && (!Number.isInteger(pct) || (pct as number) <= 0 || (pct as number) > 10_000)) {
      throw new DealerEngineError(`curtailment rule ${i + 1}: pct_bps must be 1–10000`);
    }
    if (hasAmt && (!Number.isInteger(amt) || (amt as number) <= 0)) {
      throw new DealerEngineError(`curtailment rule ${i + 1}: amount_cents must be a positive integer`);
    }
    return hasPct ? { after_days: after, pct_bps: pct as number } : { after_days: after, amount_cents: amt as number };
  });
}

export interface ScheduledCurtailment {
  sequence: number;
  dueDate: string;
  amountCents: number;
}

/** Curtailment rows created at flooring (cumulative never exceeds principal). */
export function buildCurtailmentSchedule(
  flooredDate: string,
  originalPrincipalCents: number,
  rules: CurtailmentRule[],
): ScheduledCurtailment[] {
  const sorted = [...rules].sort((a, b) => a.after_days - b.after_days);
  let remaining = originalPrincipalCents;
  const out: ScheduledCurtailment[] = [];
  for (const r of sorted) {
    if (remaining <= 0) break;
    const want = r.pct_bps != null ? applyBps(originalPrincipalCents, r.pct_bps) : (r.amount_cents ?? 0);
    const amount = Math.min(want, remaining);
    if (amount <= 0) continue;
    remaining -= amount;
    out.push({ sequence: out.length + 1, dueDate: addDays(flooredDate, r.after_days), amountCents: amount });
  }
  return out;
}

export interface FlooringPlan {
  freeFloorEndDate: string;
  maturityDate: string | null;
  curtailments: ScheduledCurtailment[];
}

export function planFlooring(input: {
  flooredDate: string;
  originalPrincipalCents: number;
  program: ProgramTerms | null;
}): FlooringPlan {
  const { flooredDate, originalPrincipalCents, program } = input;
  if (!Number.isInteger(originalPrincipalCents) || originalPrincipalCents <= 0) {
    throw new DealerEngineError('Floored principal must be a positive integer of cents');
  }
  dayNumber(flooredDate);
  if (!program) return { freeFloorEndDate: flooredDate, maturityDate: null, curtailments: [] };
  return {
    freeFloorEndDate: addDays(flooredDate, program.free_floor_days),
    maturityDate: program.max_term_days ? addDays(flooredDate, program.max_term_days) : null,
    curtailments: buildCurtailmentSchedule(
      flooredDate,
      originalPrincipalCents,
      parseCurtailmentRules(program.curtailment_schedule),
    ),
  };
}

/** Payoff due date for a sale: pay-as-sold → the sale date; else sale + N days. */
export function payoffDueDate(saleDate: string, program: Pick<ProgramTerms, 'payoff_terms' | 'payoff_days'> | null): string {
  if (!program || program.payoff_terms === 'PAY_AS_SOLD') return saleDate;
  return addDays(saleDate, program.payoff_days);
}

export interface SaleTransition {
  status: 'SOLD_UNPAID';
  soldDate: string;
  payoffDueDate: string;
  /** The payoff to PROPOSE: the remaining principal. */
  payoffCents: number;
}

/** A sale moves a live note to SOLD_UNPAID and proposes the remaining principal. */
export function transitionOnSale(
  note: { status: NoteStatus; principal_balance_cents: number },
  saleDate: string,
  program: Pick<ProgramTerms, 'payoff_terms' | 'payoff_days'> | null,
): SaleTransition {
  if (note.status !== 'OPEN' && note.status !== 'IN_DEFAULT') {
    throw new DealerEngineError(`A ${note.status} note cannot be moved to sold-unpaid`);
  }
  return {
    status: 'SOLD_UNPAID',
    soldDate: saleDate,
    payoffDueDate: payoffDueDate(saleDate, program),
    payoffCents: note.principal_balance_cents,
  };
}

/** Principal paydown (curtailment/payoff) — returns the new balance and status. */
export function applyPrincipalPayment(
  note: { status: NoteStatus; principal_balance_cents: number },
  amountCents: number,
): { balanceCents: number; status: NoteStatus } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DealerEngineError('Payment must be a positive integer of cents');
  if (note.status === 'PAID_OFF' || note.status === 'VOID' || note.status === 'RETURNED') {
    throw new DealerEngineError(`Cannot pay a ${note.status} note`);
  }
  if (amountCents > note.principal_balance_cents) {
    throw new DealerEngineError(`Payment ${amountCents} exceeds the note balance ${note.principal_balance_cents}`);
  }
  const balance = note.principal_balance_cents - amountCents;
  return { balanceCents: balance, status: balance === 0 ? 'PAID_OFF' : note.status };
}

/**
 * May the system release a proposed payoff without a human? Always false in v1 —
 * whatever the tenant's autonomy dial says (FPB §2.2 "Automatic payoff release — Later").
 */
export function canAutoRelease(): false {
  return false;
}

/** Preparer ≠ releaser (mirrors the DB CHECK on floor_plan_transactions / trade_ins). */
export function assertReleaser(proposedBy: string | null, releasedBy: string | null): void {
  if (!releasedBy) throw new DealerEngineError('A person must release this payment');
  if (proposedBy && proposedBy === releasedBy) {
    throw new DealerEngineError('The person who proposed this payment cannot also release it (separation of duties)');
  }
}
