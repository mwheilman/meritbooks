import 'server-only';
/**
 * Customer sign-off on the technician's phone (e-sign, migration 1115): the tech picks a PDF on
 * the job, the server opens an envelope with ONE in-person signer on the "link" channel (nothing
 * is emailed or texted), and hands the one-time token back to the phone that asked for it. The
 * phone downloads the document through the public, token-checked file route, the customer reads
 * it, agrees, types their name and draws their signature; the signature is queued as an
 * `esign.sign` command (sync), so it is kept even when the signal drops at that moment.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { listFiles } from '@/lib/documents/store';
import { requestSignature } from '@/lib/esign/api';
import { openSigning, type RequestMeta } from '@/lib/esign/public';
import type { PublicSignState } from '@/lib/esign/types';

export interface SignableFile {
  id: string;
  title: string;
  kind: string;
  fileName: string | null;
  updatedAt: string;
  signature: 'sent' | 'completed' | 'declined' | null;
}

const NOT_SIGNABLE = new Set(['photo', 'drawing_set']);

export async function signableFiles(db: SupabaseClient, companyIds: string[], jobId: string): Promise<SignableFile[]> {
  const files = await listFiles(db, { companyIds, jobId, limit: 200 });
  return files
    .filter((f) => !NOT_SIGNABLE.has(f.kind) && f.current?.mime_type === 'application/pdf')
    .map((f) => ({ id: f.id, title: f.title, kind: f.kind, fileName: f.current?.file_name ?? null, updatedAt: f.updated_at, signature: f.signature }));
}

/** The token from a signing link ("…/sign/<token>"). */
export function tokenFromLink(link: string | null): string | null {
  if (!link) return null;
  const m = /\/sign\/([A-Za-z0-9_-]{20,200})(?:[?#].*)?$/.exec(link);
  return m?.[1] ?? null;
}

export interface StartedSigning {
  envelopeId: string;
  token: string;
  /** The public, token-checked document route (relative to the Merit Projects origin). */
  fileUrl: string;
  state: Pick<PublicSignState, 'ok' | 'reason' | 'document' | 'company' | 'signer' | 'consent'> & { envelope?: { id: string; title: string; expires_at?: string } };
}

export async function startInPersonSigning(
  ctx: { db: SupabaseClient; orgId: string; userId: string; baseUrl: string; meta: RequestMeta },
  input: { documentId: string; signerName: string; signerRole: string | null; title: string | null },
): Promise<StartedSigning> {
  const r = await requestSignature({ db: ctx.db, orgId: ctx.orgId, userId: ctx.userId, baseUrl: ctx.baseUrl }, {
    documentId: input.documentId,
    signers: [{ name: input.signerName, roleLabel: input.signerRole ?? 'Customer', channel: 'link' }],
    ...(input.title ? { title: input.title } : {}),
    expiresDays: 2,
    routing: 'sequential',
  });
  const token = tokenFromLink(r.deliveries[0]?.link ?? null);
  if (!token) throw new HttpError(503, 'The signing request was made but its link did not come back. Try again.', 'ESIGN_NO_LINK');
  const opened = await openSigning(token, ctx.meta);
  if (!opened.state.ok) throw new HttpError(409, 'The signing request could not be opened on this phone. Try again.', 'ESIGN_OPEN_FAILED');
  const s = opened.state;
  return {
    envelopeId: r.envelopeId,
    token,
    fileUrl: opened.viewUrl ?? `/api/sign/public/${encodeURIComponent(token)}/file`,
    state: {
      ok: s.ok, reason: s.reason, document: s.document, company: s.company, signer: s.signer, consent: s.consent,
      envelope: s.envelope ? { id: s.envelope.id, title: s.envelope.title, expires_at: s.envelope.expires_at } : undefined,
    },
  };
}
