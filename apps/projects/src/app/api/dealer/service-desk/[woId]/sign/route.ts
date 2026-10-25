export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { linkBase } from '@/lib/documents/http';
import { xcall, xone } from '@/lib/dealer/rpc';
import { Req, Text, Uuid } from '@/lib/dealer/schemas';
import { requestSignature } from '@/lib/esign/api';
import { generateDocument } from '@/lib/templates/generate';

const Body = z.object({
  kind: z.enum(['checkin', 'estimate']),
  estimateId: Uuid.nullish(),
  name: Req(120, 'The customer name'),
  phone: z.string().trim().regex(/^\+?[0-9 ().-]{7,20}$/, 'Enter a mobile number').nullish(),
  email: z.string().trim().email().max(200).nullish(),
  message: Text(600).nullish(),
}).refine((b) => b.phone || b.email, { message: 'Text or e-mail the customer', path: ['phone'] })
  .refine((b) => b.kind !== 'estimate' || b.estimateId, { message: 'Pick the estimate to send', path: ['estimateId'] });

/**
 * POST /api/dealer/service-desk/:woId/sign — the customer signs from their phone (DLR-42 / DLR-45):
 * render the RO (work order template, with the findings as PROPOSED lines and their photos listed),
 * send it through the one e-sign service by text, and link the envelope to the check-in or the
 * estimate batch. When the customer signs, migration 1125's settle trigger records the check-in
 * signature or approves every finding in the batch; a decline declines them.
 */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: false, body: Body }, async ({ req, db, tenant, userId, body, params }) => {
  const pm = db.schema('pm');
  const wo = await xone<{ id: string; location_id: string; number: string; job_id: string }>(pm.from('work_orders').select('id, location_id, number, job_id').eq('id', params.woId!).maybeSingle(), 'RO', 'That RO was not found.');
  assertCompany(tenant, wo.location_id);
  let checkinId: string | null = null;
  if (body.kind === 'checkin') {
    const ck = await xone<{ id: string; signed_at: string | null }>(pm.from('dlr_ro_checkins').select('id, signed_at').eq('work_order_id', wo.id).maybeSingle(), 'check-in', 'This RO has no check-in yet.');
    if (ck.signed_at) throw new HttpError(409, 'The check-in is already signed.', 'ALREADY_SIGNED');
    checkinId = ck.id;
  }
  const doc = await generateDocument(db, { orgId: tenant.orgId, userId }, { template: 'work_order', sourceId: wo.id, title: body.kind === 'checkin' ? `RO ${wo.number} check-in authorization` : `RO ${wo.number} added work` });
  const sent = await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, {
    documentId: doc.fileId,
    signers: [{ name: body.name, phone: body.phone ?? undefined, email: body.email ?? undefined, roleLabel: 'Customer', channel: body.phone && body.email ? 'both' : body.phone ? 'sms' : 'email', order: 1 }],
    title: body.kind === 'checkin' ? `Authorize repair order ${wo.number}` : `Approve added work on ${wo.number}`,
    message: body.message ?? undefined,
    expiresDays: 3,
    routing: 'sequential',
  });
  if (checkinId) await xcall(db, 'dlr_record_checkin_signature', { p_checkin: checkinId, p_method: 'TEXT', p_signer: body.name, p_document: null, p_envelope: sent.envelopeId });
  else await xcall(db, 'dlr_link_estimate_envelope', { p_estimate: body.estimateId, p_envelope: sent.envelopeId });
  return { envelopeId: sent.envelopeId, fileId: doc.fileId, deliveries: sent.deliveries.map((d) => ({ name: d.name, channel: d.channel, link: d.link })) };
});
