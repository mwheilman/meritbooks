export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { requestMeta } from '@/lib/esign/public';
import { signableFiles, startInPersonSigning } from '../_lib/phone-sign';

/** GET /api/field/sign?jobId= — the PDFs on the job a customer can sign on this phone. */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false, query: z.object({ jobId: z.string().uuid() }) }, async ({ db, tenant, query }) => ({
  files: await signableFiles(db, tenant.companies.map((c) => c.id), query.jobId),
}));

const Start = z.object({
  documentId: z.string().uuid(),
  signerName: z.string().trim().min(2, 'Type the customer’s name').max(120),
  signerRole: z.string().trim().max(60).nullish(),
  title: z.string().trim().max(200).nullish(),
});

/**
 * POST /api/field/sign — hand the phone to the customer: opens an e-sign envelope with ONE in-person
 * signer on the "link" channel (nothing is emailed or texted) and returns its one-time token and the
 * document route to this phone only. Needs a connection (the document comes from the office); the
 * customer's signature itself is queued (`esign.sign`), so a dropped signal never loses it.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: Start }, async ({ req, db, tenant, userId, body }) =>
  startInPersonSigning(
    { db, orgId: tenant.orgId, userId, baseUrl: linkBase(req), meta: requestMeta(req.headers) },
    { documentId: body.documentId, signerName: body.signerName, signerRole: body.signerRole ?? null, title: body.title ?? null },
  ));
