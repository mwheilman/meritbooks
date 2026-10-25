export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { buildDesignPlan, FEE_MODELS, FIRM_TYPES } from '@/lib/design/setup';
import { HttpError } from '@/lib/api-errors';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export interface DesignProductRow { id: string; name: string; vendor_id: string | null; vendor_name: string | null; sku: string | null; category: string | null; width_in: number | null;
  depth_in: number | null; height_in: number | null; finish: string | null; com_yards: number | null; lead_time_days: number | null; trade_cost_cents: number | null; retail_cents: number | null;
  image_url: string | null; vendor_url: string | null; source: string; is_active: boolean }

/** The firm's product library (ID-07/08), pricing rules (ID-14), vendor terms, or the design reports (ID-36). */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: ['selection', 'procurement'],
  query: z.object({ company: Uuid, view: z.enum(['library', 'rules', 'terms', 'reports', 'settings']).default('library'), q: z.string().max(80).optional(), from: Day.optional(), to: Day.optional() }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.company);
    const c = query.company;
    if (query.view === 'reports') return resRpc(db, 'dsn_reports', { p_location: c, p_from: query.from ?? null, p_to: query.to ?? null });
    if (query.view === 'rules') return { rules: resWrote(await pm(db).from('dsn_pricing_rules').select('id, name, vendor_id, category, customer_id, method, pct, tiers, freight_pct, procurement_fee_pct, show_cost, priority, is_active').eq('location_id', c).order('priority')) };
    if (query.view === 'terms') return { terms: resWrote(await pm(db).from('v_dsn_vendor_terms_masked').select('vendor_id, trade_discount_pct, deposit_pct, freight_terms, resale_cert_on_file, resale_cert_expires_on, rep_name, rep_email, avg_lead_days, cancellation_policy, restocking_fee_pct').eq('location_id', c)) };
    if (query.view === 'settings') return { settings: resWrote<Array<Record<string, unknown>>>(await pm(db).from('dsn_settings').select('*').eq('location_id', c).limit(1))[0] ?? null };
    let q = pm(db).from('v_dsn_products_masked').select('id, name, vendor_id, vendor_name, sku, category, width_in, depth_in, height_in, finish, com_yards, lead_time_days, trade_cost_cents, retail_cents, image_url, vendor_url, source, is_active')
      .eq('location_id', c).eq('is_active', true);
    if (query.q) q = q.ilike('name', `%${query.q.replace(/[%_]/g, '')}%`);
    return { products: resWrote<DesignProductRow[]>(await q.order('name').limit(500)) };
  });

const SetupAnswers = z.object({ firmType: z.enum(FIRM_TYPES), feeModels: z.array(z.enum(FEE_MODELS)).max(6), markupPct: z.number().min(0).max(10), productDepositPct: z.number().min(0).max(1),
  retainerCents: Cents, retainerEvergreen: z.boolean(), showCostToClients: z.boolean(), receivers: z.array(z.object({ name: Text(120), address: Text(300) })).max(20),
  taxStates: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(10), replacing: Text(120).nullable() });
