import 'server-only';
/**
 * The approvals engine from the server (RLS client only; every call is a guarded pm RPC of
 * 1113_pm_approvals.sql). Existing object routes call decideObject() instead of the object's
 * own approve RPC; the inbox and the phone API call the request functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { emitBudgetRevised } from '@/lib/pm/budget-ops';
import { notify } from '@/lib/notify/emit';
import { approvalErrorCopy } from './errors';
import type {
  ApprovalDetail, ApprovalObjectType, ApprovalPolicy, ApprovalTab, BulkResult, Channel, DecideResult, DelegateCandidate,
  ExceptionRow, InboxResult, MyDelegations, SizeBucket,
} from './types';

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw approvalError(fn, res.error);
  return res.data as T;
}

interface NotifyPlan {
  event: 'approval.requested' | 'approval.decided' | null;
  job_id?: string | null;
  company_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  recipients?: string[];
  title?: string;
  title_money?: string | null;
  body?: string | null;
  money_cap?: 'projects.contract_value' | 'projects.financials' | null;
  link?: string | null;
  dedupe?: string | null;
}

/**
 * Tell the next approvers (approval.requested) or the sender (approval.decided) through lib/notify.
 * Recipients and every word of text come from pm.approval_notify_plan (built from stored data),
 * never from the request. Never throws: a notification must not fail the decision.
 */
export async function notifyApproval(db: SupabaseClient, requestId: string | null | undefined): Promise<void> {
  if (!requestId) return;
  try {
    const res = await db.schema('pm').rpc('approval_notify_plan', { p_request: requestId });
    const plan = (res.data ?? null) as NotifyPlan | null;
    if (res.error || !plan?.event || !plan.recipients?.length || !plan.title) return;
    await notify(db, {
      event: plan.event, jobId: plan.job_id ?? null, companyId: plan.company_id ?? null, subjectType: plan.subject_type ?? null,
      subjectId: plan.subject_id ?? null, recipients: plan.recipients, title: plan.title, body: plan.body ?? null,
      titleWithMoney: plan.title_money ?? null, moneyCap: plan.money_cap ?? null, link: plan.link ?? null, dedupe: plan.dedupe ?? null,
    });
  } catch (e) {
    console.warn('[approvals] notify failed (non-fatal):', e);
  }
}

const NOTIFY_ON: ReadonlySet<DecideResult['status']> = new Set(['submitted', 'pending', 'approved', 'rejected', 'reopened', 'cancelled']);

async function told<T extends Pick<DecideResult, 'status' | 'request_id'>>(db: SupabaseClient, r: T): Promise<T> {
  if (NOTIFY_ON.has(r.status)) await notifyApproval(db, r.request_id);
  return r;
}

/** A PG error from an approval RPC: known tokens become plain HttpErrors. */
export function approvalError(what: string, err: PgErrorLike): Error {
  const c = approvalErrorCopy(err);
  if (c) return new HttpError(c.status, c.error, c.code);
  return new PmQueryError(what, err);
}

export interface DecideOptions {
  decision?: 'approve' | 'reject' | 'submit';
  reason?: string | null;
  selfReason?: string | null;
  /** stage_transition: the stage to move to. */
  ref?: string | null;
  channel?: Channel;
  /** Map a non-approval PG error the object's own RPC raised (e.g. billing preconditions). */
  objectError?: (err: PgErrorLike) => Error;
}

/**
 * Route an object's approve / reject / submit through the engine. status 'not_needed' means the
 * company does not gate it right now (estimates at or above the floor, stage moves without a
 * policy): the caller runs the object's own RPC as before.
 */
export async function decideObject(db: SupabaseClient, type: ApprovalObjectType, id: string, o: DecideOptions = {}): Promise<DecideResult> {
  const res = await db.schema('pm').rpc('approval_decide', {
    p_object_type: type, p_object_id: id, p_decision: o.decision ?? 'approve', p_reason: o.reason ?? null,
    p_self_reason: o.selfReason ?? null, p_object_ref: o.ref ?? null, p_channel: o.channel ?? 'web',
  });
  if (res.error) {
    // the object's own errors (preconditions, no pay rate …) keep the route's own copy
    if (!approvalErrorCopy(res.error) && o.objectError) throw o.objectError(res.error);
    throw approvalError('approval_decide', res.error);
  }
  return told(db, res.data as DecideResult);
}

