/**
 * What the v2 phone command handlers need from the database, as an interface: phone-store.ts runs
 * every call on the caller's RLS client (guarded definer RPCs of 1113 / 1114 / 1115 / 1117 / 1122;
 * esign.sign on the anon key, token-scoped). Tests use an in-memory one. Nothing here reads a cost,
 * a rate or a margin.
 */
import type { KIOSK_ACTIONS, RO_INDIRECT } from './phone-contract';

/** An approval request as the approver sees it (pm.approval_request_detail; money not read). */
export interface ApprovalSnapshot {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  round: number;
  step: number;
  canAct: boolean;
  title: string;
  history: Array<{ decision: string; round: number; step: number | null; actor: string; channel: string; at: string }>;
}

export interface ApprovalActResult {
  status: string;
  message?: string | null;
  waitingOn?: string | null;
}

export interface KioskEventRow {
  client_event_id: string;
  session_token: string;
  action: (typeof KIOSK_ACTIONS)[number];
  operation_id: string | null;
  good_qty: number | null;
  scrap_qty: number | null;
  qty: number | null;
  reason: string | null;
  indirect_code: string | null;
  part_label: string | null;
  remake_reason: string | null;
  at: string;
}

export interface KioskEventResult {
  ok: boolean;
  replay?: boolean;
  error?: string;
  code?: string;
}

export interface RoLineRef {
  lineId: string;
  workOrderId: string;
  jobId: string;
  companyId: string;
  number: string | null;
}

export interface WorkOrderRef {
  id: string;
  jobId: string;
  companyId: string;
  number: string | null;
  kind: string;
}

export interface OpenTechPunch {
  lineId: string | null;
  kind: string;
  indirectKind: string | null;
  startedAt: string;
}

export type RoIndirectKind = (typeof RO_INDIRECT)[number];

/** esign.open / sign answer (lib/esign/types PublicSignState, the fields the handler reads). */
export interface SignAnswer {
  ok: boolean;
  reason: string | null;
}

export interface FsEstimateRef {
  id: string;
  companyId: string;
  jobId: string;
  workOrderId: string | null;
  number: string | null;
  status: 'DRAFT' | 'PRESENTED' | 'SOLD' | 'DECLINED' | 'EXPIRED';
  soldOptionIds: string[];
}

export interface FsSellArgs {
  estimateId: string;
  optionIds: string[];
  signedName: string;
  dismissReason: string | null;
  joinTemplateId: string | null;
  depositCents: number;
  requestDeposit: boolean;
  depositRef: string | null;
  financingPlanId: string | null;
  signatureDocumentId: string | null;
}

export interface FsSellResult {
  lines: number;
  agreementId: string | null;
  depositRequestId: string | null;
  memberPricing: boolean;
}

export interface PhoneStore {
  approval(requestId: string): Promise<ApprovalSnapshot | null>;
  actApproval(requestId: string, decision: 'approve' | 'reject', o: { reason: string | null; selfReason: string | null }): Promise<ApprovalActResult>;
  markNotifications(ids: ReadonlyArray<string>, state: 'read' | 'done'): Promise<number>;
  kioskEvents(companyId: string, events: KioskEventRow[]): Promise<KioskEventResult[]>;
  roLine(lineId: string): Promise<RoLineRef | null>;
  workOrder(id: string): Promise<WorkOrderRef | null>;
  /** My open tech punch at the store (own rows only), or null. */
  roOpenPunch(companyId: string): Promise<OpenTechPunch | null>;
  /** `at` = when the tech tapped on the phone (pm.dlr_clock_* p_at / p_end_at, 1125: bounded, own punch). */
  roClockOn(lineId: string, at: string): Promise<void>;
  roClockOff(companyId: string, at: string): Promise<{ open: boolean }>;
  roIndirect(companyId: string, kind: RoIndirectKind, at: string): Promise<void>;
  esignSign(token: string, input: { typedName: string; signaturePng: string }, meta: { ip: string | null; userAgent: string | null }): Promise<SignAnswer>;
  fsEstimate(id: string): Promise<FsEstimateRef | null>;
  fsToggle(itemId: string, selected: boolean): Promise<void>;
  fsSell(a: FsSellArgs): Promise<FsSellResult>;
  fsDecline(estimateId: string, reason: string): Promise<void>;
}
