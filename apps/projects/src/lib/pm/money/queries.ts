import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanSearch, core, one, pm, rows } from '@/lib/pm/db';
import type {
  AllowanceRow, BillingLineRow, BillingQueueRow, BillingRequestRow, CommitmentChangeRow, CommitmentLineRow, CommitmentRow, CommitmentStatusRow,
  ComplianceDocRow, CostCodeStatusRow, DepositRow, EstimateLineRow, EstimateRow, JobFinancialsRow, JobRetainageRow, MilestoneTaskRow,
  MilestoneWbsRow, PayApplicationRow, ReceiptRow, SeamHealthRow, SovLineRow, SovStatusRow, SovVersionRow, VendorRow,
} from './types';

// Column lists copied from 1102 / 1103 (Rule 11).
export const ESTIMATE_COLS =
  'id, location_id, job_id, customer_id, number, version, title, status, retainage_pct, valid_until, notes, total_cents, cost_total_cents, ' +
  'supersedes_id, budget_id, sent_at, accepted_at, accepted_by, declined_at, decline_reason, created_by, created_at, updated_at';
export const ESTIMATE_LINE_COLS =
  'id, estimate_id, line_no, cost_code_id, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, is_allowance, sort, ext, ' +
  'labor_rate_card_id, labor_hours';
export const COMMITMENT_COLS =
  'id, location_id, job_id, vendor_id, commitment_type, number, title, description, status, retainage_pct, payment_hold, hold_reason, version, ' +
  'executed_on, approved_by, approved_at, approval, event_id, last_emitted_hold, suppressed_reason, void_reason, created_by, created_at';
export const COMMITMENT_LINE_COLS =
  'id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, unit_cost_cents, amount_cents, original_amount_cents, received_qty, received_cents, billed_cents';
export const CCO_COLS =
  'id, job_id, commitment_id, number, commitment_line_id, cost_code_id, description, reason, amount_cents, owner_co_id, status, applied_line_id, ' +
  'approved_by, approved_at, reject_reason, created_by, created_at';
export const RECEIPT_COLS = 'id, job_id, commitment_id, commitment_line_id, qty, amount_cents, received_on, over_receipt, packing_slip, memo, status, created_by, created_at';
export const COMPLIANCE_COLS =
  'id, job_id, commitment_id, vendor_id, doc_type, status, required, expires_on, covers_through, amount_cents, notes, verified_by, verified_at, created_at';
export const CSTATUS_COLS =
  'org_id, job_id, location_id, commitment_id, number, commitment_type, vendor_id, vendor_name, status, version, retainage_pct, manual_hold, hold_reason, ' +
  'compliance_ok, payment_hold_effective, commitment_line_id, line_no, cost_code_id, cost_code, cost_type, description, original_amount_cents, ' +
  'approved_change_cents, revised_amount_cents, billed_cents, open_cents, over_billed_cents, qty, uom, unit_cost_cents, received_qty, received_cents, ' +
  'received_not_billed_cents, pct_billed';
export const SOV_VERSION_COLS = 'id, job_id, contract_id, version, status, retainage_pct, memo, activated_at, created_at';
export const SOV_LINE_COLS = 'id, sov_version_id, lineage_id, line_no, cost_code_id, description, scheduled_value_cents, retainage_pct, change_order_id, sort';
export const SOV_STATUS_COLS =
  'org_id, job_id, sov_version_id, sov_version, sov_status, sov_line_id, lineage_id, line_no, description, cost_code_id, scheduled_value_cents, ' +
  'work_completed_cents, stored_materials_cents, completed_and_stored_cents, pct_complete, balance_to_finish_cents, retainage_held_cents, ' +
  'retainage_released_cents, retainage_outstanding_cents, last_application_no';
export const BILLING_COLS =
  'id, location_id, job_id, contract_id, billing_type, billing_subtype, status, generated_by, application_no, sov_version_id, period_start, period_end, ' +
  'occurred_on, memo, source_ref, gross_earned_cents, retainage_cents, retainage_released_cents, net_cents, suppressed_reason, event_id, invoice_id, ' +
  'invoice_number, error_text, created_by, approved_by, approved_at, emitted_at, issued_at, void_reason, created_at';
