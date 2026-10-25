export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Text, Uuid } from '@/lib/residential/schemas';

/** A flooring job's 1124 records: field changes (pay masked), receipts, callbacks, sign-offs, deposit terms. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['change_order', 'procurement', 'labor_rate'] }, async ({ db, params }) => {
  const job = params.jobId!;
  const [changes, receipts, callbacks, signoffs] = await Promise.all([
    pm(db).from('v_flr_field_changes_masked').select('id, change_order_id, lines, sell_cents, pay_cents, signer_name, pay_ticket_id, created_at').eq('job_id', job).order('created_at', { ascending: false }),
    pm(db).from('v_flr_receipts_masked').select('id, procurement_item_id, qty_received, condition, lot_code, freight_in_cents, landed_cost_cents, photo_document_ids, notes, received_at').eq('job_id', job).order('received_at', { ascending: false }),
    pm(db).from('v_flr_callbacks_masked').select('id, punch_item_id, roll_id, lot_code, installer_id, reason, description, cost_cents, status, fault, created_at').eq('job_id', job).order('created_at', { ascending: false }),
    pm(db).from('flr_signoffs').select('id, booking_id, signer_name, signed_at, notes').eq('job_id', job).order('signed_at', { ascending: false }),
  ]);
  return { fieldChanges: resWrote(changes), receipts: resWrote(receipts), callbacks: resWrote(callbacks), signoffs: resWrote(signoffs) };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('deposit'), pct: z.number().positive().max(1).nullish(), amountCents: Cents.nullish(), refundable: z.boolean().default(false) }),
  z.object({ op: z.literal('measure_credit'), estimateId: Uuid }),
  z.object({ op: z.literal('field_change'), lines: z.array(z.object({ labor_code: z.string().regex(/^[A-Z0-9_]{2,32}$/), qty: z.number().positive().max(1e6), description: Text(200).nullish() })).min(1).max(20),
    signerName: Text(200).nullish(), signatureDocumentId: Uuid.nullish(), note: Text(200).nullish(), commandId: Uuid.nullish() }),
  z.object({ op: z.literal('pay_from_changes'), ticketId: Uuid }),
  z.object({ op: z.literal('special_order'), productId: Uuid, qty: z.number().positive().max(1e7), shipTo: z.enum(['STORE', 'JOBSITE']).default('STORE'), sidemark: Text(120).nullish(), vendorId: Uuid.nullish() }),
  z.object({ op: z.literal('create_pos') }),
  z.object({ op: z.literal('receive'), itemId: Uuid, qty: z.number().min(0).max(1e7), condition: z.enum(['GOOD', 'DAMAGED', 'PARTIAL', 'WRONG_ITEM']), photoDocumentIds: z.array(Uuid).max(20).default([]),
    freightInCents: Cents.default(0), lotCode: Text(40).nullish(), notes: Text(2000).nullish() }),
  z.object({ op: z.literal('completion_invoice') }),
  z.object({ op: z.literal('callback'), reason: z.enum(['SEAM', 'GAP', 'PEAKING', 'STAIN', 'DEFECT', 'DAMAGE', 'SQUEAK', 'OTHER']), description: Text(2000).nullish(), rollId: Uuid.nullish(),
    installerId: Uuid.nullish(), productId: Uuid.nullish() }),
  z.object({ op: z.literal('close_callback'), callbackId: Uuid, fault: z.enum(['INSTALLER', 'MILL', 'CUSTOMER', 'SITE', 'UNKNOWN']), costCents: Cents.default(0) }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' },
  ops: {
    deposit: { cap: 'projects.billing', action: 'create' }, measure_credit: { cap: 'projects.estimates', action: 'edit' }, pay_from_changes: { cap: 'projects.labor_rates', action: 'edit' },
    create_pos: { cap: 'projects.commitments', action: 'create' }, completion_invoice: { cap: 'projects.billing', action: 'create' }, callback: { cap: 'projects.jobs', action: 'edit' },
    close_callback: { cap: 'projects.jobs', action: 'edit' },
  },
  mask: ['change_order', 'procurement', 'labor_rate', 'billing', 'estimate'], body: Body }, async ({ db, params, body }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'deposit': return resRpc(db, 'flr_request_deposit', { p_job: job, p_pct: body.pct ?? null, p_amount_cents: body.amountCents ?? null, p_refundable: body.refundable });
    case 'measure_credit': return resRpc(db, 'flr_credit_measure_fee', { p_estimate: body.estimateId });
    case 'field_change': return resRpc(db, 'flr_field_change', { p_job: job, p_lines: body.lines, p_signer_name: body.signerName ?? null, p_signature_document: body.signatureDocumentId ?? null, p_note: body.note ?? null, p_command: body.commandId ?? null });
    case 'pay_from_changes': return resRpc(db, 'flr_add_field_changes_to_ticket', { p_ticket: body.ticketId });
    case 'special_order': return { itemId: await resRpc<string>(db, 'flr_special_order', { p_job: job, p_product: body.productId, p_qty: body.qty, p_ship_to: body.shipTo, p_sidemark: body.sidemark ?? null, p_vendor: body.vendorId ?? null }) };
    case 'create_pos': return resRpc(db, 'flr_create_special_order_pos', { p_job: job });
    case 'receive': return resRpc(db, 'flr_receive_special_order', { p_item: body.itemId, p_qty: body.qty, p_condition: body.condition, p_photos: body.photoDocumentIds,
      p_freight_in_cents: body.freightInCents, p_lot_code: body.lotCode ?? null, p_notes: body.notes ?? null });
    case 'completion_invoice': return resRpc(db, 'flr_completion_invoice', { p_job: job });
    case 'callback': return resRpc(db, 'flr_open_callback', { p_job: job, p_reason: body.reason, p_description: body.description ?? null, p_roll: body.rollId ?? null,
      p_installer: body.installerId ?? null, p_product: body.productId ?? null });
    case 'close_callback': return { callbackId: await resRpc<string>(db, 'flr_close_callback', { p_callback: body.callbackId, p_fault: body.fault, p_cost_cents: body.costCents }) };
  }
});
