/**
 * Plain words and status marks for every closed vocabulary in migration 1109, plus the moves
 * each state machine accepts (copied from the definer functions so the UI offers only what the
 * database will take). Status is never colour alone: pip shape + word. Pure (unit-tested).
 */
import { money, shortDate } from '@meritbooks/merit-ui';
import type { Mark } from '@/lib/pm/ops/labels';
import type { Vocabulary } from '@/lib/pm/vocab';
import type {
  BooksOutcome, ChecklistItem, CountStatus, DealLineType, DealStage, DealerEventType, DepositStatus, FiProductType, FinanceType,
  FloorStatus, OutboxStatus, PartsOrderStatus, PaymentMethod, QuoteStatus, RentalStatus, RoLineKind, RoPayType, SpecialOrderStatus,
  TicketStatus, TradeStatus, UnitCondition, UnitCostSource, UnitCostType, UnitStatus, WarrantyClaimStatus,
} from './types';

const mk = (word: string, kind: Mark['kind'], pip: Mark['pip']): Mark => ({ word, kind, pip });

/** True for a company whose pack runs a dealership (its job is the repair order). */
export function isDealerPack(packKey: string | null | undefined): boolean {
  return packKey === 'equipment_dealer';
}

// ---------------------------------------------------------------- units
export const UNIT_STATUS: Readonly<Record<UnitStatus, Mark>> = {
  ON_ORDER: mk('On order', 'track', 'open'),
  IN_TRANSIT: mk('In transit', 'track', 'track'),
  IN_STOCK: mk('In stock', 'ready', 'ready'),
  PDI: mk('In PDI', 'track', 'track'),
  DEMO: mk('Demo', 'track', 'soft'),
  RENTAL: mk('Rental fleet', 'track', 'track'),
  ON_HOLD: mk('On hold for a deal', 'risk', 'risk'),
  SOLD: mk('Sold, not delivered', 'risk', 'risk'),
  DELIVERED: mk('Delivered', 'track', 'closed'),
  RETURNED_TO_MFR: mk('Returned to the manufacturer', 'track', 'closed'),
  TRANSFERRED: mk('Traded out to a dealer', 'track', 'closed'),
};

/**
 * pm.set_dealer_unit_status moves (sales statuses ON_HOLD → SOLD → DELIVERED belong to the deal;
 * PDI is opened with pm.open_unit_pdi, which also opens the internal repair order).
 */
export const UNIT_NEXT: Readonly<Record<UnitStatus, ReadonlyArray<UnitStatus>>> = {
  ON_ORDER: ['IN_TRANSIT'],
  IN_TRANSIT: ['ON_ORDER'],
  IN_STOCK: ['DEMO', 'RENTAL', 'ON_HOLD', 'RETURNED_TO_MFR', 'TRANSFERRED'],
  PDI: ['IN_STOCK', 'DEMO'],
  DEMO: ['IN_STOCK', 'RENTAL', 'RETURNED_TO_MFR', 'TRANSFERRED'],
  RENTAL: ['IN_STOCK', 'RETURNED_TO_MFR', 'TRANSFERRED'],
  ON_HOLD: ['IN_STOCK'],
  SOLD: [],
  DELIVERED: [],
  RETURNED_TO_MFR: [],
  TRANSFERRED: [],
};

/** The moves the menu offers for this unit right now (a deal's hold is released by the deal). */
export function unitMoves(status: UnitStatus | null, dealId: string | null): UnitStatus[] {
  if (!status) return [];
  if (status === 'ON_HOLD' && dealId) return [];
  return [...UNIT_NEXT[status]];
}

/** The verb on the button that moves a unit to `to`. */
export const UNIT_VERB: Readonly<Record<UnitStatus, string>> = {
  ON_ORDER: 'Back to on order', IN_TRANSIT: 'Mark in transit', IN_STOCK: 'Back in stock', PDI: 'Into PDI', DEMO: 'Make it a demo',
  RENTAL: 'Move to the rental fleet', ON_HOLD: 'Hold it', SOLD: 'Sold', DELIVERED: 'Delivered',
  RETURNED_TO_MFR: 'Return to the manufacturer', TRANSFERRED: 'Trade out to another dealer',
};

