/**
 * Plain words and status marks for the residential vocabularies of migration 1119, plus the
 * moves each screen offers (copied from the definer functions so a button only appears when the
 * database will take it). Pure and client-safe (unit-tested). Status is never colour alone: a pip
 * shape plus the word.
 */
import type { PipKind, StatusKind } from '@meritbooks/merit-ui';
import type { Mark } from '@/lib/pm/ops/labels';
import type {
  CoExposureRow, LotBoardRow, PaymentScheduleRow, ProposalRow, ProposalStatus, TradeConfirmationRow, WalkRow,
} from './types';

const mk = (word: string, kind: StatusKind, pip: PipKind): Mark => ({ word, kind, pip });

export const PROPOSAL_STATUS: Readonly<Record<ProposalStatus, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  SENT: mk('Sent', 'risk', 'track'),
  ACCEPTED: mk('Accepted', 'ready', 'ready'),
  DECLINED: mk('Declined', 'blocked', 'closed'),
  SUPERSEDED: mk('Superseded', 'track', 'closed'),
};

export const PAYMENT_STATUS: Readonly<Record<PaymentScheduleRow['status'], Mark>> = {
  PLANNED: mk('Planned', 'track', 'open'),
  SCHEDULED: mk('On the schedule', 'track', 'track'),
  HELD: mk('Held', 'blocked', 'blocked'),
  DRAFTED: mk('Bill drafted', 'risk', 'risk'),
  BILLED: mk('Billed', 'ready', 'ready'),
  VOID: mk('Void', 'track', 'closed'),
};

export const EXPOSURE_STATE: Readonly<Record<CoExposureRow['exposure_state'], Mark>> = {
  unpriced: mk('Not priced', 'overdue', 'overdue'),
  sent: mk('Waiting on signature', 'risk', 'risk'),
  signed: mk('Signed', 'track', 'track'),
  approved: mk('Approved', 'ready', 'ready'),
  rejected: mk('Rejected', 'blocked', 'closed'),
  void: mk('Void', 'track', 'closed'),
};

export const CO_TYPE_WORDS: Readonly<Record<CoExposureRow['co_type'], string>> = {
  CLIENT: 'Client request', FIELD_REQUEST: 'Field request', DEMO_DISCOVERY: 'Found in demo', ALLOWANCE: 'Allowance overage', NO_CHARGE: 'No charge (internal)',
};