export const BILLING_LINE_COLS =
  'id, billing_request_id, line_no, sort, line_type, description, amount_cents, cost_code_id, sov_line_id, sov_lineage_id, task_id, wbs_id, allowance_id, ' +
  'scheduled_value_cents, previous_work_cents, this_period_work_cents, stored_materials_cents, previous_stored_cents, total_completed_cents, pct_complete, ' +
  'balance_to_finish_cents, retainage_rate, retainage_work_to_date_cents, retainage_stored_to_date_cents, retainage_this_period_cents';
export const PAY_APP_COLS =
  'org_id, job_id, billing_request_id, application_no, period_end, status, sov_version_id, original_contract_cents, net_change_by_co_cents, ' +
  'contract_sum_to_date_cents, total_completed_stored_cents, retainage_work_cents, retainage_stored_cents, retainage_total_cents, ' +
  'total_earned_less_retainage_cents, previous_certificates_cents, current_payment_due_cents, balance_to_finish_incl_retainage_cents, request_net_cents';
export const QUEUE_COLS =
  'kind, id, org_id, location_id, job_id, job_number, job_name, customer_name, billing_type, billing_subtype, status, application_no, occurred_on, period_end, ' +
  'gross_earned_cents, retainage_cents, retainage_released_cents, net_cents, created_by, created_at, approved_by, emitted_at, error_text, age_days, ' +
  'failing_preconditions, next_action';
export const DEPOSIT_COLS =
  'id, location_id, job_id, customer_id, amount_cents, memo, occurred_on, status, suppressed_reason, source_ref, event_id, invoice_number, error_text, ' +
  'emitted_at, issued_at, created_by, created_at';
export const ALLOWANCE_COLS = 'id, job_id, cost_code_id, description, allowance_cents, actual_cents, status, estimate_line_id, variance_co_id, closed_at';
export const CCS_COLS =
  'org_id, job_id, cost_code_id, cost_code, cost_code_name, cost_type, budget_cents, committed_cents, committed_open_cents, actual_cents, pending_cents, ' +
  'uncommitted_cost_cents, forecast_cents, variance_cents, pct_spent';
export const FIN_COLS =
  'org_id, job_id, location_id, job_number, job_name, original_contract_cents, approved_co_cents, revised_contract_cents, pending_co_cents, ' +
  'budget_original_cents, revised_budget_cents, committed_cents, committed_open_cents, actual_cost_cents, pending_cost_cents, forecast_by_cost_code_cents, ' +
  'projected_final_cost_cents, cost_to_complete_cents, projected_margin_cents, projected_margin_pct, billed_to_date_cents, billed_net_to_date_cents, ' +
  'retainage_held_cents, retainage_released_cents, retainage_outstanding_cents, deposits_requested_cents, pct_complete_cost, earned_revenue_cents, ' +
  'over_under_billing_cents';
export const SEAM_COLS =
  'org_id, event_type, pending_count, processed_count, rejected_count, oldest_pending_at, oldest_pending_age_minutes, last_processed_at, alarm, last_drain_at';
export const VENDOR_COLS = 'id, name, display_name, email, city, default_retainage_pct, is_active';

const ids = (xs: ReadonlyArray<string>) => [...new Set(xs)];

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export interface EstimateBundle {
  estimates: EstimateRow[];
  lines: EstimateLineRow[];
}

export async function listEstimates(db: SupabaseClient, f: { jobId?: string; companyIds?: ReadonlyArray<string> }, limit = 500): Promise<EstimateRow[]> {
  let q = pm(db).from('estimates').select(ESTIMATE_COLS);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.companyIds?.length) q = q.in('location_id', [...f.companyIds]);
  return rows<EstimateRow>(await q.order('number', { ascending: false }).order('version', { ascending: false }).limit(limit), 'estimates');
}

