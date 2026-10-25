export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { parsePriceFile } from '@/lib/flooring/price-file';
import { buildFlooringPlan, FLOORING_MIX } from '@/lib/flooring/setup';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

const View = z.enum(['tracker', 'lots', 'installers', 'reports', 'counter', 'price_imports', 'rotation']);

/**
 * Store-level flooring (1124): the special-order tracker (FLR-23), shade lots (FLR-26), installer
 * compliance (FLR-32), reports (FLR-44), counter sales (FLR-19), staged price files (FLR-14) and
 * the salesperson rotation (FLR-03) — one view at a time.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['estimate', 'procurement', 'labor_rate'],
  query: z.object({ company: Uuid, view: View, from: Day.optional(), to: Day.optional() }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const c = query.company;
  switch (query.view) {
    case 'tracker': return resRpc(db, 'flr_special_order_tracker', { p_location: c });
    case 'installers': return resRpc(db, 'flr_installer_compliance', { p_location: c, p_on: query.from ?? null });
    case 'reports': return resRpc(db, 'flr_reports', { p_location: c, p_from: query.from ?? null, p_to: query.to ?? null });
    case 'lots':
      return { lots: resWrote<Array<Record<string, unknown>>>(await pm(db).from('flr_lots')
        .select('id, product_id, lot_code, stock_location_id, pallet, barcode, cartons_on_hand, cartons_reserved, reserved_job_id, received_on, last_counted_on').eq('location_id', c).order('received_on', { ascending: false }).limit(500)) };
    case 'counter':
      return { sales: resWrote<Array<Record<string, unknown>>>(await pm(db).from('flr_counter_sales')
        .select('id, number, customer_name, subtotal_cents, tax_cents, total_cents, payment_method, status, created_at').eq('location_id', c).order('created_at', { ascending: false }).limit(200)) };
    case 'price_imports':
      return { imports: resWrote<Array<Record<string, unknown>>>(await pm(db).from('flr_price_imports')
        .select('id, vendor_id, source, file_name, effective_on, status, summary, created_at').eq('location_id', c).order('created_at', { ascending: false }).limit(50)) };
    case 'rotation':
      return { rotation: resWrote<Array<Record<string, unknown>>>(await pm(db).from('flr_lead_rotation').select('members, next_index, followup_hours').eq('location_id', c).limit(1))[0] ?? null };
  }
});

const SetupAnswers = z.object({ mix: z.array(z.enum(FLOORING_MIX)).max(6), installerPay: z.enum(['PIECE_RATE', 'HOURLY', 'MIXED']), depositPct: z.number().min(0).max(1),
  taxStates: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(10), replacing: Text(120).nullable(), measureFeeCents: Cents });

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setup_preview'), companyId: Uuid, answers: SetupAnswers }),
  z.object({ op: z.literal('setup_apply'), companyId: Uuid, answers: SetupAnswers }),
  z.object({ op: z.literal('rotation'), companyId: Uuid, members: z.array(Uuid).max(50), followupHours: z.number().int().min(0).max(72).default(2) }),
  z.object({ op: z.literal('assign_lead'), companyId: Uuid, leadId: Uuid }),
  z.object({ op: z.literal('price_stage'), companyId: Uuid, vendorId: Uuid.nullish(), fileName: Text(255).min(1), text: z.string().min(1).max(10_000_000) }),
  z.object({ op: z.literal('price_apply'), companyId: Uuid, importId: Uuid }),
  z.object({ op: z.literal('counter_sale'), companyId: Uuid, taxRate: z.number().min(0).max(0.5).default(0), customerId: Uuid.nullish(), customerName: Text(200).nullish(),
    paymentMethod: z.enum(['CARD', 'CASH', 'CHECK', 'ON_ACCOUNT']).default('CARD'),
    lines: z.array(z.object({ kind: z.enum(['PRODUCT', 'REMNANT', 'SUNDRY']), product_id: Uuid.nullish(), roll_id: Uuid.nullish(), lot_id: Uuid.nullish(), description: Text(300).min(1),
      qty: z.number().positive().max(1e6), uom: Text(12).nullish(), unit_price_cents: Cents, taxable: z.boolean().default(true) })).min(1).max(100) }),
  z.object({ op: z.literal('lot_receive'), companyId: Uuid, productId: Uuid, lotCode: Text(40).min(1), cartons: z.number().int().positive().max(100000), stockLocationId: Uuid.nullish(),
    pallet: Text(40).nullish(), procurementItemId: Uuid.nullish() }),
  z.object({ op: z.literal('lot_move'), companyId: Uuid, lotId: Uuid, kind: z.enum(['TRANSFER', 'COUNT', 'RESERVE', 'RELEASE', 'ISSUE', 'RETURN']), cartons: z.number().int().min(0).max(100000).nullish(),
    toStockLocationId: Uuid.nullish(), jobId: Uuid.nullish(), note: Text(500).nullish() }),
  z.object({ op: z.literal('unmatched'), companyId: Uuid, description: Text(300).min(1), vendorName: Text(200).nullish(), poNumber: Text(60).nullish(), qty: z.number().min(0).nullish(),
    photoDocumentIds: z.array(Uuid).max(20).default([]) }),
  z.object({ op: z.literal('match_receipt'), companyId: Uuid, unmatchedId: Uuid, procurementItemId: Uuid }),
  z.object({ op: z.literal('confirmations'), companyId: Uuid, daysAhead: z.number().int().min(0).max(14).nullish() }),
  z.object({ op: z.literal('installer'), companyId: Uuid, installerId: Uuid.nullish(), fields: z.object({ name: Text(200).optional(), worker_type: z.enum(['W2', '1099']).optional(),
    employee_id: Uuid.nullish(), vendor_id: Uuid.nullish(), crew_id: Uuid.nullish(), skills: z.array(Text(40)).max(20).optional(), coi_expires_on: Day.nullish(),
    workers_comp_expires_on: Day.nullish(), w9_on_file: z.boolean().optional(), license_expires_on: Day.nullish(), direct_deposit_on_file: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(), notes: Text(2000).nullish() }) }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' },
  ops: {
    setup_apply: { cap: 'projects.settings', action: 'configure' }, rotation: { cap: 'projects.settings', action: 'configure' }, assign_lead: { cap: 'projects.leads', action: 'edit' },
    price_apply: { cap: 'projects.financials', action: 'edit' }, counter_sale: { cap: 'projects.store', action: 'create' }, confirmations: { cap: 'projects.dispatch', action: 'edit' },
  },
  mask: ['estimate', 'procurement', 'labor_rate'], body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const c = body.companyId;
  switch (body.op) {
    case 'setup_preview': return { plan: buildFlooringPlan(body.answers) };
    case 'setup_apply': {
      const plan = buildFlooringPlan(body.answers);
      return { plan, result: await resRpc(db, 'wc_apply_setup', { p_location: c, p_industry: 'FLOORING', p_answers: body.answers, p_plan: plan }) };
    }
    case 'rotation':
      resWrote(await pm(db).from('flr_lead_rotation').upsert({ org_id: tenant.orgId, location_id: c, members: body.members, followup_hours: body.followupHours, updated_at: new Date().toISOString() },
        { onConflict: 'org_id,location_id' }).select('location_id'));
      return { ok: true };
    case 'assign_lead': return resRpc(db, 'flr_assign_lead', { p_lead: body.leadId });
    case 'price_stage': {
      const parsed = parsePriceFile(body.text);
      if (parsed.lines.length === 0) throw new HttpError(422, parsed.issues[0]?.message ?? 'No prices were found in that file.', 'PM_INVALID');
      const r = await resRpc<Record<string, unknown>>(db, 'flr_stage_price_import', { p_location: c, p_vendor: body.vendorId ?? null, p_source: parsed.source, p_file_name: body.fileName,
        p_lines: parsed.lines, p_effective_on: parsed.effectiveOn });
      return { ...r, issues: parsed.issues };
    }
    case 'price_apply': return resRpc(db, 'flr_apply_price_import', { p_import: body.importId });
    case 'counter_sale': return resRpc(db, 'flr_counter_sale', { p_location: c, p_lines: body.lines, p_tax_rate: body.taxRate, p_customer: body.customerId ?? null,
      p_customer_name: body.customerName ?? null, p_payment_method: body.paymentMethod });
    case 'lot_receive': return resRpc(db, 'flr_receive_lot', { p_location: c, p_product: body.productId, p_lot_code: body.lotCode, p_cartons: body.cartons,
      p_stock_location: body.stockLocationId ?? null, p_pallet: body.pallet ?? null, p_procurement_item: body.procurementItemId ?? null });
    case 'lot_move': return resRpc(db, 'flr_move_lot', { p_lot: body.lotId, p_kind: body.kind, p_cartons: body.cartons ?? null, p_to_stock_location: body.toStockLocationId ?? null,
      p_job: body.jobId ?? null, p_note: body.note ?? null });
    case 'unmatched': return { id: await resRpc<string>(db, 'flr_log_unmatched_receipt', { p_location: c, p_description: body.description, p_vendor_name: body.vendorName ?? null,
      p_po_number: body.poNumber ?? null, p_qty: body.qty ?? null, p_photos: body.photoDocumentIds }) };
    case 'match_receipt': return resRpc(db, 'flr_match_receipt', { p_unmatched: body.unmatchedId, p_item: body.procurementItemId });
    case 'confirmations': return { sent: await resRpc<number>(db, 'flr_send_install_confirmations', { p_location: c, p_days_ahead: body.daysAhead ?? null }) };
    case 'installer': return { installerId: await resRpc<string>(db, 'flr_save_installer', { p_location: c, p_installer: body.installerId ?? null, p_fields: body.fields }) };
  }
});