export const CONDITION_WORDS: Readonly<Record<UnitCondition, string>> = { NEW: 'New', USED: 'Used', DEMO: 'Demo', RENTAL: 'Rental' };

export const COST_TYPE_WORDS: Readonly<Record<UnitCostType, string>> = {
  BASE_INVOICE: 'Manufacturer invoice', FREIGHT: 'Freight', SETUP_PDI: 'Setup and PDI', ACCESSORY: 'Accessory', RECON: 'Reconditioning', OTHER: 'Other',
};
export const COST_SOURCE_WORDS: Readonly<Record<UnitCostSource, string>> = {
  RECEIPT: 'At receipt', MANUAL: 'Added here', INTERNAL_RO: 'Internal repair order', TRADE_IN: 'Trade-in value',
};

/** Aging bucket mark: brick from 181 days (the aged-inventory measure). */
export function agingMark(days: number | null): Mark | null {
  if (days == null) return null;
  if (days > 365) return mk(`${days} days`, 'overdue', 'overdue');
  if (days > 180) return mk(`${days} days`, 'risk', 'risk');
  if (days > 90) return mk(`${days} days`, 'track', 'soft');
  return mk(`${days} ${days === 1 ? 'day' : 'days'}`, 'track', 'track');
}

export interface FloorInput {
  floored: boolean;
  floor_status: FloorStatus | null;
  payoff_cents: number | null;
  payoff_due_on: string | null;
  payoff_scheduled: boolean;
  sold_out_of_trust: boolean;
}

/**
 * The floor-plan pip on a unit, read from Merit Books (never member-written): sold out of trust and
 * default in brick, payoff due in ochre, floored steel, paid off spruce.
 */
export function floorMark(u: FloorInput, today: string): Mark & { attention: boolean } {
  if (u.sold_out_of_trust) return { ...mk('Sold out of trust', 'overdue', 'overdue'), attention: true };
  switch (u.floor_status) {
    case null:
      return { ...mk('No word from Merit Books', 'track', 'open'), attention: false };
    case 'IN_DEFAULT':
      return { ...mk('Floor note in default', 'blocked', 'blocked'), attention: true };
    case 'SOLD_UNPAID':
      return { ...mk(u.payoff_scheduled ? 'Sold, payoff scheduled' : 'Sold, payoff due', 'risk', 'risk'), attention: !u.payoff_scheduled };
    case 'FLOORED': {
      if (u.payoff_due_on && u.payoff_due_on <= today && !u.payoff_scheduled) return { ...mk(`Payoff due ${shortDate(u.payoff_due_on, today)}`, 'risk', 'risk'), attention: true };
      return { ...mk('Floored', 'track', 'track'), attention: false };
    }
    case 'PAID_OFF':
      return { ...mk('Paid off', 'ready', 'ready'), attention: false };
    case 'NOT_FLOORED':
      return { ...mk('Not floored', 'track', 'closed'), attention: false };
    case 'RETURNED':
      return { ...mk('Returned to the lender', 'track', 'closed'), attention: false };
  }
}

// ---------------------------------------------------------------- deals
export const DEAL_STAGE: Readonly<Record<DealStage, Mark>> = {
  QUOTE: mk('Quote', 'track', 'open'),
  WRITTEN: mk('Written, to the desk', 'risk', 'risk'),
  APPROVED: mk('Approved, to fund', 'track', 'track'),
  FUNDED: mk('Funded, to deliver', 'track', 'track'),
  DELIVERED: mk('Delivered', 'ready', 'ready'),
  UNWOUND: mk('Unwound', 'blocked', 'blocked'),
  LOST: mk('Lost', 'track', 'closed'),
};

/** The six pipeline bands (lost deals sit behind a toggle). */
export const DEAL_BANDS: ReadonlyArray<{ value: Exclude<DealStage, 'LOST'>; label: string; caption: string }> = [
  { value: 'QUOTE', label: 'Quote', caption: 'Priced, not signed' },
  { value: 'WRITTEN', label: 'Written', caption: 'Buyer’s order signed, needs the desk' },
  { value: 'APPROVED', label: 'Approved', caption: 'Desked, waiting on cash or financing' },
  { value: 'FUNDED', label: 'Funded', caption: 'Ready to deliver' },
  { value: 'DELIVERED', label: 'Delivered', caption: 'Sent to Merit Books' },
  { value: 'UNWOUND', label: 'Unwound', caption: 'Reversed after delivery' },
];

