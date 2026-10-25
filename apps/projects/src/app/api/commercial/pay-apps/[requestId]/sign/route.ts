export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { linkBase } from '@/lib/documents/http';
import { requestSignature } from '@/lib/esign/api';
import { generateDocument } from '@/lib/templates/generate';
import { PayAppSign } from '@/lib/commercial/screen-schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/pay-apps/:id/sign — the contractor's signature on the pay application
 * (CGC-44): render the branded G702-style cover from the request as it stands, file it on the
 * request, and send it through the one e-sign service (one-time links). The architect's
 * certification and notary block are recorded on the workspace (op certify); the owner approves
 * when Merit Books issues the invoice. Re-signing a revised application renders a new version.
 */
export const POST = route({ access: { cap: 'projects.billing', action: 'edit' }, mask: false, body: PayAppSign }, async ({ req, db, tenant, userId, body, params }) => {
  const id = params.requestId!;
  const r = await db.schema('pm').from('billing_requests').select('id, status, billing_subtype').eq('id', id).maybeSingle();
  if (r.error) throw cmError(r.error);
  const row = r.data as { id: string; status: string; billing_subtype: string | null } | null;
  if (!row || row.billing_subtype !== 'SOV') throw new HttpError(404, 'That pay application was not found.', 'NOT_FOUND');
  if (row.status === 'VOID') throw new HttpError(409, 'This application was replaced by a revision. Sign the current revision.', 'PM_PAYAPP_STAGE');
  const doc = await generateDocument(db, { orgId: tenant.orgId, userId }, { template: 'pay_app_cover', sourceId: id });
  const sent = await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, {
    documentId: doc.fileId,
    signers: body.signers.map((s, i) => ({ name: s.name, email: s.email, roleLabel: s.roleLabel ?? 'Contractor', channel: s.email ? 'email' : 'link', order: i + 1 })),
    title: 'Application for payment — please sign',
    message: body.message ?? undefined,
    expiresDays: 7,
    routing: 'sequential',
  });
  // link the envelope to the pay app: its completion (pm.tg_cm_pay_app_esign) is the only thing that stamps contractor_signed_at
  await cmRpc<string>(db, 'cm_pay_app_link_envelope', { p_request: id, p_envelope: sent.envelopeId }, 'billing request');
  return { envelopeId: sent.envelopeId, fileId: doc.fileId, deliveries: sent.deliveries.map((d) => ({ name: d.name, channel: d.channel, link: d.link })) };
});
