/**
 * GATE 12 — money-movement approval engine (Books-owned, lift-friendly).
 *
 * Generic approval lifecycle for every money movement (AR refunds, AP
 * disbursements/batches, payroll runs). Two guarantees:
 *   1. preparer != approver — enforced by a DB CHECK (migration 042) AND here.
 *   2. who-may-approve — role authorization RECONCILED TO CORE IDENTITY. Per the
 *      suite identity/access contract (docs/canon/10-suite-contracts-digest.md
 *      FILE 4 + CANON-ANCHOR §3), money-movement authorization is Books-owned but
 *      MUST reconcile to `core.users` / `core.memberships` — Books must NOT bake a
 *      private "who may approve" that won't reconcile to the membership spine.
 *      canApprove() therefore resolves the caller through core.users ->
 *      core.memberships (the canonical spine, migration 061) and gates on the
 *      normalized membership role. It FAILS CLOSED on any error/absence and, only
 *      when no active membership exists yet, falls back to the interim
 *      core.employees.role path so nothing regresses while memberships backfill.
 *
 * Every transition appends an immutable approval_steps row (actor, timestamp,
 * before/after, provider_correlation_id). Call with the admin Supabase client;
 * the acting user id (Clerk) is passed explicitly by the route.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPermission, type UserRole } from '@/lib/rbac/permissions';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';

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

/** The money surfaces on which "may approve at all" is decided. A role that may
 * approve on ANY of these has money-movement approval authority. */
function roleMayApproveMoney(role: UserRole): boolean {
  return (
    hasPermission(role, 'checks', 'approve') ||
    hasPermission(role, 'bills', 'approve') ||
    hasPermission(role, 'payroll', 'approve')
  );
}

/**
 * TRANSITIONAL fallback — reads the interim `core.employees.role` source that
 * canApprove() used before the identity spine existed. Kept ONLY so approval does
 * not regress for callers who have an employee row but not yet an active
 * membership while memberships are backfilled (identity FPB Phase 2). Remove once
 * every approver has a `core.memberships` row (see "NEEDS CENTRAL" below).
 * Fails closed on any error/absence.
 */
async function canApproveViaEmployeesFallback(
  adminDb: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<boolean> {
  const { data, error } = await adminDb
    .schema('core')
    .from('employees')
    .select('role')
    .eq('org_id', orgId)
    .eq('clerk_user_id', clerkUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data?.role) return false; // no active role in this org -> fail closed
  const role = normalizeMembershipRole(data.role as string);
  if (!role) return false; // unrecognized role -> fail closed
  return roleMayApproveMoney(role);
}

/**
 * Role authorization — FAILS CLOSED, reconciled to Core identity.
 *
 * Resolution order (per the suite identity/access contract):
 *   1. CANONICAL: core.users (by clerk_user_id) -> core.memberships
 *      (by user_id, org_id, status='active') -> normalize the membership role
 *      onto a Books UserRole -> gate via hasPermission on the money surfaces.
 *      'owner'/'org_admin'/'admin' normalize to company_admin (full approver).
 *      A membership that exists but whose role is unrecognized fails CLOSED — we
 *      do NOT fall through to a possibly-more-permissive source once the
 *      authoritative membership has spoken.
 *   2. TRANSITIONAL: only when NO active membership is found (user missing, or no
 *      active membership in this org yet) do we fall back to core.employees.role,
 *      so approval does not regress mid-backfill.
 *
 * Separation of duties (approver != preparer) is enforced separately in approve()
 * and by a DB CHECK; this only answers "may this role approve at all".
 */
export async function canApprove(adminDb: SupabaseClient, orgId: string, clerkUserId: string): Promise<boolean> {
  try {
    // 1. Resolve the caller on the canonical identity spine.
    const { data: user, error: userErr } = await adminDb
      .schema('core')
      .from('users')
      .select('id')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (userErr) return false; // fail closed on lookup error

    if (user?.id) {
      const { data: membership, error: memErr } = await adminDb
        .schema('core')
        .from('memberships')
        .select('role')
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .eq('status', 'active')
        .maybeSingle();
      if (memErr) return false; // fail closed on lookup error

      if (membership?.role) {
        // Authoritative: honor the membership decision, do NOT fall back.
        const role = normalizeMembershipRole(membership.role as string);
        if (!role) return false; // membership present but role unrecognized -> fail closed
        if (!roleMayApproveMoney(role)) return false;
        // H1 guard (security audit, 2026-08-01): a membership is minted ACTIVE at
        // login and is NOT yet synced when an employee is deactivated/downgraded, so
        // a stale active membership could keep approval authority a deactivated
        // employee should have lost. Until membership lifecycle is reconciled to
        // employee status (identity gate #9), deny money approval when an employee
        // row exists for this org and is inactive. A caller with NO employee row
        // (a future invitation-only membership user) is unaffected.
        const { data: emp, error: empErr } = await adminDb
          .schema('core').from('employees')
          .select('is_active')
          .eq('org_id', orgId)
          .eq('clerk_user_id', clerkUserId)
          .maybeSingle();
        if (empErr) return false; // fail closed on lookup error
        if (emp && emp.is_active === false) return false; // deactivated employee -> no authority
        return true;
      }
      // user exists but no active membership in this org -> transitional fallback.
    }

    // 2. TRANSITIONAL fallback while memberships backfill (see NEEDS CENTRAL note).
    return await canApproveViaEmployeesFallback(adminDb, orgId, clerkUserId);
  } catch {
    return false; // fail closed
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
  constructor() { super('Not authorized to approve money movement. Your role does not have approval authority on checks, bills, or payroll.'); this.name = 'NotAuthorizedToApproveError'; }
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