export async function approvalNeeded(db: SupabaseClient, type: ApprovalObjectType, id: string, ref: string | null = null): Promise<boolean> {
  return rpc<boolean>(db, 'approval_needed', { p_object_type: type, p_object_id: id, p_object_ref: ref });
}

export async function actOnRequest(db: SupabaseClient, requestId: string, decision: 'approve' | 'reject', o: { reason?: string | null; selfReason?: string | null; channel?: Channel } = {}): Promise<DecideResult> {
  return told(db, await rpc<DecideResult>(db, 'approval_act', {
    p_request: requestId, p_decision: decision, p_reason: o.reason ?? null, p_self_reason: o.selfReason ?? null, p_channel: o.channel ?? 'web',
  }));
}

export async function actOnMany(db: SupabaseClient, ids: ReadonlyArray<string>, decision: 'approve' | 'reject', reason: string | null, channel: Channel = 'web'): Promise<BulkResult> {
  const r = await rpc<BulkResult>(db, 'approval_act_many', { p_requests: [...ids], p_decision: decision, p_reason: reason, p_channel: channel });
  for (const x of r.results) if (x.ok) await notifyApproval(db, x.id);
  return r;
}

export async function cancelRequest(db: SupabaseClient, requestId: string, reason: string | null): Promise<DecideResult> {
  return told(db, await rpc<DecideResult>(db, 'approval_cancel', { p_request: requestId, p_reason: reason }));
}

export interface InboxQuery {
  tab: ApprovalTab;
  types?: ReadonlyArray<ApprovalObjectType> | null;
  companyId?: string | null;
  jobId?: string | null;
  overdue?: boolean;
  limit?: number;
}

export async function loadInbox(db: SupabaseClient, q: InboxQuery): Promise<InboxResult> {
  return rpc<InboxResult>(db, 'approval_inbox', {
    p_tab: q.tab, p_types: q.types && q.types.length ? [...q.types] : null, p_location: q.companyId ?? null,
    p_job: q.jobId ?? null, p_overdue: q.overdue ?? false, p_limit: q.limit ?? 200,
  });
}

export async function loadRequest(db: SupabaseClient, requestId: string): Promise<ApprovalDetail> {
  return rpc<ApprovalDetail>(db, 'approval_request_detail', { p_request: requestId });
}

export async function loadObjectStatus(db: SupabaseClient, type: ApprovalObjectType, id: string): Promise<ApprovalDetail | { status: 'none'; needed: boolean }> {
  return rpc(db, 'approval_object_status', { p_object_type: type, p_object_id: id });
}

export async function loadDelegations(db: SupabaseClient): Promise<{ mine: MyDelegations; candidates: DelegateCandidate[] }> {
  const [mine, candidates] = await Promise.all([
    rpc<MyDelegations>(db, 'approval_my_delegations', {}),
    rpc<DelegateCandidate[]>(db, 'approval_delegate_candidates', {}),
  ]);
  return { mine, candidates: candidates ?? [] };
}

export interface NewDelegation {
  delegateMembershipId: string;
  startsAt: string;
  endsAt: string;
  maxAmountCents: number | null;
  objectTypes: ReadonlyArray<ApprovalObjectType>;
  notify: boolean;
  reason: string | null;
  delegatorMembershipId?: string | null;
}

export async function createDelegation(db: SupabaseClient, d: NewDelegation): Promise<string> {
  return rpc<string>(db, 'approval_set_delegation', {
    p_delegate: d.delegateMembershipId, p_starts: d.startsAt, p_ends: d.endsAt, p_max_cents: d.maxAmountCents,
    p_object_types: [...d.objectTypes], p_notify: d.notify, p_reason: d.reason, p_delegator: d.delegatorMembershipId ?? null,
  });
}

