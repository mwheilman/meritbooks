/**
 * Plain sentences for the tokens the 1109 dealer functions raise. Several carry the specifics a
 * person needs to act on (the margin floor, the payoff list, the checklist keys), so the detail
 * is parsed rather than dropped. Runs before the ops and shared mappers: 1109 reuses 42501 for
 * the margin floor and 23P01 for a rental overlap, which they would otherwise word as a missing
 * permission or a dispatch double booking. Pure (unit-tested).
 */
import { money } from '@meritbooks/merit-ui';
import { APPROVAL_ROLE_LABELS, type ApprovalRole } from '@meritbooks/industry-packs/src/constants';
import { splitToken, type PgErrorLike } from '@/lib/api-errors';
import { CHECKLIST_WORDS } from './labels';

export interface DealerErrorCopy {
  status: number;
  code: string;
  error: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function tidy(detail: string): string {
  const s = detail.replace(UUID_RE, 'that record').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/\.?$/, '.') : '';
}

/** "{pm,ops_manager}" or "{ops_manager}" → "project manager or operations manager". */
export function roleWords(braced: string | undefined | null): string {
  const list = (braced ?? '').replace(/[{}"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return 'a manager role';
  const words = list.map((r) => (APPROVAL_ROLE_LABELS[r as ApprovalRole] ?? r.replace(/_/g, ' ')).toLowerCase());
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

function haveWords(role: string | undefined): string {
  if (!role || role === '(none)') return 'your role is not set';
  return `you are ${(APPROVAL_ROLE_LABELS[role as ApprovalRole] ?? role.replace(/_/g, ' ')).toLowerCase()}`;
}

/** Parse "front gross 120000 cents (6.15% of sale) is below the floor (8.00% / 0 cents); needs role {ops_manager}, approver has pm". */
export function parseMarginFloor(detail: string): { frontCents: number; pct: string | null; floorPct: string; minCents: number; roles: string; has: string } | null {
  const m = /front gross (-?\d+) cents \(([^)]*) of sale\) is below the floor \(([\d.]+%) \/ (\d+) cents\); needs role (\{[^}]*\}|\S+), approver has (\S+)/.exec(detail);
  if (!m) return null;
  return { frontCents: Number(m[1]), pct: m[2] === 'n/a' ? null : m[2]!, floorPct: m[3]!, minCents: Number(m[4]), roles: m[5]!, has: m[6]! };
}

/** The unit list inside a payoff error: [{"stock_number": "N26-0004", "payoff_cents": 1840000, ...}]. */
export function parsePayoffUnits(detail: string): Array<{ stock_number: string | null; serial_number: string | null; payoff_cents: number | null; payoff_due_on: string | null }> {
  const start = detail.indexOf('[');
  const end = detail.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(detail.slice(start, end + 1)) as Array<Record<string, unknown>>;
    return arr.map((u) => ({
      stock_number: typeof u.stock_number === 'string' ? u.stock_number : null,
      serial_number: typeof u.serial_number === 'string' ? u.serial_number : null,
      payoff_cents: typeof u.payoff_cents === 'number' ? u.payoff_cents : null,
      payoff_due_on: typeof u.payoff_due_on === 'string' ? u.payoff_due_on : null,
    }));
  } catch {
    return [];
  }
}

function payoffList(detail: string): string {
  const units = parsePayoffUnits(detail);
  return units.map((u) => `${u.stock_number ?? u.serial_number ?? 'unit'}${u.payoff_cents != null ? ` ${money(u.payoff_cents)}` : ''}`).join(', ');
}

