export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { xrows } from '@/lib/dealer/rpc';
import { Cents, IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * The store office (1125): customer 360 (DLR-70), registers + drawer close producing deposit-batch
 * facts for Books (DLR-71 — Books owns the deposit), price limits / overrides / manager PIN (DLR-77)
 * and the day / month store close (DLR-80), plus the completion settings.
 */
const views = {
  customer: view('dlr_customer_360', z.object({ company: Uuid, customer: Uuid }), (q) => ({ p_location: q.company, p_customer: q.customer })),
  drawer: view('dlr_drawer_board', z.object({ company: Uuid, day: IsoDate.optional() }), (q) => ({ p_location: q.company, p_day: q.day ?? null })),
  pricing: view('dlr_price_override_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  price_check: view('dlr_price_check', z.object({ company: Uuid, base: z.coerce.number().int().min(0), price: z.coerce.number().int().min(0), cost: z.coerce.number().int().min(0).optional() }),
    (q) => ({ p_location: q.company, p_base_cents: q.base, p_price_cents: q.price, p_cost_cents: q.cost ?? null })),
  close: view('dlr_store_close_checklist', z.object({ company: Uuid, kind: z.enum(['DAY', 'MONTH']).default('DAY'), date: IsoDate.optional() }), (q) => ({ p_location: q.company, p_kind: q.kind, p_date: q.date ?? null })),
  config: view('dlr_store_config', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: ['parts_ticket', 'repair_order', 'dealer_deal', 'rental'], query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Settings = z.object({
  lot_lat: z.number().min(-90).max(90).nullable(), lot_lng: z.number().min(-180).max(180).nullable(), lot_radius_m: z.number().int().min(25).max(20000),
  service_job_type_key: Text(60), recon_required: z.boolean(), internal_route_required: z.boolean(), qc_required: z.boolean(),
  status_texts: z.record(z.enum(['CHECKED_IN', 'DIAGNOSING', 'WAITING_APPROVAL', 'WAITING_PARTS', 'IN_PROGRESS', 'QC', 'READY', 'PICKED_UP']), z.boolean()),
  special_order_text: z.boolean(), special_order_stale_days: z.number().int().min(1).max(365), storage_free_days: z.number().int().min(0).max(365), storage_daily_cents: PosCents,
  lien_notice_days: z.number().int().min(1).max(365), rerent_inspection_required: z.boolean(),
  rental_out_requires: z.array(z.enum(['license', 'coi', 'card_hold', 'waiver', 'safety_briefing', 'signature'])), cit_stale_days: z.number().int().min(1).max(120),
  default_stips: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label: Req(120, 'The label') })).max(30),
  daily_tech_hours: z.number().min(0).max(2000), cycle_days: z.number().int().min(7).max(90), drawer_variance_cents: PosCents.max(50000, 'At most $500'),
  labor_rate_cents: PosCents.refine((n) => n > 0, 'The posted rate is above zero').nullable(),
}).partial();

/** Counter tickets land in the drawer when they close (never recorded by hand: security review H2). */
const SourceKind = z.enum(['REPAIR_ORDER', 'DEAL_DEPOSIT', 'RENTAL', 'SPECIAL_ORDER', 'PAYOUT', 'OTHER']);
const SOURCE_TABLE: Readonly<Record<string, string>> = { REPAIR_ORDER: 'work_orders', DEAL_DEPOSIT: 'dealer_deals', RENTAL: 'rental_contracts', SPECIAL_ORDER: 'parts_special_orders' };
const PaymentByNumber = z.object({ op: z.literal('payment'), sourceKind: SourceKind, sourceId: Uuid.nullish(), sourceNumber: Text(40).nullish() }).passthrough();

