/**
 * CONFIGURABLE MULTI-STEP APPROVAL WORKFLOWS — the pure, side-effect-free core.
 *
 * A tenant defines, per document type (BILL / JOURNAL_ENTRY / PAYMENT / EXPENSE /
 * PAYROLL), an ordered chain of approval STEPS, each carrying an amount band
 * (min/max cents), a required approver ROLE, and a `requireDistinct` flag. A given
 * document's AMOUNT selects which steps apply (the tier), and the chain is walked in
 * `stepOrder`. This module owns ONLY the deterministic decisioning:
 *
 *   1. `applicableSteps(workflow, amountCents)` — resolve the ordered steps whose
 *      amount band covers the amount (the amount-tiered chain for this doc).
 *   2. `advanceChain(state, actor, decision)` — the pure state machine that enforces,
 *      at each step: role-at-step, preparer != approver (canon SoD), and — when
 *      `requireDistinct` — approver distinct from every prior approver on the chain;
 *      then advances to the next step or completes (APPROVED) when the LAST applicable
 *      step approves, or REJECTS on any rejection.
 *
 * No I/O, no clock, no randomness, no model — the same inputs always produce the same
 * verdict. The DB/service layer (lib/approvals/service.ts) is the only thing that
 * touches Supabase; it feeds plain data into these functions. Money is bigint cents.
 *
 * DEGRADE-SAFE: a doc_type with no active workflow (or whose bands exclude the amount)
 * yields an EMPTY chain — the caller treats that as "no multi-step workflow applies"
 * and the existing single-approver behavior is unchanged.
 */

import type { UserRole } from '@/lib/rbac/permissions';

export type WorkflowDocType = 'BILL' | 'JOURNAL_ENTRY' | 'PAYMENT' | 'EXPENSE' | 'PAYROLL';

export const WORKFLOW_DOC_TYPES: readonly WorkflowDocType[] = [
  'BILL',
  'JOURNAL_ENTRY',
  'PAYMENT',
  'EXPENSE',
  'PAYROLL',
] as const;

export type ApprovalDecision = 'APPROVE' | 'REJECT';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** One configured step in a chain. `maxAmountCents` null = no upper bound. */
export interface WorkflowStepDef {
  stepOrder: number;
  minAmountCents: number;
  maxAmountCents: number | null;
  approverRole: UserRole;
  requireDistinct: boolean;
}

export interface WorkflowDef {
  id: string;
  docType: WorkflowDocType;
  name: string;
  active: boolean;
  steps: WorkflowStepDef[];
}

/** A recorded action already taken on a request (for distinct-approver checks). */
export interface RecordedAction {
  stepOrder: number;
  actorUser: string;
  decision: ApprovalDecision;
}

/** The live state of a request as the state machine sees it. */
export interface ChainState {
  /** The ordered applicable steps for this request's amount (from applicableSteps). */
  steps: WorkflowStepDef[];
  /** The `stepOrder` of the step currently awaiting a decision. */
  currentStep: number;
  status: RequestStatus;
  /** clerk_user_id of the preparer/submitter (may never approve — canon SoD). */
  preparedBy: string;
  /** Prior actions on this request, in order. */
  actions: RecordedAction[];
}

export interface Actor {
  userId: string;
  role: UserRole | null;
}

export type WorkflowErrorCode =
  | 'NOT_PENDING'
  | 'NO_APPLICABLE_STEPS'
  | 'STEP_NOT_FOUND'
  | 'NOT_CURRENT_STEP'
  | 'ROLE_NOT_AUTHORIZED'
  | 'PREPARER_CANNOT_APPROVE'
  | 'DISTINCT_APPROVER_REQUIRED';

export class WorkflowError extends Error {
  code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkflowError';
  }
}

/**
 * Role authority ranking — a higher-ranked role satisfies a step that requires a
 * lower-ranked one (an approver may always step UP to cover a subordinate tier, never
 * down). Deterministic; mirrors the RBAC tiering in lib/rbac/permissions.ts.
 */
const ROLE_RANK: Record<UserRole, number> = {
  business_user: 0,
  general_admin: 1,
  check_processor: 1,
  accounting_specialist: 2,
  accounting_manager: 3,
  assistant_cfo: 4,
  merit_controller: 5,
  cfo: 6,
  company_admin: 7,
};

/** True when `actor` meets or exceeds the authority a step requires. */
export function roleMeetsStep(actor: UserRole | null, required: UserRole): boolean {
  if (!actor) return false;
  return ROLE_RANK[actor] >= ROLE_RANK[required];
}

/**
 * Resolve the ordered subset of a workflow's steps whose amount band covers
 * `amountCents`. A step applies when `amount >= minAmountCents` AND
 * (`maxAmountCents` is null OR `amount <= maxAmountCents`). Result is sorted ascending
 * by `stepOrder`, then re-indexed is NOT done — callers walk by `stepOrder`. Pure.
 */
export function applicableSteps(
  workflow: Pick<WorkflowDef, 'steps'>,
  amountCents: number
): WorkflowStepDef[] {
  return workflow.steps
    .filter(
      (s) =>
        amountCents >= s.minAmountCents &&
        (s.maxAmountCents === null || amountCents <= s.maxAmountCents)
    )
    .sort((a, b) => a.stepOrder - b.stepOrder);
}

/** The step currently awaiting a decision, or null if the chain has no current step. */
export function currentStepDef(state: ChainState): WorkflowStepDef | null {
  return state.steps.find((s) => s.stepOrder === state.currentStep) ?? null;
}

