export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Manufacturing front office (1125): the bid board (MFG-03), drawing takeoff on 1115 sheets (MFG-05),
 * the parametric product library (MFG-07) and proposals (MFG-11). Estimating capability; cost
 * figures come back only with Job financials (the functions strip them; the route masks on top).
 */
const Pt = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const ParamsQ = z.string().max(2000).transform((s, ctx) => {
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[a-z_]{1,20}$/.test(k) || typeof n !== 'number' || !Number.isFinite(n)) throw new Error('bad');
      out[k] = n;
    }
    return out;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Parameters are numbers by name' });
    return z.NEVER;
  }
});

const views = {
  bids: view('mfg_bid_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  library: view('mfg_product_library', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  expand: view('mfg_expand_product', z.object({ product: Uuid, params: ParamsQ }), (q) => ({ p_product: q.product, p_params: q.params })),
  takeoff: view('mfg_takeoff_sheet', z.object({ revision: Uuid }), (q) => ({ p_revision: q.revision })),
  takeoff_summary: view('mfg_takeoff_summary', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  proposal: view('mfg_proposal_detail', z.object({ id: Uuid }), (q) => ({ p_proposal: q.id })),
};

export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: 'estimate', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const ParamDef = z.object({ default: z.number().optional(), min: z.number().optional(), max: z.number().optional(), label: Text(40).optional() });
const Coef = z.record(z.enum(['const', 'w', 'h', 'd', 'wh', 'wd', 'hd', 'doors', 'drawers', 'shelves']), z.number().min(-1e6).max(1e6));
const Component = z.object({ kind: z.enum(['SHEET', 'EDGEBAND', 'HARDWARE', 'LUMBER', 'FINISH', 'BUYOUT', 'LABOR', 'INSTALL', 'FREIGHT']), key: Req(80, 'The key'), description: Text(200).optional(),
  uom: Text(10).optional(), coef: Coef, unit_cost_cents: PosCents.nullish() });

const ops = {
  save_opportunity: op('mfg_save_opportunity', z.object({ companyId: Uuid, id: Uuid.nullish(), name: Text(200).nullish(), customerId: Uuid.nullish(), bidDueOn: IsoDate.nullish(), estValueCents: PosCents.nullish(),
    probability: z.number().min(0).max(1).nullish(), source: Text(80).nullish(), projectAddress: Text(200).nullish(), architect: Text(120).nullish(), specDocumentId: Uuid.nullish(), notes: Text(2000).nullish() }),
  (b) => ({ p_location: b.companyId, p_id: b.id ?? null, p_attrs: { name: b.name ?? null, customer_id: b.customerId ?? null, bid_due_on: b.bidDueOn ?? null, est_value_cents: b.estValueCents ?? null,
    probability: b.probability ?? null, source: b.source ?? null, project_address: b.projectAddress ?? null, architect: b.architect ?? null, spec_document_id: b.specDocumentId ?? null, notes: b.notes ?? null } })),
  move_opportunity: op('mfg_move_opportunity', z.object({ id: Uuid, stage: z.enum(['LEAD', 'QUALIFIED', 'BIDDING', 'SUBMITTED', 'LOST', 'NO_BID']),
    reasonCode: z.enum(['PRICE', 'SCHEDULE', 'SCOPE', 'RELATIONSHIP', 'CAPACITY', 'NO_DECISION', 'OTHER']).nullish(), reason: Text(500).nullish() }),
  (b) => ({ p_id: b.id, p_stage: b.stage, p_reason_code: b.reasonCode ?? null, p_reason: b.reason ?? null })),
  save_bid: op('mfg_save_bid', z.object({ opportunityId: Uuid, customerId: Uuid, estimateId: Uuid.nullish(), amountCents: PosCents.nullish(), submittedOn: IsoDate.nullish(), status: z.enum(['DRAFT', 'SUBMITTED', 'WITHDRAWN']).nullish(), notes: Text(1000).nullish() }),
    (b) => ({ p_opportunity: b.opportunityId, p_customer: b.customerId, p_attrs: { estimate_id: b.estimateId ?? null, amount_cents: b.amountCents ?? null, submitted_on: b.submittedOn ?? null, status: b.status ?? null, notes: b.notes ?? null } })),
  award_bid: op('mfg_award_bid', z.object({ bidId: Uuid }), (b) => ({ p_bid: b.bidId })),
  set_scale: op('mfg_set_takeoff_scale', z.object({ revisionId: Uuid, p1: Pt, p2: Pt, knownLength: z.number().positive().max(1e6), unit: z.enum(['IN', 'FT', 'MM', 'M']) }),
    (b) => ({ p_revision: b.revisionId, p_p1: b.p1, p_p2: b.p2, p_known_length: b.knownLength, p_unit: b.unit })),
  save_takeoff: op('mfg_save_takeoff', z.object({ revisionId: Uuid, id: Uuid.nullish(), kind: z.enum(['LINEAR', 'AREA', 'COUNT']), label: Text(120).nullish(), points: z.array(Pt).min(1).max(500),
    room: Text(80).nullish(), elevation: Text(80).nullish(), wbsId: Uuid.nullish(), productId: Uuid.nullish(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish() }),
  (b) => ({ p_revision: b.revisionId, p_id: b.id ?? null, p_attrs: { kind: b.kind, label: b.label ?? null, points: b.points, room: b.room ?? null, elevation: b.elevation ?? null,
    wbs_id: b.wbsId ?? null, product_id: b.productId ?? null, color: b.color ?? null } })),
  delete_takeoff: op('mfg_delete_takeoff', z.object({ id: Uuid }), (b) => ({ p_id: b.id })),
  save_product: op('mfg_save_product', z.object({ companyId: Uuid, code: z.string().regex(/^[A-Z0-9_-]{2,30}$/, 'Codes are 2–30 capitals, digits, - or _'), name: Req(120, 'The name'),
    family: z.enum(['BASE', 'WALL', 'TALL', 'VANITY', 'CLOSET', 'PANEL', 'FILLER', 'COUNTERTOP', 'DESK', 'FEATURE_WALL', 'OTHER']), params: z.record(z.string().regex(/^[a-z_]{1,20}$/), ParamDef),
    components: z.array(Component).max(60), priceCoef: Coef.default({}), markupPct: z.number().min(0).max(5).nullish(), routingId: Uuid.nullish(), isActive: z.boolean().default(true) }),
  (b) => ({ p_location: b.companyId, p_attrs: { code: b.code, name: b.name, family: b.family, params: b.params, components: b.components, price_coef: b.priceCoef, markup_pct: b.markupPct ?? null,
    routing_id: b.routingId ?? null, is_active: b.isActive } })),
  add_product_line: op('mfg_add_product_line', z.object({ estimateId: Uuid, productId: Uuid, params: z.record(z.string().regex(/^[a-z_]{1,20}$/), z.number()), wbsId: Uuid.nullish(), costCodeId: Uuid.nullish(),
    takeoffId: Uuid.nullish(), description: Text(300).nullish() }),
  (b) => ({ p_estimate: b.estimateId, p_product: b.productId, p_params: b.params, p_attrs: { wbs_id: b.wbsId ?? null, cost_code_id: b.costCodeId ?? null, takeoff_id: b.takeoffId ?? null, description: b.description ?? null } })),
  save_proposal: op('mfg_save_proposal', z.object({ estimateId: Uuid, title: Text(200).nullish(), alternates: z.array(z.object({ label: Req(200, 'The alternate'), amount_cents: z.number().int().min(-1e12).max(1e12), accepted: z.boolean().optional() })).max(40).optional(),
    allowances: z.array(z.object({ label: Req(200, 'The allowance'), amount_cents: PosCents })).max(40).optional(), clarifications: z.array(Text(500)).max(60).optional(), exclusions: z.array(Text(500)).max(60).optional(),
    depositSchedule: z.array(z.object({ label: Req(80, 'The step'), pct: z.number().min(0).max(1) })).max(10).optional(), validUntil: IsoDate.nullish() }),
  (b) => ({ p_estimate: b.estimateId, p_attrs: Object.fromEntries(Object.entries({ title: b.title, alternates: b.alternates, allowances: b.allowances, clarifications: b.clarifications, exclusions: b.exclusions,
    deposit_schedule: b.depositSchedule, valid_until: b.validUntil }).filter(([, v]) => v !== undefined && v !== null)) })),
  request_deposit: op('mfg_request_proposal_deposit', z.object({ proposalId: Uuid, step: z.number().int().min(1).max(10).default(1) }), (b) => ({ p_proposal: b.proposalId, p_step: b.step })),
};

export const POST = route({
  access: { cap: 'projects.estimates', action: 'edit' },
  ops: { save_opportunity: { cap: 'projects.estimates', action: 'create' }, request_deposit: { cap: 'projects.billing', action: 'create' } },
  mask: 'estimate', body: deskBody(ops),
}, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));
