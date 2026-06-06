/**
 * GATE 12 — money-movement approval engine (Books-owned, lift-friendly).
 *
 * Generic approval lifecycle for every money movement (AR refunds, AP
 * disbursements/batches, payroll runs). Two guarantees:
 *   1. preparer != approver — enforced by a DB CHECK (migration 042) AND here.
 *   2. who-may-approve — role authorization. Per the Core ruling this depends on
 *      core.users / core.memberships / core.roles, which are SPECCED BUT NOT
 *      BUILT. So canApprove() FAILS CLOSED: until that identity authority exists
 *      (or an interim membership source is deliberately wired), no one is
 *      authorized to approve, and releases are blocked. This is intentional —
 *      it prevents an insecure "anyone can release money" path. Records,
 *      transitions, and the audit trail all function now.
 *
 * Every transition appends an immutable approval_steps row (actor, timestamp,
 * before/after, provider_correlation_id). Call with the admin Supabase client;
 * the acting user id (Clerk) is passed explicitly by the route.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ApprovalKind = 'AR_REFUND' | 'AP_DISBURSEMENT' | 'AP_BATCH' | 'PAYROLL_RUN';
export type ApprovalStatus =
  | 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'RELEASED' | 'SETTLED' | 'REJECTED' | 'RETURNED';

const VALID_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'REJECTED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['RELEASED', 'REJECTED'],
  RELEASED: ['SETTLED', 'RETURNED'],
  SETTLED: [],
  REJECTED: [],
  RETURNED: [],
};

export interface Approval {
  id: string;
  orgId: string;
  kind: ApprovalKind;
  subjectTable: string;
  subjectId: string;
  amountCents: number | null;
  status: ApprovalStatus;
  preparedBy: string;
  approvedBy: string | null;
  releasedBy: string | null;
  providerCorrelationId: string | null;
  rejectReason: string | null;
}

interface ApprovalRow {
  id: string;
  org_id: string;
  kind: ApprovalKind;
  subject_table: string;
  subject_id: string;
  amount_cents: number | null;
  status: ApprovalStatus;
  prepared_by: string;
  approved_by: string | null;
  released_by: string | null;
  provider_correlation_id: string | null;
  reject_reason: string | null;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id, orgId: r.org_id, kind: r.kind, subjectTable: r.subject_table, subjectId: r.subject_id,
    amountCents: r.amount_cents, status: r.status, preparedBy: r.prepared_by, approvedBy: r.approved_by,
    releasedBy: r.released_by, providerCorrelationId: r.provider_correlation_id, rejectReason: r.reject_reason,
  };
}

async function logStep(
  adminDb: SupabaseClient,
  orgId: string,
  approvalId: string,
  action: string,
  actor: string,
  before: ApprovalStatus | null,
  after: ApprovalStatus | null,
  opts?: { providerCorrelationId?: string | null; note?: string },
): Promise<void> {
  await adminDb.from('approval_steps').insert({
    org_id: orgId,
    approval_id: approvalId,
    action,
    actor,
    before_state: before,
    after_state: after,
    provider_correlation_id: opts?.providerCorrelationId ?? null,
    note: opts?.note ?? null,
  });
}

/**
 * Role authorization — FAILS CLOSED. Consults core.memberships/core.roles for a
 * payment-approval permission; if that authority is unavailable (tables not yet
 * built), returns false. Do not replace this with a Books-private scheme that
 * won't reconcile to core.memberships at merge.
 */
export async function canApprove(adminDb: SupabaseClient, orgId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await adminDb
      .schema('core')
      .from('memberships')
      .select('role:roles(permissions)')
      .eq('org_id', orgId)
      .eq('clerk_user_id', userId);
    if (error) return false; // tables/columns not present -> fail closed
    const rows = (data ?? []) as Array<{ role?: { permissions?: Record<string, boolean> } | null }>;
    return rows.some((r) => r.role?.permissions?.approve_money_movement === true);
  } catch {
    return false; // schema absent -> fail closed
  }
}

