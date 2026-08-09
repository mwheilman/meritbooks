/**
 * CONFIGURABLE APPROVAL WORKFLOWS — the DB/service layer.
 *
 * The only place that touches Supabase for the workflow feature. It loads chain
 * definitions, resolves a document into its applicable amount-tiered steps, opens a
 * request, and records approve/reject decisions — delegating EVERY authorization and
 * state-transition decision to the pure engine in ./workflow.ts (which is unit-tested).
 *
 * TENANT ISOLATION (defense in depth): the migration-092 workflow tables
 * (approval_workflows, approval_workflow_steps, approval_requests, approval_request_actions)
 * are all in `public` with RLS `org_id = get_org_id()`. Every function here takes the
 * RLS-SCOPED client (`ctx.supabase`, running as the user) for those tables, so the
 * DATABASE refuses another tenant's rows even if an .eq('org_id', ...) filter is ever
 * dropped. We ALSO keep the explicit org filter on each query as belt-and-suspenders.
 *
 * TWO operations genuinely need the RLS-BYPASSING admin client and build it internally
 * (never taken from the route): (1) `resolveActorRole` reads the `core` identity spine
 * (core.users/memberships/employees), which RLS shields from the user client; (2) the
 * money bridge `approveSingle` → `canApprove`, which also reads `core`. Both carry an
 * explicit, VERIFIED org_id filter and mirror the money-movement engine's convention.
 *
 * BRIDGE (no forked posting): when a request's FINAL step approves and the request is
 * linked to an existing single-approval row (public.approvals, migration 042), the
 * service drives that row to APPROVED through the EXISTING gated `approve()` primitive
 * — the already-audited money-movement action fires, unchanged. Money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/server';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import type { UserRole } from '@/lib/rbac/permissions';
import { approve as approveSingle } from '@/lib/money/approvals';
import {
  applicableSteps,
  advanceChain,
  firstStepOrder,
  validateWorkflowSteps,
  WorkflowError,
  type WorkflowDef,
  type WorkflowStepDef,
  type WorkflowDocType,
  type ApprovalDecision,
  type RecordedAction,
  type RequestStatus,
} from './workflow';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  org_id: string;
  name: string;
  doc_type: WorkflowDocType;
  active: boolean;
  description: string | null;
  created_by_user: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  workflow_id: string;
  step_order: number;
  min_amount_cents: number;
  max_amount_cents: number | null;
  approver_role: string;
  require_distinct: boolean;
}

interface RequestRow {
  id: string;
  org_id: string;
  workflow_id: string;
  doc_type: WorkflowDocType;
  doc_id: string;
  amount_cents: number;
  current_step: number;
  status: RequestStatus;
  prepared_by: string;
  link_approval_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  request_id: string;
  step_order: number;
  actor_user: string;
  decision: ApprovalDecision;
  reason: string | null;
  acted_at: string;
}

// ---------------------------------------------------------------------------
// Public view models
// ---------------------------------------------------------------------------

export interface WorkflowView extends WorkflowDef {
  description: string | null;
  createdByUser: string | null;
}

export interface RequestView {
  id: string;
  orgId: string;
  workflowId: string;
  workflowName: string;
  docType: WorkflowDocType;
  docId: string;
  amountCents: number;
  currentStep: number;
  status: RequestStatus;
  preparedBy: string;
  linkApprovalId: string | null;
  /** The ordered applicable steps for this request's amount. */
  steps: WorkflowStepDef[];
  actions: Array<RecordedAction & { reason: string | null; actedAt: string }>;
}

function toStepDef(r: StepRow): WorkflowStepDef {
  return {
    stepOrder: r.step_order,
    minAmountCents: Number(r.min_amount_cents),
    maxAmountCents: r.max_amount_cents === null ? null : Number(r.max_amount_cents),
    // Role vocabulary is validated in app code; unrecognized normalizes to a safe token.
    approverRole: (normalizeMembershipRole(r.approver_role) ?? (r.approver_role as UserRole)),
    requireDistinct: r.require_distinct,
  };
}

// ---------------------------------------------------------------------------
// Definitions — load / list / create
// ---------------------------------------------------------------------------

