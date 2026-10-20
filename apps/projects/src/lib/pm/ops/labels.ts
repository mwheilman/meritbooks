/**
 * Plain words and status marks for every closed vocabulary in 1104–1107 and the 1100 field
 * records, plus the allowed moves each state machine accepts (copied from the definer
 * functions so the UI only offers moves the database will take). Pure (unit-tested).
 * Status is never colour alone: a pip shape plus the word.
 */
import type { PipKind, StatusKind } from '@meritbooks/merit-ui';
import type { Vocabulary } from '@/lib/pm/vocab';
import type {
  AgreementStatus, ApprovalMethod, ApprovalState, AreaKind, AssetKind, AssetStatus, AssignmentStatus, BomKind, ClaimStatus,
  EntitlementKind, EntitlementStatus, HistoryKind, ItemStatus, LineKind, LogKind, MeasureStatus, OpStatus, PayType,
  ProductCategory, PunchKind, PunchStatus, SelectionStatus, UnitKind, UnitStatus, WoKind, WoOutcome, WoStatus,
} from './types';

export interface Mark {
  word: string;
  kind: StatusKind;
  pip: PipKind;
}

const mk = (word: string, kind: StatusKind, pip: PipKind): Mark => ({ word, kind, pip });

// ---------------------------------------------------------------- work orders
export const WO_STATUS: Readonly<Record<WoStatus, Mark>> = {
  NEW: mk('New', 'track', 'open'),
  SCHEDULED: mk('Scheduled', 'track', 'track'),
  DISPATCHED: mk('Dispatched', 'track', 'track'),
  IN_PROGRESS: mk('In progress', 'track', 'track'),
  ON_HOLD: mk('On hold', 'risk', 'soft'),
  RELEASED: mk('Released', 'track', 'track'),
  COMPLETE: mk('Complete', 'ready', 'ready'),
  CLOSED: mk('Closed', 'track', 'closed'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

/** The five bands of the work-order queue. Cancelled sits with Closed. */
export type WoBand = 'new' | 'scheduled' | 'progress' | 'complete' | 'closed';
export function woBand(s: WoStatus): WoBand {
  switch (s) {
    case 'NEW': return 'new';
    case 'SCHEDULED':
    case 'DISPATCHED': return 'scheduled';
    case 'IN_PROGRESS':
    case 'ON_HOLD':
    case 'RELEASED': return 'progress';
    case 'COMPLETE': return 'complete';
    default: return 'closed';
  }
}

/** True when the pack calls its job a repair order (equipment dealers). */
export function isDealerVocab(v: Pick<Vocabulary, 'job'>): boolean {
  return /repair order/i.test(v.job);
}

/** The term for a REPAIR_ORDER work order: the pack's own word when it has one. */
export function repairOrderTerm(v: Pick<Vocabulary, 'job'>): string {
  return isDealerVocab(v) ? v.job : 'Repair order';
}

/**
 * What the work-order pages call their rows. A dealer's unit of work is the repair order
 * (its pack names work orders "RO lines", which are lines inside it), so dealer pages say
 * "Repair orders"; everyone else uses the pack's work-order term ("Visits", "Install tickets").
 */
export function woVocab(v: Pick<Vocabulary, 'job' | 'jobs' | 'work_order' | 'work_orders'>): { one: string; many: string; dealer: boolean } {
  return isDealerVocab(v) ? { one: v.job, many: v.jobs, dealer: true } : { one: v.work_order, many: v.work_orders, dealer: false };
}

export function woKindLabel(kind: WoKind, v: Pick<Vocabulary, 'job' | 'work_order'>): string {
  switch (kind) {
    case 'SERVICE': return 'Service';
    case 'MAINTENANCE_VISIT': return 'Maintenance visit';
    case 'INSTALL': return 'Install';
    case 'MEASURE': return 'Measure';
    case 'DELIVERY': return 'Delivery';
    case 'REPAIR_ORDER': return repairOrderTerm(v);
    case 'PDI': return 'Pre-delivery inspection';
    case 'PRODUCTION': return 'Production order';
    case 'INSPECTION': return 'Inspection';
  }
}

/** Kinds a create form offers, by pack. The first is the default. */
export function creatableKinds(packKey: string | null): WoKind[] {
  switch (packKey) {
    case 'equipment_dealer': return ['REPAIR_ORDER', 'PDI', 'SERVICE', 'INSPECTION', 'DELIVERY'];
    case 'flooring': return ['MEASURE', 'INSTALL', 'DELIVERY', 'SERVICE', 'INSPECTION'];
    case 'field_service': return ['SERVICE', 'INSTALL', 'MAINTENANCE_VISIT', 'INSPECTION', 'DELIVERY'];
    default: return ['SERVICE', 'INSTALL', 'INSPECTION', 'DELIVERY', 'MEASURE', 'REPAIR_ORDER', 'PDI'];
  }
}

export const PRIORITY_WORDS: Readonly<Record<number, string>> = { 1: 'Emergency', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'When convenient' };
export function priorityWord(p: number): string {
  return PRIORITY_WORDS[p] ?? `Priority ${p}`;
}
export function priorityPip(p: number): PipKind {
  return p <= 1 ? 'overdue' : p === 2 ? 'risk' : p >= 4 ? 'soft' : 'track';
}

export const OUTCOME_WORDS: Readonly<Record<WoOutcome, string>> = {
  FIXED: 'Fixed', COMPLETED: 'Completed', PARTIAL: 'Partly done', NOT_FIXED: 'Not fixed', NEEDS_PARTS: 'Needs parts',
  NEEDS_QUOTE: 'Needs a quote', NO_PROBLEM_FOUND: 'No problem found', DECLINED: 'Customer declined', NO_ACCESS: 'No access to the site',
};

export const LINE_KIND_WORDS: Readonly<Record<LineKind, string>> = {
  SERVICE: 'Flat-rate task', PART: 'Part', LABOR: 'Labor', EQUIPMENT: 'Equipment', FEE: 'Fee', DISCOUNT: 'Discount', SUBLET: 'Sublet', FREIGHT: 'Freight',
};

export const ASSIGNMENT_STATUS: Readonly<Record<AssignmentStatus, Mark>> = {
  ASSIGNED: mk('Assigned', 'track', 'open'),
  DISPATCHED: mk('Dispatched', 'track', 'track'),
  EN_ROUTE: mk('En route', 'track', 'track'),
  ON_SITE: mk('On site', 'track', 'track'),
  DONE: mk('Done', 'ready', 'ready'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

/** pm.set_assignment_status moves. */
export const ASSIGNMENT_NEXT: Readonly<Record<AssignmentStatus, ReadonlyArray<AssignmentStatus>>> = {
  ASSIGNED: ['DISPATCHED', 'EN_ROUTE', 'ON_SITE', 'CANCELLED'],
  DISPATCHED: ['EN_ROUTE', 'ON_SITE', 'CANCELLED'],
  EN_ROUTE: ['ON_SITE', 'CANCELLED'],
  ON_SITE: ['DONE'],
  DONE: [],
  CANCELLED: [],
};

export const CLAIM_STATUS: Readonly<Record<ClaimStatus, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  SUBMITTED: mk('Submitted', 'track', 'track'),
  RETURNED: mk('Returned for info', 'risk', 'risk'),
  APPROVED: mk('Approved, not paid', 'track', 'track'),
  PAID: mk('Paid', 'ready', 'ready'),
  REJECTED: mk('Rejected', 'blocked', 'blocked'),
  WRITTEN_OFF: mk('Written off', 'track', 'closed'),
};

/** pm.advance_warranty_claim moves. */
export const CLAIM_NEXT: Readonly<Record<ClaimStatus, ReadonlyArray<ClaimStatus>>> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['APPROVED', 'RETURNED', 'REJECTED'],
  RETURNED: ['SUBMITTED', 'WRITTEN_OFF'],
  APPROVED: ['PAID', 'WRITTEN_OFF'],
  REJECTED: ['SUBMITTED', 'WRITTEN_OFF'],
  PAID: [],
  WRITTEN_OFF: [],
};

/** Outstanding on a claim, exactly as warranty_claims_outstanding_cents counts it. */
export function claimOutstanding(c: { status: ClaimStatus; approved_cents: number | null; claimed_cents: number; paid_cents: number }): number {
  if (c.status !== 'SUBMITTED' && c.status !== 'RETURNED' && c.status !== 'APPROVED') return 0;
  return Math.max((c.approved_cents ?? c.claimed_cents) - c.paid_cents, 0);
}

export const AGREEMENT_STATUS: Readonly<Record<AgreementStatus, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  ACTIVE: mk('Active', 'ready', 'ready'),
  SUSPENDED: mk('Suspended', 'risk', 'soft'),
  EXPIRED: mk('Expired', 'track', 'closed'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
  RENEWED: mk('Renewed', 'track', 'closed'),
};

export const ASSET_KIND_WORDS: Readonly<Record<AssetKind, string>> = {
  CUSTOMER_EQUIPMENT: 'Customer equipment', DEALER_UNIT: 'Dealer unit', RENTAL_UNIT: 'Rental unit', COMPANY_EQUIPMENT: 'Company equipment',
};
export const ASSET_STATUS: Readonly<Record<AssetStatus, Mark>> = {
  ACTIVE: mk('In service', 'ready', 'ready'),
  REPLACED: mk('Replaced', 'track', 'closed'),
  RETIRED: mk('Retired', 'track', 'closed'),
  SOLD: mk('Sold', 'track', 'closed'),
};
export const HISTORY_WORDS: Readonly<Record<HistoryKind, string>> = {
  INSTALL: 'Installed', REPAIR: 'Repair', MAINTENANCE: 'Maintenance', INSPECTION: 'Inspection', WARRANTY: 'Warranty repair', RECALL: 'Recall',
  CALLBACK: 'Callback', PDI: 'Pre-delivery inspection', REPLACEMENT: 'Replaced', METER_READING: 'Meter reading', NOTE: 'Note',
};

// ---------------------------------------------------------------- production
export const OP_STATUS: Readonly<Record<OpStatus, Mark>> = {
  PENDING: mk('Waiting', 'track', 'open'),
  READY: mk('Ready', 'track', 'track'),
  IN_PROGRESS: mk('Running', 'track', 'track'),
  COMPLETE: mk('Done', 'ready', 'ready'),
  SKIPPED: mk('Skipped', 'track', 'closed'),
};
export const PRODUCTION_STATUS_WORDS: Readonly<Partial<Record<WoStatus, string>>> = {
  NEW: 'Engineering', RELEASED: 'Released', IN_PROGRESS: 'In the shop', ON_HOLD: 'On hold', COMPLETE: 'Complete', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};
export const BOM_KIND_WORDS: Readonly<Record<BomKind, string>> = {
  ASSEMBLY: 'Assembly', PART: 'Part', SHEET: 'Sheet', LUMBER: 'Lumber', EDGEBAND: 'Edgeband', HARDWARE: 'Hardware', FINISH: 'Finish', BUYOUT: 'Buyout', CONSUMABLE: 'Consumable',
};

// ---------------------------------------------------------------- selections / procurement / measures
export const SELECTION_STATUS: Readonly<Record<SelectionStatus, Mark>> = {
  OPEN: mk('Open', 'track', 'open'),
  PROPOSED: mk('With the client', 'risk', 'risk'),
  APPROVED: mk('Approved', 'ready', 'ready'),
  REJECTED: mk('Declined, re-propose', 'blocked', 'blocked'),
  VOID: mk('Void', 'track', 'closed'),
};

export const METHOD_WORDS: Readonly<Record<ApprovalMethod, string>> = {
  IN_PERSON: 'In person', PORTAL: 'Client portal', EMAIL: 'Email', PHONE: 'Phone', E_SIGNATURE: 'E-signature',
};

export const ITEM_STATUS: Readonly<Record<ItemStatus, Mark>> = {
  SPECIFIED: mk('Specified', 'track', 'open'),
  PROPOSED: mk('Proposed', 'risk', 'risk'),
  APPROVED: mk('Approved', 'track', 'track'),
  ORDERED: mk('Ordered', 'track', 'track'),
  ACKNOWLEDGED: mk('Acknowledged', 'track', 'track'),
  BACK_ORDERED: mk('Back-ordered', 'risk', 'risk'),
  SHIPPED: mk('Shipped', 'track', 'track'),
  RECEIVED: mk('Received', 'track', 'track'),
  DAMAGED: mk('Damaged', 'blocked', 'blocked'),
  STORED: mk('In storage', 'track', 'soft'),
  DELIVERED: mk('Delivered', 'ready', 'ready'),
  INSTALLED: mk('Installed', 'ready', 'ready'),
  RETURNED: mk('Returned', 'track', 'closed'),
  CANCELLED: mk('Cancelled', 'track', 'closed'),
};

/** pm.advance_procurement_item moves. */
export const ITEM_NEXT: Readonly<Record<ItemStatus, ReadonlyArray<ItemStatus>>> = {
  SPECIFIED: ['PROPOSED', 'CANCELLED'],
  PROPOSED: ['APPROVED', 'SPECIFIED', 'CANCELLED'],
  APPROVED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['ACKNOWLEDGED', 'BACK_ORDERED', 'SHIPPED', 'RECEIVED', 'CANCELLED'],
  ACKNOWLEDGED: ['BACK_ORDERED', 'SHIPPED', 'RECEIVED', 'CANCELLED'],
  BACK_ORDERED: ['ACKNOWLEDGED', 'SHIPPED', 'RECEIVED', 'CANCELLED'],
  SHIPPED: ['RECEIVED', 'DAMAGED'],
  RECEIVED: ['STORED', 'DELIVERED', 'INSTALLED', 'DAMAGED'],
  DAMAGED: ['ORDERED', 'RECEIVED', 'RETURNED', 'CANCELLED'],
  STORED: ['DELIVERED', 'INSTALLED'],
  DELIVERED: ['INSTALLED', 'RETURNED'],
  INSTALLED: ['RETURNED'],
  RETURNED: [],
  CANCELLED: [],
};

/** The verb on the button that moves an item to `to`. */
export const ITEM_VERB: Readonly<Record<ItemStatus, string>> = {
  SPECIFIED: 'Back to specified', PROPOSED: 'Propose to client', APPROVED: 'Record approval', ORDERED: 'Mark ordered',
  ACKNOWLEDGED: 'Vendor acknowledged', BACK_ORDERED: 'Back-ordered', SHIPPED: 'Mark shipped', RECEIVED: 'Receive',
  DAMAGED: 'Report damage', STORED: 'Put in storage', DELIVERED: 'Mark delivered', INSTALLED: 'Mark installed',
  RETURNED: 'Return', CANCELLED: 'Cancel item',
};

/** The happy path the meter draws. */
export const ITEM_PATH: ReadonlyArray<ItemStatus> = ['SPECIFIED', 'PROPOSED', 'APPROVED', 'ORDERED', 'SHIPPED', 'RECEIVED', 'DELIVERED', 'INSTALLED'];

export const MEASURE_STATUS: Readonly<Record<MeasureStatus, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  FINAL: mk('Final', 'ready', 'ready'),
  SUPERSEDED: mk('Superseded', 'track', 'closed'),
};
export const AREA_KIND_WORDS: Readonly<Record<AreaKind, string>> = { FLOOR: 'Floor', STAIRS: 'Stairs', WALL: 'Wall', BASE: 'Base', TRANSITION: 'Transition', OTHER: 'Other' };
export const CATEGORY_WORDS_FLOOR: Readonly<Record<ProductCategory, string>> = {
  CARPET: 'Carpet', LVP: 'LVP', HARDWOOD: 'Hardwood', LAMINATE: 'Laminate', TILE: 'Tile', VINYL_SHEET: 'Sheet vinyl', RUBBER: 'Rubber', OTHER: 'Other',
};

// ---------------------------------------------------------------- development
export const UNIT_STATUS: Readonly<Record<UnitStatus, Mark>> = {
  PLANNED: mk('Planned', 'track', 'open'),
  ENTITLED: mk('Entitled', 'track', 'open'),
  AVAILABLE: mk('Available', 'track', 'track'),
  UNDER_CONSTRUCTION: mk('Under construction', 'track', 'track'),
  COMPLETE: mk('Complete', 'track', 'track'),
  UNDER_CONTRACT: mk('Under contract', 'risk', 'risk'),
  CLOSED: mk('Closed', 'ready', 'ready'),
  LEASED: mk('Leased', 'ready', 'ready'),
  HELD: mk('Held', 'track', 'soft'),
};

/** pm.set_unit_status moves. */
export const UNIT_NEXT: Readonly<Record<UnitStatus, ReadonlyArray<UnitStatus>>> = {
  PLANNED: ['ENTITLED', 'AVAILABLE', 'UNDER_CONSTRUCTION', 'HELD'],
  ENTITLED: ['AVAILABLE', 'UNDER_CONSTRUCTION', 'HELD'],
  AVAILABLE: ['UNDER_CONSTRUCTION', 'UNDER_CONTRACT', 'LEASED', 'HELD'],
  UNDER_CONSTRUCTION: ['COMPLETE', 'UNDER_CONTRACT', 'HELD'],
  COMPLETE: ['UNDER_CONTRACT', 'LEASED', 'HELD'],
  UNDER_CONTRACT: ['CLOSED', 'AVAILABLE', 'UNDER_CONSTRUCTION', 'COMPLETE'],
  HELD: ['PLANNED', 'ENTITLED', 'AVAILABLE', 'UNDER_CONSTRUCTION', 'COMPLETE'],
  LEASED: ['AVAILABLE'],
  CLOSED: [],
};

export const UNIT_KIND_WORDS: Readonly<Record<UnitKind, string>> = {
  LOT: 'Lot', SINGLE_FAMILY: 'Single family', TOWNHOME: 'Townhome', CONDO: 'Condo', APARTMENT: 'Apartment', COMMERCIAL: 'Commercial', PAD: 'Pad',
};

export const ENTITLEMENT_KIND_WORDS: Readonly<Record<EntitlementKind, string>> = {
  LAND_ACQUISITION: 'Land acquisition', ZONING: 'Zoning', SITE_PLAN: 'Site plan', PRELIMINARY_PLAT: 'Preliminary plat', FINAL_PLAT: 'Final plat',
  ENVIRONMENTAL: 'Environmental', UTILITY: 'Utility', GRADING_PERMIT: 'Grading permit', BUILDING_PERMIT: 'Building permit',
  CERTIFICATE_OF_OCCUPANCY: 'Certificate of occupancy', OTHER: 'Other',
};

export const ENTITLEMENT_STATUS: Readonly<Record<EntitlementStatus, Mark>> = {
  NOT_STARTED: mk('Not started', 'track', 'open'),
  IN_PREP: mk('In preparation', 'track', 'open'),
  SUBMITTED: mk('Submitted', 'track', 'track'),
  UNDER_REVIEW: mk('Under review', 'track', 'track'),
  HEARING_SCHEDULED: mk('Hearing scheduled', 'risk', 'risk'),
  APPROVED: mk('Approved', 'ready', 'ready'),
  APPROVED_WITH_CONDITIONS: mk('Approved with conditions', 'ready', 'ready'),
  DENIED: mk('Denied', 'blocked', 'blocked'),
  EXPIRED: mk('Expired', 'overdue', 'overdue'),
  WITHDRAWN: mk('Withdrawn', 'track', 'closed'),
};

/** pm.record_entitlement_status moves. */
export const ENTITLEMENT_NEXT: Readonly<Record<EntitlementStatus, ReadonlyArray<EntitlementStatus>>> = {
  NOT_STARTED: ['IN_PREP', 'SUBMITTED', 'WITHDRAWN'],
  IN_PREP: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['UNDER_REVIEW', 'HEARING_SCHEDULED', 'APPROVED', 'APPROVED_WITH_CONDITIONS', 'DENIED', 'WITHDRAWN'],
  UNDER_REVIEW: ['SUBMITTED', 'HEARING_SCHEDULED', 'APPROVED', 'APPROVED_WITH_CONDITIONS', 'DENIED', 'WITHDRAWN'],
  HEARING_SCHEDULED: ['UNDER_REVIEW', 'APPROVED', 'APPROVED_WITH_CONDITIONS', 'DENIED', 'WITHDRAWN'],
  DENIED: ['IN_PREP', 'SUBMITTED', 'WITHDRAWN'],
  APPROVED: ['EXPIRED'],
  APPROVED_WITH_CONDITIONS: ['EXPIRED'],
  EXPIRED: ['IN_PREP'],
  WITHDRAWN: [],
};

// ---------------------------------------------------------------- field records
export const APPROVAL_STATE: Readonly<Record<ApprovalState, Mark>> = {
  DRAFT: mk('Draft', 'track', 'open'),
  SUBMITTED: mk('Submitted', 'track', 'track'),
  APPROVED: mk('Approved', 'ready', 'ready'),
  REJECTED: mk('Rejected', 'blocked', 'blocked'),
  VOID: mk('Void', 'track', 'closed'),
};
export const PAY_TYPE_WORDS: Readonly<Record<PayType, string>> = { REG: 'Regular', OT: 'Overtime', DT: 'Double time', PIECE: 'Piece rate', FLAG: 'Flat rate' };

export const LOG_KIND_WORDS: Readonly<Record<LogKind, string>> = { DAILY: 'Daily', INSPECTION: 'Inspection', SAFETY: 'Safety', DELIVERY: 'Delivery', VISIT: 'Site visit' };

export const PUNCH_KIND_WORDS: Readonly<Record<PunchKind, string>> = { PUNCH: 'Punch', WARRANTY: 'Warranty', CALLBACK: 'Callback' };
export const PUNCH_STATUS: Readonly<Record<PunchStatus, Mark>> = {
  OPEN: mk('Open', 'track', 'open'),
  IN_PROGRESS: mk('In progress', 'track', 'track'),
  READY_FOR_REVIEW: mk('Ready for review', 'risk', 'risk'),
  CLOSED: mk('Closed', 'ready', 'ready'),
  VOID: mk('Void', 'track', 'closed'),
};

/** "Dana Lee" for an employee row. */
export function personName(e: { first_name: string; last_name: string } | null | undefined): string {
  if (!e) return 'Unassigned';
  return [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member';
}

/** Words for a status code nobody mapped (a newer migration added it). */
export function words(code: string): string {
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