export async function revokeDelegation(db: SupabaseClient, id: string): Promise<void> {
  await rpc<null>(db, 'approval_revoke_delegation', { p_delegation: id });
}

export async function loadPolicy(db: SupabaseClient, companyId: string): Promise<ApprovalPolicy> {
  return rpc<ApprovalPolicy>(db, 'approval_policy', { p_location: companyId });
}

export interface CompanySettingsInput {
  size?: SizeBucket | null;
  solo?: boolean | null;
  marginFloor?: number | null;
  escalationRoles?: ReadonlyArray<string> | null;
  reseed?: boolean;
}

export async function saveCompanySettings(db: SupabaseClient, companyId: string, s: CompanySettingsInput): Promise<ApprovalPolicy> {
  return rpc<ApprovalPolicy>(db, 'approval_set_company', {
    p_location: companyId, p_size: s.size ?? null, p_solo: s.solo ?? null, p_margin_floor: s.marginFloor ?? null,
    p_escalation_roles: s.escalationRoles ? [...s.escalationRoles] : null, p_reseed: s.reseed ?? false,
  });
}

export async function loadExceptions(db: SupabaseClient, companyId: string | null, from: string | null, to: string | null): Promise<ExceptionRow[]> {
  return (await rpc<ExceptionRow[]>(db, 'approval_exception_report', { p_location: companyId, p_from: from, p_to: to })) ?? [];
}

/**
 * What the object's own route did after the RPC, done after an engine approval too: a budget
 * transfer that became the budget tells Merit Books the new cost estimate.
 */
export async function afterApproval(db: SupabaseClient, r: Pick<DecideResult, 'status' | 'object_type' | 'result'>, booksPresent: boolean): Promise<Record<string, unknown>> {
  if (r.status !== 'approved') return {};
  if (r.object_type === 'budget_transfer') {
    const jobId = typeof r.result?.job_id === 'string' ? r.result.job_id : null;
    if (jobId) return { books: await emitBudgetRevised(db, jobId, booksPresent) };
  }
  return {};
}

/** The shape existing object routes add to their response. */
export function approvalSummary(r: DecideResult): { status: DecideResult['status']; requestId: string | null; waitingOn: string | null; step: number | null; stepCount: number | null; message: string | null } {
  return {
    status: r.status, requestId: r.request_id ?? null, waitingOn: r.waiting_on ?? null, step: r.step ?? null,
    stepCount: r.step_count ?? null, message: r.message ?? null,
  };
}

export interface TimeApprovalOutcome {
  /** Entries now APPROVED (costed, sent to Merit Books by pm.approve_time_entries). */
  approved: number;
  /** Entries whose step this approver took, still waiting on a later step. */
  pending: number;
  /** Entries this approver could only send on (another tier, their own time …). */
  sentOn: number;
  results: Array<{ id: string; status: DecideResult['status']; waitingOn: string | null }>;
}

/**
 * Approve time entries through the engine, one request per entry, in order. Entries the engine
 * does not gate (a company without the engine) are approved together by pm.approve_time_entries,
 * as before. Labor errors keep their plain copy through `objectError`.
 */
export async function approveTimeEntries(db: SupabaseClient, ids: ReadonlyArray<string>, objectError: (err: PgErrorLike) => Error, channel: Channel = 'web'): Promise<TimeApprovalOutcome> {
  const out: TimeApprovalOutcome = { approved: 0, pending: 0, sentOn: 0, results: [] };
  const direct: string[] = [];
  for (const id of [...new Set(ids)]) {
    const r = await decideObject(db, 'time_entry', id, { channel, objectError });
    out.results.push({ id, status: r.status, waitingOn: r.waiting_on ?? null });
    if (r.status === 'not_needed') direct.push(id);
    else if (r.status === 'approved') out.approved += 1;
    else if (r.status === 'pending') out.pending += 1;
    else out.sentOn += 1;
  }
  if (direct.length) {
    const res = await db.schema('pm').rpc('approve_time_entries', { p_ids: direct });
    if (res.error) throw objectError(res.error);
    out.approved += Number(res.data ?? 0);
  }
  return out;
}
