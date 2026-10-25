export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { RESIDENTIAL_QUESTIONS, buildResidentialPlan } from '@/lib/residential/setup';
import { Uuid } from '@/lib/residential/schemas';

/** The residential setup interview (RES-01): the questions, the company's current settings and its last run. */
export const GET = route({ access: { cap: 'projects.settings', action: 'view' }, mask: false, query: z.object({ company: Uuid }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const settings = resWrote<Array<Record<string, unknown>>>(await pm(db).from('res_settings')
    .select('business_kind, default_contract_type, default_tax_form, state_code, default_deposit_pct, billing_method, self_perform_mix, warranty_walk_days, structural_warranty_years, setup_completed_at')
    .eq('location_id', query.company).limit(1));
  const runs = resWrote<Array<Record<string, unknown>>>(await pm(db).from('wc_setup_runs').select('id, answers, result, applied_at')
    .eq('location_id', query.company).eq('industry', 'RESIDENTIAL').order('applied_at', { ascending: false }).limit(1));
  return { questions: RESIDENTIAL_QUESTIONS, settings: settings[0] ?? null, lastRun: runs[0] ?? null };
});

const Answers = z.object({
  businessKind: z.enum(['remodel', 'custom', 'production', 'hybrid']),
  contractTypes: z.array(z.enum(['FIXED_PRICE', 'COST_PLUS_PCT', 'COST_PLUS_FEE', 'COST_PLUS_GMP', 'TIME_MATERIALS'])).min(1, 'Pick at least one contract type').max(5),
  billingMethod: z.enum(['MILESTONE', 'PROGRESS', 'DRAW', 'COST_PLUS', 'MIXED']),
  selfPerform: z.enum(['SELF_PERFORM', 'SUBCONTRACT', 'MIXED']),
  stateCode: z.string().regex(/^[A-Z]{2}$/, 'Two letters, like IA').nullable(),
  taxForm: z.enum(['LUMP_SUM_IMPROVEMENT', 'RETAIL_PLUS_INSTALL', 'EXEMPT']),
  depositPct: z.number().min(0).max(1),
  markupPct: z.number().min(0).max(10),
  workmanshipWarrantyMonths: z.number().int().min(0).max(120),
  structuralWarrantyYears: z.number().int().min(0).max(20),
  usesSelectionsPortal: z.boolean(),
});

const Body = z.object({ op: z.enum(['preview', 'apply']), companyId: Uuid, answers: Answers });

/** preview → the plan the answers make (nothing written); apply → written by pm.wc_apply_setup. */
export const POST = route({ access: { cap: 'projects.settings', action: 'view' }, ops: { apply: { cap: 'projects.settings', action: 'configure' } }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const plan = buildResidentialPlan(body.answers);
  if (body.op === 'preview') return { plan };
  const result = await resRpc<Record<string, unknown>>(db, 'wc_apply_setup', { p_location: body.companyId, p_industry: 'RESIDENTIAL', p_answers: body.answers, p_plan: plan });
  return { plan, result };
});