/** The lowest `stepOrder` among applicable steps — the entry point of a fresh chain. */
export function firstStepOrder(steps: WorkflowStepDef[]): number | null {
  if (steps.length === 0) return null;
  return steps.reduce((min, s) => (s.stepOrder < min ? s.stepOrder : min), steps[0].stepOrder);
}

export interface AdvanceResult {
  /** Status after the action. */
  status: RequestStatus;
  /** The next step awaiting a decision (only meaningful when status === 'PENDING'). */
  currentStep: number;
  /** True when this action closed the chain (APPROVED at last step, or REJECTED). */
  completed: boolean;
  /** True only when the chain completed with full approval. */
  approvedComplete: boolean;
}

/**
 * The pure approval state machine. Given the current chain state, an acting user
 * (with resolved role), and their decision, validate and compute the next state.
 * Throws `WorkflowError` on any violation — the caller maps the code to a 4xx and
 * writes NOTHING when it throws.
 *
 * Enforced invariants (in order):
 *   - the request must still be PENDING;
 *   - there must be applicable steps and the actor must be acting on the CURRENT step;
 *   - the actor's role must meet the step's required role (`roleMeetsStep`);
 *   - the actor must not be the preparer (canon SoD — always, every step);
 *   - if the step is `requireDistinct`, the actor must not have approved an earlier
 *     step on this chain (a distinct human per distinct-required step).
 *
 * On APPROVE at the last applicable step → APPROVED (approvedComplete). On APPROVE at a
 * non-last step → advance `currentStep` to the next applicable step's order. On REJECT
 * at any step → REJECTED (terminal).
 */
export function advanceChain(
  state: ChainState,
  actor: Actor,
  decision: ApprovalDecision
): AdvanceResult {
  if (state.status !== 'PENDING') {
    throw new WorkflowError('NOT_PENDING', `Request is ${state.status}, no further action allowed`);
  }
  const ordered = [...state.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  if (ordered.length === 0) {
    throw new WorkflowError('NO_APPLICABLE_STEPS', 'No approval steps apply to this document');
  }

  const idx = ordered.findIndex((s) => s.stepOrder === state.currentStep);
  if (idx < 0) {
    throw new WorkflowError('STEP_NOT_FOUND', `Current step ${state.currentStep} is not in the chain`);
  }
  const step = ordered[idx];

  // Preparer may never approve or reject their own document (canon SoD).
  if (actor.userId === state.preparedBy) {
    throw new WorkflowError('PREPARER_CANNOT_APPROVE', 'The preparer cannot act on their own document');
  }

  // Role-at-step authority.
  if (!roleMeetsStep(actor.role, step.approverRole)) {
    throw new WorkflowError(
      'ROLE_NOT_AUTHORIZED',
      `This step requires ${step.approverRole} authority`
    );
  }

  // Distinct-approver: the actor must not have already approved an earlier step here.
  if (step.requireDistinct) {
    const priorApprovers = new Set(
      state.actions.filter((a) => a.decision === 'APPROVE').map((a) => a.actorUser)
    );
    if (priorApprovers.has(actor.userId)) {
      throw new WorkflowError(
        'DISTINCT_APPROVER_REQUIRED',
        'A distinct approver is required at this step — you approved an earlier step'
      );
    }
  }

  if (decision === 'REJECT') {
    return { status: 'REJECTED', currentStep: state.currentStep, completed: true, approvedComplete: false };
  }

  // APPROVE: advance or complete.
  const isLast = idx === ordered.length - 1;
  if (isLast) {
    return { status: 'APPROVED', currentStep: state.currentStep, completed: true, approvedComplete: true };
  }
  const next = ordered[idx + 1];
  return { status: 'PENDING', currentStep: next.stepOrder, completed: false, approvedComplete: false };
}

/**
 * Validate a proposed chain definition (used by the workflow builder before persist).
 * Pure. Returns human-readable errors; empty array = valid. Enforces: at least one
 * step, unique ascending `stepOrder`, non-negative bands with max >= min when set, and
 * a recognized approver role. Bands may overlap (a $60k doc legitimately triggers a
 * "$0+" manager step AND a "$50k+" CFO step) — that is the intended tier-stacking.
 */
export function validateWorkflowSteps(steps: WorkflowStepDef[]): string[] {
  const errors: string[] = [];
  if (steps.length === 0) {
    errors.push('A workflow needs at least one step.');
    return errors;
  }
  const orders = new Set<number>();
  for (const s of steps) {
    if (!Number.isInteger(s.stepOrder) || s.stepOrder < 1) {
      errors.push(`Step order must be a positive integer (got ${s.stepOrder}).`);
    }
    if (orders.has(s.stepOrder)) {
      errors.push(`Duplicate step order ${s.stepOrder}.`);
    }
    orders.add(s.stepOrder);
    if (!Number.isInteger(s.minAmountCents) || s.minAmountCents < 0) {
      errors.push(`Step ${s.stepOrder}: minimum amount must be a non-negative integer (cents).`);
    }
    if (s.maxAmountCents !== null) {
      if (!Number.isInteger(s.maxAmountCents) || s.maxAmountCents < 0) {
        errors.push(`Step ${s.stepOrder}: maximum amount must be a non-negative integer (cents) or blank.`);
      } else if (s.maxAmountCents < s.minAmountCents) {
        errors.push(`Step ${s.stepOrder}: maximum amount is below the minimum.`);
      }
    }
    if (!(s.approverRole in ROLE_RANK)) {
      errors.push(`Step ${s.stepOrder}: unrecognized approver role "${s.approverRole}".`);
    }
  }
  return errors;
}
