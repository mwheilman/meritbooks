export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { decideObject } from '@/lib/approvals/server';
import { dwrite, toHttp } from '@/lib/pm/dealer/rpc';
import { depthErrorCopy } from '@/lib/dealer/errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

const STAGES = ['PURSUIT', 'UNDER_CONTRACT', 'PRE_DEVELOPMENT', 'SPE_FORMED', 'CAPITALIZED', 'CONSTRUCTION', 'SUBSTANTIAL_COMPLETION', 'LEASE_UP', 'STABILIZED', 'REFI_DISPOSITION', 'WIND_DOWN', 'DEAD'] as const;
const SOURCE_KINDS = ['SENIOR_LOAN', 'MEZZ', 'PREF_EQUITY', 'SPONSOR_EQUITY', 'LP_EQUITY', 'TIF', 'GRANT', 'TAX_CREDIT', 'OTHER'] as const;
const CATEGORIES = ['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER'] as const;
const KEY_DATES = ['DD_EXPIRY', 'EARNEST_HARD_DATE', 'PSA_CLOSING', 'LOAN_CLOSING', 'RATE_LOCK', 'COMPLETION_GUARANTY', 'OUTSIDE_COMPLETION', 'LOAN_MATURITY', 'EXTENSION_OPTION', 'RATE_CAP_EXPIRY', 'LENDER_REPORT', 'INVESTOR_REPORT', 'OTHER'] as const;

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

/**
 * One development project: the SPE, pro forma versions, the budget grid (original → revised →
 * committed → pending CO → ECAC → paid → drawn → remaining, mapped to lender lines and CIP),
 * sources, the in-balance test, contingency pools and their log, key dates, and the investor view
 * read from Merit Books. Sections the caller cannot see come back null.
 */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'budget', 'billing'] }, async ({ db, params }) => {
  const job = params.jobId!;
  const pm = db.schema('pm');
  const [project, spe, proFormas, sources, keyDates, reallocations, grid, balance, contingency, investors, schedules] = await Promise.all([
    pm.from('dev_projects').select('spe_name, spe_location_id, sponsor_location_id, product_type, stage, address, parcels, gc_vendor_id, contract_type, block_out_of_balance, schedule_behind_days, spe_request_status').eq('job_id', job).maybeSingle().then((r) => r.data),
    pm.from('dev_spe_requests').select('id, status, payload, provisioned_location_id, books_note, created_at').eq('job_id', job).order('created_at', { ascending: false }).limit(1).maybeSingle().then((r) => r.data),
    xrows<Record<string, unknown>>(pm.from('dev_pro_formas').select('id, label, kind, status, inputs, results, computed_at, locked_at, created_at').eq('job_id', job).order('created_at', { ascending: false }), 'pro formas'),
    xrows<Record<string, unknown>>(pm.from('dev_sources').select('id, kind, name, commitment_cents, funded_cents, funded_as_of, rank, funding_rule, draw_schedule_id, notes').eq('job_id', job).order('rank'), 'sources'),
    xrows<Record<string, unknown>>(pm.from('dev_key_dates').select('id, kind, label, due_on, status, reminder_days, notes').eq('job_id', job).order('due_on'), 'key dates'),
    xrows<Record<string, unknown>>(pm.from('dev_reallocations').select('id, from_cost_code_id, to_cost_code_id, cents, reason, budget_id, lender_consent_required, lender_consent_ref, lender_consent_on, status, approved_at, created_at').eq('job_id', job).order('created_at', { ascending: false }), 'reallocations'),
    soft(xcall<Record<string, unknown>>(db, 'dev_budget_grid', { p_job: job })),
    soft(xcall<Record<string, unknown>>(db, 'dev_in_balance', { p_job: job })),
    soft(xcall<Record<string, unknown>>(db, 'dev_contingency', { p_job: job })),
    soft(xcall<Record<string, unknown>>(db, 'dev_investor_view', { p_job: job })),
    xrows<Record<string, unknown>>(pm.from('draw_schedules').select('id, lender_name, loan_number, loan_commitment_cents, status').eq('job_id', job), 'draw schedules'),
  ]);
  const draws = schedules.length
    ? await xrows<Record<string, unknown>>(pm.from('draws').select('id, draw_schedule_id, draw_number, status, period_end, inspection_status, requested_cents, approved_cents, created_at').in('draw_schedule_id', schedules.map((s) => s.id as string)).order('created_at', { ascending: false }), 'draws')
    : [];
  const lenderLines = schedules.length
    ? await xrows<{ id: string; draw_schedule_id: string; line_no: number; description: string; category: string | null }>(pm.from('draw_budget_lines').select('id, draw_schedule_id, line_no, description, category').in('draw_schedule_id', schedules.map((s) => s.id as string)).order('line_no'), 'lender lines')
    : [];
  return { project, spe, proFormas, sources, keyDates, reallocations, grid, balance, contingency, investors, schedules, draws, lenderLines };
});