export const TRADE_STATUS: Readonly<Record<TradeConfirmationRow['status'], Mark>> = {
  ASSIGNED: mk('Not sent', 'overdue', 'open'),
  NOTIFIED: mk('Waiting on trade', 'risk', 'risk'),
  CONFIRMED: mk('Confirmed', 'ready', 'ready'),
  DECLINED: mk("Can't make it", 'blocked', 'blocked'),
  PROPOSED: mk('Proposed a date', 'risk', 'track'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

export const LOT_STATUS: Readonly<Record<LotBoardRow['status'], Mark>> = {
  RAW: mk('Raw land', 'track', 'open'),
  DEVELOPED: mk('Developed', 'track', 'open'),
  AVAILABLE: mk('Available', 'ready', 'open'),
  HELD: mk('Held', 'risk', 'soft'),
  SOLD: mk('Sold', 'risk', 'track'),
  STARTED: mk('Under construction', 'track', 'track'),
  COMPLETE: mk('Complete', 'ready', 'ready'),
  CLOSED: mk('Closed', 'track', 'closed'),
};

export const WALK_WORDS: Readonly<Record<WalkRow['kind'], string>> = {
  FINAL_WALKTHROUGH: 'Final walkthrough', ORIENTATION: 'Homeowner orientation', WARRANTY_30: '30-day warranty walk',
  WARRANTY_11M: '11-month warranty walk', WARRANTY_2Y: '2-year warranty walk', CUSTOM: 'Walk',
};

export const CONTRACT_SHORT: Readonly<Record<ProposalRow['contract_type'], string>> = {
  FIXED_PRICE: 'Fixed price', COST_PLUS_PCT: 'Cost plus %', COST_PLUS_FEE: 'Cost plus fee', COST_PLUS_GMP: 'Cost plus, GMP',
  TIME_MATERIALS: 'Time and materials', DESIGN_AGREEMENT: 'Design agreement', PURCHASE_AGREEMENT: 'Purchase agreement',
};

export const TAX_FORM_WORDS: Readonly<Record<ProposalRow['tax_contract_form'], string>> = {
  LUMP_SUM_IMPROVEMENT: 'Lump sum (we pay tax on materials)',
  RETAIL_PLUS_INSTALL: 'Retail plus install (tax on the invoice)',
  EXEMPT: 'Exempt',
};

export const METHOD_WORDS: Readonly<Record<'IN_PERSON' | 'PORTAL' | 'EMAIL' | 'PHONE' | 'E_SIGNATURE', string>> = {
  IN_PERSON: 'In person', PORTAL: 'Customer portal', EMAIL: 'By email', PHONE: 'By phone', E_SIGNATURE: 'E-signature',
};

/** What a proposal in this state can do next (the database refuses anything else). */
export function proposalMoves(p: Pick<ProposalRow, 'status' | 'envelope_id'>, envelopeOpen: boolean): {
  edit: boolean; send: boolean; accept: boolean; sign: boolean; revise: boolean; decline: boolean;
} {
  const draft = p.status === 'DRAFT';
  const sent = p.status === 'SENT';
  return { edit: draft, send: draft, accept: sent, sign: sent && !envelopeOpen, revise: sent, decline: sent || draft };
}

/** The share of a payment schedule a row carries, as words ("25%", "$1,250.00", "balance"). */
export function scheduleShare(r: Pick<PaymentScheduleRow, 'kind' | 'pct' | 'amount_cents'>, fmt: (c: number) => string): string {
  if (r.amount_cents != null) return fmt(r.amount_cents);
  if (r.pct != null) return `${Math.round(r.pct * 10000) / 100}%`;
  return r.kind === 'FINAL' ? 'Balance' : '—';
}

/** Why a draft proposal cannot be sent yet, in the order the database checks (null = ready). */
export function sendBlocker(p: { lines: ReadonlyArray<{ cost_code_id: string | null; option_id: string | null }>; options: ReadonlyArray<{ kind: string; group_key: string | null; is_selected: boolean }>; schedulePctSum: number | null }): string | null {
  if (p.lines.length === 0) return 'Add at least one line.';
  const groups = new Map<string, number>();
  for (const o of p.options) if (o.kind === 'ALTERNATE' && o.group_key) groups.set(o.group_key, (groups.get(o.group_key) ?? 0) + (o.is_selected ? 1 : 0));
  for (const [g, n] of groups) if (n > 1) return `Pick only one option in “${g}”.`;
  if (p.schedulePctSum != null && Math.abs(p.schedulePctSum - 1) > 0.0001) return `The payment schedule adds to ${Math.round(p.schedulePctSum * 10000) / 100}%, not 100%.`;
  return null;
}

/** Group proposal lines by room, keeping the order rooms first appear. */
export function byRoom<T extends { room: string | null }>(lines: ReadonlyArray<T>, general = 'General'): Array<{ room: string; lines: T[] }> {
  const m = new Map<string, T[]>();
  for (const l of lines) {
    const k = l.room?.trim() || general;
    m.set(k, [...(m.get(k) ?? []), l]);
  }
  return [...m.entries()].map(([room, ls]) => ({ room, lines: ls }));
}

/** What an option does to the allowance, in words, BEFORE the homeowner picks it (RES-33). */
export function allowanceDeltaWords(o: { over_cents: number | null; under_cents: number | null }, visible: boolean, fmt: (c: number) => string): { text: string; tone: 'neg' | 'pos' | 'default' } {
  if (!visible) return { text: '', tone: 'default' };
  if (o.over_cents && o.over_cents > 0) return { text: `${fmt(o.over_cents)} over the allowance`, tone: 'neg' };
  if (o.under_cents && o.under_cents > 0) return { text: `${fmt(o.under_cents)} under — a credit`, tone: 'pos' };
  return { text: 'Within the allowance', tone: 'default' };
}

/**
 * The house's design-center stage from its schedule — the same rule as pm.res_lot_stage (1119):
 * nothing started → PRE_START; trim / cabinets / finish carpentry started → CLOSEOUT; drywall →
 * PRE_TRIM; framing → PRE_DRYWALL; anything else started → PRE_FRAME.
 */
export function houseStage(tasks: ReadonlyArray<{ title: string; status: string; is_summary: boolean }>): 'PRE_START' | 'PRE_FRAME' | 'PRE_DRYWALL' | 'PRE_TRIM' | 'CLOSEOUT' {
  const started = tasks.filter((t) => !t.is_summary && (t.status === 'IN_PROGRESS' || t.status === 'DONE'));
  if (!started.length) return 'PRE_START';
  if (started.some((t) => /(trim|cabinet|finish carp)/i.test(t.title))) return 'CLOSEOUT';
  if (started.some((t) => /drywall/i.test(t.title))) return 'PRE_TRIM';
  if (started.some((t) => /fram/i.test(t.title))) return 'PRE_DRYWALL';
  return 'PRE_FRAME';
}