const FIXED: Readonly<Record<string, string>> = {
  PM_DEAL_MARGIN_FLOOR_REASON: 'This deal is below the margin floor. Say why you are approving it anyway.',
  PM_SOD_VIOLATION: 'The salesperson and the person who wrote the deal cannot desk it. Ask another manager.',
  PM_DELIVERY_PAYOFF_BLOCKED: 'A floored unit on this deal needs its floor-plan payoff scheduled in Merit Books before delivery.',
  PM_DEAL_LOCKED: 'The deal is past the desk, so its lines are locked. Reopen it to change them.',
  PM_DEAL_LINE_FIXED: 'A line cannot move to another deal.',
  PM_QUOTE_STALE: 'The deal changed after this quote went out. Issue a new quote for the customer to accept.',
  PM_QUOTE_NOT_OPEN: 'That quote was already accepted, declined or replaced.',
  PRECONDITION_NO_CUSTOMER: 'Pick the customer first.',
  PRECONDITION_NO_LINES: 'Add at least one line first.',
  PRECONDITION_NO_UNIT: 'Add a unit from stock before writing the deal.',
  PRECONDITION_NONPOSITIVE: 'The amount must be more than zero.',
  PRECONDITION_NO_OEM_PAYER: 'Pick the manufacturer who pays the claim (set up as a customer in Merit Books).',
  PRECONDITION_NO_WARRANTY_LINES: 'This repair order has no approved warranty lines to claim.',
  PM_UNWIND_TRADE_RESOLD: 'A trade-in from this deal is no longer free in stock (it is held, sold or moved), so the deal cannot be unwound.',
  PM_TICKET_LOCKED: 'This counter ticket is closed or void; its lines are locked.',
  PM_TICKET_TRANSITION_INVALID: 'This counter ticket is already closed or void. A closed sale is returned or credited in Merit Books.',
  PM_ORDER_LOCKED: 'The parts order is submitted, so its lines are locked.',
  PM_ORDER_TRANSITION_INVALID: 'The parts order cannot make that move from where it is.',
  PM_SPECIAL_ORDER_TRANSITION_INVALID: 'The special order cannot make that move from where it is.',
  PM_COUNT_OPEN: 'This stock location already has a count open. Finish or post it first.',
  PM_COUNT_LOCKED: 'The count is posted; its lines are locked.',
  PM_COUNT_TRANSITION_INVALID: 'Only an open count can be posted.',
  PM_RENTAL_OVERLAP: 'That unit is already reserved or out during that time. Pick other dates or another unit.',
  PM_RENTAL_TRANSITION_INVALID: 'The rental cannot make that move from where it is.',
  PM_UNIT_NOT_RENTAL: 'That unit is not in the rental fleet. Move it to the fleet from Stock first.',
  PM_NO_RENTAL_RATE: 'No rental rate covers that unit. Add a rate for the unit, its model or its category.',
  PM_DEALER_EVENT_NOT_REJECTED: 'Only an event Merit Books rejected can be sent again.',
  PM_DEALER_SEAM_OFF: 'Merit Books is not taking dealer events for this company yet, so nothing can be re-sent.',
  PM_UNIT_FIELDS_LOCKED: 'Stock status, cost and floor plan change only through the store actions.',
  PM_UNKNOWN_CUSTOMER: 'That customer was not found. Pick another or add them.',
  PM_NO_ITEM_MASTER: 'The item list is not available, so new parts cannot be added yet.',
  PM_PART_SCOPE: 'That part belongs to another company.',
  PM_UNIT_SCOPE: 'That unit belongs to another company.',
  PM_STOCK_NUMBER_TAKEN: 'That stock number is already used. Leave it blank to get the next one.',
  PM_APPROVAL_ROLE_SETTINGS: 'Store settings need the operations manager role, or owner or admin.',
  PM_FORBIDDEN: 'That belongs to a different workspace, or you no longer have access to it.',
};

