export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { xcall, xone } from '@/lib/dealer/rpc';
import { Req, Text, Uuid } from '@/lib/dealer/schemas';
import { requestSignature } from '@/lib/esign/api';

const Body = z.object({
  fileId: Uuid,
  reviewerKind: z.enum(['GC', 'ARCHITECT', 'DESIGNER', 'OWNER', 'ENGINEER']).default('GC'),
  reviewer: z.object({ name: Req(120, 'The reviewer'), email: z.string().trim().email().max(200) }).nullish(),
  message: Text(1000).nullish(),
});

/**
 * POST /api/mfg/shop-drawings/:id/submit — MFG-16: send the shop drawing PDF (a document on the
 * job) to the GC / architect. With a reviewer, the e-sign service sends a one-time link: signing
 * stamps it APPROVED, declining returns it REVISE & RESUBMIT with their reason (migration 1125's
 * settle trigger). Without one, it is recorded as submitted and the returned stamp is entered.
 */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: false, body: Body }, async ({ req, db, tenant, userId, body, params }) => {
  const d = await xone<{ id: string; number: string; revision: number; title: string }>(
    db.schema('pm').from('mfg_shop_drawings').select('id, number, revision, title').eq('id', params.sdId!).maybeSingle(), 'shop drawing', 'That shop drawing was not found.');
  let envelopeId: string | null = null;
  if (body.reviewer) {
    // Security review R6: the reviewer is outside the organization (checked before anything is sent),
    // and the one-time signing link goes only to the reviewer — it is never returned to the drafter.
    await xcall(db, 'mfg_check_reviewer', { p_id: d.id, p_email: body.reviewer.email });
    const sent = await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, {
      documentId: body.fileId,
      signers: [{ name: body.reviewer.name, email: body.reviewer.email, roleLabel: body.reviewerKind === 'ARCHITECT' ? 'Architect' : body.reviewerKind === 'GC' ? 'General contractor' : 'Reviewer', channel: 'email', order: 1 }],
      title: `Shop drawing ${d.number} rev ${d.revision}: ${d.title}`,
      message: body.message ?? 'Sign to approve. Decline with your comments to return it for revision.',
      expiresDays: 21,
      routing: 'sequential',
    });
    envelopeId = sent.envelopeId;
  }
  const r = await xcall(db, 'mfg_submit_shop_drawing', { p_id: d.id, p_file: body.fileId, p_reviewer_kind: body.reviewerKind, p_envelope: envelopeId });
  return { result: r, envelopeId, sentToReviewer: envelopeId !== null };
});
