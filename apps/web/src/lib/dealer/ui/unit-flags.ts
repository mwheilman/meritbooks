/**
 * Dealer Pack (D2 slice A) — unit register flags, aging ranges and which unit
 * actions are available. Pure and client-safe; mirrors the D1 service guards in
 * lib/dealer/service/units.ts so the UI never offers an action the server refuses.
 *
 * Flags (FPB §6): DL-4 aged unit / near floor-plan term end, DL-12 demo or rental
 * on floor plan, a manufacturer warranty registration with no sale (an SOT signal,
 * DL-1), a sold unit whose payoff is still owed, consignment.
 */

import type { NoteStatus, UnitCondition, UnitStatus } from '../types';
import type { Tone } from './labels';

export const CARRIED_STATUSES: readonly UnitStatus[] = ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'RENTAL'];
export const LIVE_NOTE: readonly NoteStatus[] = ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT'];

function dayN(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** ISO date `n` days after `iso` (negative = before). */
export function shiftDays(iso: string, n: number): string {
  return new Date((dayN(iso) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days in stock as of `today`; null without a received date. Never negative. */
export function daysInStock(receivedDate: string | null | undefined, today: string): number | null {
  if (!receivedDate) return null;
  return Math.max(0, dayN(today) - dayN(receivedDate));
}

/**
 * Days-in-stock range → received_date range for the D1 list (`from`/`to` filter on
 * received_date). minAge 91 → received on or before today − 91; maxAge 180 →
 * received on or after today − 180.
 */
export function agingRange(today: string, minAge?: number | null, maxAge?: number | null): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (typeof minAge === 'number' && Number.isFinite(minAge) && minAge > 0) out.to = shiftDays(today, -Math.floor(minAge));
  if (typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge >= 0) out.from = shiftDays(today, -Math.floor(maxAge));
  return out;
}

export interface UnitFlag {
  key: 'aged' | 'term' | 'past_term' | 'demo_floored' | 'consignment' | 'registered_unsold' | 'payoff_owed' | 'default';
  label: string;
  tone: Tone;
  hint: string;
}

export interface FlagUnit {
  status: UnitStatus;
  condition: UnitCondition;
  is_consignment: boolean;
  received_date: string | null;
  warranty_registered_date: string | null;
}

export interface FlagNote {
  status: NoteStatus;
  maturity_date: string | null;
}

export interface FlagPolicy {
  aging_buckets: number[];
  term_warning_days: number;
}

const DEFAULT_POLICY: FlagPolicy = { aging_buckets: [90, 180, 270, 365], term_warning_days: 60 };

export function unitFlags(unit: FlagUnit, note: FlagNote | null, policy: FlagPolicy | null, today: string): UnitFlag[] {
  const p = policy ?? DEFAULT_POLICY;
  const flags: UnitFlag[] = [];
  const carried = CARRIED_STATUSES.includes(unit.status);
  const live = note && LIVE_NOTE.includes(note.status) ? note : null;

  if (live?.status === 'SOLD_UNPAID') {
    flags.push({ key: 'payoff_owed', label: 'Payoff owed', tone: 'danger', hint: 'The unit is sold and the lender has not been paid off yet.' });
  }
  if (live?.status === 'IN_DEFAULT') {
    flags.push({ key: 'default', label: 'Note in default', tone: 'danger', hint: 'The lender has this note in default.' });
  }
  if (unit.warranty_registered_date && carried) {
    flags.push({
      key: 'registered_unsold',
      label: 'Registered, not sold',
      tone: 'danger',
      hint: 'The manufacturer shows a retail warranty registration but Books has no sale. Lenders treat this as proof of sale.',
    });
  }

  if (carried) {
    const days = daysInStock(unit.received_date, today);
    const edges = [...new Set(p.aging_buckets.filter((e) => Number.isInteger(e) && e > 0))].sort((a, b) => a - b);
    if (days !== null && edges.length > 0) {
      const passed = edges.filter((e) => days > e);
      if (passed.length > 0) {
        const edge = passed[passed.length - 1];
        flags.push({ key: 'aged', label: `Over ${edge} days`, tone: 'warning', hint: `In stock ${days} days — past the ${edge}-day aging mark.` });
      }
    }
    if (live?.maturity_date) {
      const left = dayN(live.maturity_date) - dayN(today);
      if (left < 0) {
        flags.push({ key: 'past_term', label: 'Past floor-plan term', tone: 'danger', hint: `The floor-plan term ended ${-left} days ago — the lender expects a repayment plan.` });
      } else if (left <= p.term_warning_days) {
        flags.push({ key: 'term', label: `Term ends in ${left} days`, tone: 'warning', hint: 'Close to the end of the floor-plan term — plan a sale, curtailment or payoff.' });
      }
    }
    if (live && (unit.condition === 'DEMO' || unit.status === 'RENTAL')) {
      flags.push({
        key: 'demo_floored',
        label: unit.status === 'RENTAL' ? 'Rental on floor plan' : 'Demo on floor plan',
        tone: 'neutral',
        hint: 'Check the lender’s demo/rental terms — many programs curtail or call demo and rental units.',
      });
    }
  }
  if (unit.is_consignment) {
    flags.push({ key: 'consignment', label: 'Consignment', tone: 'neutral', hint: 'Owned by the consignor — not on this client’s balance sheet.' });
  }
  return flags;
}

export type UnitActionKey =
  | 'MARK_DEMO'
  | 'UNMARK_DEMO'
  | 'MOVE_TO_RENTAL'
  | 'WRITE_DOWN'
  | 'RETURN_TO_OEM'
  | 'RECORD_WARRANTY_REGISTRATION'
  | 'MARK_DELIVERED'
  | 'VOID';

/** Mirrors lib/dealer/service/units.ts#unitActionNeedsApproval (service module is server-only). */
export function actionNeedsApproval(a: UnitActionKey): boolean {
  return a === 'MOVE_TO_RENTAL' || a === 'WRITE_DOWN' || a === 'RETURN_TO_OEM' || a === 'VOID';
}

/** Actions that post to the GL (need the pack switched on). */
export function actionPostsGl(a: UnitActionKey): boolean {
  return a === 'MOVE_TO_RENTAL' || a === 'WRITE_DOWN' || a === 'RETURN_TO_OEM';
}

export interface ActionUnit {
  status: UnitStatus;
  condition: UnitCondition;
  is_consignment: boolean;
  cost_cents: number;
}

/** Which actions the server would accept for this unit right now. */
export function availableActions(unit: ActionUnit, ctx: { hasLiveNote: boolean; hasSale: boolean }): Record<UnitActionKey, boolean> & { ADD_COST: boolean; RECORD_SALE: boolean } {
  const carried = CARRIED_STATUSES.includes(unit.status);
  return {
    MARK_DEMO: carried && unit.condition === 'NEW',
    UNMARK_DEMO: carried && unit.condition === 'DEMO',
    MOVE_TO_RENTAL: carried && unit.status !== 'RENTAL' && !unit.is_consignment,
    WRITE_DOWN: carried && !unit.is_consignment && unit.cost_cents > 0,
    RETURN_TO_OEM: carried && !unit.is_consignment,
    RECORD_WARRANTY_REGISTRATION: unit.status !== 'VOID',
    MARK_DELIVERED: unit.status === 'SOLD',
    VOID: unit.cost_cents === 0 && !ctx.hasLiveNote && !ctx.hasSale && unit.status !== 'VOID' && unit.status !== 'SOLD' && unit.status !== 'DELIVERED',
    ADD_COST: carried && !unit.is_consignment,
    RECORD_SALE: carried && !ctx.hasSale,
  };
}