/** Detail-carrying tokens: keep the database's specifics, tidied. */
const DETAIL: ReadonlySet<string> = new Set([
  'PM_INVALID', 'PM_UNIT_TRANSITION_INVALID', 'PM_UNIT_NOT_AVAILABLE', 'PM_UNIT_ON_ANOTHER_DEAL', 'PM_UNIT_NOT_IN_INVENTORY', 'PM_UNIT_ON_RENT',
  'PM_PDI_OPEN', 'PM_UNIT_CUSTOMER_OWNED', 'PM_DEAL_TRANSITION_INVALID', 'PRECONDITION_TRADE_NOT_APPRAISED', 'PM_QUOTE_EXPIRED',
  'PM_UNIT_NOT_RECEIVED', 'PM_UNIT_NOT_SOLD', 'PM_PARTS_INSUFFICIENT', 'PM_COUNT_INCOMPLETE', 'PM_NOTHING_TO_BILL', 'PM_TRADE_UNIT_IN_STOCK',
]);

/** Copy for a dealer RPC failure, or null to let the ops and shared mappers answer. */
export function dealerErrorCopy(err: PgErrorLike): DealerErrorCopy | null {
  const pg = (err.code ?? '').toUpperCase();
  const { token, detail } = splitToken(err.message);
  if (!token) return null;
  const status = pg === '42501' ? 403 : pg === '23505' || pg === '23P01' ? 409 : pg === 'P0002' ? 404 : 422;

  switch (token) {
    case 'PM_DEAL_MARGIN_FLOOR': {
      const f = parseMarginFloor(detail);
      if (!f) return { status: 403, code: token, error: 'This deal is below the margin floor; a floor override needs a manager with the override role.' };
      const min = f.minCents > 0 ? ` and the ${money(f.minCents)} minimum` : '';
      return {
        status: 403, code: token,
        error: `Front gross ${money(f.frontCents)}${f.pct ? ` (${f.pct} of sale)` : ''} is below the ${f.floorPct} floor${min}. A floor override needs ${roleWords(f.roles)}; ${haveWords(f.has)}.`,
      };
    }
    case 'PM_APPROVAL_ROLE': {
      if (/dealer settings/.test(detail)) return { status: 403, code: token, error: FIXED.PM_APPROVAL_ROLE_SETTINGS! };
      const m = /^(.*?) needs role (\{[^}]*\}|\S+); (?:approver has|you have) (\S+)/.exec(detail);
      if (!m) return { status: 403, code: token, error: tidy(detail) || 'Your role cannot do that here.' };
      const what = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
      return { status: 403, code: token, error: `${what} needs ${roleWords(m[2])}; ${haveWords(m[3])}.` };
    }
    case 'PM_DELIVERY_PAYOFF_DUE': {
      const list = payoffList(detail);
      return { status: 422, code: token, error: `Floor-plan payoff is due when this unit leaves${list ? `: ${list}` : ''}. Merit Books shows it sold out of trust until the lender is paid. Acknowledge it to deliver.` };
    }
    case 'PM_DELIVERY_PAYOFF_BLOCKED': {
      const list = payoffList(detail);
      return { status: 422, code: token, error: `${FIXED[token]}${list ? ` Due: ${list}.` : ''}` };
    }
    case 'PM_DELIVERY_CHECKLIST_INCOMPLETE': {
      const keys = (/still needs: (.+)$/.exec(detail)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const words = keys.map((k) => CHECKLIST_WORDS[k] ?? k.replace(/_/g, ' '));
      return { status: 422, code: token, error: words.length ? `Finish the delivery checklist first: ${words.join('; ')}.` : 'Finish the delivery checklist first.' };
    }
    case 'PM_UNIT_SERIAL_EXISTS':
      return { status: 409, code: token, error: `${tidy(detail.replace(/ is already dealer inventory/, ' is already in stock'))} Open it from Stock instead of receiving it again.` };
    case 'PM_RENTAL_OVERLAP':
      return { status: 409, code: token, error: FIXED[token]! };
  }
  if (DETAIL.has(token)) return { status, code: token, error: tidy(detail) || 'Check the values and try again.' };
  const fixed = FIXED[token];
  if (fixed) return { status, code: token, error: fixed };
  return null;
}
