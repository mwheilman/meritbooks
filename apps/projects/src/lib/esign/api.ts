import 'server-only';
/**
 * The e-sign API other Projects objects call (estimate / proposal, change order, lien waiver,
 * buyer's order …):
 *
 *   requestSignature(ctx, { documentId, signers, onCompleted: { kind, id } })
 *
 * documentId = a pm.doc_files id whose current version is a PDF (render one with
 * lib/templates first). The envelope pins that exact version (sha-256). Links are one-time
 * tokens (only the hash is stored). When everyone signs, the database queues an
 * envelope.completed outbox event; lib/esign/callbacks.ts stamps the signed PDF + audit
 * certificate as a new locked version and runs the record's own action (accept the estimate,
 * approve the change order, receive the lien waiver, accept the buyer's order quote).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { documentsError, unwrap } from '@/lib/documents/errors';
import { deliverLink, type DeliveryOutcome } from './deliver';
import { generateToken, hashToken, signingLink } from './token';
import type { CompletionKind, RequestSignatureInputT, SignerInputT } from './types';

export interface EsignCtx {
  db: SupabaseClient;
  orgId: string;
  userId: string;
  /** Origin the signing links point at (https://projects.example.com). */
  baseUrl: string;
}

export interface Delivery extends DeliveryOutcome {
  signerId: string;
  name: string;
  channel: string;
  /** Present only when nothing was delivered: the sender shares it. */
  link: string | null;
}

export interface RequestResult {
  envelopeId: string;
  deliveries: Delivery[];
}

const pm = (db: SupabaseClient) => db.schema('pm');

function toDbSigner(s: SignerInputT): Record<string, unknown> {
  return { name: s.name, email: s.email ?? null, phone: s.phone ?? null, role_label: s.roleLabel ?? null, channel: s.channel ?? null, order: s.order ?? null };
}

/** Issue a fresh one-time token for a signer (revoking any earlier one) and deliver it. */
export async function issueAndDeliver(ctx: EsignCtx, signerId: string, companyName: string): Promise<Delivery> {
  const token = generateToken();
  const r = await pm(ctx.db).rpc('esign_issue_token', { p_signer: signerId, p_token_hash: hashToken(token) });
  if (r.error) throw documentsError(r.error);
  const s = r.data as { signer_id: string; name: string; email: string | null; phone: string | null; channel: 'email' | 'sms' | 'both' | 'link'; title: string; message: string | null; expires_at: string; resend: boolean };
  const link = signingLink(ctx.baseUrl, token);
  const out = await deliverLink({ name: s.name, email: s.email, phone: s.phone, channel: s.channel, link, title: s.title, message: s.message, companyName, expiresAt: s.expires_at, resend: s.resend });
  return { ...out, signerId: s.signer_id, name: s.name, channel: s.channel, link: out.manual ? link : null };
}

export async function companyNameOf(db: SupabaseClient, locationId: string): Promise<string> {
  const b = await pm(db).rpc('doc_brand', { p_location: locationId });
  const name = (b.data as { company_name?: string } | null)?.company_name;
  return name || 'Your contractor';
}

export async function requestSignature(ctx: EsignCtx, input: RequestSignatureInputT): Promise<RequestResult> {
  const envelopeId = unwrap<string>(await pm(ctx.db).rpc('esign_create', {
    p_file: input.documentId,
    p_signers: input.signers.map(toDbSigner),
    p_attrs: {
      title: input.title, message: input.message, expires_days: input.expiresDays ?? 14, routing: input.routing ?? 'sequential',
      on_completed: input.onCompleted ? { kind: input.onCompleted.kind satisfies CompletionKind, id: input.onCompleted.id } : undefined,
    },
  }));
  // No document URL is stored: each valid open of a link grants 10 minutes of read (migration 1115 §16).
  const env = unwrap<{ location_id: string }>(await pm(ctx.db).from('esign_envelopes').select('location_id').eq('id', envelopeId).single());
  const sent = unwrap<{ pending: string[] }>(await pm(ctx.db).rpc('esign_send', { p_envelope: envelopeId }));
  const company = await companyNameOf(ctx.db, env.location_id);
  const deliveries: Delivery[] = [];
  for (const id of sent.pending) deliveries.push(await issueAndDeliver(ctx, id, company));
  return { envelopeId, deliveries };
}

/** Send a signer a new link (the old one stops working). */
export async function resendLink(ctx: EsignCtx, signerId: string): Promise<Delivery> {
  const s = unwrap<{ envelope_id: string } | null>(await pm(ctx.db).from('esign_signers').select('envelope_id').eq('id', signerId).maybeSingle());
  if (!s) throw new HttpError(404, 'That signer was not found.', 'NOT_FOUND');
  const env = unwrap<{ location_id: string }>(await pm(ctx.db).from('esign_envelopes').select('location_id').eq('id', s.envelope_id).single());
  return issueAndDeliver(ctx, signerId, await companyNameOf(ctx.db, env.location_id));
}

export async function voidEnvelope(ctx: EsignCtx, envelopeId: string, reason: string): Promise<void> {
  unwrap(await pm(ctx.db).rpc('esign_void', { p_envelope: envelopeId, p_reason: reason }));
}