export async function createApproval(
  adminDb: SupabaseClient,
  orgId: string,
  input: { kind: ApprovalKind; subjectTable: string; subjectId: string; amountCents?: number | null; preparedBy: string; metadata?: Record<string, unknown> },
): Promise<Approval> {
  const { data, error } = await adminDb
    .from('approvals')
    .insert({
      org_id: orgId,
      kind: input.kind,
      subject_table: input.subjectTable,
      subject_id: input.subjectId,
      amount_cents: input.amountCents ?? null,
      status: 'DRAFT',
      prepared_by: input.preparedBy,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  const approval = toApproval(data as ApprovalRow);
  await logStep(adminDb, orgId, approval.id, 'PREPARED', input.preparedBy, null, 'DRAFT');
  return approval;
}

async function getApproval(adminDb: SupabaseClient, orgId: string, approvalId: string): Promise<Approval> {
  const { data, error } = await adminDb.from('approvals').select('*').eq('org_id', orgId).eq('id', approvalId).single();
  if (error) throw new Error(error.message);
  return toApproval(data as ApprovalRow);
}

function assertTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid approval transition ${from} -> ${to}`);
  }
}

export async function submitForApproval(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'PENDING_APPROVAL');
  const { error } = await adminDb.from('approvals').update({ status: 'PENDING_APPROVAL' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(adminDb, orgId, approvalId, 'SUBMITTED', actor, a.status, 'PENDING_APPROVAL');
  return { ...a, status: 'PENDING_APPROVAL' };
}

export class NotAuthorizedToApproveError extends Error {
  constructor() { super('Not authorized to approve money movement. Approval authority requires Core identity (core.memberships/roles), which is not yet available.'); this.name = 'NotAuthorizedToApproveError'; }
}
export class SeparationOfDutiesError extends Error {
  constructor() { super('The approver cannot be the preparer (separation of duties).'); this.name = 'SeparationOfDutiesError'; }
}

export async function approve(adminDb: SupabaseClient, orgId: string, approvalId: string, approverId: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'APPROVED');
  if (approverId === a.preparedBy) throw new SeparationOfDutiesError();
  if (!(await canApprove(adminDb, orgId, approverId))) throw new NotAuthorizedToApproveError();

  const { error } = await adminDb
    .from('approvals')
    .update({ status: 'APPROVED', approved_by: approverId })
    .eq('org_id', orgId)
    .eq('id', approvalId);
  if (error) throw new Error(error.message); // DB CHECK also guards preparer != approver
  await logStep(adminDb, orgId, approvalId, 'APPROVED', approverId, a.status, 'APPROVED');
  return { ...a, status: 'APPROVED', approvedBy: approverId };
}

export async function reject(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, reason: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'REJECTED');
  const { error } = await adminDb.from('approvals').update({ status: 'REJECTED', reject_reason: reason }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(adminDb, orgId, approvalId, 'REJECTED', actor, a.status, 'REJECTED', { note: reason });
  return { ...a, status: 'REJECTED', rejectReason: reason };
}

/** Record that the actual money movement was triggered (after APPROVED). */
export async function markReleased(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, providerCorrelationId: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'RELEASED');
  const { error } = await adminDb
    .from('approvals')
    .update({ status: 'RELEASED', released_by: actor, provider_correlation_id: providerCorrelationId })
    .eq('org_id', orgId)
    .eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(adminDb, orgId, approvalId, 'RELEASED', actor, a.status, 'RELEASED', { providerCorrelationId });
  return { ...a, status: 'RELEASED', releasedBy: actor, providerCorrelationId };
}

export async function markSettled(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'SETTLED');
  const { error } = await adminDb.from('approvals').update({ status: 'SETTLED' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(adminDb, orgId, approvalId, 'SETTLED', actor, a.status, 'SETTLED');
  return { ...a, status: 'SETTLED' };
}

export async function markReturned(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, note?: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'RETURNED');
  const { error } = await adminDb.from('approvals').update({ status: 'RETURNED' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(adminDb, orgId, approvalId, 'RETURNED', actor, a.status, 'RETURNED', { note });
  return { ...a, status: 'RETURNED' };
}
