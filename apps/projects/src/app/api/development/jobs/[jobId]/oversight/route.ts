export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { DEV_IMPORT_KINDS, parseDevImport } from '@/lib/development/import';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

/**
 * The development project's oversight (1124): entitlements + conditions + incentives (RED-05),
 * covenants (RED-06), interest reserve (RED-15), fee position (RED-16), vendor compliance (RED-20),
 * draw tracking (RED-29), construction status (RED-31), affiliate bills (RED-42) and the tie-out
 * (RED-44). Money sections need job financials; the rest needs the job.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['draw', 'budget', 'commitment', 'billing'] }, async ({ db, params, access }) => {
  const job = params.jobId!;
  const loc = resWrote<Array<{ location_id: string }>>(await pm(db).from('projects').select('location_id').eq('job_id', job).limit(1))[0]?.location_id ?? null;
  if (!loc) throw new HttpError(404, 'That job was not found.', 'NOT_FOUND');
  const money = can(access, 'projects.financials', 'view', loc);
  const entitlements = await resRpc<Record<string, unknown>>(db, 'dev_entitlement_board', { p_job: job });
  const status = resWrote<Array<{ id: string; kind: string; effective_on: string; note: string | null }>>(await pm(db).from('dev_status_events').select('id, kind, effective_on, note').eq('job_id', job).order('effective_on'));
  const folders = resWrote<Array<{ id: string; key: string | null; name: string; sort: number }>>(await pm(db).from('doc_folders').select('id, key, name, sort').eq('job_id', job).order('sort'));
  if (!money) return { money: false, entitlements, statusEvents: status, folders };
  const [interest, fees, tracking, tieout] = await Promise.all([
    resRpc(db, 'dev_interest_reserve', { p_job: job }),
    resRpc(db, 'dev_fee_position', { p_job: job }),
    resRpc(db, 'dev_draw_tracking', { p_job: job }),
    resRpc(db, 'dev_tieout', { p_job: job }),
  ]);
  const compliance = can(access, 'projects.commitments', 'view', loc) ? await resRpc(db, 'dev_compliance', { p_job: job }) : null;
  const covenants = resWrote<Array<Record<string, unknown>>>(await pm(db).from('dev_covenants').select('id, kind, name, party, frequency, comparator, threshold, next_due_on, last_value, last_tested_on, status').eq('job_id', job).order('next_due_on'));
  const affiliate = resWrote<Array<Record<string, unknown>>>(await pm(db).from('dev_affiliate_bills').select('id, gc_job_id, billing_request_id, amount_cents, memo, status, approved_at').eq('job_id', job).order('created_at', { ascending: false }));
  const imports = resWrote<Array<Record<string, unknown>>>(await pm(db).from('dev_imports').select('id, kind, file_name, status, mapping, result, created_at').eq('job_id', job).order('created_at', { ascending: false }).limit(10));
  return { money: true, entitlements, statusEvents: status, folders, interest, fees, tracking, tieout, compliance, covenants, affiliate, imports };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('condition'), entitlementId: Uuid, condition: Text(2000).min(1), dueOn: Day.nullish(), owner: Text(200).nullish() }),
  z.object({ op: z.literal('condition_status'), conditionId: Uuid, status: z.enum(['OPEN', 'MET', 'WAIVED']), documentId: Uuid.nullish() }),
  z.object({ op: z.literal('covenant'), covenantId: Uuid.nullish(), fields: z.object({ kind: z.enum(['DSCR', 'LTV', 'DEBT_YIELD', 'MIN_LIQUIDITY', 'NET_WORTH', 'REPORTING', 'INSURANCE', 'OTHER']).optional(),
    name: Text(200).optional(), party: z.enum(['LENDER', 'INVESTOR', 'AUTHORITY']).optional(), frequency: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL', 'ONCE']).optional(),
    comparator: z.enum(['>=', '<=']).nullish(), threshold: z.number().nullish(), next_due_on: Day.optional(), reminder_days: z.number().int().min(0).max(365).optional(),
    status: z.enum(['OK', 'BREACH', 'WAIVED', 'ENDED']).optional(), notes: Text(2000).nullish() }) }),
  z.object({ op: z.literal('covenant_test'), covenantId: Uuid, value: z.number().nullish(), on: Day.nullish() }),
  z.object({ op: z.literal('interest'), month: Day, interestCents: Cents, source: z.enum(['ESTIMATE', 'LENDER_STATEMENT', 'BOOKS']).default('LENDER_STATEMENT'), note: Text(500).nullish() }),
  z.object({ op: z.literal('fee_schedule'), kind: z.enum(['DEVELOPER_FEE', 'CM_FEE', 'ASSET_MGMT_FEE']), totalCents: Cents, earnBasis: z.enum(['PCT_COMPLETE', 'MILESTONE', 'MONTHLY', 'AT_CLOSING']),
    schedule: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(60).default([]), drawBudgetLineId: Uuid.nullish(), payeeCompanyId: Uuid.nullish() }),
  z.object({ op: z.literal('fee_draw'), feeId: Uuid, amountCents: Cents.refine((n) => n > 0, 'More than zero'), drawId: Uuid.nullish() }),
  z.object({ op: z.literal('co_funding'), changeOrderId: Uuid, funding: z.enum(['CONTINGENCY', 'BUDGET_LINE', 'OWNER_EQUITY', 'GC_CONTINGENCY']), pool: z.enum(['HARD', 'SOFT', 'OWNER']).nullish(),
    costCodeId: Uuid.nullish(), drawBudgetLineId: Uuid.nullish() }),
  z.object({ op: z.literal('co_consent'), changeOrderId: Uuid, note: Text(1000).min(1, 'Record who at the lender consented and how'), documentId: Uuid.nullish() }),
  z.object({ op: z.literal('pay_app_review'), commitmentId: Uuid, applicationNo: z.number().int().min(1), periodTo: Day.nullish(), inspectorPct: z.number().min(0).max(1).nullish(),
    lines: z.array(z.object({ line_no: z.number().int().min(1), description: Text(300).optional(), scheduled_value_cents: Cents, previous_cents: Cents, this_period_cents: Cents,
      stored_cents: Cents.default(0), retainage_cents: Cents.default(0) })).min(1).max(500) }),
  z.object({ op: z.literal('milestones'), dates: z.record(z.string().regex(/^[a-z_]{2,40}$/), Day).default({}) }),
  z.object({ op: z.literal('status_event'), kind: z.enum(['START', 'SUSPEND', 'RESUME', 'SUBSTANTIAL_COMPLETION', 'FINAL_COMPLETION']), effectiveOn: Day, note: Text(2000).nullish() }),
  z.object({ op: z.literal('doc_room') }),
  z.object({ op: z.literal('share_folder'), folderId: Uuid, audiences: z.array(z.enum(['customer', 'vendor', 'lender', 'investor'])).max(4) }),
  z.object({ op: z.literal('affiliate_bill'), gcJobId: Uuid, amountCents: Cents.refine((n) => n > 0, 'More than zero'), memo: Text(500).nullish(), costCodeId: Uuid.nullish() }),
  z.object({ op: z.literal('affiliate_approve'), billId: Uuid, selfReason: Text(500).nullish() }),
  z.object({ op: z.literal('import_stage'), kind: z.enum(DEV_IMPORT_KINDS), fileName: Text(255).min(1), text: z.string().min(1).max(5_000_000) }),
  z.object({ op: z.literal('import_map'), importId: Uuid, mapping: z.array(z.object({ row: z.number().int().min(1), cost_code_id: Uuid, draw_budget_line_id: Uuid.nullish(),
    category: z.enum(['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER']), cip_account_ref: Text(40).nullish(), pool: z.enum(['HARD', 'SOFT', 'OWNER']).nullish() })).max(2000) }),
  z.object({ op: z.literal('import_apply'), importId: Uuid }),
  z.object({ op: z.literal('incentive'), incentiveId: Uuid.nullish(), fields: z.object({ kind: z.enum(['TIF', 'ABATEMENT', 'GRANT', 'TAX_CREDIT', 'OTHER']).optional(), name: Text(200).min(1).optional(),
    authority: Text(200).nullish(), amount_cents: Cents.nullish(), term_years: z.number().int().min(0).max(50).nullish(),
    status: z.enum(['PURSUING', 'APPLIED', 'APPROVED', 'EXECUTED', 'DENIED', 'EXPIRED']).optional(), approved_on: Day.nullish(), conditions: Text(4000).nullish() }) }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' },
  ops: {
    condition: { cap: 'projects.jobs', action: 'edit' }, condition_status: { cap: 'projects.jobs', action: 'edit' }, covenant: { cap: 'projects.financials', action: 'edit' },
    covenant_test: { cap: 'projects.financials', action: 'edit' }, interest: { cap: 'projects.financials', action: 'edit' }, fee_schedule: { cap: 'projects.financials', action: 'edit' },
    fee_draw: { cap: 'projects.financials', action: 'edit' }, co_funding: { cap: 'projects.financials', action: 'edit' }, co_consent: { cap: 'projects.financials', action: 'edit' },
    pay_app_review: { cap: 'projects.financials', action: 'view' }, milestones: { cap: 'projects.jobs', action: 'edit' }, status_event: { cap: 'projects.jobs', action: 'edit' },
    doc_room: { cap: 'projects.documents', action: 'edit' }, share_folder: { cap: 'projects.documents', action: 'edit' }, affiliate_bill: { cap: 'projects.financials', action: 'edit' },
    affiliate_approve: { cap: 'projects.financials', action: 'edit' }, import_stage: { cap: 'projects.financials', action: 'edit' }, import_map: { cap: 'projects.financials', action: 'edit' },
    import_apply: { cap: 'projects.financials', action: 'edit' }, incentive: { cap: 'projects.financials', action: 'edit' },
  },
  mask: ['draw', 'budget', 'commitment', 'billing', 'change_order'], body: Body }, async ({ db, params, body }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'condition': return { conditionId: await resRpc<string>(db, 'dev_add_entitlement_condition', { p_entitlement: body.entitlementId, p_condition: body.condition, p_due_on: body.dueOn ?? null, p_owner: body.owner ?? null }) };
    case 'condition_status': return { conditionId: await resRpc<string>(db, 'dev_set_condition_status', { p_condition: body.conditionId, p_status: body.status, p_document: body.documentId ?? null }) };
    case 'covenant': return { covenantId: await resRpc<string>(db, 'dev_save_covenant', { p_job: job, p_covenant: body.covenantId ?? null, p_fields: body.fields }) };
    case 'covenant_test': return resRpc(db, 'dev_test_covenant', { p_covenant: body.covenantId, p_value: body.value ?? null, p_on: body.on ?? null });
    case 'interest': return { id: await resRpc<string>(db, 'dev_record_interest', { p_job: job, p_month: body.month, p_interest_cents: body.interestCents, p_source: body.source, p_note: body.note ?? null }) };
    case 'fee_schedule': return { feeId: await resRpc<string>(db, 'dev_set_fee_schedule', { p_job: job, p_kind: body.kind, p_total_cents: body.totalCents, p_earn_basis: body.earnBasis,
      p_schedule: body.schedule, p_draw_budget_line: body.drawBudgetLineId ?? null, p_payee_location: body.payeeCompanyId ?? null }) };
    case 'fee_draw': return resRpc(db, 'dev_request_fee_draw', { p_fee: body.feeId, p_amount_cents: body.amountCents, p_draw: body.drawId ?? null });
    case 'co_funding': return resRpc(db, 'dev_set_co_funding', { p_change_order: body.changeOrderId, p_funding: body.funding, p_pool: body.pool ?? null, p_cost_code: body.costCodeId ?? null, p_draw_budget_line: body.drawBudgetLineId ?? null });
    case 'co_consent': return { fundingId: await resRpc<string>(db, 'dev_record_co_consent', { p_change_order: body.changeOrderId, p_note: body.note, p_document: body.documentId ?? null }) };
    case 'pay_app_review': return resRpc(db, 'dev_review_pay_app', { p_commitment: body.commitmentId, p_application_no: body.applicationNo, p_lines: body.lines, p_period_to: body.periodTo ?? null, p_inspector_pct: body.inspectorPct ?? null });
    case 'milestones': return { added: await resRpc<number>(db, 'dev_seed_milestones', { p_job: job, p_dates: body.dates }) };
    case 'status_event': return resRpc(db, 'dev_record_status_event', { p_job: job, p_kind: body.kind, p_effective_on: body.effectiveOn, p_note: body.note ?? null });
    case 'doc_room': return { added: await resRpc<number>(db, 'dev_seed_doc_room', { p_job: job }) };
    case 'share_folder': return resRpc(db, 'dev_share_folder', { p_folder: body.folderId, p_audiences: body.audiences });
    case 'affiliate_bill': return resRpc(db, 'dev_affiliate_bill', { p_job: job, p_gc_job: body.gcJobId, p_amount_cents: body.amountCents, p_memo: body.memo ?? null, p_cost_code: body.costCodeId ?? null });
    case 'affiliate_approve': return resRpc(db, 'dev_approve_affiliate_bill', { p_bill: body.billId, p_self_reason: body.selfReason ?? null });
    case 'import_stage': {
      const parsed = parseDevImport(body.kind, body.text);
      if (parsed.rows.length === 0) throw new HttpError(422, parsed.issues[0]?.message ?? 'No rows were found in that file.', 'PM_INVALID');
      const r = await resRpc<Record<string, unknown>>(db, 'dev_stage_import', { p_job: job, p_kind: body.kind, p_file_name: body.fileName, p_rows: parsed.rows });
      return { ...r, issues: parsed.issues, totalCents: parsed.totalCents };
    }
    case 'import_map': return resRpc(db, 'dev_set_import_map', { p_import: body.importId, p_mapping: body.mapping });
    case 'import_apply': return resRpc(db, 'dev_apply_import', { p_import: body.importId });
    case 'incentive': {
      // dev_incentives is a member-writable job-money table (class M); RLS decides.
      if (body.incentiveId) {
        resWrote(await pm(db).from('dev_incentives').update({ ...body.fields, updated_at: new Date().toISOString() }).eq('id', body.incentiveId).eq('job_id', job).select('id'));
        return { incentiveId: body.incentiveId };
      }
      if (!body.fields.kind || !body.fields.name) throw new HttpError(422, 'An incentive needs a kind and a name.', 'PM_INVALID');
      const row = resWrote<Array<{ id: string }>>(await pm(db).from('dev_incentives').insert({ job_id: job, ...body.fields }).select('id'));
      return { incentiveId: row[0]?.id ?? null };
    }
  }
});