/** The single ACTIVE workflow (with steps) for a doc_type, or null (degrade-safe). */
export async function getActiveWorkflow(
  db: SupabaseClient,
  orgId: string,
  docType: WorkflowDocType
): Promise<WorkflowDef | null> {
  const { data: wf, error } = await db
    .from('approval_workflows')
    .select('*')
    .eq('org_id', orgId)
    .eq('doc_type', docType)
    .eq('active', true)
    .maybeSingle();
  if (error || !wf) return null;
  const row = wf as WorkflowRow;
  const { data: stepRows } = await db
    .from('approval_workflow_steps')
    .select('*')
    .eq('org_id', orgId)
    .eq('workflow_id', row.id)
    .order('step_order', { ascending: true });
  const steps = (stepRows ?? []).map((s) => toStepDef(s as StepRow));
  return { id: row.id, docType: row.doc_type, name: row.name, active: row.active, steps };
}

export async function listWorkflows(db: SupabaseClient, orgId: string): Promise<WorkflowView[]> {
  const { data: wfs, error } = await db
    .from('approval_workflows')
    .select('*')
    .eq('org_id', orgId)
    .order('doc_type', { ascending: true })
    .order('created_at', { ascending: false });
  if (error || !wfs) return [];
  const rows = wfs as WorkflowRow[];
  const { data: allSteps } = await db
    .from('approval_workflow_steps')
    .select('*')
    .eq('org_id', orgId);
  const stepsByWf = new Map<string, WorkflowStepDef[]>();
  for (const s of (allSteps ?? []) as StepRow[]) {
    const arr = stepsByWf.get(s.workflow_id) ?? [];
    arr.push(toStepDef(s));
    stepsByWf.set(s.workflow_id, arr);
  }
  return rows.map((r) => ({
    id: r.id,
    docType: r.doc_type,
    name: r.name,
    active: r.active,
    description: r.description,
    createdByUser: r.created_by_user,
    steps: (stepsByWf.get(r.id) ?? []).sort((a, b) => a.stepOrder - b.stepOrder),
  }));
}

export interface CreateWorkflowInput {
  name: string;
  docType: WorkflowDocType;
  description?: string | null;
  active?: boolean;
  steps: WorkflowStepDef[];
  createdByUser: string;
}

export class WorkflowValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join('; '));
    this.errors = errors;
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Create a workflow + its steps. Validates the chain via the pure validator first. When
 * `active`, deactivates any other active workflow for the same doc_type so the
 * one-active-per-(org,doc_type) invariant holds (the partial unique index is the DB
 * guarantor; this keeps the app from racing into it).
 */