/** What the desk does next on a deal in this stage. */
export const DEAL_NEXT_WORDS: Readonly<Record<DealStage, string>> = {
  QUOTE: 'Quote it or write it', WRITTEN: 'Desk it', APPROVED: 'Fund it', FUNDED: 'Deliver it', DELIVERED: 'Done', UNWOUND: 'Reversed', LOST: 'Lost',
};

/** Line types are editable while the deal is QUOTE or WRITTEN (the line triggers' rule). */
export function dealEditable(stage: DealStage): boolean {
  return stage === 'QUOTE' || stage === 'WRITTEN';
}

export const LINE_TYPE_WORDS: Readonly<Record<DealLineType, string>> = {
  UNIT: 'Unit', ATTACHMENT: 'Attachment or part', FEE: 'Fee', DISCOUNT: 'Discount', REBATE: 'Customer rebate', INCENTIVE: 'Dealer incentive',
};
export const LINE_TYPE_HELP: Readonly<Record<DealLineType, string>> = {
  UNIT: 'A unit from stock; its cost is pinned from the unit.',
  ATTACHMENT: 'Bucket, deck, loader or a part sold with the unit.',
  FEE: 'Documentation, freight, setup or delivery charged to the customer.',
  DISCOUNT: 'Lowers the sale price.',
  REBATE: 'Manufacturer money to the customer; lowers what they pay, not your gross.',
  INCENTIVE: 'Manufacturer money to you; adds to front gross.',
};

export const FINANCE_WORDS: Readonly<Record<FinanceType, string>> = { CASH: 'Cash', RETAIL_FINANCE: 'Retail finance', LEASE: 'Lease', OPEN_ACCOUNT: 'Open account' };

export const FI_WORDS: Readonly<Record<FiProductType, string>> = {
  EXTENDED_WARRANTY: 'Extended warranty', SERVICE_CONTRACT: 'Service contract', MAINTENANCE_PLAN: 'Maintenance plan', GAP: 'GAP',
  CREDIT_LIFE: 'Credit life', TIRE_WHEEL: 'Tire and wheel', THEFT: 'Theft protection', OTHER: 'Other product',
};

export const QUOTE_STATUS: Readonly<Record<QuoteStatus, Mark>> = {
  ISSUED: mk('With the customer', 'risk', 'risk'),
  ACCEPTED: mk('Accepted', 'ready', 'ready'),
  DECLINED: mk('Declined', 'blocked', 'blocked'),
  EXPIRED: mk('Expired', 'track', 'closed'),
  SUPERSEDED: mk('Replaced by a newer quote', 'track', 'closed'),
};

export const TRADE_STATUS: Readonly<Record<TradeStatus, Mark>> = {
  APPRAISED: mk('Appraised', 'track', 'track'),
  RECEIVED: mk('In stock as used', 'ready', 'ready'),
  UNWOUND: mk('Returned on unwind', 'track', 'closed'),
  VOID: mk('Void', 'track', 'closed'),
};

export const DEPOSIT_STATUS: Readonly<Record<DepositStatus, Mark>> = {
  REQUESTED: mk('Requested from Merit Books', 'track', 'track'),
  ISSUED: mk('Invoiced in Merit Books', 'ready', 'ready'),
  REJECTED: mk('Rejected by Merit Books', 'blocked', 'blocked'),
  SUPPRESSED: mk('Recorded here only', 'track', 'soft'),
  VOID: mk('Void', 'track', 'closed'),
};

/** Default labels for the delivery checklist keys 1109 seeds. */
export const CHECKLIST_WORDS: Readonly<Record<string, string>> = {
  pdi_complete: 'PDI and setup complete',
  walkaround: 'Operator walk-around and safety review',
  operator_manual: 'Operator’s manual, keys and accessories handed over',
  buyers_order_signed: 'Buyer’s order signed',
  warranty_registration: 'Warranty registration submitted',
};

