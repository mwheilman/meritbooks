export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { unwrap } from '@/lib/documents/errors';
import { linkBase } from '@/lib/documents/http';
import { resendLink, voidEnvelope } from '@/lib/esign/api';
import type { EnvelopeRow, EventRow, SignerRow } from '@/lib/esign/types';

/** GET /api/sign/:envelopeId — status, signers (no signature images) and the audit trail. */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ db, params }) => {
  const p = db.schema('pm');
  const e = unwrap<EnvelopeRow | null>(await p.from('esign_envelopes').select('id, location_id, job_id, file_id, version_id, title, message, status, routing, expires_at, on_completed_kind, on_completed_id, sender_user, sent_at, completed_at, declined_at, decline_reason, voided_at, void_reason, original_sha256, finalize_state, finalize_error, signed_version_id, signed_sha256, created_at').eq('id', params.envelopeId!).maybeSingle());
  if (!e) throw new HttpError(404, 'That signature request was not found.', 'NOT_FOUND');
  const [s, ev] = await Promise.all([
    p.from('esign_signers').select('id, envelope_id, routing_order, position, name, email, phone, role_label, channel, status, sent_at, viewed_at, consented_at, consent_version, signed_at, typed_name, sign_ip, sign_user_agent, declined_at, decline_reason').eq('envelope_id', e.id).order('position'),
    p.from('esign_events').select('id, envelope_id, signer_id, event, at, ip, user_agent, actor_user, detail').eq('envelope_id', e.id).order('seq'),
  ]);
  return { envelope: e, signers: (s.data ?? []) as SignerRow[], events: (ev.data ?? []) as EventRow[] };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('void'), reason: z.string().trim().min(3).max(500) }),
  z.object({ op: z.literal('resend'), signerId: z.string().uuid() }),
]);

/** POST /api/sign/:envelopeId — void the request, or send a signer a new link (the old one stops working). Sender or documents:edit. */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: Body }, async ({ req, db, tenant, userId, params, body }) => {
  const ctx = { db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) };
  if (body.op === 'void') { await voidEnvelope(ctx, params.envelopeId!, body.reason); return { ok: true }; }
  return { ok: true, delivery: await resendLink(ctx, body.signerId) };
});
