/**
 * Dealer Pack (D2, slice C) — manufacturer receivables helpers for the warranty,
 * incentive and OEM-statement screens. Pure and client-safe (no server imports).
 *
 * Row interfaces mirror migration 169 columns exactly (Rule 11); the D1 list routes
 * return whole rows with *_cents coerced to numbers. Every plain-English "what this
 * posts" sentence lives here so the screens and their tests agree.
 */

import { ROLE_SPEC, type DealerRole } from '../roles';
import type {
  ClaimEventType,
  ClaimKind,
  IncentiveStatus,
  IncentiveTreatment,
  OemLineType,
  OemMatchStatus,
  OemProgramStatus,
  OemSettlementMethod,
  OemStatementStatus,
  ProgramType,
  WarrantyRecognition,
  WarrantyStatus,
} from '../types';
import { daysBetween, money } from './format';

// ── rows (migration 169) ──────────────────────────────────────────────────────

export interface WarrantyClaimRow {
  id: string;
  org_id: string;
  location_id: string;
  oem_vendor_id: string;
  oem_claim_number: string | null;
  dealer_claim_ref: string | null;
  repair_order_ref: string | null;
  job_id: string | null;
  unit_id: string | null;
  serial_number: string | null;
  customer_id: string | null;
  failure_date: string | null;
  repair_date: string | null;
  ro_closed_date: string | null;
  submitted_date: string | null;
  filing_deadline: string | null;
  /** numeric(8,2) — PostgREST returns it as a number or string. */
  labor_hours: number | string;
  labor_rate_cents: number;
  labor_cents: number;
  parts_cost_cents: number;
  parts_markup_bps: number;
  parts_cents: number;
  sublet_cents: number;
  freight_cents: number;
  other_cents: number;
  claimed_cents: number;
  approved_cents: number | null;
  settled_cents: number;
  written_off_cents: number;
  debited_cents: number;
  status: WarrantyStatus;
  rejection_reason: string | null;
  recognized_gl_entry_id: string | null;
  gl_entry_id: string | null;
  import_batch_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncentiveClaimRow {
  id: string;
  org_id: string;
  location_id: string;
  program_id: string;
  unit_id: string | null;
  sale_id: string | null;
  claim_reference: string | null;
  earned_date: string;
  claim_deadline: string | null;
  submitted_date: string | null;
  treatment: IncentiveTreatment;
  accrual_target_role: string | null;
  accrued_cents: number;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
  status: IncentiveStatus;
  gl_entry_id: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OemProgramRecord {
  id: string;
  org_id: string;
  location_id: string;
  oem_vendor_id: string;
  program_code: string | null;
  name: string;
  program_type: ProgramType;
  treatment: IncentiveTreatment;
  paid_direct: boolean;
  start_date: string | null;
  end_date: string | null;
  claim_deadline_days: number | null;
  rules: Record<string, unknown>;
  source_document_id: string | null;
  status: OemProgramStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OemStatementRow {
  id: string;
  org_id: string;
  location_id: string;
  oem_vendor_id: string;
  statement_date: string;
  document_id: string | null;
  import_batch_id: string | null;
  footer_total_cents: number | null;
  status: OemStatementStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OemStatementLineRow {
  id: string;
  org_id: string;
  location_id: string;
  statement_id: string;
  line_number: number | null;
  line_type: OemLineType;
  reference: string | null;
  serial_number: string | null;
  description: string | null;
  amount_cents: number;
  matched_warranty_claim_id: string | null;
  matched_incentive_claim_id: string | null;
  match_status: OemMatchStatus;
  match_confidence_bps: number | null;
  ai_decision_id: string | null;
  settlement_gl_entry_id: string | null;
  created_at: string;
}

export interface ClaimEventRow {
  id: string;
  claim_kind: ClaimKind;
  warranty_claim_id: string | null;
  incentive_claim_id: string | null;
  event_type: ClaimEventType;
  event_date: string;
  amount_cents: number;
  oem_statement_line_id: string | null;
  gl_entry_id: string | null;
  actor: string | null;
  note: string | null;
  created_at: string;
}

/** POST /api/dealer/oem-statements/match proposal (engine/oem-match OemProposal). */
export interface OemMatchProposal {
  lineId: string;
  claimKind: ClaimKind;
  claimId: string;
  method: 'CLAIM_NUMBER' | 'CLAIM_NUMBER_SHORT' | 'SERIAL_AMOUNT';
  confidenceBps: number;
  shortPayCents: number;
  autoSettleEligible: boolean;
}

export interface OemMatchResponse {
  proposals: OemMatchProposal[];
  autoSettled: string[];
}

// ── open amounts ──────────────────────────────────────────────────────────────

/** Warranty open = claimed − settled − written off (engine/warranty openCents). */
export function warrantyOpenCents(c: Pick<WarrantyClaimRow, 'claimed_cents' | 'settled_cents' | 'written_off_cents'>): number {
  return c.claimed_cents - c.settled_cents - c.written_off_cents;
}

/**
 * Incentive open as the settle / write-off services compute it:
 * accrued − settled − written off (service/claims.ts incentiveOpen).
 */
export function incentiveOpenCents(c: Pick<IncentiveClaimRow, 'accrued_cents' | 'settled_cents' | 'written_off_cents'>): number {
  return c.accrued_cents - c.settled_cents - c.written_off_cents;
}

/** ISO date ± whole days, computed in UTC (no TZ drift). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Hours as a two-decimal number (labor_hours is numeric → may arrive as a string). */
export function hoursNumber(h: number | string | null | undefined): number {
  const n = typeof h === 'string' ? Number(h) : h ?? 0;
  return Number.isFinite(n) ? n : 0;
}

// ── aging / deadlines (DL-5, DL-7) ────────────────────────────────────────────

export interface AgingFlag {
  tone: 'danger' | 'warning';
  label: string;
}

export interface AgingResult {
  /** Days since submission (submitted claims) — null otherwise. */
  daysOutstanding: number | null;
  flag: AgingFlag | null;
}

const WARRANTY_AWAITING: readonly WarrantyStatus[] = ['SUBMITTED', 'PARTIAL', 'RESUBMITTED'];

/**
 * DL-5: a DRAFT within `warranty_deadline_warn_days` of its filing deadline (or past it)
 * is red; a submitted claim unpaid longer than `warranty_submitted_aging_days` is amber.
 */
export function warrantyAging(
  row: Pick<WarrantyClaimRow, 'status' | 'filing_deadline' | 'submitted_date'>,
  s: { warranty_deadline_warn_days: number; warranty_submitted_aging_days: number },
  today: string,
): AgingResult {
  if (row.status === 'DRAFT') {
    const left = daysBetween(today, row.filing_deadline);
    if (left === null) return { daysOutstanding: null, flag: null };
    if (left < 0) return { daysOutstanding: null, flag: { tone: 'danger', label: `Filing deadline passed ${-left} day${left === -1 ? '' : 's'} ago` } };
    if (left === 0) return { daysOutstanding: null, flag: { tone: 'danger', label: 'File today — deadline' } };
    if (left <= s.warranty_deadline_warn_days) return { daysOutstanding: null, flag: { tone: 'danger', label: `File within ${left} day${left === 1 ? '' : 's'}` } };
    return { daysOutstanding: null, flag: null };
  }
  if (WARRANTY_AWAITING.includes(row.status)) {
    const days = daysBetween(row.submitted_date, today);
    if (days === null) return { daysOutstanding: null, flag: null };
    if (days > s.warranty_submitted_aging_days) return { daysOutstanding: days, flag: { tone: 'warning', label: `Unpaid ${days} days` } };
    return { daysOutstanding: days, flag: null };
  }
  return { daysOutstanding: null, flag: null };
}

/**
 * DL-7: an earned incentive not yet claimed is amber within `incentive_deadline_warn_days`
 * of its claim deadline and red in the last few days / once passed; a claimed incentive
 * unpaid longer than `incentive_submitted_aging_days` is amber.
 */
export function incentiveAging(
  row: Pick<IncentiveClaimRow, 'status' | 'claim_deadline' | 'submitted_date'>,
  s: { incentive_deadline_warn_days: number; incentive_submitted_aging_days: number },
  today: string,
): AgingResult {
  if (row.status === 'ACCRUED' || row.status === 'REJECTED') {
    const left = daysBetween(today, row.claim_deadline);
    if (left === null) return { daysOutstanding: null, flag: null };
    if (left < 0) return { daysOutstanding: null, flag: { tone: 'danger', label: `Claim deadline passed ${-left} day${left === -1 ? '' : 's'} ago` } };
    const red = Math.max(1, Math.ceil(s.incentive_deadline_warn_days / 3));
    if (left <= red) return { daysOutstanding: null, flag: { tone: 'danger', label: left === 0 ? 'Claim today — deadline' : `Claim within ${left} day${left === 1 ? '' : 's'}` } };
    if (left <= s.incentive_deadline_warn_days) return { daysOutstanding: null, flag: { tone: 'warning', label: `Claim within ${left} days` } };
    return { daysOutstanding: null, flag: null };
  }
  if (row.status === 'SUBMITTED' || row.status === 'PARTIAL') {
    const days = daysBetween(row.submitted_date, today);
    if (days === null) return { daysOutstanding: null, flag: null };
    if (days > s.incentive_submitted_aging_days) return { daysOutstanding: days, flag: { tone: 'warning', label: `Unpaid ${days} days` } };
    return { daysOutstanding: days, flag: null };
  }
  return { daysOutstanding: null, flag: null };
}

// ── available actions by status ───────────────────────────────────────────────

export type WarrantyAction =
  | 'EDIT'
  | 'RO_CLOSE'
  | 'SUBMIT'
  | 'SETTLE'
  | 'ACCEPT_SHORT_PAY'
  | 'WRITE_OFF'
  | 'REJECTED_BY_OEM'
  | 'RESUBMIT'
  | 'DEBIT';

/** Actions the D1 services accept for a claim in this state (mirrors service/claims.ts guards). */
export function warrantyActions(row: Pick<WarrantyClaimRow, 'status' | 'ro_closed_date' | 'claimed_cents' | 'settled_cents' | 'written_off_cents'>): WarrantyAction[] {
  const open = warrantyOpenCents(row);
  switch (row.status) {
    case 'DRAFT':
      return row.ro_closed_date ? ['EDIT', 'SUBMIT'] : ['EDIT', 'RO_CLOSE', 'SUBMIT'];
    case 'SUBMITTED':
    case 'RESUBMITTED':
      return open > 0 ? ['SETTLE', 'REJECTED_BY_OEM', 'WRITE_OFF'] : [];
    case 'PARTIAL': {
      const out: WarrantyAction[] = [];
      if (open > 0) out.push('SETTLE');
      if (open > 0 && row.settled_cents > 0) out.push('ACCEPT_SHORT_PAY');
      if (open > 0 && row.settled_cents === 0) out.push('WRITE_OFF');
      out.push('RESUBMIT', 'REJECTED_BY_OEM', 'DEBIT');
      return out;
    }
    case 'REJECTED':
      return open > 0 ? ['RESUBMIT', 'WRITE_OFF'] : ['RESUBMIT'];
    case 'PAID':
    case 'WRITTEN_OFF':
    case 'DEBITED':
      return ['DEBIT'];
    default:
      return [];
  }
}

/** Approver-only warranty actions (parts & service manager) — mirror warrantyResolutionNeedsApproval. */
export const WARRANTY_APPROVER_ACTIONS: readonly WarrantyAction[] = ['ACCEPT_SHORT_PAY', 'WRITE_OFF', 'DEBIT'];

export type IncentiveAction = 'SUBMIT' | 'SETTLE' | 'WRITE_OFF' | 'REJECTED_BY_OEM';

export function incentiveActions(row: Pick<IncentiveClaimRow, 'status' | 'accrued_cents' | 'settled_cents' | 'written_off_cents' | 'accrual_target_role'>): IncentiveAction[] {
  const open = incentiveOpenCents(row);
  const canWriteOff = open > 0 && !!row.accrual_target_role;
  switch (row.status) {
    case 'ACCRUED':
      return [...(open > 0 ? (['SUBMIT', 'SETTLE'] as IncentiveAction[]) : (['SUBMIT'] as IncentiveAction[])), ...(canWriteOff ? (['WRITE_OFF'] as IncentiveAction[]) : [])];
    case 'SUBMITTED':
    case 'PARTIAL':
      return [...(open > 0 ? (['SETTLE'] as IncentiveAction[]) : []), 'REJECTED_BY_OEM', ...(canWriteOff ? (['WRITE_OFF'] as IncentiveAction[]) : [])];
    case 'REJECTED':
      return ['SUBMIT', ...(canWriteOff ? (['WRITE_OFF'] as IncentiveAction[]) : [])];
    default:
      return [];
  }
}

// ── plain-English GL effect sentences ─────────────────────────────────────────

function roleLabel(role: string): string {
  const spec = ROLE_SPEC[role as DealerRole];
  return spec ? spec.label.charAt(0).toLowerCase() + spec.label.slice(1) : 'the original account';
}

export function settlementEffect(input: {
  receivable: 'warranty' | 'incentive';
  amountCents: number;
  openCents: number;
  method: OemSettlementMethod;
  manufacturer?: string | null;
}): string {
  const who = input.manufacturer || 'the manufacturer';
  const rec = input.receivable === 'warranty' ? 'warranty claims receivable' : 'manufacturer incentives receivable';
  const head =
    input.method === 'STATEMENT_CREDIT'
      ? `Reduces what you owe ${who} (accounts payable) by ${money(input.amountCents)} and lowers the ${rec} by the same amount.`
      : `Records ${money(input.amountCents)} received in the operating bank and lowers the ${rec} by the same amount.`;
  const left = input.openCents - input.amountCents;
  if (left > 0) {
    return `${head} ${money(left)} stays open — the claim is partly paid until ${input.receivable === 'warranty' ? 'a manager accepts the short-pay, resubmits it, or more money arrives' : 'the rest arrives or it is written off'}.`;
  }
  return `${head} This pays the claim in full.`;
}

export function warrantySubmitEffect(input: {
  claim: Pick<WarrantyClaimRow, 'labor_cents' | 'parts_cents' | 'sublet_cents' | 'freight_cents' | 'other_cents' | 'claimed_cents' | 'parts_cost_cents' | 'recognized_gl_entry_id'>;
  relieveParts: boolean;
  manufacturer?: string | null;
}): string {
  const c = input.claim;
  if (c.recognized_gl_entry_id) {
    return 'The receivable was already booked when the repair order closed, so nothing more posts — this records the submission date and starts the aging clock.';
  }
  const laborSide = c.labor_cents + c.sublet_cents + c.freight_cents + c.other_cents;
  const parts =
    input.relieveParts && c.parts_cost_cents > 0
      ? ` It also moves ${money(c.parts_cost_cents)} of parts from parts inventory to parts cost of sales.`
      : '';
  return `Books a ${money(c.claimed_cents)} receivable from ${input.manufacturer || 'the manufacturer'}: ${money(laborSide)} warranty labor sales (Service) and ${money(c.parts_cents)} warranty parts sales (Parts).${parts}`;
}

export function warrantyRoCloseEffect(recognition: WarrantyRecognition, alreadyRecognized: boolean): string {
  if (recognition === 'ON_RO_CLOSE') {
    return alreadyRecognized
      ? 'Records the repair-order close date. The receivable is already booked, so nothing more posts.'
      : 'This client books warranty when the repair order closes, so closing it books the receivable and warranty sales now (before submission).';
  }
  return 'Records the repair-order close date only. This client books warranty when the claim is submitted, so nothing posts until then.';
}

export function warrantyResolveEffect(action: Exclude<WarrantyAction, 'EDIT' | 'RO_CLOSE' | 'SUBMIT' | 'SETTLE'>, input: { openCents: number; debitCents?: number | null; manufacturer?: string | null }): string {
  const who = input.manufacturer || 'the manufacturer';
  switch (action) {
    case 'ACCEPT_SHORT_PAY':
      return `Books the ${money(input.openCents)} shortfall to warranty policy expense (Service) and closes the claim as paid.`;
    case 'WRITE_OFF':
      return `Books the open ${money(input.openCents)} to warranty policy expense (Service) and closes the claim. Nothing more is expected from ${who}.`;
    case 'REJECTED_BY_OEM':
      return `Marks the claim rejected. Nothing posts — the ${money(input.openCents)} stays in the receivable until you resubmit it or write it off.`;
    case 'RESUBMIT':
      return `Marks the claim resubmitted for the open ${money(input.openCents)}. Nothing posts; the aging clock restarts today.`;
    case 'DEBIT':
      return input.debitCents && input.debitCents > 0
        ? `Books a ${money(input.debitCents)} chargeback to warranty policy expense (Service) and adds it to what you owe ${who} (accounts payable).`
        : `Books the chargeback to warranty policy expense (Service) and adds it to what you owe ${who} (accounts payable).`;
  }
}

/** What writing off an incentive reverses (into the account the accrual credited). */
export function incentiveWriteOffEffect(input: { targetRole: string | null; openCents: number; unitInStock: boolean }): string {
  if (!input.targetRole) return 'The account this incentive was booked to is unknown — write it off with a manual journal entry instead.';
  const inventory = input.targetRole === 'WHOLE_GOODS_INVENTORY' || input.targetRole === 'USED_WHOLE_GOODS_INVENTORY' || input.targetRole === 'RENTAL_INVENTORY';
  if (inventory) {
    return input.unitInStock
      ? `Reverses the ${money(input.openCents)} rebate: the unit’s cost goes back up by ${money(input.openCents)} (${roleLabel(input.targetRole)}) and the incentive receivable comes down.`
      : `Reverses the ${money(input.openCents)} rebate into the unit’s cost of sales (it has sold since) and lowers the incentive receivable.`;
  }
  return `Reverses ${money(input.openCents)} back into ${roleLabel(input.targetRole)} — the account the incentive was credited to — and lowers the incentive receivable.`;
}

/** What recording an earned incentive will book, from the engine's target role. */
export function incentiveAccrualEffect(input: { targetRole: string; amountCents: number; unitCostReductionCents: number }): string {
  const amt = money(input.amountCents);
  if (input.unitCostReductionCents > 0) {
    return `Books ${amt} owed by the manufacturer (incentives receivable) and lowers the unit’s cost by ${amt} while it is in stock.`;
  }
  if (input.targetRole === 'ACCRUED_EXPENSES') {
    return `Books ${amt} owed by the manufacturer and the same amount owed on to staff (accrued expenses) — it is not dealer income.`;
  }
  return `Books ${amt} owed by the manufacturer (incentives receivable) and credits ${roleLabel(input.targetRole)}.`;
}

// ── OEM statements ────────────────────────────────────────────────────────────

/** Which claim kind a statement line can settle (credits only). */
export function lineClaimKind(lineType: OemLineType): ClaimKind | null {
  if (lineType === 'WARRANTY_CREDIT') return 'WARRANTY';
  if (lineType === 'INCENTIVE_CREDIT') return 'INCENTIVE';
  return null;
}

/**
 * A suggestion persisted on the line by an earlier "Find matches" run (match_status
 * PROPOSED + matched claim + confidence). The method isn't stored; the engine's
 * confidence per method is fixed (oem-match CONFIDENCE), so it is recovered from it.
 */
export function proposalFromLine(
  line: Pick<OemStatementLineRow, 'id' | 'match_status' | 'matched_warranty_claim_id' | 'matched_incentive_claim_id' | 'match_confidence_bps' | 'amount_cents'>,
  claimOpenCents: number | null,
): OemMatchProposal | null {
  if (line.match_status !== 'PROPOSED') return null;
  const claimId = line.matched_warranty_claim_id ?? line.matched_incentive_claim_id;
  if (!claimId) return null;
  const bps = line.match_confidence_bps ?? 0;
  const method: OemMatchProposal['method'] = bps >= 10_000 ? 'CLAIM_NUMBER' : bps >= 9_000 ? 'CLAIM_NUMBER_SHORT' : 'SERIAL_AMOUNT';
  const shortPay = claimOpenCents !== null ? Math.max(0, claimOpenCents - line.amount_cents) : 0;
  return {
    lineId: line.id,
    claimKind: line.matched_warranty_claim_id ? 'WARRANTY' : 'INCENTIVE',
    claimId,
    method,
    confidenceBps: bps,
    shortPayCents: shortPay,
    autoSettleEligible: false,
  };
}

/** Plain-English explanation of how a suggestion was found. */
export const MATCH_METHOD_EXPLAINED: Record<OemMatchProposal['method'], string> = {
  CLAIM_NUMBER: 'Same claim number and the exact open amount',
  CLAIM_NUMBER_SHORT: 'Same claim number, but the manufacturer paid less than is open',
  SERIAL_AMOUNT: 'No claim number — same serial number and the exact open amount',
};

export interface FootingCheck {
  linesTotalCents: number;
  differenceCents: number;
  foots: boolean;
}

/** Statement lines (signed) must sum to the footer total (service importOemStatement). */
export function footing(lines: Array<{ amountCents: number | null }>, footerCents: number | null): FootingCheck {
  const total = lines.reduce((s, l) => s + (l.amountCents ?? 0), 0);
  const diff = (footerCents ?? 0) - total;
  return { linesTotalCents: total, differenceCents: diff, foots: footerCents !== null && diff === 0 && lines.every((l) => l.amountCents !== null) };
}

// ── DL-6: manufacturer rejection rate ─────────────────────────────────────────

/** FPB §6 DL-6: an OEM rejecting more than 10% of claims over 90 days. */
export const REJECTION_RATE_WARN_BPS = 1000;
export const REJECTION_WINDOW_DAYS = 90;

export interface OemRejectionRate {
  oemVendorId: string;
  submitted: number;
  rejected: number;
  rateBps: number;
  flagged: boolean;
}

/**
 * Rejection rate per manufacturer from claim events in the window: distinct claims
 * rejected ÷ distinct claims submitted or resubmitted. Pure (the overview route feeds it).
 */
export function rejectionRates(events: Array<{ claimId: string; oemVendorId: string; type: string }>): OemRejectionRate[] {
  const by = new Map<string, { sub: Set<string>; rej: Set<string> }>();
  for (const e of events) {
    const b = by.get(e.oemVendorId) ?? { sub: new Set<string>(), rej: new Set<string>() };
    if (e.type === 'SUBMITTED' || e.type === 'RESUBMITTED') b.sub.add(e.claimId);
    if (e.type === 'REJECTED') {
      b.rej.add(e.claimId);
      b.sub.add(e.claimId);
    }
    by.set(e.oemVendorId, b);
  }
  return [...by.entries()]
    .map(([oemVendorId, b]) => {
      const submitted = b.sub.size;
      const rejected = b.rej.size;
      const rateBps = submitted > 0 ? Math.round((rejected * 10_000) / submitted) : 0;
      return { oemVendorId, submitted, rejected, rateBps, flagged: rejected > 0 && rateBps > REJECTION_RATE_WARN_BPS };
    })
    .sort((a, b) => b.rateBps - a.rateBps);
}

/** GET /api/dealer/claims-overview response. */
export interface ClaimsOverview {
  counts: Record<string, number>;
  total: number;
  /** Σ open on open claims (v_warranty_aging / v_incentive_aging). */
  openCents: number;
  openCount: number;
  /** Submitted / claimed and unpaid past the client's aging setting (amber). */
  overdue: { count: number; cents: number };
  /** Drafts / unclaimed near (or past) their filing / claim deadline (red). */
  deadline: { count: number; cents: number };
  /** Warranty only: DL-6 rejection rate per manufacturer, last 90 days. */
  rejection: OemRejectionRate[];
}
