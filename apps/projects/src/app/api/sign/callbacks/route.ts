export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { currentUser } from '@clerk/nextjs/server';
import { route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { linkBase } from '@/lib/documents/http';
import { processOutbox } from '@/lib/esign/callbacks';

/**
 * POST /api/sign/callbacks — work the caller's pending e-sign events: next signer's link,
 * signed PDF + audit certificate, and the record's own action (estimate accepted, change order
 * approved, lien waiver received, buyer's order accepted). Idempotent; safe to call on every page
 * load (the documents views and the inbox do).
 */
export const POST = route({
  access: { cap: 'projects.documents', action: 'view' }, mask: false,
  body: z.object({ envelopeId: z.string().uuid().optional(), limit: z.number().int().min(1).max(25).optional() }),
}, async ({ req, db, tenant, userId, body, access }) => {
  const me = await currentUser().catch(() => null);
  const senderName = me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.primaryEmailAddress?.emailAddress || null : null;
  return processOutbox({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, {
    envelopeId: body.envelopeId, limit: body.limit, senderName,
    canManage: (env) => can(access, 'projects.documents', 'edit', env.location_id),
  });
});
