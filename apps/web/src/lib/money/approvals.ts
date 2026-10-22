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
import { createAdminSupabase } from '@/lib/supabase/server';
import { effectiveAnyPermissionStrict, type EffectiveCellRef } from '@/lib/rbac/resolve-permissions';
import { assertActionSod, SodViolationError, type ActionSodCode } from '@/lib/rbac/sod';
import { loadTenantSodSettings } from '@/lib/rbac/sod-store';

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
  /** Free-form evidence captured with the approval (e.g. the payroll lines digest). */
  metadata: Record<string, unknown>;
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
  metadata?: Record<string, unknown> | null;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id, orgId: r.org_id, kind: r.kind, subjectTable: r.subject_table, subjectId: r.subject_id,
    amountCents: r.amount_cents, status: r.status, preparedBy: r.prepared_by, approvedBy: r.approved_by,
    releasedBy: r.released_by, providerCorrelationId: r.provider_correlation_id, rejectReason: r.reject_reason,
    metadata: r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? r.metadata : {},
  };
}

/**
 * Service-role writer for the approval record + its audit trail. Migration 154 makes
 * public.approvals and public.approval_steps SELECT-only for members (a member could
 * otherwise UPDATE approvals SET status='APPROVED' straight through PostgREST and skip
 * canApprove + separation of duties). Every write below is therefore issued as the
 * service role regardless of which client the caller handed in, is pinned to the
 * caller's `orgId` with an explicit org_id filter, and only happens AFTER this module's
 * own gates (assertTransition, SoD, canApprove) — callers own route-level authz
 * (requireMoneyMovement / requirePermission). Reads stay on the caller's client.
 */
function svc(): SupabaseClient {
  return createAdminSupabase();
}

