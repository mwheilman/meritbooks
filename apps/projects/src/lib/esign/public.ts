import 'server-only';
/**
 * The public signing page's database access: the ANON key, no session, schema `esign` only.
 * esign.open / sign / decline are token-scoped SECURITY DEFINER functions (migration 1115):
 * they see nothing but the one signer the token belongs to. Never the service role.
 */
import { createClient } from '@supabase/supabase-js';
import { isTokenShape } from './token';
import type { PublicSignState } from './types';

function anonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('esign');
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** First hop of x-forwarded-for (the edge sets it), else x-real-ip. */
export function requestMeta(h: Headers): RequestMeta {
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || null;
  return { ip: fwd ? fwd.slice(0, 64) : null, userAgent: (h.get('user-agent') ?? '').slice(0, 500) || null };
}

const INVALID: PublicSignState = { ok: false, reason: 'invalid' };

async function call(fn: 'open' | 'sign' | 'decline', args: Record<string, unknown>): Promise<PublicSignState> {
  const r = await anonClient().rpc(fn, args);
  if (r.error) {
    // eslint-disable-next-line no-console
    console.error('[esign public]', fn, r.error.code, r.error.message);
    return { ok: false, reason: 'unavailable' };
  }
  return (r.data as PublicSignState | null) ?? INVALID;
}

export interface OpenedSigning {
  state: PublicSignState;
  /** Same-origin route that streams the document after re-checking the token (null when it cannot act). */
  viewUrl: string | null;
}

/** Open a link. The document itself is served by /api/sign/public/<token>/file, never by a storage URL. */
export async function openSigning(token: string, meta: RequestMeta): Promise<OpenedSigning> {
  if (!isTokenShape(token)) return { state: INVALID, viewUrl: null };
  const state = await call('open', { p_token: token, p_ip: meta.ip, p_user_agent: meta.userAgent });
  return { state, viewUrl: state.ok ? `/api/sign/public/${encodeURIComponent(token)}/file` : null };
}

export type SignerDocument =
  | { ok: true; path: string; fileName: string; mimeType: string }
  | { ok: false; reason: string };

/** The file route's per-request re-check (esign.document): the storage key only while the link may act. */
export async function documentForToken(token: string): Promise<SignerDocument> {
  if (!isTokenShape(token)) return { ok: false, reason: 'invalid' };
  const r = await anonClient().rpc('document', { p_token: token });
  if (r.error) return { ok: false, reason: 'unavailable' };
  const d = (r.data ?? {}) as { ok?: boolean; reason?: string | null; path?: string; file_name?: string; mime_type?: string | null };
  if (!d.ok || !d.path) return { ok: false, reason: d.reason ?? 'invalid' };
  return { ok: true, path: d.path, fileName: d.file_name ?? 'document.pdf', mimeType: d.mime_type ?? 'application/pdf' };
}

export async function signWithToken(token: string, input: { typedName: string; signaturePng: string; consent: boolean }, meta: RequestMeta): Promise<PublicSignState> {
  if (!isTokenShape(token)) return INVALID;
  return call('sign', { p_token: token, p_typed_name: input.typedName, p_signature_png: input.signaturePng, p_consent: input.consent, p_ip: meta.ip, p_user_agent: meta.userAgent });
}

export async function declineWithToken(token: string, reason: string, meta: RequestMeta): Promise<PublicSignState> {
  if (!isTokenShape(token)) return INVALID;
  return call('decline', { p_token: token, p_reason: reason, p_ip: meta.ip, p_user_agent: meta.userAgent });
}
