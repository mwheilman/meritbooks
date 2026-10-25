export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { linkBase } from '@/lib/documents/http';
import { xcall, xone } from '@/lib/dealer/rpc';
import { Req, Text } from '@/lib/dealer/schemas';
import { requestSignature } from '@/lib/esign/api';
import { generateDocument } from '@/lib/templates/generate';

const Body = z.object({
  signers: z.array(z.object({ name: Req(120, 'The signer'), email: z.string().trim().email().max(200).nullish(), phone: z.string().trim().regex(/^\+?[0-9 ().-]{7,20}$/).nullish(), roleLabel: Text(60).nullish() })
    .refine((s) => s.email || s.phone, { message: 'E-mail or text each signer', path: ['email'] })).min(1).max(4),
  message: Text(1000).nullish(),
});

/**
 * POST /api/mfg/proposals/:id/send — MFG-11: send the proposal for signature. The estimate goes out
 * (pm.send_estimate keeps its approval floor), the branded proposal PDF is rendered from it (1115
 * template, versioned per send), the envelope completes the estimate on signature (accept → contract
 * value, quote-to-job keeps the version), and migration 1125 marks the proposal signed / declined.
 */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: Body }, async ({ req, db, tenant, userId, body, params }) => {
  const pm = db.schema('pm');
  const p = await xcall<{ id: string; status: string; estimate_id: string; location_id: string; title: string }>(db, 'mfg_proposal_detail', { p_proposal: params.proposalId! });
  assertCompany(tenant, p.location_id);
  if (p.status !== 'DRAFT') throw new HttpError(409, 'This proposal was already sent. Save a new version to send again.', 'PM_INVALID');
  const est = await xone<{ status: string }>(pm.from('estimates').select('status').eq('id', p.estimate_id).maybeSingle(), 'estimate', 'The estimate was not found.');
  if (est.status === 'DRAFT') await xcall(db, 'send_estimate', { p_estimate: p.estimate_id });
  const doc = await generateDocument(db, { orgId: tenant.orgId, userId }, { template: 'proposal', sourceId: p.estimate_id, title: p.title });
  const sent = await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, {
    documentId: doc.fileId,
    signers: body.signers.map((s, i) => ({ name: s.name, email: s.email ?? undefined, phone: s.phone ?? undefined, roleLabel: s.roleLabel ?? 'Client', channel: s.email && s.phone ? 'both' : s.email ? 'email' : 'sms', order: i + 1 })),
    title: `${p.title} — proposal`,
    message: body.message ?? undefined,
    expiresDays: 30,
    routing: 'sequential',
    onCompleted: { kind: 'estimate', id: p.estimate_id },
  });
  await xcall(db, 'mfg_mark_proposal_sent', { p_proposal: p.id, p_file: doc.fileId, p_envelope: sent.envelopeId });
  return { envelopeId: sent.envelopeId, fileId: doc.fileId, deliveries: sent.deliveries.map((d) => ({ name: d.name, channel: d.channel, link: d.link })) };
});
