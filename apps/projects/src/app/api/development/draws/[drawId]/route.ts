export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { linkBase } from '@/lib/documents/http';
import { requestSignature } from '@/lib/esign/api';
import { SignerInput } from '@/lib/esign/types';
import { xcall, xone, xrows } from '@/lib/dealer/rpc';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * One lender draw: the invoices behind it, the pre-submission check (waivers, invoices,
 * approvals, COIs, inspection, the in-balance gap), the waivers tied to it, and the package in
 * the lender's read order with the G702 / G703 figures.
 */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['billing', 'commitment'] }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const draw = await xone<{ id: string; job_id: string; draw_schedule_id: string } & Record<string, unknown>>(pm.from('draws').select('id, job_id, draw_schedule_id, draw_number, period_end, status, inspection_status, inspected_on, requested_cents, approved_cents').eq('id', params.drawId!).maybeSingle(), 'draw', 'That draw was not found.');
  const [invoices, waivers, precheck, pkg, template] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('dev_draw_invoices').select('id, vendor_id, commitment_id, cost_code_id, draw_budget_line_id, invoice_number, invoice_on, amount_cents, retainage_cents, document_id, status, approved_at, created_by').eq('draw_id', draw.id).order('created_at'), 'draw invoices'),
    xrows<Record<string, unknown>>(pm.from('dev_draw_waivers').select('id, vendor_id, kind, compliance_doc_id, amount_cents, through_on, esign_envelope_id, created_at').eq('draw_id', draw.id).order('created_at'), 'waivers'),
    xcall<Record<string, unknown>>(db, 'dev_draw_precheck', { p_draw: draw.id }),
    xcall<Record<string, unknown>>(db, 'dev_draw_package', { p_draw: draw.id }),
    pm.from('dev_lender_templates').select('sections, format_notes').eq('draw_schedule_id', draw.draw_schedule_id).maybeSingle().then((r) => r.data),
  ]);
  const docIds = waivers.map((w) => w.compliance_doc_id as string).filter(Boolean);
  const envelopes = docIds.length
    ? await xrows<{ id: string; on_completed_id: string; status: string; sent_at: string | null; completed_at: string | null }>(pm.from('esign_envelopes').select('id, on_completed_id, status, sent_at, completed_at').eq('on_completed_kind', 'lien_waiver').in('on_completed_id', docIds).order('created_at', { ascending: false }), 'waiver envelopes')
    : [];
  const docs = docIds.length
    ? await xrows<{ id: string; status: string; doc_type: string; document_id: string | null }>(pm.from('compliance_docs').select('id, status, doc_type, document_id').in('id', docIds), 'waiver documents')
    : [];
  return { draw, invoices, waivers, waiverDocs: docs, envelopes, precheck, package: pkg, template };
});

const Section = z.object({ key: Req(40, 'The section key'), label: Req(120, 'The label'), required: z.boolean().default(true) });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_invoice'), vendorId: Uuid, invoiceNumber: Req(60, 'The invoice number'), amountCents: z.number().int().positive().max(1e13), invoiceOn: IsoDate.nullish(), commitmentId: Uuid.nullish(), costCodeId: Uuid.nullish(), drawBudgetLineId: Uuid.nullish(), retainageCents: PosCents.default(0), documentId: Uuid.nullish() }),
  z.object({ op: z.literal('decide_invoice'), invoiceId: Uuid, approve: z.boolean() }),
  z.object({ op: z.literal('build') }),
  z.object({ op: z.literal('request_waivers') }),
  z.object({ op: z.literal('send_waiver'), complianceDocId: Uuid, documentId: Uuid, signer: SignerInput, message: Text(2000).optional() }),
  z.object({ op: z.literal('set_template'), sections: z.array(Section).min(1).max(30), notes: Text(2000).nullish() }),
]);

export const POST = route({
  access: { cap: 'projects.billing', action: 'edit' },
  ops: { decide_invoice: { cap: 'projects.billing', action: 'approve' } },
  mask: ['billing', 'commitment'],
  body: Op,
}, async ({ req, db, params, body, tenant, userId }) => {
  const drawId = params.drawId!;
  switch (body.op) {
    case 'add_invoice':
      return { id: await xcall<string>(db, 'dev_add_draw_invoice', { p_draw: drawId, p_vendor: body.vendorId, p_invoice_number: body.invoiceNumber, p_amount_cents: body.amountCents, p_invoice_on: body.invoiceOn ?? null, p_commitment: body.commitmentId ?? null, p_cost_code: body.costCodeId ?? null, p_draw_budget_line: body.drawBudgetLineId ?? null, p_retainage_cents: body.retainageCents, p_document: body.documentId ?? null }) };
    case 'decide_invoice':
      // approving goes through the invoice's approval chain (steps, roles, preparer ≠ approver);
      // excluding an invoice from the draw stays a direct decision
      if (body.approve) return xcall(db, 'dev_decide_invoice_step', { p_invoice: body.invoiceId, p_approve: true, p_note: null, p_channel: 'web' });
      return { id: await xcall<string>(db, 'dev_decide_draw_invoice', { p_invoice: body.invoiceId, p_approve: false }) };
    case 'build':
      return xcall(db, 'dev_build_draw', { p_draw: drawId });
    case 'request_waivers':
      return xcall(db, 'dev_request_draw_waivers', { p_draw: drawId });
    case 'send_waiver': {
      // A waiver document (rendered from the lien-waiver template) goes out through Wave A e-sign;
      // when it is signed, the e-sign callback receives the compliance doc (kind lien_waiver).
      const w = await xrows<{ id: string }>(db.schema('pm').from('dev_draw_waivers').select('id').eq('draw_id', drawId).eq('compliance_doc_id', body.complianceDocId), 'waiver');
      if (!w.length) throw new HttpError(404, 'That waiver is not on this draw. Request waivers first.', 'NOT_FOUND');
      const r = await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, { documentId: body.documentId, signers: [body.signer], title: 'Lien waiver', message: body.message, onCompleted: { kind: 'lien_waiver', id: body.complianceDocId } });
      return r;
    }
    case 'set_template': {
      const d = await xone<{ draw_schedule_id: string }>(db.schema('pm').from('draws').select('draw_schedule_id').eq('id', drawId).maybeSingle(), 'draw', 'That draw was not found.');
      return { id: await xcall<string>(db, 'dev_set_lender_template', { p_schedule: d.draw_schedule_id, p_sections: body.sections, p_notes: body.notes ?? null }) };
    }
  }
});
