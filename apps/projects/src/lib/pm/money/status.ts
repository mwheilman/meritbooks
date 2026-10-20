/**
 * Status words and marks for the money records. Status is never colour alone: a pip
 * shape plus the word. Pure (unit-tested).
 */
import type { PipKind, StatusKind } from '@meritbooks/merit-ui';
import type {
  BillingStatus, BillingSubtype, BillingType, CommitmentStatus, ComplianceDocType, ComplianceStatus, EstimateStatus, SeamAlarm, SuppressedReason,
} from './types';

export interface Mark { kind: StatusKind; pip: PipKind; word: string }

export function estimateMark(s: EstimateStatus): Mark {
  switch (s) {
    case 'DRAFT': return { kind: 'track', pip: 'open', word: 'Draft' };
    case 'SENT': return { kind: 'risk', pip: 'risk', word: 'With the customer' };
    case 'ACCEPTED': return { kind: 'ready', pip: 'ready', word: 'Accepted' };
    case 'DECLINED': return { kind: 'blocked', pip: 'blocked', word: 'Declined' };
    case 'SUPERSEDED': return { kind: 'track', pip: 'closed', word: 'Superseded' };
  }
}

export function commitmentMark(s: CommitmentStatus, holdEffective = false): Mark {
  if (holdEffective && (s === 'APPROVED' || s === 'EXECUTED')) return { kind: 'blocked', pip: 'blocked', word: 'On payment hold' };
  switch (s) {
    case 'DRAFT': return { kind: 'track', pip: 'open', word: 'Draft' };
    case 'APPROVED': return { kind: 'ready', pip: 'track', word: 'Approved' };
    case 'EXECUTED': return { kind: 'ready', pip: 'ready', word: 'Signed' };
    case 'CLOSED': return { kind: 'track', pip: 'closed', word: 'Closed' };
    case 'VOID': return { kind: 'track', pip: 'closed', word: 'Void' };
  }
}

/**
 * Billing request status. DRAFT → EMITTED (event pending in Merit Books) → ISSUED with
 * the Books invoice number, or REJECTED with the Books error. UNISSUED = approved where
 * nothing is sent (no Merit Books, or a sample job).
 */
export function billingMark(s: BillingStatus, suppressed: SuppressedReason | null = null): Mark {
  switch (s) {
    case 'DRAFT': return { kind: 'track', pip: 'open', word: 'Draft' };
    case 'EMITTED': return { kind: 'track', pip: 'soft', word: 'Waiting on Merit Books' };
    case 'ISSUED': return { kind: 'ready', pip: 'ready', word: 'Issued' };
    case 'REJECTED': return { kind: 'blocked', pip: 'blocked', word: 'Rejected by Merit Books' };
    case 'UNISSUED': return { kind: 'track', pip: 'closed', word: suppressed === 'SAMPLE' ? 'Sample, not sent' : 'Approved, not sent' };
    case 'VOID': return { kind: 'track', pip: 'closed', word: 'Void' };
  }
}

/** Why an approved request did not reach Merit Books, in one honest sentence. */
export function unissuedSentence(reason: SuppressedReason | null): string {
  return reason === 'SAMPLE'
    ? 'This is a sample job, so nothing is sent to Merit Books. Remove the sample data when you are ready.'
    : 'Merit Books is not on for this workspace, so nothing is invoiced from here. The request is approved and counts toward billed to date; send the invoice from your own system.';
}

export function billingKindLabel(r: { billing_type: BillingType | null; billing_subtype: BillingSubtype | null; application_no: number | null; kind?: 'BILLING' | 'DEPOSIT' }): string {
  if (r.kind === 'DEPOSIT') return 'Deposit';
  switch (r.billing_subtype) {
    case 'SOV': return r.application_no ? `Pay application #${r.application_no}` : 'Pay application';
    case 'RETAINAGE_RELEASE': return 'Retainage release';
    case 'ALLOWANCE': return 'Allowance overage';
    case 'FIXED': return 'Fixed amount';
    case 'RECURRING': return 'Recurring';
    default: break;
  }
  switch (r.billing_type) {
    case 'PROGRESS': return 'Progress';
    case 'MILESTONE': return 'Milestones';
    case 'TIME_MATERIALS': return 'Time & materials';
    case 'DRAW': return 'Draw';
    default: return 'Billing';
  }
}