/** Required checklist items still open (deliver_deal refuses until these are done). */
export function checklistMissing(items: ReadonlyArray<ChecklistItem>): ChecklistItem[] {
  return items.filter((i) => i.required && !i.done);
}

// ---------------------------------------------------------------- parts
export const TICKET_STATUS: Readonly<Record<TicketStatus, Mark>> = {
  OPEN: mk('Open', 'track', 'open'),
  CLOSED: mk('Closed', 'ready', 'ready'),
  VOID: mk('Void', 'track', 'closed'),
};

export const PAYMENT_WORDS: Readonly<Record<PaymentMethod, string>> = { CASH: 'Cash', CARD: 'Card', CHARGE: 'Charge to account', CHECK: 'Check', OTHER: 'Other' };

export const SPECIAL_ORDER_STATUS: Readonly<Record<SpecialOrderStatus, Mark>> = {
  REQUESTED: mk('Requested', 'track', 'open'),
  ORDERED: mk('Ordered', 'track', 'track'),
  RECEIVED: mk('In, customer not told', 'risk', 'risk'),
  NOTIFIED: mk('Customer notified', 'track', 'track'),
  PICKED_UP: mk('Picked up', 'ready', 'ready'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

/** pm.advance_special_order moves. */
export const SPECIAL_ORDER_NEXT: Readonly<Record<SpecialOrderStatus, ReadonlyArray<SpecialOrderStatus>>> = {
  REQUESTED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['NOTIFIED', 'PICKED_UP'],
  NOTIFIED: ['PICKED_UP'],
  PICKED_UP: [],
  CANCELLED: [],
};

export const SPECIAL_ORDER_VERB: Readonly<Record<SpecialOrderStatus, string>> = {
  REQUESTED: 'Requested', ORDERED: 'Mark ordered', RECEIVED: 'Receive', NOTIFIED: 'Customer notified', PICKED_UP: 'Picked up', CANCELLED: 'Cancel',
};

export const PARTS_ORDER_STATUS: Readonly<Record<PartsOrderStatus, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  SUBMITTED: mk('Submitted', 'track', 'track'),
  PARTIAL: mk('Partly received', 'risk', 'risk'),
  RECEIVED: mk('Received', 'ready', 'ready'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

export const COUNT_STATUS: Readonly<Record<CountStatus, Mark>> = {
  OPEN: mk('Counting', 'track', 'open'),
  POSTED: mk('Posted', 'ready', 'ready'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

// ---------------------------------------------------------------- service
export const PAY_TYPE_WORDS: Readonly<Record<RoPayType, string>> = { CUSTOMER: 'Customer', WARRANTY: 'Warranty', INTERNAL: 'Internal', POLICY: 'Policy' };
export const PAY_TYPE_HELP: Readonly<Record<RoPayType, string>> = {
  CUSTOMER: 'The customer pays at pickup.',
  WARRANTY: 'Claimed to the manufacturer.',
  INTERNAL: 'Your own work: PDI, reconditioning, shop.',
  POLICY: 'Goodwill the manufacturer or the store absorbs outside warranty.',
};
export const RO_KIND_WORDS: Readonly<Record<RoLineKind, string>> = {
  LABOR: 'Labor op', PART: 'Part', SUBLET: 'Sublet', MISC: 'Misc', SERVICE: 'Flat-rate task', FEE: 'Fee', FREIGHT: 'Freight', DISCOUNT: 'Discount', EQUIPMENT: 'Equipment',
};
/** The four kinds the RO line editor writes. */
export const RO_EDITOR_KINDS: ReadonlyArray<RoLineKind> = ['LABOR', 'PART', 'SUBLET', 'MISC'];

// ---------------------------------------------------------------- warranty
export const WARRANTY_BANDS: ReadonlyArray<{ value: WarrantyClaimStatus | 'SETTLED'; label: string; caption: string }> = [
  { value: 'DRAFT', label: 'To file', caption: 'Drafted, not sent to the manufacturer' },
  { value: 'SUBMITTED', label: 'Submitted', caption: 'With the manufacturer' },
  { value: 'RETURNED', label: 'Returned', caption: 'The manufacturer wants more' },
  { value: 'APPROVED', label: 'Approved', caption: 'Approved, credit not in yet' },
  { value: 'SETTLED', label: 'Settled by Books', caption: 'Credited, short-paid or rejected' },
];

export const BOOKS_OUTCOME: Readonly<Record<BooksOutcome, Mark>> = {
  CREDITED: mk('Credited in full', 'ready', 'ready'),
  SHORT_PAID: mk('Short-paid', 'risk', 'risk'),
  REJECTED: mk('Rejected', 'blocked', 'blocked'),
};

/** Filing-deadline mark on a draft claim. */
export function deadlineMark(deadline: string | null, status: WarrantyClaimStatus, today: string): Mark | null {
  if (!deadline || status !== 'DRAFT') return null;
  const days = Math.round((Date.parse(`${deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (days < 0) return mk(`Deadline passed ${shortDate(deadline, today)}`, 'overdue', 'overdue');
  if (days <= 5) return mk(days === 0 ? 'File today' : `File within ${days} ${days === 1 ? 'day' : 'days'}`, 'risk', 'risk');
  return mk(`File by ${shortDate(deadline, today)}`, 'track', 'track');
}

// ---------------------------------------------------------------- rentals
export const RENTAL_STATUS: Readonly<Record<RentalStatus, Mark>> = {
  RESERVED: mk('Reserved', 'track', 'open'),
  OUT: mk('Out on rent', 'track', 'track'),
  RETURNED: mk('Back, to bill', 'risk', 'risk'),
  CLOSED: mk('Billed and closed', 'ready', 'ready'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

// ---------------------------------------------------------------- Merit Books seam
/** One record's place in the dealer outbox, in words. */
export function outboxMark(status: OutboxStatus, suppressed: 'SAMPLE' | 'STANDALONE' | null = null): Mark {
  switch (status) {
    case 'HELD': return mk('Held until Merit Books turns on dealer posting', 'track', 'soft');
    case 'RELEASED': return mk('Sent, waiting on Merit Books', 'track', 'track');
    case 'PROCESSED': return mk('Posted in Merit Books', 'ready', 'ready');
    case 'REJECTED': return mk('Rejected by Merit Books', 'blocked', 'blocked');
    case 'SUPPRESSED': return suppressed === 'SAMPLE' ? mk('Sample record, not sent', 'track', 'closed') : mk('Merit Books is not on', 'track', 'closed');
  }
}

export const EVENT_WORDS: Readonly<Record<DealerEventType, string>> = {
  DEALER_UNIT_RECEIVED: 'Unit received',
  DEALER_UNIT_COST: 'Unit cost added',
  DEALER_UNIT_STATUS: 'Unit status change',
  DEALER_DEAL_FINALIZED: 'Deal delivered',
  DEALER_DEAL_UNWOUND: 'Deal unwound',
  DEALER_TRADE_RECEIVED: 'Trade-in received',
  DEALER_PARTS_SALE: 'Counter sale',
  DEALER_RO_CLOSED: 'Repair order closed',
  DEALER_WARRANTY_CLAIM: 'Warranty claim',
  DEALER_WARRANTY_REGISTRATION: 'Warranty registration',
  DEALER_RENTAL_BILLED: 'Rental billed',
  DEALER_DEPOSIT_REQUEST: 'Deal deposit',
};

/** Where a dealer event's record lives in the app. */
export function subjectHref(subjectTable: string | null, subjectId: string | null): string | null {
  if (!subjectId) return null;
  switch (subjectTable) {
    case 'assets': return `/stock?unit=${subjectId}`;
    case 'dealer_deals': return `/deals/${subjectId}`;
    case 'dealer_trades': return '/deals';
    case 'parts_tickets': return `/parts?ticket=${subjectId}`;
    case 'work_orders': return `/work-orders?wo=${subjectId}`;
    case 'warranty_claims': return '/warranty';
    case 'rental_contracts': return `/rentals?contract=${subjectId}`;
    default: return null;
  }
}

// ---------------------------------------------------------------- activity
function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Dealer activity rows in plain words (money through merit-ui, never "N cents"). Falls back to the
 * row's own summary for verbs it does not know.
 */
export function dealerActivitySentence(a: { verb: string; summary: string | null; meta: Record<string, unknown> }): string {
  const m = a.meta ?? {};
  const s = a.summary ?? '';
  switch (a.verb) {
    case 'dealer_unit.received': {
      const c = n(m.cost_cents);
      return `Received${typeof m.stock_number === 'string' ? ` ${m.stock_number}` : ''}${c ? ` at ${money(c)}` : ''}`;
    }
    case 'dealer_unit.cost_added': {
      const c = n(m.amount_cents);
      const t = typeof m.cost_type === 'string' ? COST_TYPE_WORDS[m.cost_type as UnitCostType] ?? m.cost_type : 'cost';
      return `Added ${t.toLowerCase()}${c ? ` of ${money(c)}` : ''}`;
    }
    case 'dealer_unit.status': {
      const to = typeof m.to === 'string' ? UNIT_STATUS[m.to as UnitStatus]?.word ?? m.to : null;
      return to ? `Moved to ${to.toLowerCase()}${typeof m.reason === 'string' && m.reason ? `: ${m.reason}` : ''}` : s;
    }
    case 'dealer_unit.transferred': return `Transferred to another stock location${s.includes('inter-company') ? ' (another company)' : ''}`;
    case 'dealer_unit.pdi_opened': return 'Opened the PDI repair order';
    case 'dealer_unit.registered': return 'Registered the warranty with the manufacturer';
    case 'dealer_unit.ordered': return 'Ordered from the manufacturer';
    case 'dealer_unit.floor_status': {
      const st = typeof m.floor_status === 'string' ? m.floor_status : null;
      const p = n(m.payoff_cents);
      return `Merit Books: floor plan ${st ? st.toLowerCase().replace(/_/g, ' ') : 'updated'}${p ? `, payoff ${money(p)}` : ''}${typeof m.payoff_due_on === 'string' && m.payoff_due_on ? ` due ${shortDate(m.payoff_due_on)}` : ''}`;
    }
    case 'dealer.sot_alert': {
      const amt = n(m.amount_cents);
      return `Merit Books: sold out of trust${amt ? `, ${money(amt)} owed to the lender` : ''}`;
    }
    case 'deal.created': return 'Started the deal';
    case 'deal.quoted': return `Issued a quote${n((m.totals as Record<string, unknown> | undefined)?.cash_price_cents) != null ? ` for ${money(n((m.totals as Record<string, unknown>).cash_price_cents)!)}` : ''}`;
    case 'deal.quote_accepted': return 'The customer accepted the quote';
    case 'deal.quote_declined': return `The customer declined the quote${typeof m.reason === 'string' && m.reason ? `: ${m.reason}` : ''}`;
    case 'deal.written': return 'Wrote the deal (buyer’s order)';
    case 'deal.approved': return `Desked the deal${m.rule === 'FLOOR_OVERRIDE' ? ' below the margin floor' : ''}${n(m.front_gross_cents) != null ? `, front gross ${money(n(m.front_gross_cents)!)}` : ''}${typeof m.override_reason === 'string' && m.override_reason ? ` (${m.override_reason})` : ''}`;
    case 'deal.reopened': return 'Reopened the deal; the approval was cleared';
    case 'deal.funded': return 'Marked funded and ready to deliver';
    case 'deal.delivered': return 'Delivered the deal and sent it to Merit Books';
    case 'deal.unwound': return 'Unwound the deal';
    case 'deal.lost': return `Marked the deal lost${typeof m.reason === 'string' && m.reason ? `: ${m.reason}` : ''}`;
    case 'deal.deposit_requested': return 'Requested a deposit through Merit Books';
    case 'dealer.event_rejected': return s.replace(/^Merit Books rejected/, 'Merit Books rejected');
    case 'dealer.event_resent': return 'Sent the event to Merit Books again';
    default: return s || a.verb.replace(/[._]/g, ' ');
  }
}

/** "2024 Kubota BX2380" */
export function unitTitle(u: { model_year: number | null; make: string | null; model: string | null; description?: string | null }): string {
  return [u.model_year, u.make, u.model].filter((x) => x != null && x !== '').join(' ') || u.description || 'Unit';
}

/** The dealer vocabulary stays the pack's; a store page still says "Repair order" from it. */
export function roTerm(v: Pick<Vocabulary, 'job'>): string {
  return /repair order/i.test(v.job) ? v.job : 'Repair order';
}
