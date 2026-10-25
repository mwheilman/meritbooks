export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { xcall } from '@/lib/dealer/rpc';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * The service desk (1125): capacity + appointments + pickup / delivery routes (DLR-41), check-in
 * (DLR-42), findings → estimate → approval (DLR-45), sublets + shop fees (DLR-50), stage + customer
 * texts (DLR-51), QC / close / Books pay link / pickup / storage (DLR-52), internal routing
 * (DLR-53) and WIP with the month-end cutoff (DLR-57). Customer texts go through 1114 (held until
 * the workspace goes live; consent and STOP honored).
 */
const Time = z.string().regex(/^\d{2}:\d{2}$/, 'Use a time like 08:30');
const views = {
  board: view('dlr_service_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  calendar: view('dlr_service_calendar', z.object({ company: Uuid, from: IsoDate.optional(), to: IsoDate.optional() }), (q) => ({ p_location: q.company, p_from: q.from ?? null, p_to: q.to ?? null })),
  route: view('dlr_route_plan', z.object({ company: Uuid, day: IsoDate }), (q) => ({ p_location: q.company, p_day: q.day })),
  ro: view('dlr_ro_desk', z.object({ wo: Uuid }), (q) => ({ p_wo: q.wo })),
  reply: view('dlr_ro_status_reply', z.object({ wo: Uuid }), (q) => ({ p_wo: q.wo })),
  invoice: view('dlr_ro_invoice', z.object({ wo: Uuid }), (q) => ({ p_wo: q.wo })),
  wip: view('dlr_wip_report', z.object({ company: Uuid, cutoff: IsoDate.optional() }), (q) => ({ p_location: q.company, p_cutoff: q.cutoff ?? null })),
  storage: view('dlr_storage_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'repair_order', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Complaint = z.object({ text: Req(300, 'The complaint'), pay_type: z.enum(['CUSTOMER', 'WARRANTY', 'INTERNAL', 'POLICY']).nullish(), flag_hours: z.number().min(0).max(200).nullish(), labor_op: Text(40).nullish(), unit_price_cents: PosCents.nullish() });
const FindingPart = z.object({ part_id: Uuid.nullish(), part_number: Text(40).nullish(), description: Text(200).nullish(), qty: z.number().positive().max(1e5), unit_price_cents: PosCents.nullish() });

const ops = {
  set_capacity: op('dlr_set_service_capacity', z.object({ companyId: Uuid, weekdays: z.record(z.string().regex(/^[0-6]$/), z.number().min(0).max(2000)).nullish(), overrides: z.array(z.object({ day: IsoDate, tech_hours: z.number().min(0).max(2000).nullable(), note: Text(200).nullish() })).max(120).nullish() }),
    (b) => ({ p_location: b.companyId, p_weekdays: b.weekdays ?? null, p_overrides: b.overrides ?? null })),
  book: op('dlr_book_service', z.object({
    companyId: Uuid, apptOn: IsoDate, estHours: z.number().positive().max(200).default(1), customerId: Uuid.nullish(), assetId: Uuid.nullish(), contactId: Uuid.nullish(),
    windowStart: Time.nullish(), windowEnd: Time.nullish(), complaint: Text(1000).nullish(), pickup: z.boolean().default(false), delivery: z.boolean().default(false),
    address: Text(200).nullish(), city: Text(80).nullish(), state: Text(20).nullish(), zip: Text(12).nullish(), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(), notes: Text(1000).nullish(),
  }), (b) => ({ p_location: b.companyId, p_attrs: { appt_on: b.apptOn, est_hours: b.estHours, customer_id: b.customerId ?? null, asset_id: b.assetId ?? null, contact_id: b.contactId ?? null,
    window_start: b.windowStart ?? null, window_end: b.windowEnd ?? null, complaint: b.complaint ?? null, pickup: b.pickup, delivery: b.delivery, address_line1: b.address ?? null, city: b.city ?? null,
    state: b.state ?? null, zip: b.zip ?? null, lat: b.lat ?? null, lng: b.lng ?? null, notes: b.notes ?? null } })),
  update_appointment: op('dlr_update_appointment', z.object({ appointmentId: Uuid, status: z.enum(['BOOKED', 'CONFIRMED', 'ARRIVED', 'NO_SHOW', 'CANCELLED']), apptOn: IsoDate.nullish(), estHours: z.number().positive().max(200).nullish(), notes: Text(1000).nullish() }),
    (b) => ({ p_appointment: b.appointmentId, p_status: b.status, p_attrs: { appt_on: b.apptOn ?? null, est_hours: b.estHours ?? null, notes: b.notes ?? null } })),
  add_stop: op('dlr_add_stop', z.object({ companyId: Uuid, kind: z.enum(['PICKUP', 'DELIVERY']), stopOn: IsoDate, purpose: z.enum(['SERVICE', 'RENTAL', 'SALE']).nullish(), workOrderId: Uuid.nullish(), rentalContractId: Uuid.nullish(),
    dealId: Uuid.nullish(), customerId: Uuid.nullish(), assetId: Uuid.nullish(), windowStart: Time.nullish(), windowEnd: Time.nullish(), address: Text(200).nullish(), city: Text(80).nullish(), state: Text(20).nullish(), zip: Text(12).nullish(),
    lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(), notes: Text(500).nullish() }),
  (b) => ({ p_location: b.companyId, p_attrs: { kind: b.kind, stop_on: b.stopOn, purpose: b.purpose ?? null, work_order_id: b.workOrderId ?? null, rental_contract_id: b.rentalContractId ?? null, deal_id: b.dealId ?? null,
    customer_id: b.customerId ?? null, asset_id: b.assetId ?? null, window_start: b.windowStart ?? null, window_end: b.windowEnd ?? null, address_line1: b.address ?? null, city: b.city ?? null, state: b.state ?? null, zip: b.zip ?? null,
    lat: b.lat ?? null, lng: b.lng ?? null, notes: b.notes ?? null } })),
  route_order: op('dlr_set_route_order', z.object({ companyId: Uuid, day: IsoDate, stops: z.array(Uuid).max(200) }), (b) => ({ p_location: b.companyId, p_day: b.day, p_stops: b.stops })),
  finish_stop: op('dlr_finish_stop', z.object({ stopId: Uuid, status: z.enum(['DONE', 'CANCELLED', 'PLANNED']).default('DONE') }), (b) => ({ p_stop: b.stopId, p_status: b.status })),
  check_in: op('dlr_check_in', z.object({
    companyId: Uuid, unitId: Uuid, jobId: Uuid.nullish(), customerId: Uuid.nullish(), appointmentId: Uuid.nullish(), complaints: z.array(Complaint).min(1).max(30),
    meter: z.number().min(0).max(1e7).nullish(), tagNumber: Text(20).nullish(), authLimitCents: PosCents.nullish(), depositCents: PosCents.nullish(), promisedOn: IsoDate.nullish(),
    payerType: z.enum(['CUSTOMER', 'OEM', 'INTERNAL', 'THIRD_PARTY']).default('CUSTOMER'), payerCustomerId: Uuid.nullish(), photoIds: z.array(Uuid).max(20).default([]),
  }), (b) => ({ p_location: b.companyId, p_unit: b.unitId, p_attrs: { job_id: b.jobId ?? null, customer_id: b.customerId ?? null, appointment_id: b.appointmentId ?? null, complaints: b.complaints,
    meter: b.meter ?? null, tag_number: b.tagNumber ?? null, auth_limit_cents: b.authLimitCents ?? null, deposit_cents: b.depositCents ?? null, promised_on: b.promisedOn ?? null,
    payer_type: b.payerType, payer_customer_id: b.payerCustomerId ?? null, photo_document_ids: b.photoIds } })),
  counter_signature: op('dlr_record_checkin_signature', z.object({ checkinId: Uuid, signer: Req(120, 'The signer'), documentId: Uuid.nullish() }),
    (b) => ({ p_checkin: b.checkinId, p_method: 'COUNTER', p_signer: b.signer, p_document: b.documentId ?? null, p_envelope: null })),
  set_stage: op('dlr_set_ro_stage', z.object({ woId: Uuid, stage: z.enum(['CHECKED_IN', 'DIAGNOSING', 'WAITING_APPROVAL', 'WAITING_PARTS', 'IN_PROGRESS', 'QC', 'READY', 'PICKED_UP']), text: z.boolean().default(true) }),
    (b) => ({ p_wo: b.woId, p_stage: b.stage, p_text: b.text })),
  text_customer: op('dlr_text_ro_customer', z.object({ woId: Uuid, body: Req(600, 'The text') }), (b) => ({ p_wo: b.woId, p_body: b.body })),
  add_finding: op('dlr_add_finding', z.object({ woId: Uuid, description: Req(300, 'What you found'), techNote: Text(1000).nullish(), laborHours: z.number().min(0).max(200).default(0), laborRateCents: PosCents.default(0),
    parts: z.array(FindingPart).max(30).default([]), photoIds: z.array(Uuid).max(20).default([]), videoId: Uuid.nullish() }),
    (b) => ({ p_wo: b.woId, p_attrs: { description: b.description, tech_note: b.techNote ?? null, labor_hours: b.laborHours, labor_rate_cents: b.laborRateCents, parts: b.parts, photo_document_ids: b.photoIds, video_document_id: b.videoId ?? null } })),
  send_estimate: op('dlr_send_estimate', z.object({ woId: Uuid, findings: z.array(Uuid).min(1).max(30), message: Text(600).nullish() }), (b) => ({ p_wo: b.woId, p_findings: b.findings, p_message: b.message ?? null })),
  decide: op('dlr_decide_findings', z.object({ estimateId: Uuid, decisions: z.array(z.object({ finding_id: Uuid, decision: z.enum(['APPROVED', 'DECLINED']) })).min(1).max(30), name: Req(120, 'Who approved'), method: z.enum(['PHONE', 'IN_PERSON', 'PORTAL']).default('PHONE') }),
    (b) => ({ p_estimate: b.estimateId, p_decisions: b.decisions, p_name: b.name, p_method: b.method })),
  add_sublet: op('dlr_add_sublet', z.object({ woId: Uuid, vendorId: Uuid, description: Req(300, 'The outside work'), costCents: PosCents, priceCents: PosCents, poRef: Text(40).nullish(), payType: z.enum(['CUSTOMER', 'WARRANTY', 'INTERNAL', 'POLICY']).default('CUSTOMER') }),
    (b) => ({ p_wo: b.woId, p_attrs: { vendor_id: b.vendorId, description: b.description, cost_cents: b.costCents, price_cents: b.priceCents, po_ref: b.poRef ?? null, pay_type: b.payType } })),
  update_sublet: op('dlr_update_sublet', z.object({ subletId: Uuid, status: z.enum(['OPEN', 'RECEIVED', 'BILLED', 'CANCELLED']), vendorBillRef: Text(60).nullish() }), (b) => ({ p_sublet: b.subletId, p_status: b.status, p_vendor_bill_ref: b.vendorBillRef ?? null })),
  shop_fees: op('dlr_apply_shop_fees', z.object({ woId: Uuid }), (b) => ({ p_wo: b.woId })),
  storage_fee: op('dlr_add_storage_fee', z.object({ woId: Uuid }), (b) => ({ p_wo: b.woId })),
  internal_route: op('dlr_set_internal_route', z.object({ lineId: Uuid, route: z.enum(['PDI', 'RECON', 'RENTAL', 'SHOP', 'POLICY']), assetId: Uuid.nullish() }), (b) => ({ p_line: b.lineId, p_route: b.route, p_asset: b.assetId ?? null })),
  qc: op('dlr_qc_signoff', z.object({ woId: Uuid, checklist: z.array(z.object({ item: Req(120, 'The item'), ok: z.boolean(), note: Text(300).nullish() })).min(1).max(60), passed: z.boolean().default(true) }),
    (b) => ({ p_wo: b.woId, p_checklist: b.checklist, p_passed: b.passed })),
  close: op('dlr_close_ro', z.object({ woId: Uuid, outcome: z.enum(['FIXED', 'PARTIAL', 'NOT_FIXED', 'NO_PROBLEM_FOUND', 'DECLINED']).default('FIXED') }), (b) => ({ p_wo: b.woId, p_outcome: b.outcome })),
  pickup: op('dlr_record_pickup', z.object({ woId: Uuid, signer: Req(120, 'Who picked it up'), documentId: Uuid.nullish() }), (b) => ({ p_wo: b.woId, p_signer: b.signer, p_document: b.documentId ?? null })),
};

const PayLink = z.object({ op: z.literal('pay_link'), woId: Uuid });
const Body = deskBody(ops).or(PayLink);

export const POST = route({
  access: { cap: 'projects.store', action: 'edit' },
  ops: { check_in: { cap: 'projects.store', action: 'create' } },
  mask: 'repair_order', body: Body,
}, async ({ db, body, tenant }) => {
  if (body.op === 'pay_link') {
    const b = PayLink.parse(body);
    // The pay-link origin is the store's configured setting (security review L1), never sent from here.
    return xcall(db, 'dlr_text_pay_link', { p_wo: b.woId });
  }
  return runOp(ops, body, db, tenant);
});