export async function getJobEstimates(db: SupabaseClient, jobId: string): Promise<EstimateBundle> {
  const estimates = await listEstimates(db, { jobId });
  if (!estimates.length) return { estimates, lines: [] };
  const lines = rows<EstimateLineRow>(
    await pm(db).from('estimate_lines').select(ESTIMATE_LINE_COLS).in('estimate_id', estimates.map((e) => e.id)).order('sort').order('line_no'),
    'estimate lines',
  );
  return { estimates, lines };
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export interface CommitmentBundle {
  commitments: CommitmentRow[];
  lines: CommitmentLineRow[];
  status: CommitmentStatusRow[];
  changes: CommitmentChangeRow[];
  receipts: ReceiptRow[];
  compliance: ComplianceDocRow[];
  vendors: Record<string, string>;
}

export async function listCommitments(db: SupabaseClient, f: { jobId?: string; companyIds?: ReadonlyArray<string>; statuses?: ReadonlyArray<string> }, limit = 1000): Promise<CommitmentRow[]> {
  let q = pm(db).from('commitments').select(COMMITMENT_COLS);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.companyIds?.length) q = q.in('location_id', [...f.companyIds]);
  if (f.statuses?.length) q = q.in('status', [...f.statuses]);
  return rows<CommitmentRow>(await q.order('created_at', { ascending: false }).limit(limit), 'commitments');
}

export async function listCommitmentStatus(db: SupabaseClient, f: { jobId?: string; companyIds?: ReadonlyArray<string>; commitmentIds?: ReadonlyArray<string> }): Promise<CommitmentStatusRow[]> {
  let q = pm(db).from('v_commitment_status').select(CSTATUS_COLS);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.companyIds?.length) q = q.in('location_id', [...f.companyIds]);
  if (f.commitmentIds) {
    if (!f.commitmentIds.length) return [];
    q = q.in('commitment_id', ids(f.commitmentIds));
  }
  return rows<CommitmentStatusRow>(await q.order('number').order('line_no').limit(5000), 'commitment status');
}

export async function vendorNames(db: SupabaseClient, vendorIds: ReadonlyArray<string | null>): Promise<Record<string, string>> {
  const list = ids(vendorIds.filter((v): v is string => !!v));
  if (!list.length) return {};
  const vs = rows<Pick<VendorRow, 'id' | 'name' | 'display_name'>>(await core(db).from('vendors').select('id, name, display_name').in('id', list), 'vendor names');
  return Object.fromEntries(vs.map((v) => [v.id, v.display_name || v.name]));
}

export async function getJobCommitments(db: SupabaseClient, jobId: string): Promise<CommitmentBundle> {
  const commitments = await listCommitments(db, { jobId });
  const cids = commitments.map((c) => c.id);
  if (!cids.length) {
    const compliance = rows<ComplianceDocRow>(await pm(db).from('compliance_docs').select(COMPLIANCE_COLS).eq('job_id', jobId), 'compliance');
    return { commitments, lines: [], status: [], changes: [], receipts: [], compliance, vendors: {} };
  }
  const [lines, status, changes, receipts, compliance, vendors] = await Promise.all([
    pm(db).from('commitment_lines').select(COMMITMENT_LINE_COLS).in('commitment_id', cids).order('line_no').then((r) => rows<CommitmentLineRow>(r, 'commitment lines')),
    listCommitmentStatus(db, { jobId }),
    pm(db).from('commitment_changes').select(CCO_COLS).eq('job_id', jobId).order('created_at', { ascending: false }).then((r) => rows<CommitmentChangeRow>(r, 'commitment changes')),
    pm(db).from('receipts').select(RECEIPT_COLS).eq('job_id', jobId).order('received_on', { ascending: false }).limit(500).then((r) => rows<ReceiptRow>(r, 'receipts')),
    pm(db).from('compliance_docs').select(COMPLIANCE_COLS).eq('job_id', jobId).order('created_at').then((r) => rows<ComplianceDocRow>(r, 'compliance')),
    vendorNames(db, commitments.map((c) => c.vendor_id)),
  ]);
  return { commitments, lines, status, changes, receipts, compliance, vendors };
}

export async function searchVendors(db: SupabaseClient, q: string, limit = 8): Promise<VendorRow[]> {
  const term = cleanSearch(q);
  let query = core(db).from('vendors').select(VENDOR_COLS).eq('is_active', true);
  if (term) query = query.or(`name.ilike.*${term}*,display_name.ilike.*${term}*`);
  return rows<VendorRow>(await query.order('name').limit(limit), 'vendors');
}

export async function getVendor(db: SupabaseClient, id: string): Promise<VendorRow | null> {
  return one<VendorRow>(await core(db).from('vendors').select(VENDOR_COLS).eq('id', id).maybeSingle(), 'vendor');
}