async function logStep(
  orgId: string,
  approvalId: string,
  action: string,
  actor: string,
  before: ApprovalStatus | null,
  after: ApprovalStatus | null,
  opts?: { providerCorrelationId?: string | null; note?: string },
): Promise<void> {
  await svc().from('approval_steps').insert({
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
export const MONEY_APPROVAL_CELLS: readonly EffectiveCellRef[] = [
  { featureId: 'checks', action: 'approve' },
  { featureId: 'bills', action: 'approve' },
  { featureId: 'payroll', action: 'approve' },
];

/**
 * R0 (IA-SPEC §7, 05-RBAC C3) — money-approval authority from the EFFECTIVE permission,
 * not the frozen system matrix. `rawRole` is the caller's membership/employee role string
 * (a system role OR a tenant custom-role key). The org's role edits (migration 130
 * overrides) and custom roles are honored:
 *   - a tenant that revokes checks/bills/payroll:approve from a role → that role is denied;
 *   - a custom role granted approve on any of those cells → allowed;
 *   - an unknown role / missing custom role / unreadable overrides → denied (strict).
 * Interim: disappears when canApprove() calls authorize(…,'approve',{amount,preparedBy})
 * (R-11). Separation of duties is NOT decided here — see approve().
 */
async function roleMayApproveMoney(db: SupabaseClient, orgId: string, rawRole: string): Promise<boolean> {
  return effectiveAnyPermissionStrict(db, orgId, rawRole, MONEY_APPROVAL_CELLS);
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
  // Unrecognized (neither system nor this org's custom role) -> fail closed inside.
  return roleMayApproveMoney(adminDb, orgId, data.role as string);
}

export interface CanApproveOptions {
  /** The item's approval kind — v2 checks that kind's capability (05 §5.1, closes C3). */
  kind?: ApprovalKind;
  /** Wave 2C passthrough (dollar limits) — not evaluated here. */
  amountCents?: number;
  /** Wave 2C passthrough (transaction SoD) — SoD stays enforced in approve() + DB CHECK. */
  preparedBy?: string | null;
  /** Client the money movement belongs to, when known. */
  locationId?: string | null;
  /** Route label for the dual-run log. */
  route?: string;
}

/**
 * Money-approval authority through the single policy decision point (R-11).
 *
 * The LEGACY decision is exactly the pre-R-11 rule (legacyCanApprove below). In the
 * tenant's 'legacy' / 'dual' enforcement modes that decision is returned unchanged
 * ('dual' logs any disagreement with the capability model); in 'v2' the capability
 * model decides: `<kind capability>:approve` when the kind is known (pay.batches /
 * payroll.runs / pay.refunds), else ANY of the three money-approve capabilities —
 * re-checked in the DB (core.assert_actor_capability) and by the approvals guard
 * trigger (migration 164).
 */
export async function canApprove(
  adminDb: SupabaseClient,
  orgId: string,
  clerkUserId: string,
  opts: CanApproveOptions = {},
): Promise<boolean> {
  try {
    const legacyAllowed = await legacyCanApprove(adminDb, orgId, clerkUserId);
    const { authorizeAny, MONEY_APPROVE_REFS, MONEY_KIND_CAPABILITY } = await import('@/lib/rbac/authorize');
    const refs = opts.kind
      ? [{ capability: MONEY_KIND_CAPABILITY[opts.kind], action: 'approve' as const }]
      : MONEY_APPROVE_REFS;
    const decision = await authorizeAny({ userId: clerkUserId, orgId }, refs, {
      legacy: async () => legacyAllowed,
      equivalentRefs: opts.kind ? MONEY_APPROVE_REFS : undefined,
      locationId: opts.locationId ?? null,
      amountCents: opts.amountCents,
      preparedBy: opts.preparedBy,
      route: opts.route ?? `money:approve${opts.kind ? `:${opts.kind}` : ''}`,
    });
    return decision.allow;
  } catch {
    return false; // fail closed
  }
}

/**
 * LEGACY (pre-R-11) role authorization — the dual-run's legacy side. FAILS CLOSED,
 * reconciled to Core identity.
 *
 * Resolution order (per the suite identity/access contract):
 *   1. CANONICAL: core.users (by clerk_user_id) -> core.memberships
 *      (by user_id, org_id, status='active') -> resolve the membership role (system
 *      role, normalized; or this org's custom role) -> gate on the EFFECTIVE
 *      permission (system default merged with the org's overrides) on the money
 *      surfaces. 'owner'/'org_admin'/'admin' normalize to company_admin.
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
async function legacyCanApprove(adminDb: SupabaseClient, orgId: string, clerkUserId: string): Promise<boolean> {
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
        // Authoritative: honor the membership decision, do NOT fall back. The RAW role
        // (system or custom key) is resolved against the org's EFFECTIVE permissions;
        // an unrecognized role fails closed inside roleMayApproveMoney.
        if (!(await roleMayApproveMoney(adminDb, orgId, membership.role as string))) return false;
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
  const { data, error } = await svc()
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
  await logStep(orgId, approval.id, 'PREPARED', input.preparedBy, null, 'DRAFT');
  return approval;
}

/**
 * Read one approval with the SERVICE ROLE, pinned to the org. The authoritative record
 * for a release (public.approvals is member read-only, mig 154; transitions are
 * DB-guarded, mig 170). null when absent.
 */
export async function loadApproval(orgId: string, approvalId: string): Promise<Approval | null> {
  const { data, error } = await svc().from('approvals').select('*').eq('org_id', orgId).eq('id', approvalId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toApproval(data as ApprovalRow) : null;
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
  const { error } = await svc().from('approvals').update({ status: 'PENDING_APPROVAL' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'SUBMITTED', actor, a.status, 'PENDING_APPROVAL');
  return { ...a, status: 'PENDING_APPROVAL' };
}

export class NotAuthorizedToApproveError extends Error {
  constructor() { super('Not authorized to approve money movement. Your role does not have approval authority on checks, bills, or payroll.'); this.name = 'NotAuthorizedToApproveError'; }
}
export class SeparationOfDutiesError extends Error {
  /** The H6 rule behind it (05 §4.1), when raised through assertActionSod. */
  readonly code: ActionSodCode;
  constructor(code: ActionSodCode = 'PREPARER_CANNOT_APPROVE') {
    super('The approver cannot be the preparer (separation of duties).');
    this.name = 'SeparationOfDutiesError';
    this.code = code;
  }
}

export async function approve(adminDb: SupabaseClient, orgId: string, approvalId: string, approverId: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'APPROVED');
  // H6 through the shared action-time check (wave 2C); the SeparationOfDutiesError
  // contract callers map to 409 is preserved.
  try {
    assertActionSod({ actor: approverId, action: 'approve', preparedBy: a.preparedBy });
  } catch (e) {
    if (e instanceof SodViolationError) throw new SeparationOfDutiesError(e.code);
    throw e;
  }
  if (!(await canApprove(adminDb, orgId, approverId, {
    kind: a.kind,
    amountCents: a.amountCents ?? undefined,
    preparedBy: a.preparedBy,
  }))) throw new NotAuthorizedToApproveError();

  const { error } = await svc()
    .from('approvals')
    .update({ status: 'APPROVED', approved_by: approverId })
    .eq('org_id', orgId)
    .eq('id', approvalId);
  if (error) throw new Error(error.message); // DB CHECK also guards preparer != approver
  await logStep(orgId, approvalId, 'APPROVED', approverId, a.status, 'APPROVED');
  return { ...a, status: 'APPROVED', approvedBy: approverId };
}

export async function reject(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, reason: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'REJECTED');
  const { error } = await svc().from('approvals').update({ status: 'REJECTED', reject_reason: reason }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'REJECTED', actor, a.status, 'REJECTED', { note: reason });
  return { ...a, status: 'REJECTED', rejectReason: reason };
}

/**
 * H6 at release (05 §4.1): the preparer never releases; the approver releases only when
 * the tenant allows it (any amount, or up to the tenant's limit — mig 174) and never for
 * payroll; and nobody releases a payment to a payee whose bank details THEY changed (or
 * approved) in the last 10 days (H6_BANK_CHANGE_RELEASE).
 * Throws SodViolationError (routes map it to 409 with its message). The DB trigger
 * approvals_release_sod_guard (migrations 165 / 174) re-checks the first two.
 *
 * `parties.amountCents` is the approval's amount; when the tenant has a limit and the
 * amount is unknown the approver is refused (fail closed). `parties.kind` PAYROLL_RUN
 * makes the approver ≠ releaser rule strict whatever the tenant setting.
 */
export interface ReleaseParties {
  preparedBy: string | null;
  approvedBy: string | null;
  amountCents?: number | null;
  kind?: ApprovalKind | null;
}

export async function assertReleaseSod(
  adminDb: SupabaseClient,
  orgId: string,
  actor: string,
  parties: ReleaseParties,
  bankDetailChanges: ReadonlyArray<{ userId: string; at: string }> = [],
): Promise<void> {
  const settings = await loadTenantSodSettings(adminDb, orgId);
  assertActionSod({
    actor,
    action: 'release',
    preparedBy: parties.preparedBy,
    approvedBy: parties.approvedBy,
    soleApproverMode: settings.soleApproverMode,
    soleApproverMaxCents: settings.soleApproverMaxCents,
    strictApproverRelease: parties.kind === 'PAYROLL_RUN',
    amountCents: parties.amountCents ?? null,
    bankDetailChanges,
  });
}

/** Bank-detail authorship columns a vendor payment profile may carry (137 + later). */
const BANK_DETAIL_ACTOR_COLUMNS: ReadonlyArray<{ who: string; when: readonly string[] }> = [
  { who: 'captured_by', when: ['updated_at', 'captured_at'] },
  { who: 'changed_by', when: ['changed_at', 'updated_at'] },
  { who: 'approved_by', when: ['approved_at', 'updated_at'] },
];

/**
 * Who changed / approved the payee's bank details, and when — for the 10-day
 * bank-change → release rule. The payee is the vendor of the bill an AP approval
 * covers. Fails CLOSED (throws) when the lookup errors; an approval that isn't a bill
 * payment, or a vendor with no payment profile, has no bank-detail changes.
 */
export async function loadPayeeBankDetailChanges(
  orgId: string,
  approval: { kind: ApprovalKind; subjectTable: string; subjectId: string },
  vendorId?: string | null,
): Promise<Array<{ userId: string; at: string }>> {
  if (approval.kind !== 'AP_DISBURSEMENT' && approval.kind !== 'AP_BATCH') return [];
  let vid = vendorId ?? null;
  if (!vid && approval.subjectTable === 'bills') {
    const { data: bill, error } = await svc()
      .from('bills').select('vendor_id').eq('org_id', orgId).eq('id', approval.subjectId).maybeSingle();
    if (error) throw new Error(`Could not check the payee's bank details: ${error.message}`);
    vid = ((bill ?? null) as { vendor_id: string | null } | null)?.vendor_id ?? null;
  }
  if (!vid) return [];
  const { data: prof, error: pErr } = await svc()
    .from('vendor_payment_profiles').select('*').eq('org_id', orgId).eq('vendor_id', vid).maybeSingle();
  if (pErr) throw new Error(`Could not check the payee's bank details: ${pErr.message}`);
  const row = (prof ?? null) as Record<string, unknown> | null;
  if (!row) return [];
  const out: Array<{ userId: string; at: string }> = [];
  for (const c of BANK_DETAIL_ACTOR_COLUMNS) {
    const who = row[c.who];
    if (typeof who !== 'string' || !who) continue;
    const at = c.when.map((k) => row[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
    // No timestamp → treat as just changed (fail toward enforcing).
    out.push({ userId: who, at: at ?? new Date().toISOString() });
  }
  return out;
}

/** Record that the actual money movement was triggered (after APPROVED). */
export async function markReleased(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, providerCorrelationId: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'RELEASED');
  await assertReleaseSod(svc(), orgId, actor,
    { preparedBy: a.preparedBy, approvedBy: a.approvedBy, amountCents: a.amountCents, kind: a.kind },
    await loadPayeeBankDetailChanges(orgId, a));
  const { error } = await svc()
    .from('approvals')
    .update({ status: 'RELEASED', released_by: actor, provider_correlation_id: providerCorrelationId })
    .eq('org_id', orgId)
    .eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'RELEASED', actor, a.status, 'RELEASED', { providerCorrelationId });
  return { ...a, status: 'RELEASED', releasedBy: actor, providerCorrelationId };
}

export type ReleaseClaimResult = 'CLAIMED' | 'ALREADY_CLAIMED';

/**
 * Atomically CLAIM an APPROVED approval for release — the concurrency guarantor
 * for the money-out path (task #110, security audit).
 *
 * The double-pay race: two simultaneous /ap/disbursements/release calls could
 * each assemble the same APPROVED line and both reach recordBillPayment before
 * markReleased flipped it to RELEASED (markReleased read-then-writes via
 * assertTransition — not atomic under concurrency).
 *
 * This closes it with a single conditional compare-and-set: flip APPROVED ->
 * RELEASED with an UPDATE that only matches WHILE status is still APPROVED. Under
 * READ COMMITTED, two concurrent releasers serialize on the row lock and Postgres
 * re-evaluates the `status = 'APPROVED'` predicate against the winner's committed
 * row, so EXACTLY ONE update matches. The DB — not an app-level check — is the
 * guarantor; the loser gets ALREADY_CLAIMED and MUST NOT post.
 *
 * Deliberately does NOT route through markReleased/assertTransition (that is a
 * racy read-then-write). It uses ONLY existing columns/enum values, so it needs
 * no migration and cannot regress. released_by is stamped now;
 * provider_correlation_id and the immutable RELEASED audit step are written by
 * finalizeReleaseClaim() AFTER the payment posts. If posting fails, the caller
 * MUST revertReleaseClaim() so the (un-posted) line returns to APPROVED for retry.
 */
export interface ReleaseClaimSod {
  /** Known parties of the item. Omit to read them from the approval. */
  preparedBy?: string | null;
  approvedBy?: string | null;
  /** The payee vendor when the caller already knows it (skips the bill lookup). */
  vendorId?: string | null;
}

export async function claimApprovalForRelease(
  db: SupabaseClient,
  orgId: string,
  approvalId: string,
  actor: string,
  sod: ReleaseClaimSod = {},
): Promise<ReleaseClaimResult> {
  // H6 BEFORE claiming, so an approver-who-releases (or the preparer, or the person who
  // just changed the payee's bank details) gets a clean SodViolationError instead of a
  // trigger failure mid-claim. The approval row is read (service role) for the payee.
  const { data: row, error: readErr } = await svc()
    .from('approvals')
    .select('kind, subject_table, subject_id, prepared_by, approved_by, amount_cents')
    .eq('org_id', orgId)
    .eq('id', approvalId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const r = (row ?? null) as {
    kind: ApprovalKind; subject_table: string; subject_id: string; prepared_by: string | null; approved_by: string | null;
    amount_cents: number | string | null;
  } | null;
  if (!r) return 'ALREADY_CLAIMED'; // nothing to claim in this org
  const parties: ReleaseParties = {
    preparedBy: sod.preparedBy !== undefined ? sod.preparedBy : r.prepared_by ?? null,
    approvedBy: sod.approvedBy !== undefined ? sod.approvedBy : r.approved_by ?? null,
    // The amount always comes from the approval row (frozen once approved, mig 170) —
    // never from the caller — so the approver-release limit can't be talked around.
    amountCents: r.amount_cents == null ? null : Number(r.amount_cents),
    kind: r.kind,
  };
  const bankChanges = await loadPayeeBankDetailChanges(
    orgId, { kind: r.kind, subjectTable: r.subject_table, subjectId: r.subject_id }, sod.vendorId,
  );
  await assertReleaseSod(svc(), orgId, actor, parties, bankChanges);

  const { data, error } = await svc()
    .from('approvals')
    .update({ status: 'RELEASED', released_by: actor })
    .eq('org_id', orgId)
    .eq('id', approvalId)
    .eq('status', 'APPROVED') // compare-and-set: only the row still APPROVED matches
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? 'CLAIMED' : 'ALREADY_CLAIMED';
}

/**
 * Finalize a claimed release AFTER the payment posted: stamp the provider
 * correlation id and append the immutable RELEASED audit step (the step is only
 * written once money has actually posted, so the trail never shows a release that
 * did not happen).
 */
export async function finalizeReleaseClaim(
  db: SupabaseClient,
  orgId: string,
  approvalId: string,
  actor: string,
  providerCorrelationId: string,
): Promise<void> {
  const { error } = await svc()
    .from('approvals')
    .update({ provider_correlation_id: providerCorrelationId })
    .eq('org_id', orgId)
    .eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'RELEASED', actor, 'APPROVED', 'RELEASED', { providerCorrelationId });
}

/**
 * Roll back a claim whose payment FAILED to post — returns the line to APPROVED so
 * it can be retried. Conditional on the row still being the un-finalized claim
 * (status RELEASED, no provider_correlation_id) so it can never clobber a
 * legitimately completed release. No audit step is written: nothing was released.
 */
export async function revertReleaseClaim(
  db: SupabaseClient,
  orgId: string,
  approvalId: string,
): Promise<void> {
  const { error } = await svc()
    .from('approvals')
    .update({ status: 'APPROVED', released_by: null })
    .eq('org_id', orgId)
    .eq('id', approvalId)
    .eq('status', 'RELEASED')
    .is('provider_correlation_id', null);
  if (error) throw new Error(`Could not hand the release claim back: ${error.message}`);
}

export async function markSettled(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'SETTLED');
  const { error } = await svc().from('approvals').update({ status: 'SETTLED' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'SETTLED', actor, a.status, 'SETTLED');
  return { ...a, status: 'SETTLED' };
}

export async function markReturned(adminDb: SupabaseClient, orgId: string, approvalId: string, actor: string, note?: string): Promise<Approval> {
  const a = await getApproval(adminDb, orgId, approvalId);
  assertTransition(a.status, 'RETURNED');
  const { error } = await svc().from('approvals').update({ status: 'RETURNED' }).eq('org_id', orgId).eq('id', approvalId);
  if (error) throw new Error(error.message);
  await logStep(orgId, approvalId, 'RETURNED', actor, a.status, 'RETURNED', { note });
  return { ...a, status: 'RETURNED' };
}