const ops = {
  settings: op('dlr_set_store_settings', z.object({ companyId: Uuid, patch: Settings }), (b) => ({ p_location: b.companyId, p_patch: b.patch })),
  fee_rule: op('dlr_save_shop_fee_rule', z.object({ companyId: Uuid, code: z.string().regex(/^[A-Z0-9_]{2,24}$/), label: Req(80, 'The label'), kind: z.enum(['SHOP_SUPPLIES', 'ENVIRONMENTAL', 'DISPOSAL', 'OTHER']),
    basis: z.enum(['PCT_LABOR', 'PCT_PARTS', 'FLAT']), pct: z.number().min(0).max(1).default(0), amountCents: PosCents.default(0), minCents: PosCents.default(0), capCents: PosCents.nullish(),
    payTypes: z.array(z.enum(['CUSTOMER', 'WARRANTY', 'INTERNAL', 'POLICY'])).min(1).default(['CUSTOMER']), isActive: z.boolean().default(true) }),
  (b) => ({ p_location: b.companyId, p_attrs: { code: b.code, label: b.label, kind: b.kind, basis: b.basis, pct: b.pct, amount_cents: b.amountCents, min_cents: b.minCents, cap_cents: b.capCents ?? null, pay_types: b.payTypes, is_active: b.isActive } })),
  save_register: op('dlr_save_register', z.object({ companyId: Uuid, code: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/), name: Req(60, 'The name'), active: z.boolean().default(true) }),
    (b) => ({ p_location: b.companyId, p_code: b.code, p_name: b.name, p_active: b.active })),
  open_drawer: op('dlr_open_drawer', z.object({ registerId: Uuid, openingCashCents: PosCents }), (b) => ({ p_register: b.registerId, p_opening_cash_cents: b.openingCashCents })),
  payment: op('dlr_record_payment', z.object({ sessionId: Uuid, sourceKind: SourceKind, sourceId: Uuid.nullish(),
    tender: z.enum(['CASH', 'CHECK', 'CARD', 'OTHER']), amountCents: Cents.refine((n) => n !== 0, 'Enter the amount'), reference: Text(60).nullish(), note: Text(300).nullish() }),
  (b) => ({ p_session: b.sessionId, p_source_kind: b.sourceKind, p_source: b.sourceId ?? null, p_tender: b.tender, p_amount_cents: b.amountCents, p_reference: b.reference ?? null, p_note: b.note ?? null })),
  note_variance: op('dlr_note_drawer_variance', z.object({ sessionId: Uuid, note: Req(500, 'The explanation') }), (b) => ({ p_session: b.sessionId, p_note: b.note })),
  close_drawer: op('dlr_close_drawer', z.object({ sessionId: Uuid, cashCents: PosCents, checkCents: PosCents.default(0), cardCents: PosCents.default(0), keepFloatCents: PosCents.nullish(), note: Text(500).nullish(),
    denominations: z.record(z.string().max(10), z.number().int().min(0).max(100000)).nullish() }),
  (b) => ({ p_session: b.sessionId, p_counts: { cash_cents: b.cashCents, check_cents: b.checkCents, card_cents: b.cardCents, denominations: b.denominations ?? null }, p_keep_float_cents: b.keepFloatCents ?? null, p_note: b.note ?? null })),
  price_limits: op('dlr_set_price_limits', z.object({ companyId: Uuid, rows: z.array(z.object({ role_key: z.string().regex(/^(default|projects_[a-z_]+)$/), max_discount_pct: z.number().min(0).max(1), allow_below_cost: z.boolean().default(false) })).max(30) }),
    (b) => ({ p_location: b.companyId, p_rows: b.rows })),
  request_override: op('dlr_request_price_override', z.object({ kind: z.enum(['PARTS_TICKET_LINE', 'RO_LINE']), lineId: Uuid, priceCents: PosCents, reason: Req(300, 'The reason') }),
    (b) => ({ p_kind: b.kind, p_line: b.lineId, p_price_cents: b.priceCents, p_reason: b.reason })),
  decide_override: op('dlr_decide_price_override', z.object({ overrideId: Uuid, decision: z.enum(['APPROVE', 'REJECT']), note: Text(300).nullish() }), (b) => ({ p_override: b.overrideId, p_decision: b.decision, p_note: b.note ?? null })),
  set_pin: op('dlr_set_manager_pin', z.object({ pin: z.string().regex(/^[0-9]{6,12}$/, 'A manager PIN is 6 to 12 digits') }), (b) => ({ p_pin: b.pin })),
  approve_pin: op('dlr_approve_override_pin', z.object({ overrideId: Uuid, managerId: Uuid, pin: z.string().regex(/^[0-9]{6,12}$/) }), (b) => ({ p_override: b.overrideId, p_manager: b.managerId, p_pin: b.pin })),
  sign_close: op('dlr_sign_store_close', z.object({ companyId: Uuid, kind: z.enum(['DAY', 'MONTH']), date: IsoDate.nullish(), note: Text(500).nullish() }), (b) => ({ p_location: b.companyId, p_kind: b.kind, p_date: b.date ?? null, p_note: b.note ?? null })),
};

export const POST = route({
  access: { cap: 'projects.store', action: 'edit' },
  ops: { settings: { cap: 'projects.settings', action: 'configure' }, price_limits: { cap: 'projects.settings', action: 'configure' }, decide_override: { cap: 'projects.store', action: 'approve' }, sign_close: { cap: 'projects.store', action: 'approve' }, save_register: { cap: 'projects.store', action: 'approve' } },
  mask: ['parts_ticket', 'repair_order'], body: deskBody(ops),
}, async ({ db, body, tenant }) => {
  // A payment for an RO / deal / rental / special order may name the record by its number; the
  // database checks it is at the drawer's store (pm.dlr_record_payment).
  if (body.op === 'payment') {
    const p = PaymentByNumber.parse(body);
    const table = SOURCE_TABLE[p.sourceKind];
    if (table && !p.sourceId) {
      if (!p.sourceNumber) throw new HttpError(422, 'Enter the number of the record this payment is for.', 'VALIDATION');
      const rows = await xrows<{ id: string }>(db.schema('pm').from(table).select('id').eq('number', p.sourceNumber.toUpperCase()).limit(2), 'payment source');
      if (rows.length !== 1 || !rows[0]) throw new HttpError(422, `No ${p.sourceKind.toLowerCase().replace('_', ' ')} numbered ${p.sourceNumber} at your stores.`, 'VALIDATION');
      return runOp(ops, Object.assign({}, body, { sourceId: rows[0].id }), db, tenant);
    }
  }
  return runOp(ops, body, db, tenant);
});
