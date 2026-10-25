export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall, xone, xrows } from '@/lib/dealer/rpc';
import { submitterFor, type PreparedSubmission } from '@/lib/dealer/warranty-adapters';
import { Cents, IsoDate, PosCents, Qty, Req, Text, Uuid } from '@/lib/dealer/schemas';

export const CLAIM_COLS = 'id, job_id, work_order_id, asset_id, payer_customer_id, claim_number, status, failure_code, labor_op, labor_hours, claimed_labor_cents, claimed_parts_cents, claimed_other_cents, claimed_cents, approved_cents, paid_cents, filing_deadline, submitted_at, decided_at, decision_reason, notes, oem_brand, causal_part_number, causal_part_serial, failure_on, repair_on, purchase_on, machine_hours, engine_hours, engine_serial, symptom_code, defect_code, remedy_code, complaint, cause, correction, requested_hours, pre_auth_ref, submit_by, response_due_on, retention_until, return_tag, parts_returned_on, submission_channel, external_ref, adjudication, credit_memo_ref, credited_cents, rebill_requested_at';

/** The claim builder: the claim, what the OEM still needs, its parts, and every submission attempt. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'repair_order' }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const claim = await xone<Record<string, unknown> & { id: string; asset_id: string | null; work_order_id: string }>(pm.from('warranty_claims').select(CLAIM_COLS).eq('id', params.claimId!).maybeSingle(), 'claim', 'That warranty claim was not found.');
  const [readiness, parts, submissions, unit, wo] = await Promise.all([
    xcall<Record<string, unknown>>(db, 'dlr_claim_readiness', { p_claim: claim.id }),
    xrows<Record<string, unknown>>(pm.from('dlr_claim_parts').select('id, line_no, part_number, description, qty, unit_price_cents, amount_cents, is_causal, return_required, returned_on').eq('claim_id', claim.id).order('line_no'), 'claim parts'),
    xrows<Record<string, unknown>>(pm.from('dlr_claim_submissions').select('id, attempt_no, brand, channel, packet, status, external_ref, response, created_at, updated_at').eq('claim_id', claim.id).order('attempt_no', { ascending: false }), 'submissions'),
    claim.asset_id ? pm.from('assets').select('id, make, model, model_year, serial_number, stock_number').eq('id', claim.asset_id).maybeSingle().then((r) => r.data) : Promise.resolve(null),
    pm.from('work_orders').select('id, number, status').eq('id', claim.work_order_id).maybeSingle().then((r) => r.data),
  ]);
  return { claim, readiness, parts, submissions, unit, workOrder: wo };
});

const Fields = z.object({
  oem_brand: Text(30), causal_part_number: Text(40), causal_part_serial: Text(60), failure_on: IsoDate, repair_on: IsoDate, purchase_on: IsoDate,
  machine_hours: Qty, engine_hours: Qty, engine_serial: Text(60), symptom_code: Text(30), defect_code: Text(30), remedy_code: Text(30),
  complaint: Text(2000), cause: Text(2000), correction: Text(2000), requested_hours: Qty, pre_auth_ref: Text(60), return_tag: Text(60),
  failure_code: Text(30), labor_op: Text(30), labor_hours: Qty, claimed_labor_cents: PosCents, claimed_other_cents: PosCents, notes: Text(2000), filing_deadline: IsoDate,
}).partial();

const Part = z.object({ part_number: Req(40, 'The part number'), description: Text(200).nullish(), qty: z.number().positive().max(1e6), unit_price_cents: PosCents.nullish(), is_causal: z.boolean().default(false), return_required: z.boolean().default(false), part_id: Uuid.nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), fields: Fields }),
  z.object({ op: z.literal('parts'), parts: z.array(Part).max(100) }),
  z.object({ op: z.literal('prepare') }),
  z.object({ op: z.literal('submitted'), submissionId: Uuid, status: z.enum(['FILED_ON_PORTAL', 'FAILED']), claimNumber: Text(60).nullish(), externalRef: Text(60).nullish(), note: Text(500).nullish() }),
  z.object({ op: z.literal('response'), outcome: z.enum(['ACCEPTED', 'ADJUSTED', 'REJECTED', 'RETURNED']), approvedCents: Cents.nullish(), reason: Text(500).nullish() }),
  z.object({ op: z.literal('resolve'), action: z.enum(['RESUBMIT', 'REBILL', 'WRITE_OFF']), reason: Text(500).nullish() }),
]);

/**
 * Build and file the claim. `prepare` writes the packet and, when the brand's direct interface is
 * connected, hands it to that adapter (all stubs today → the clerk files from the portal-assist
 * packet and records the claim number with `submitted`).
 */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, ops: { resolve: { cap: 'projects.store', action: 'edit' } }, mask: 'repair_order', body: Op }, async ({ db, params, body }) => {
  const claim = params.claimId!;
  switch (body.op) {
    case 'update': {
      const fields = Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, v === '' ? null : v]));
      return { id: await xcall<string>(db, 'dlr_update_claim', { p_claim: claim, p_fields: fields }) };
    }
    case 'parts':
      return { count: await xcall<number>(db, 'dlr_set_claim_parts', { p_claim: claim, p_parts: body.parts }) };
    case 'prepare': {
      const prep = await xcall<PreparedSubmission>(db, 'dlr_prepare_claim_submission', { p_claim: claim });
      if (prep.channel !== 'DIRECT') return { ...prep, adapter: null };
      const adapter = submitterFor((prep.packet.unit?.make as string | undefined) ?? null);
      const out = adapter ? await adapter.submit(prep) : { status: 'NOT_CONNECTED' as const, message: 'No direct interface for this brand; file from the packet.' };
      if (out.status === 'SENT' || out.status === 'ACKNOWLEDGED') {
        await xcall(db, 'dlr_record_claim_submitted', { p_submission: prep.submission_id, p_status: out.status, p_external_ref: out.externalRef, p_claim_number: out.claimNumber, p_response: out.response });
      } else if (out.status === 'FAILED') {
        await xcall(db, 'dlr_record_claim_submitted', { p_submission: prep.submission_id, p_status: 'FAILED', p_response: out.response });
      }
      return { ...prep, adapter: out };
    }
    case 'submitted':
      return xcall(db, 'dlr_record_claim_submitted', { p_submission: body.submissionId, p_status: body.status, p_external_ref: body.externalRef ?? null, p_claim_number: body.claimNumber ?? null, p_response: body.note ? { note: body.note } : null });
    case 'response':
      return xcall(db, 'dlr_record_claim_response', { p_claim: claim, p_outcome: body.outcome, p_approved_cents: body.approvedCents ?? null, p_reason: body.reason ?? null });
    case 'resolve':
      return xcall(db, 'dlr_resolve_rejected_claim', { p_claim: claim, p_action: body.action, p_reason: body.reason ?? null });
  }
});
