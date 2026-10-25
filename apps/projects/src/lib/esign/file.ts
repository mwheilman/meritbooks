import 'server-only';
/**
 * Streams a signer's document. THE ONLY SERVICE-ROLE USE IN DOCUMENTS / E-SIGN (a test enforces it) — why it is safe:
 *
 *  · A signer has no account, and anon has no storage access at all (1115 §16), so some trusted
 *    reader must fetch the bytes. Granting anon storage reads (an earlier draft) exposed objects to
 *    anyone holding the public anon key; this replaces it.
 *  · The caller never chooses the path. The route first re-validates the token through
 *    esign.document (anon key, token-scoped definer function) on EVERY request — revoked, used,
 *    expired, voided, declined or out-of-turn links get 410 — and only then passes the one storage
 *    key the database returned for that envelope's exact version.
 *  · The key is re-checked here (bucket `documents`, `<org uuid>/pm/…`, no traversal), and the
 *    service role only mints a 60-second signed URL for that single object, which the server
 *    fetches and streams; the URL never leaves the server. No other storage or table call is made
 *    with this client.
 */
import { createAdminSupabase } from '@/lib/supabase/server';

import { isSignerDocumentPath } from './file-path';

export interface Streamed {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: string | null;
}

export async function fetchSignerDocument(path: string): Promise<Streamed | null> {
  if (!isSignerDocumentPath(path)) return null;
  const signed = await createAdminSupabase().storage.from('documents').createSignedUrl(path, 60);
  if (signed.error || !signed.data?.signedUrl) return null;
  const res = await fetch(signed.data.signedUrl, { cache: 'no-store', redirect: 'error' });
  if (!res.ok || !res.body) return null;
  return { body: res.body, contentType: res.headers.get('content-type') ?? 'application/pdf', contentLength: res.headers.get('content-length') };
}