export async function createWorkflow(
  db: SupabaseClient,
  orgId: string,
  input: CreateWorkflowInput
): Promise<WorkflowView> {
  const errors = validateWorkflowSteps(input.steps);
  if (errors.length > 0) throw new WorkflowValidationError(errors);

  const active = input.active ?? true;
  if (active) {
    await db
      .from('approval_workflows')
      .update({ active: false })
      .eq('org_id', orgId)
      .eq('doc_type', input.docType)
      .eq('active', true);
  }

  const { data: wf, error } = await db
    .from('approval_workflows')
    .insert({
      org_id: orgId,
      name: input.name,
      doc_type: input.docType,
      description: input.description ?? null,
      active,
      created_by_user: input.createdByUser,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  const row = wf as WorkflowRow;

  const stepInserts = input.steps.map((s) => ({
    org_id: orgId,
    workflow_id: row.id,
    step_order: s.stepOrder,
    min_amount_cents: s.minAmountCents,
    max_amount_cents: s.maxAmountCents,
    approver_role: s.approverRole,
    require_distinct: s.requireDistinct,
  }));
  const { error: stepErr } = await db.from('approval_workflow_steps').insert(stepInserts);
  if (stepErr) throw new Error(stepErr.message);

  return {
    id: row.id,
    docType: row.doc_type,
    name: row.name,
    active: row.active,
    description: row.description,
    createdByUser: row.created_by_user,
    steps: [...input.steps].sort((a, b) => a.stepOrder - b.stepOrder),
  };
}

/** Activate/deactivate a workflow, keeping the one-active-per-doc_type invariant. */
export async function setWorkflowActive(
  db: SupabaseClient,
  orgId: string,
  workflowId: string,
  active: boolean
): Promise<void> {
  if (active) {
    const { data: wf } = await db
      .from('approval_workflows')
      .select('doc_type')
      .eq('org_id', orgId)
      .eq('id', workflowId)
      .maybeSingle();
    if (wf) {
      await db
        .from('approval_workflows')
        .update({ active: false })
        .eq('org_id', orgId)
        .eq('doc_type', (wf as { doc_type: string }).doc_type)
        .eq('active', true);
    }
  }
  const { error } = await db
    .from('approval_workflows')
    .update({ active })
    .eq('org_id', orgId)
    .eq('id', workflowId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Requests — submit / act / read
// ---------------------------------------------------------------------------

export interface SubmitResult {
  entered: boolean;
  request?: RequestView;
  /** Why no chain was opened (degrade-safe informational), when entered === false. */
  reason?: 'NO_ACTIVE_WORKFLOW' | 'NO_APPLICABLE_STEPS' | 'ALREADY_OPEN';
}

/**
 * Route a document into its workflow ON SUBMIT — the seam other flows call WITHOUT
 * forking their posting. Resolves the active workflow for the doc_type; if none, or if
 * the amount hits no step band, returns `{ entered: false }` and the caller keeps the
 * existing single-approver behavior. Otherwise opens a PENDING request at the first
 * applicable step. Idempotent per open document (the DB partial unique index blocks a
 * second open request for the same doc).
 */
export async function submitToWorkflow(
  db: SupabaseClient,
  orgId: string,
  input: {
    docType: WorkflowDocType;
    docId: string;
    amountCents: number;
    preparedBy: string;
    linkApprovalId?: string | null;
  }
): Promise<SubmitResult> {
  const wf = await getActiveWorkflow(db, orgId, input.docType);
  if (!wf) return { entered: false, reason: 'NO_ACTIVE_WORKFLOW' };

  const steps = applicableSteps(wf, input.amountCents);
  const first = firstStepOrder(steps);
  if (first === null) return { entered: false, reason: 'NO_APPLICABLE_STEPS' };

  // Reuse an already-open request for this doc (idempotent submit).
  const { data: existing } = await db
    .from('approval_requests')
    .select('*')
    .eq('org_id', orgId)
    .eq('doc_type', input.docType)
    .eq('doc_id', input.docId)
    .eq('status', 'PENDING')
    .maybeSingle();
  if (existing) {
    return { entered: true, request: await hydrateRequest(db, orgId, existing as RequestRow, wf) };
  }

  const { data: req, error } = await db
    .from('approval_requests')
    .insert({
      org_id: orgId,
      workflow_id: wf.id,
      doc_type: input.docType,
      doc_id: input.docId,
      amount_cents: input.amountCents,
      current_step: first,
      status: 'PENDING',
      prepared_by: input.preparedBy,
      link_approval_id: input.linkApprovalId ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return { entered: true, request: await hydrateRequest(db, orgId, req as RequestRow, wf) };
}

async function hydrateRequest(
  db: SupabaseClient,
  orgId: string,
  row: RequestRow,
  wf?: WorkflowDef | null
): Promise<RequestView> {
  const workflow =
    wf && wf.id === row.workflow_id
      ? wf
      : await getWorkflowById(db, orgId, row.workflow_id);
  const steps = workflow ? applicableSteps(workflow, Number(row.amount_cents)) : [];
  const { data: actionRows } = await db
    .from('approval_request_actions')
    .select('*')
    .eq('org_id', orgId)
    .eq('request_id', row.id)
    .order('acted_at', { ascending: true });
  const actions = ((actionRows ?? []) as ActionRow[]).map((a) => ({
    stepOrder: a.step_order,
    actorUser: a.actor_user,
    decision: a.decision,
    reason: a.reason,
    actedAt: a.acted_at,
  }));
  return {
    id: row.id,
    orgId: row.org_id,
    workflowId: row.workflow_id,
    workflowName: workflow?.name ?? 'Workflow',
    docType: row.doc_type,
    docId: row.doc_id,
    amountCents: Number(row.amount_cents),
    currentStep: row.current_step,
    status: row.status,
    preparedBy: row.prepared_by,
    linkApprovalId: row.link_approval_id,
    steps,
    actions,
  };
}

async function getWorkflowById(
  db: SupabaseClient,
  orgId: string,
  workflowId: string
): Promise<WorkflowDef | null> {
  const { data: wf } = await db
    .from('approval_workflows')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', workflowId)
    .maybeSingle();
  if (!wf) return null;
  const row = wf as WorkflowRow;
  const { data: stepRows } = await db
    .from('approval_workflow_steps')
    .select('*')
    .eq('org_id', orgId)
    .eq('workflow_id', workflowId)
    .order('step_order', { ascending: true });
  return {
    id: row.id,
    docType: row.doc_type,
    name: row.name,
    active: row.active,
    steps: (stepRows ?? []).map((s) => toStepDef(s as StepRow)),
  };
}

/** Read a single request (with steps + audit trail). */
export async function getRequest(
  db: SupabaseClient,
  orgId: string,
  requestId: string
): Promise<RequestView | null> {
  const { data: req } = await db
    .from('approval_requests')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', requestId)
    .maybeSingle();
  if (!req) return null;
  return hydrateRequest(db, orgId, req as RequestRow);
}

/** Read the open (PENDING) request for a document, if any. */
export async function getOpenRequestForDoc(
  db: SupabaseClient,
  orgId: string,
  docType: WorkflowDocType,
  docId: string
): Promise<RequestView | null> {
  const { data: req } = await db
    .from('approval_requests')
    .select('*')
    .eq('org_id', orgId)
    .eq('doc_type', docType)
    .eq('doc_id', docId)
    .eq('status', 'PENDING')
    .maybeSingle();
  if (!req) return null;
  return hydrateRequest(db, orgId, req as RequestRow);
}

export async function listRequests(
  db: SupabaseClient,
  orgId: string,
  opts?: { status?: RequestStatus; docType?: WorkflowDocType }
): Promise<RequestView[]> {
  let q = db.from('approval_requests').select('*').eq('org_id', orgId);
  if (opts?.status) q = q.eq('status', opts.status);
  if (opts?.docType) q = q.eq('doc_type', opts.docType);
  const { data } = await q.order('created_at', { ascending: false }).limit(200);
  const rows = (data ?? []) as RequestRow[];
  return Promise.all(rows.map((r) => hydrateRequest(db, orgId, r)));
}

/**
 * Resolve an actor's role on the canonical identity spine (core.users →
 * core.memberships), falling back to core.employees while memberships backfill —
 * mirroring canApprove()'s resolution so the two authz paths can't disagree. Returns
 * null (fail-closed) on any error/absence/unrecognized role.
 *
 * ADMIN CLIENT REQUIRED: the `core` identity spine is deliberately NOT exposed to the
 * user (RLS) client, so this reads it via the service-role client built here. Isolation
 * still holds because every query carries an explicit, VERIFIED org_id filter and the
 * caller-supplied `clerkUserId`. Kept self-contained (builds its own admin client) so it
 * can never be handed an RLS client that silently returns nothing from `core`.
 */
export async function resolveActorRole(
  orgId: string,
  clerkUserId: string
): Promise<UserRole | null> {
  const admin = createAdminSupabase();
  try {
    const { data: user } = await admin
      .schema('core')
      .from('users')
      .select('id')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (user?.id) {
      const { data: membership } = await admin
        .schema('core')
        .from('memberships')
        .select('role')
        .eq('user_id', (user as { id: string }).id)
        .eq('org_id', orgId)
        .eq('status', 'active')
        .maybeSingle();
      if (membership?.role) {
        // Deactivated employee guard (mirrors canApprove H1): a stale-active membership
        // must not retain authority for a deactivated employee.
        const { data: emp } = await admin
          .schema('core')
          .from('employees')
          .select('is_active')
          .eq('org_id', orgId)
          .eq('clerk_user_id', clerkUserId)
          .maybeSingle();
        if (emp && (emp as { is_active: boolean }).is_active === false) return null;
        return normalizeMembershipRole((membership as { role: string }).role);
      }
    }
    // Transitional fallback: core.employees.role while memberships backfill.
    const { data: emp } = await admin
      .schema('core')
      .from('employees')
      .select('role')
      .eq('org_id', orgId)
      .eq('clerk_user_id', clerkUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (emp?.role) return normalizeMembershipRole((emp as { role: string }).role);
    return null;
  } catch {
    return null;
  }
}

/**
 * Count ACTIVE members per canonical Books role for an org — feeds the settings-side
 * coverage audit (a step whose required authority no active member could satisfy is a
 * dead step). READ-ONLY and best-effort: returns {} on any error.
 *
 * ADMIN CLIENT REQUIRED for the same reason as resolveActorRole: the `core` identity
 * spine (core.memberships) is RLS-shielded from the user client. The single query
 * carries an explicit, VERIFIED org_id filter and status='active', so tenant isolation
 * holds. Membership roles are normalized onto the Books vocabulary before counting, so
 * the keys line up with the RBAC catalog the analysis reasons over; a membership whose
 * role doesn't normalize is skipped (it grants no known authority).
 */
export async function getActiveRoleCounts(orgId: string): Promise<Record<string, number>> {
  const admin = createAdminSupabase();
  try {
    const { data, error } = await admin
      .schema('core')
      .from('memberships')
      .select('role')
      .eq('org_id', orgId)
      .eq('status', 'active');
    if (error || !data) return {};
    const counts: Record<string, number> = {};
    for (const row of data as Array<{ role: string | null }>) {
      const role = normalizeMembershipRole(row.role ?? undefined);
      if (!role) continue;
      counts[role] = (counts[role] ?? 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

export interface ActResult {
  request: RequestView;
  /** Set when the chain completed with full approval. */
  completed: boolean;
  approvedComplete: boolean;
  /** Non-null when the linked single-approval bridge was attempted but failed. */
  bridgeError?: string;
}

/**
 * Record an approve/reject on the request's CURRENT step. All authorization and the
 * state transition are decided by the pure engine (advanceChain), which enforces
 * role-at-step, preparer != approver, and distinct-approver. On success this writes the
 * audit action and advances/closes the request atomically-enough for our model (single
 * verification lane; the open-request unique index prevents concurrent duplicates).
 *
 * On full completion with a linked single-approval, drives that row to APPROVED via the
 * EXISTING gated `approve()` primitive — the money-movement action fires unchanged. A
 * bridge failure does NOT roll back the chain approval (the chain decision stands and is
 * audited); it is surfaced as `bridgeError` for the caller to handle.
 */
export async function actOnRequest(
  db: SupabaseClient,
  orgId: string,
  input: { requestId: string; actorUserId: string; decision: ApprovalDecision; reason?: string | null }
): Promise<ActResult> {
  const { data: reqRow } = await db
    .from('approval_requests')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', input.requestId)
    .maybeSingle();
  if (!reqRow) throw new Error('Approval request not found');
  const row = reqRow as RequestRow;

  const workflow = await getWorkflowById(db, orgId, row.workflow_id);
  if (!workflow) throw new Error('Workflow definition not found');
  const steps = applicableSteps(workflow, Number(row.amount_cents));

  const { data: actionRows } = await db
    .from('approval_request_actions')
    .select('*')
    .eq('org_id', orgId)
    .eq('request_id', row.id)
    .order('acted_at', { ascending: true });
  const priorActions: RecordedAction[] = ((actionRows ?? []) as ActionRow[]).map((a) => ({
    stepOrder: a.step_order,
    actorUser: a.actor_user,
    decision: a.decision,
  }));

  const role = await resolveActorRole(orgId, input.actorUserId);

  // Pure decision — throws WorkflowError on any violation (caller maps to 4xx).
  const result = advanceChain(
    { steps, currentStep: row.current_step, status: row.status, preparedBy: row.prepared_by, actions: priorActions },
    { userId: input.actorUserId, role },
    input.decision
  );

  // Append the audit action.
  const { error: actErr } = await db.from('approval_request_actions').insert({
    org_id: orgId,
    request_id: row.id,
    step_order: row.current_step,
    actor_user: input.actorUserId,
    decision: input.decision,
    reason: input.reason ?? null,
  });
  if (actErr) throw new Error(actErr.message);

  // Advance/close the request.
  const patch: Record<string, unknown> = { status: result.status, current_step: result.currentStep };
  if (result.completed) patch.decided_at = new Date().toISOString();
  const { error: updErr } = await db
    .from('approval_requests')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', row.id);
  if (updErr) throw new Error(updErr.message);

  // Bridge: on full approval with a linked single-approval, fire the existing gate.
  // ADMIN CLIENT REQUIRED: approveSingle → canApprove reads the `core` identity spine
  // (RLS-shielded from the user client). It carries its own explicit org_id filter and
  // preparer!=approver check, so isolation and SoD are preserved on the admin path.
  let bridgeError: string | undefined;
  if (result.approvedComplete && row.link_approval_id) {
    try {
      await approveSingle(createAdminSupabase(), orgId, row.link_approval_id, input.actorUserId);
    } catch (e) {
      bridgeError = e instanceof Error ? e.message : 'Linked approval bridge failed';
    }
  }

  const request = await hydrateRequest(db, orgId, { ...row, status: result.status, current_step: result.currentStep }, workflow);
  return { request, completed: result.completed, approvedComplete: result.approvedComplete, bridgeError };
}

export { WorkflowError };