export async function listComplianceForVendors(db: SupabaseClient, vendorIds: ReadonlyArray<string>): Promise<ComplianceDocRow[]> {
  if (!vendorIds.length) return [];
  return rows<ComplianceDocRow>(await pm(db).from('compliance_docs').select(COMPLIANCE_COLS).in('vendor_id', ids(vendorIds)).limit(5000), 'compliance');
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface BillingBundle {
  requests: BillingRequestRow[];
  lines: BillingLineRow[];
  queue: BillingQueueRow[];
  payApps: PayApplicationRow[];
  sovVersions: SovVersionRow[];
  sovLines: SovLineRow[];
  sovStatus: SovStatusRow[];
  deposits: DepositRow[];
  allowances: AllowanceRow[];
  tasks: MilestoneTaskRow[];
  wbs: MilestoneWbsRow[];
  retainage: JobRetainageRow | null;
  financials: JobFinancialsRow | null;
}

export async function getJobBilling(db: SupabaseClient, jobId: string): Promise<BillingBundle> {
  const [requests, queue, payApps, sovVersions, sovStatus, deposits, allowances, tasks, wbs, retainage, financials] = await Promise.all([
    pm(db).from('billing_requests').select(BILLING_COLS).eq('job_id', jobId).order('created_at', { ascending: false }).limit(500).then((r) => rows<BillingRequestRow>(r, 'billing requests')),
    pm(db).from('v_billing_queue').select(QUEUE_COLS).eq('job_id', jobId).then((r) => rows<BillingQueueRow>(r, 'billing queue')),
    pm(db).from('v_pay_application').select(PAY_APP_COLS).eq('job_id', jobId).order('application_no').then((r) => rows<PayApplicationRow>(r, 'pay applications')),
    pm(db).from('sov_versions').select(SOV_VERSION_COLS).eq('job_id', jobId).order('version', { ascending: false }).then((r) => rows<SovVersionRow>(r, 'SOV versions')),
    pm(db).from('v_sov_status').select(SOV_STATUS_COLS).eq('job_id', jobId).eq('sov_status', 'ACTIVE').order('line_no').then((r) => rows<SovStatusRow>(r, 'SOV status')),
    pm(db).from('deposit_requests').select(DEPOSIT_COLS).eq('job_id', jobId).order('created_at', { ascending: false }).then((r) => rows<DepositRow>(r, 'deposits')),
    pm(db).from('allowances').select(ALLOWANCE_COLS).eq('job_id', jobId).order('description').then((r) => rows<AllowanceRow>(r, 'allowances')),
    pm(db).from('tasks').select('id, title, status, is_milestone, due_on, completed_at, billing_amount_cents, billing_pct').eq('job_id', jobId).eq('is_milestone', true).order('sort').then((r) => rows<MilestoneTaskRow>(r, 'milestones')),
    pm(db).from('wbs_nodes').select('id, name, kind, pct_complete, billing_amount_cents, billing_pct').eq('job_id', jobId).eq('kind', 'MILESTONE').order('sort').then((r) => rows<MilestoneWbsRow>(r, 'WBS milestones')),
    pm(db).from('v_job_retainage').select('org_id, job_id, held_cents, released_cents, outstanding_cents').eq('job_id', jobId).maybeSingle().then((r) => one<JobRetainageRow>(r, 'retainage')),
    pm(db).from('v_job_financials').select(FIN_COLS).eq('job_id', jobId).maybeSingle().then((r) => one<JobFinancialsRow>(r, 'job financials')),
  ]);
  const reqIds = requests.map((r) => r.id);
  const versionIds = sovVersions.map((v) => v.id);
  const [lines, sovLines] = await Promise.all([
    reqIds.length
      ? pm(db).from('billing_request_lines').select(BILLING_LINE_COLS).in('billing_request_id', reqIds).order('sort').order('line_no').then((r) => rows<BillingLineRow>(r, 'billing lines'))
      : Promise.resolve([] as BillingLineRow[]),
    versionIds.length
      ? pm(db).from('sov_lines').select(SOV_LINE_COLS).in('sov_version_id', versionIds).order('sort').order('line_no').then((r) => rows<SovLineRow>(r, 'SOV lines'))
      : Promise.resolve([] as SovLineRow[]),
  ]);
  return { requests, lines, queue, payApps, sovVersions, sovLines, sovStatus, deposits, allowances, tasks, wbs, retainage, financials };
}

export async function getBillingRequest(db: SupabaseClient, id: string): Promise<BillingRequestRow | null> {
  return one<BillingRequestRow>(await pm(db).from('billing_requests').select(BILLING_COLS).eq('id', id).maybeSingle(), 'billing request');
}

export async function listBillingQueue(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<BillingQueueRow[]> {
  let q = pm(db).from('v_billing_queue').select(QUEUE_COLS);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<BillingQueueRow>(await q.order('created_at', { ascending: false }).limit(1000), 'billing queue');
}

/** Requests that left the queue: ISSUED and UNISSUED (approved where nothing is sent), most recent first. */
export async function listSettledBilling(db: SupabaseClient, companyIds: ReadonlyArray<string>, sinceIso: string, limit = 300): Promise<BillingRequestRow[]> {
  let q = pm(db).from('billing_requests').select(BILLING_COLS).in('status', ['ISSUED', 'UNISSUED']).gte('created_at', sinceIso);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<BillingRequestRow>(await q.order('created_at', { ascending: false }).limit(limit), 'billing history');
}

export async function listSettledDeposits(db: SupabaseClient, companyIds: ReadonlyArray<string>, sinceIso: string, limit = 300): Promise<DepositRow[]> {
  let q = pm(db).from('deposit_requests').select(DEPOSIT_COLS).in('status', ['ISSUED', 'UNISSUED']).gte('created_at', sinceIso);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<DepositRow>(await q.order('created_at', { ascending: false }).limit(limit), 'deposit history');
}

// ---------------------------------------------------------------------------
// Retainage, job cost, seam
// ---------------------------------------------------------------------------

export async function listJobRetainage(db: SupabaseClient): Promise<JobRetainageRow[]> {
  return rows<JobRetainageRow>(await pm(db).from('v_job_retainage').select('org_id, job_id, held_cents, released_cents, outstanding_cents').limit(5000), 'retainage');
}

export async function listReleases(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<BillingRequestRow[]> {
  let q = pm(db).from('billing_requests').select(BILLING_COLS).eq('billing_subtype', 'RETAINAGE_RELEASE').neq('status', 'VOID');
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<BillingRequestRow>(await q.order('created_at', { ascending: false }).limit(1000), 'retainage releases');
}

export async function listJobFinancials(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<JobFinancialsRow[]> {
  let q = pm(db).from('v_job_financials').select(FIN_COLS);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<JobFinancialsRow>(await q.limit(2000), 'job financials');
}

export async function getJobFinancials(db: SupabaseClient, jobId: string): Promise<JobFinancialsRow | null> {
  return one<JobFinancialsRow>(await pm(db).from('v_job_financials').select(FIN_COLS).eq('job_id', jobId).maybeSingle(), 'job financials');
}

export async function listCostCodeStatus(db: SupabaseClient, jobId: string): Promise<CostCodeStatusRow[]> {
  return rows<CostCodeStatusRow>(await pm(db).from('v_cost_code_status').select(CCS_COLS).eq('job_id', jobId).order('cost_code', { nullsFirst: false }), 'cost code status');
}

export async function listSeamHealth(db: SupabaseClient): Promise<SeamHealthRow[]> {
  return rows<SeamHealthRow>(await pm(db).from('v_seam_health').select(SEAM_COLS), 'seam health');
}

/** The contract a billing applies to (pm.primary_contract_id): earliest ACTIVE PRIME, else earliest ACTIVE. */
export interface PrimaryContract {
  id: string;
  kind: string;
  original_cents: number;
  retention_pct: number | null;
  retention_cap_cents: number | null;
  pct_complete: number | null;
  billing_mode: string | null;
}

export async function getPrimaryContract(db: SupabaseClient, jobId: string): Promise<PrimaryContract | null> {
  const list = rows<PrimaryContract & { created_at: string }>(
    await pm(db).from('contracts').select('id, kind, original_cents, retention_pct, retention_cap_cents, pct_complete, billing_mode, created_at').eq('job_id', jobId).eq('status', 'ACTIVE').order('created_at').order('id'),
    'contracts',
  );
  return list.find((c) => c.kind === 'PRIME') ?? list[0] ?? null;
}
