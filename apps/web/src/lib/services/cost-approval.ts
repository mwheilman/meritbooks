/**
 * Books-side cost approval + configurable routing.
 *
 * A cost attributed to a job is recorded as a job_cost_attribution and moves
 * through a lifecycle. Each transition emits the matching JOB_COST event
 * (contract §3). Routing is configurable (by vendor / GL code / transaction
 * source / default) and overridable after the fact. The PM/leader is one
 * approver destination; the bill stays Books-owned throughout.
 *
 * Gates (contract §5):
 *   PAYABLE_APPROVAL        -> starts PENDING, clears on approval
 *   BANKFEED_CATEGORIZATION -> clears immediately (cash already spent)
 *   TIMESHEET_PAYROLL       -> starts PENDING, clears on timesheet/payroll approval
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitJobCostEvent, type CostType, type Gate } from './job-cost-events';

type DB = SupabaseClient;

export type ApproverType = 'ACCOUNTING' | 'RESPONSIBLE_PARTY' | 'PM_LEADER';

export interface RoutingContext {
  vendorId?: string | null;
  accountNumber?: string | null;
  sourceType?: string | null;
}

export interface ResolvedApprover {
  approver_type: ApproverType;
  approver_ref: string | null;
}

/**
 * Resolve the approver for a cost from the org's routing rules. Most-specific
 * match wins (VENDOR > GL_CODE > TRANSACTION_SOURCE > DEFAULT), then lowest
 * priority. Falls back to direct ACCOUNTING approval when no rule matches.
 */
export async function resolveApprover(db: DB, orgId: string, ctx: RoutingContext): Promise<ResolvedApprover> {
  const { data } = await db
    .from('cost_approval_rules')
    .select('match_type, match_value, approver_type, approver_ref, priority')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('priority', { ascending: true });

  const rules = data ?? [];
  const specificity: Record<string, number> = { VENDOR: 0, GL_CODE: 1, TRANSACTION_SOURCE: 2, DEFAULT: 3 };

  const matches = rules.filter((r) => {
    const mt = (r as { match_type: string }).match_type;
    const mv = (r as { match_value: string | null }).match_value;
    if (mt === 'VENDOR') return ctx.vendorId != null && mv === ctx.vendorId;
    if (mt === 'GL_CODE') return ctx.accountNumber != null && mv === ctx.accountNumber;
    if (mt === 'TRANSACTION_SOURCE') return ctx.sourceType != null && mv === ctx.sourceType;
    if (mt === 'DEFAULT') return true;
    return false;
  });

  matches.sort((a, b) => {
    const sa = specificity[(a as { match_type: string }).match_type] ?? 9;
    const sb = specificity[(b as { match_type: string }).match_type] ?? 9;
    if (sa !== sb) return sa - sb;
    return ((a as { priority: number }).priority) - ((b as { priority: number }).priority);
  });

  const best = matches[0] as { approver_type: ApproverType; approver_ref: string | null } | undefined;
  return best
    ? { approver_type: best.approver_type, approver_ref: best.approver_ref ?? null }
    : { approver_type: 'ACCOUNTING', approver_ref: null };
}

export interface CreateAttributionInput {
  orgId: string;
  locationId: string;
  jobId: string;
  departmentId?: string | null;
  costType: CostType;
  amountCents: number;
  occurredOn: string;
  gate: Gate;
  sourceType: 'BILL' | 'BANK_TXN' | 'TIMESHEET' | 'MANUAL';
  sourceRef?: string | null;
  memo?: string | null;
  routing?: RoutingContext;
  glEntryId?: string | null;
}

/**
 * Create a cost attribution. BANKFEED_CATEGORIZATION clears immediately
 * (no approval); other gates start PENDING and route to an approver. Emits the
 * matching JOB_COST event (PENDING or CLEARED).
 */
