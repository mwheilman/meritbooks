export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { loadBuilder } from '@/lib/residential/queries';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Fraction, Required, Text, Uuid } from '@/lib/residential/schemas';

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['dev_unit', 'estimate'] }, async ({ db, tenant }) =>
  loadBuilder(db, tenant.activeCompanyId ? [tenant.activeCompanyId] : tenant.companies.map((c) => c.id)));

const Stage = z.enum(['PRE_START', 'PRE_FRAME', 'PRE_DRYWALL', 'PRE_TRIM', 'ANYTIME']);
const Release = z.enum(['START', 'FOUNDATION', 'FRAME', 'MECHANICAL', 'DRYWALL', 'TRIM', 'FINAL']);

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('community'), companyId: Uuid, code: Required(24, 'Code'), name: Required(120, 'Name'), city: Text(80).nullish(), state: Text(2).nullish(), hoaName: Text(200).nullish(), hoaRules: Text(8000).nullish() }),
  z.object({ op: z.literal('phase'), communityId: Uuid, name: Required(80, 'Name'), sort: z.number().int().min(0).max(1000).default(0) }),
  z.object({ op: z.literal('plan'), companyId: Uuid, code: Required(24, 'Code'), name: Required(120, 'Name'), beds: z.number().min(0).max(20).nullish(), baths: z.number().min(0).max(20).nullish(),
    sqft: z.number().int().min(0).max(100000).nullish(), baseCostCents: Cents.nullish(), targetMarginPct: Fraction.nullish(), standardCycleDays: z.number().int().min(1).max(1000).nullish(),
    scheduleTemplateKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish(), jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish() }),
  z.object({ op: z.literal('plan_price'), planId: Uuid, communityId: Uuid.nullish(), basePriceCents: Cents.refine((n) => n > 0, 'More than zero'), effectiveFrom: Day.nullish() }),
  z.object({ op: z.literal('elevation'), planId: Uuid, code: Required(12, 'Code'), name: Required(80, 'Name'), premiumCents: Cents.default(0) }),
  z.object({ op: z.literal('option'), companyId: Uuid, code: Required(40, 'Code'), name: Required(200, 'Name'), category: Text(80).nullish(), cutoffStage: Stage.default('PRE_DRYWALL'),
    isStructural: z.boolean().default(false), planIds: z.array(Uuid).max(100).nullish(), requires: z.array(Uuid).max(50).default([]), excludes: z.array(Uuid).max(50).default([]),
    costCents: Cents.nullish(), priceCents: Cents.nullish() }),
  z.object({ op: z.literal('option_price'), optionId: Uuid, communityId: Uuid.nullish(), planId: Uuid.nullish(), priceCents: Cents, effectiveFrom: Day.nullish() }),
  z.object({ op: z.literal('lot'), companyId: Uuid, communityId: Uuid, phaseId: Uuid.nullish(), lotNumber: Required(24, 'Lot number'), block: Text(24).nullish(), addressLine1: Text(200).nullish(),
    status: z.enum(['RAW', 'DEVELOPED', 'AVAILABLE', 'HELD']).default('AVAILABLE'), premiumCents: Cents.default(0), landCostCents: Cents.nullish(), swing: z.enum(['LEFT', 'RIGHT', 'EITHER']).nullish(),
    isSpec: z.boolean().default(false), planId: Uuid.nullish(), listPriceCents: Cents.nullish() }),
  z.object({ op: z.literal('price_agreement'), companyId: Uuid, vendorId: Uuid, planId: Uuid.nullish(), elevationId: Uuid.nullish(), optionId: Uuid.nullish(), communityId: Uuid.nullish(),
    costCodeId: Uuid.nullish(), scope: Required(300, 'Scope'), amountCents: Cents, releaseStage: Release.default('START'), effectiveFrom: Day.nullish(), effectiveTo: Day.nullish() }),
  z.object({ op: z.literal('kpis'), companyId: Uuid }),
]);

