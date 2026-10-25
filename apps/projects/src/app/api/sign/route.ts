export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { requestSignature } from '@/lib/esign/api';
import { RequestSignatureInput } from '@/lib/esign/types';

/**
 * POST /api/sign — send a document for signature (one-time links by email / text; when a channel
 * is not set up the links come back for the sender to share). Money documents need the money
 * capability (enforced in pm.esign_create).
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: RequestSignatureInput }, async ({ req, db, tenant, userId, body }) => {
  return { ok: true, ...(await requestSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, body)) };
});