export async function createAttribution(db: DB, input: CreateAttributionInput) {
  const clearsImmediately = input.gate === 'BANKFEED_CATEGORIZATION';
  const approver = clearsImmediately
    ? { approver_type: 'ACCOUNTING' as ApproverType, approver_ref: null }
    : await resolveApprover(db, input.orgId, input.routing ?? {});

  const lifecycle = clearsImmediately ? 'CLEARED' : 'PENDING';

  const { data, error } = await db
    .from('job_cost_attributions')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      job_id: input.jobId,
      department_id: input.departmentId ?? null,
      cost_type: input.costType,
      amount_cents: input.amountCents,
      occurred_on: input.occurredOn,
      gate: input.gate,
      lifecycle,
      source_type: input.sourceType,
      source_ref: input.sourceRef ?? null,
      gl_entry_id: input.glEntryId ?? null,
      approver_type: approver.approver_type,
      approver_ref: approver.approver_ref,
      approved_by: clearsImmediately ? 'system:bankfeed' : null,
      approved_at: clearsImmediately ? new Date().toISOString() : null,
      memo: input.memo ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createAttribution: ${error?.message ?? 'insert failed'}`);

  await emitJobCostEvent(db, {
    orgId: input.orgId,
    locationId: input.locationId,
    jobId: input.jobId,
    departmentId: input.departmentId ?? null,
    costType: input.costType,
    amountCents: input.amountCents,
    occurredOn: input.occurredOn,
    lifecycle,
    gate: input.gate,
    sourceRef: input.sourceRef ?? (data as { id: string }).id,
    glEntryId: input.glEntryId ?? null,
    memo: input.memo ?? null,
  });

  return { id: (data as { id: string }).id, lifecycle };
}

async function loadAttribution(db: DB, orgId: string, id: string) {
  const { data, error } = await db
    .from('job_cost_attributions')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', id)
    .single();
  if (error || !data) throw new Error('Attribution not found');
  return data as Record<string, unknown>;
}

/** Approve a PENDING attribution -> CLEARED, and emit CLEARED. */
export async function approveAttribution(db: DB, orgId: string, id: string, approvedBy: string) {
  const a = await loadAttribution(db, orgId, id);
  if (a.lifecycle === 'VOIDED') throw new Error('Cannot approve a voided cost');
  if (a.lifecycle === 'CLEARED') return { id, lifecycle: 'CLEARED' as const };

  const { error } = await db
    .from('job_cost_attributions')
    .update({ lifecycle: 'CLEARED', approved_by: approvedBy, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`approveAttribution: ${error.message}`);

  await emitJobCostEvent(db, {
    orgId, locationId: String(a.location_id), jobId: String(a.job_id),
    departmentId: (a.department_id as string) ?? null, costType: a.cost_type as CostType,
    amountCents: Number(a.amount_cents), occurredOn: String(a.occurred_on), lifecycle: 'CLEARED',
    gate: a.gate as Gate, sourceRef: (a.source_ref as string) ?? id, glEntryId: (a.gl_entry_id as string) ?? null,
    memo: (a.memo as string) ?? null,
  });
  return { id, lifecycle: 'CLEARED' as const };
}

/** Void an attribution -> VOIDED, and emit VOIDED. */
export async function voidAttribution(db: DB, orgId: string, id: string, reason: string) {
  const a = await loadAttribution(db, orgId, id);
  const { error } = await db
    .from('job_cost_attributions')
    .update({ lifecycle: 'VOIDED', void_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`voidAttribution: ${error.message}`);

  await emitJobCostEvent(db, {
    orgId, locationId: String(a.location_id), jobId: String(a.job_id),
    departmentId: (a.department_id as string) ?? null, costType: a.cost_type as CostType,
    amountCents: Number(a.amount_cents), occurredOn: String(a.occurred_on), lifecycle: 'VOIDED',
    gate: a.gate as Gate, sourceRef: (a.source_ref as string) ?? id, glEntryId: (a.gl_entry_id as string) ?? null,
    memo: reason,
  });
  return { id, lifecycle: 'VOIDED' as const };
}

/** Override the routed approver after the fact (no lifecycle change). */
export async function overrideApprover(db: DB, orgId: string, id: string, approverType: ApproverType, approverRef: string | null) {
  const { error } = await db
    .from('job_cost_attributions')
    .update({ approver_type: approverType, approver_ref: approverRef, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) throw new Error(`overrideApprover: ${error.message}`);
  return { id };
}