const Clip = z.object({ name: Text(200).min(1), vendor_id: Uuid.nullish(), vendor_name: Text(200).nullish(), sku: Text(80).nullish(), category: Text(80).nullish(),
  width_in: z.number().min(0).max(10000).nullish(), depth_in: z.number().min(0).max(10000).nullish(), height_in: z.number().min(0).max(10000).nullish(), finish: Text(200).nullish(),
  com_yards: z.number().min(0).max(1000).nullish(), lead_time_days: z.number().int().min(0).max(730).nullish(), trade_cost_cents: Cents.nullish(), retail_cents: Cents.nullish(),
  image_url: z.string().url().startsWith('https://').nullish(), vendor_url: z.string().url().startsWith('https://').nullish(), source: z.enum(['CLIPPER', 'QR']).default('CLIPPER'), notes: Text(2000).nullish() });

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setup_preview'), companyId: Uuid, answers: SetupAnswers }),
  z.object({ op: z.literal('setup_apply'), companyId: Uuid, answers: SetupAnswers }),
  z.object({ op: z.literal('discovery'), companyId: Uuid, leadId: Uuid, fields: z.object({ rooms: z.array(Text(80)).max(40).optional(), scope: Text(4000).nullish(), style_notes: Text(4000).nullish(),
    budget_low_cents: Cents.nullish(), budget_high_cents: Cents.nullish(), timeline: Text(200).nullish(), call_notes: Text(8000).nullish(), fit: z.enum(['GOOD', 'MAYBE', 'NOT_A_FIT']).nullish(),
    appointment_id: Uuid.nullish() }) }),
  z.object({ op: z.literal('clip'), companyId: Uuid, clip: Clip }),
  z.object({ op: z.literal('price'), companyId: Uuid, costCents: Cents.nullish(), retailCents: Cents.nullish(), vendorId: Uuid.nullish(), category: Text(80).nullish(), customerId: Uuid.nullish() }),
  z.object({ op: z.literal('rule'), companyId: Uuid, ruleId: Uuid.nullish(), fields: z.object({ name: Text(120).min(1).optional(), vendor_id: Uuid.nullish(), category: Text(80).nullish(), customer_id: Uuid.nullish(),
    method: z.enum(['COST_PLUS', 'DISCOUNT_FROM_RETAIL', 'TIERED']).optional(), pct: z.number().min(0).max(10).nullish(),
    tiers: z.array(z.object({ up_to_cents: Cents.nullable(), pct: z.number().min(0).max(10) })).max(10).optional(), freight_pct: z.number().min(0).max(1).nullish(),
    procurement_fee_pct: z.number().min(0).max(1).nullish(), show_cost: z.boolean().optional(), priority: z.number().int().min(0).max(1000).optional(), is_active: z.boolean().optional() }) }),
]);

export const POST = route({ access: { cap: 'projects.selections', action: 'view' },
  ops: { setup_apply: { cap: 'projects.settings', action: 'configure' }, discovery: { cap: 'projects.leads', action: 'edit' }, clip: { cap: 'projects.selections', action: 'edit' },
    rule: { cap: 'projects.settings', action: 'configure' } },
  mask: ['selection'], body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  switch (body.op) {
    case 'setup_preview': return { plan: buildDesignPlan(body.answers) };
    case 'setup_apply': {
      const plan = buildDesignPlan(body.answers);
      return { plan, result: await resRpc(db, 'wc_apply_setup', { p_location: body.companyId, p_industry: 'DESIGN', p_answers: body.answers, p_plan: plan }) };
    }
    case 'discovery': return { discoveryId: await resRpc<string>(db, 'dsn_save_discovery', { p_lead: body.leadId, p_fields: body.fields }) };
    case 'clip': return resRpc(db, 'dsn_clip', { p_location: body.companyId, p_clip: body.clip });
    case 'price': return resRpc(db, 'dsn_price', { p_location: body.companyId, p_cost_cents: body.costCents ?? null, p_retail_cents: body.retailCents ?? null,
      p_vendor: body.vendorId ?? null, p_category: body.category ?? null, p_customer: body.customerId ?? null });
    case 'rule': {
      // dsn_pricing_rules is a company-settings table (class S, write cap projects.settings); RLS decides.
      if (body.ruleId) {
        resWrote(await pm(db).from('dsn_pricing_rules').update(body.fields).eq('id', body.ruleId).eq('location_id', body.companyId).select('id'));
        return { ruleId: body.ruleId };
      }
      if (!body.fields.name || !body.fields.method) throw new HttpError(422, 'A pricing rule needs a name and a method.', 'PM_INVALID');
      const row = resWrote<Array<{ id: string }>>(await pm(db).from('dsn_pricing_rules').insert({ location_id: body.companyId, ...body.fields }).select('id'));
      return { ruleId: row[0]?.id ?? null };
    }
  }
});