const ProForma = z.object({
  total_cost_cents: PosCents, loan_cents: PosCents, interest_rate: z.number().min(0).max(0.5), noi_annual_cents: PosCents,
  equity_cash_flows_cents: z.array(z.number().int().min(-1e13).max(1e13)).min(2).max(480), periods_per_year: z.union([z.literal(1), z.literal(4), z.literal(12)]).default(1),
  amort_years: z.number().int().min(0).max(40).nullish(),
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_project'), fields: z.object({ spe_name: Text(200), product_type: z.enum(['FOR_RENT', 'FOR_SALE', 'MIXED']), stage: z.enum(STAGES), address: Text(300), parcels: Text(300), gc_vendor_id: Uuid.nullable(), contract_type: z.enum(['GMP', 'STIPULATED_SUM', 'COST_PLUS']).nullable(), block_out_of_balance: z.boolean() }).partial() }),
  z.object({ op: z.literal('request_spe'), entityName: Req(200, 'The entity name'), stateOfFormation: z.string().regex(/^[A-Z]{2}$/, 'Two-letter state'), notes: Text(1000).nullish() }),
  z.object({ op: z.literal('save_pro_forma'), label: Req(120, 'A label'), kind: z.enum(['UNDERWRITTEN', 'IC_APPROVED', 'CURRENT', 'SCENARIO']), inputs: ProForma, id: Uuid.nullish() }),
  z.object({ op: z.literal('lock_pro_forma'), id: Uuid }),
  z.object({ op: z.literal('map_line'), costCodeId: Uuid, category: z.enum(CATEGORIES), pool: z.enum(['HARD', 'SOFT', 'OWNER']).nullish(), drawBudgetLineId: Uuid.nullish(), cipRef: Text(40).nullish(), sort: z.number().int().min(0).max(10000).nullish() }),
  z.object({ op: z.literal('add_source'), kind: z.enum(SOURCE_KINDS), name: Req(120, 'The name'), commitmentCents: PosCents, fundedCents: PosCents.default(0), fundedAsOf: IsoDate.nullish(), rank: z.number().int().min(1).max(20).default(1), fundingRule: z.enum(['EQUITY_FIRST', 'PRO_RATA', 'SEQUENCED']).default('SEQUENCED'), drawScheduleId: Uuid.nullish() }),
  z.object({ op: z.literal('update_source'), sourceId: Uuid, fundedCents: PosCents, fundedAsOf: IsoDate.nullish() }),
  z.object({ op: z.literal('add_key_date'), kind: z.enum(KEY_DATES), label: Text(120).nullish(), dueOn: IsoDate, reminderDays: z.number().int().min(0).max(365).default(14) }),
  z.object({ op: z.literal('key_date_done'), keyDateId: Uuid, status: z.enum(['DONE', 'WAIVED', 'OPEN']) }),
  z.object({ op: z.literal('propose_reallocation'), fromCostCodeId: Uuid, toCostCodeId: Uuid, cents: z.number().int().positive().max(1e13), reason: Req(500, 'A reason'), lenderConsentRequired: z.boolean().nullish() }),
  z.object({ op: z.literal('lender_consent'), reallocationId: Uuid, ref: Req(200, 'The consent reference'), on: IsoDate.nullish() }),
  z.object({ op: z.literal('approve_reallocation'), reallocationId: Uuid }),
  z.object({ op: z.literal('cancel_reallocation'), reallocationId: Uuid }),
  z.object({ op: z.literal('capital_plan'), start: IsoDate, months: z.number().int().min(1).max(120) }),
]);