export const COMPLIANCE_DOC_LABELS: Readonly<Record<ComplianceDocType, string>> = {
  COI: 'Certificate of insurance',
  LIEN_WAIVER_CONDITIONAL: 'Conditional lien waiver',
  LIEN_WAIVER_UNCONDITIONAL: 'Unconditional lien waiver',
  LIEN_WAIVER_FINAL: 'Final lien waiver',
  W9: 'W-9',
  CERTIFIED_PAYROLL: 'Certified payroll',
  OTHER: 'Other document',
};

/** A compliance doc as of a date: VERIFIED but past its expiry reads as expired. */
export function complianceMark(d: { status: ComplianceStatus; expires_on: string | null; required: boolean }, today: string, soonDays = 30): Mark & { ok: boolean; expiringSoon: boolean } {
  const expired = d.status === 'EXPIRED' || (d.status === 'VERIFIED' && d.expires_on != null && d.expires_on < today);
  if (expired) return { kind: 'overdue', pip: 'overdue', word: 'Expired', ok: !d.required, expiringSoon: false };
  if (d.status === 'VERIFIED') {
    const soon = d.expires_on != null && daysFrom(today, d.expires_on) <= soonDays;
    return soon ? { kind: 'risk', pip: 'risk', word: 'Expires soon', ok: true, expiringSoon: true } : { kind: 'ready', pip: 'ready', word: 'Verified', ok: true, expiringSoon: false };
  }
  if (d.status === 'RECEIVED') return { kind: 'risk', pip: 'soft', word: 'Received, not verified', ok: !d.required, expiringSoon: false };
  if (d.status === 'REJECTED') return { kind: 'blocked', pip: 'blocked', word: 'Rejected', ok: !d.required, expiringSoon: false };
  return { kind: 'blocked', pip: 'open', word: 'Missing', ok: !d.required, expiringSoon: false };
}

function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export const SEAM_EVENT_LABELS: Readonly<Record<string, string>> = {
  JOB_BILLING: 'Billing requests',
  JOB_DEPOSIT_REQUEST: 'Deposit requests',
  JOB_PROGRESS: 'Contract and progress',
  JOB_COMMITMENT: 'Commitments',
  JOB_COST: 'Job cost from Merit Books',
  JOB_TIME: 'Time',
  JOB_MATERIAL: 'Materials',
  JOB_PAYABLE_REQUEST: 'Payable requests',
};

/** "2 h", "3 d", "45 min" from minutes. */
export function ageWords(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/** The seam-health headline for the worst alarm, in plain language. */
export function seamSentence(worst: SeamAlarm, pending: number, oldestMinutes: number | null): string {
  if (pending === 0) return 'Nothing is waiting on Merit Books.';
  const age = ageWords(oldestMinutes);
  if (worst === 'ALARM') return `Merit Books has not picked up ${pending === 1 ? 'one record' : `${pending} records`} for more than a day (oldest ${age}). Bills, costs and invoices from these are not in the ledger yet; tell your Merit Books administrator.`;
  if (worst === 'WARN') return `${pending === 1 ? 'One record has' : `${pending} records have`} waited more than an hour (oldest ${age}). Merit Books usually catches up within the hour.`;
  return `${pending === 1 ? 'One record is' : `${pending} records are`} on the way to Merit Books (oldest ${age}).`;
}

export function worstAlarm(alarms: ReadonlyArray<SeamAlarm>): SeamAlarm {
  if (alarms.includes('ALARM')) return 'ALARM';
  if (alarms.includes('WARN')) return 'WARN';
  return 'OK';
}