const OPS = { price_agreement: { cap: 'projects.commitments', action: 'edit' }, lot: { cap: 'projects.jobs', action: 'edit' }, kpis: { cap: 'projects.reports', action: 'view' } } as const;

/** Builder setup: land → community → phase → lot; plan / elevation / option price book; trade price agreements. */
export const POST = route({ access: { cap: 'projects.settings', action: 'view' }, ops: OPS, mask: false, body: Op }, async ({ db, body, tenant }) => {
  const org = tenant.orgId;
  const ins = async (table: string, row: Record<string, unknown>) => resWrote<Array<{ id: string }>>(await pm(db).from(table).insert({ org_id: org, ...row }).select('id'))[0]?.id ?? null;
  switch (body.op) {
    case 'community': return { id: await ins('res_communities', { location_id: body.companyId, code: body.code, name: body.name, city: body.city ?? null, state: body.state ?? null, hoa_name: body.hoaName ?? null, hoa_rules: body.hoaRules ?? null }) };
    case 'phase': return { id: await ins('res_community_phases', { community_id: body.communityId, name: body.name, sort: body.sort }) };
    case 'plan': return { id: await ins('res_plans', { location_id: body.companyId, code: body.code, name: body.name, beds: body.beds ?? null, baths: body.baths ?? null, sqft: body.sqft ?? null,
      base_cost_cents: body.baseCostCents ?? null, target_margin_pct: body.targetMarginPct ?? null, standard_cycle_days: body.standardCycleDays ?? null,
      schedule_template_key: body.scheduleTemplateKey ?? null, job_type_key: body.jobTypeKey ?? null }) };
    case 'plan_price': return { id: await ins('res_plan_prices', { plan_id: body.planId, community_id: body.communityId ?? null, base_price_cents: body.basePriceCents, ...(body.effectiveFrom ? { effective_from: body.effectiveFrom } : {}) }) };
    case 'elevation': return { id: await ins('res_elevations', { plan_id: body.planId, code: body.code, name: body.name, premium_cents: body.premiumCents }) };
    case 'option': {
      const id = await ins('res_options', { location_id: body.companyId, code: body.code, name: body.name, category: body.category ?? null, cutoff_stage: body.cutoffStage,
        is_structural: body.isStructural, plan_ids: body.planIds ?? null, requires: body.requires, excludes: body.excludes, cost_cents: body.costCents ?? null });
      if (id && body.priceCents != null) await ins('res_option_prices', { option_id: id, price_cents: body.priceCents });
      return { id };
    }
    case 'option_price': return { id: await ins('res_option_prices', { option_id: body.optionId, community_id: body.communityId ?? null, plan_id: body.planId ?? null, price_cents: body.priceCents, ...(body.effectiveFrom ? { effective_from: body.effectiveFrom } : {}) }) };
    case 'lot': return { id: await ins('res_lots', { location_id: body.companyId, community_id: body.communityId, phase_id: body.phaseId ?? null, lot_number: body.lotNumber, block: body.block ?? null,
      address_line1: body.addressLine1 ?? null, status: body.status, premium_cents: body.premiumCents, land_cost_cents: body.landCostCents ?? null, swing: body.swing ?? null,
      is_spec: body.isSpec, plan_id: body.planId ?? null, list_price_cents: body.listPriceCents ?? null, ...(body.isSpec ? { listed_on: new Date().toISOString().slice(0, 10) } : {}) }) };
    case 'price_agreement': return { id: await ins('res_price_agreements', { location_id: body.companyId, vendor_id: body.vendorId, plan_id: body.planId ?? null, elevation_id: body.elevationId ?? null,
      option_id: body.optionId ?? null, community_id: body.communityId ?? null, cost_code_id: body.costCodeId ?? null, scope: body.scope, amount_cents: body.amountCents, release_stage: body.releaseStage,
      ...(body.effectiveFrom ? { effective_from: body.effectiveFrom } : {}), effective_to: body.effectiveTo ?? null }) };
    case 'kpis': return resRpc(db, 'res_builder_kpis', { p_location: body.companyId });
  }
});