export const POST = route({
  access: { cap: 'projects.financials', action: 'view' },
  ops: {
    set_project: { cap: 'projects.jobs', action: 'edit' }, request_spe: { cap: 'projects.financials', action: 'edit' }, save_pro_forma: { cap: 'projects.financials', action: 'edit' },
    lock_pro_forma: { cap: 'projects.financials', action: 'edit' }, map_line: { cap: 'projects.financials', action: 'edit' }, add_source: { cap: 'projects.financials', action: 'edit' },
    update_source: { cap: 'projects.financials', action: 'edit' }, add_key_date: { cap: 'projects.jobs', action: 'edit' }, key_date_done: { cap: 'projects.jobs', action: 'edit' },
    propose_reallocation: { cap: 'projects.financials', action: 'edit' }, lender_consent: { cap: 'projects.financials', action: 'edit' }, cancel_reallocation: { cap: 'projects.financials', action: 'edit' },
    capital_plan: { cap: 'projects.financials', action: 'edit' },
  },
  mask: ['job', 'budget', 'billing'],
  body: Op,
}, async ({ db, params, body }) => {
  const job = params.jobId!;
  const pm = db.schema('pm');
  switch (body.op) {
    case 'set_project':
      return { id: await xcall<string>(db, 'dev_set_project', { p_job: job, p_fields: body.fields }) };
    case 'request_spe':
      return { id: await xcall<string>(db, 'dev_request_spe', { p_job: job, p_payload: { entity_name: body.entityName, state_of_formation: body.stateOfFormation, notes: body.notes ?? null } }) };
    case 'save_pro_forma':
      return xcall(db, 'dev_save_pro_forma', { p_job: job, p_label: body.label, p_kind: body.kind, p_inputs: body.inputs, p_id: body.id ?? null });
    case 'lock_pro_forma':
      return { id: await xcall<string>(db, 'dev_lock_pro_forma', { p_id: body.id }) };
    case 'map_line':
      return { id: await xcall<string>(db, 'dev_map_budget_line', { p_job: job, p_cost_code: body.costCodeId, p_category: body.category, p_contingency_pool: body.pool ?? null, p_draw_budget_line: body.drawBudgetLineId ?? null, p_cip_account_ref: body.cipRef ?? null, p_sort: body.sort ?? null }) };
    case 'add_source': {
      const r = await dwrite<Array<{ id: string }>>(pm.from('dev_sources').insert({ job_id: job, kind: body.kind, name: body.name, commitment_cents: body.commitmentCents, funded_cents: body.fundedCents, funded_as_of: body.fundedAsOf ?? null, rank: body.rank, funding_rule: body.fundingRule, draw_schedule_id: body.drawScheduleId ?? null }).select('id'), 'add source');
      return { id: r[0]?.id ?? null };
    }
    case 'update_source': {
      const r = await dwrite<unknown[]>(pm.from('dev_sources').update({ funded_cents: body.fundedCents, funded_as_of: body.fundedAsOf ?? null }).eq('id', body.sourceId).eq('job_id', job).select('id'), 'update source');
      if (!r.length) throw new HttpError(404, 'That source was not found on this project.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'add_key_date': {
      const r = await dwrite<Array<{ id: string }>>(pm.from('dev_key_dates').insert({ job_id: job, kind: body.kind, label: body.label ?? null, due_on: body.dueOn, reminder_days: body.reminderDays }).select('id'), 'add key date');
      return { id: r[0]?.id ?? null };
    }
    case 'key_date_done':
      await dwrite(pm.from('dev_key_dates').update({ status: body.status }).eq('id', body.keyDateId).eq('job_id', job).select('id'), 'key date');
      return { ok: true };
    case 'propose_reallocation':
      return xcall(db, 'dev_propose_reallocation', { p_job: job, p_from: body.fromCostCodeId, p_to: body.toCostCodeId, p_cents: body.cents, p_reason: body.reason, p_lender_consent_required: body.lenderConsentRequired ?? null });
    case 'lender_consent':
      return { id: await xcall<string>(db, 'dev_record_lender_consent', { p_reallocation: body.reallocationId, p_ref: body.ref, p_on: body.on ?? null }) };
    case 'approve_reallocation': {
      // The REVISED budget is a budget_transfer in the approvals engine (1113); the lender-consent gate runs inside it.
      const r = await xrows<{ budget_id: string | null }>(pm.from('dev_reallocations').select('budget_id').eq('id', body.reallocationId).eq('job_id', job), 'reallocation');
      const budget = r[0]?.budget_id;
      if (!budget) throw new HttpError(404, 'That reallocation was not found or has no budget revision.', 'NOT_FOUND');
      const d = await decideObject(db, 'budget_transfer', budget, { objectError: (e) => { const c = depthErrorCopy(e); return c ? new HttpError(c.status, c.error, c.code) : toHttp(e, 'approve reallocation'); } });
      if (d.status !== 'not_needed') return d;
      const res = await pm.from('budgets').update({ status: 'APPROVED' }).eq('id', budget).eq('status', 'DRAFT').select('id');
      if (res.error) { const c = depthErrorCopy(res.error); throw c ? new HttpError(c.status, c.error, c.code) : toHttp(res.error, 'approve budget revision'); }
      return { status: 'approved' };
    }
    case 'cancel_reallocation':
      return { id: await xcall<string>(db, 'dev_cancel_reallocation', { p_reallocation: body.reallocationId }) };
    case 'capital_plan':
      return xcall(db, 'dev_generate_capital_plan', { p_job: job, p_start: body.start, p_months: body.months });
  }
});
