/**
 * Magic-link tokens for external request recipients (core.request_tokens, migration 178).
 *
 * The clear token exists ONLY inside the email we send; the database keeps its sha256
 * (hex). Resolving a link hashes what the visitor presents and looks the hash up with the
 * service role — a leaked table row can't be replayed as a link. One token is minted per
 * send, and every token of a request dies with it (closed request → 410).
 */

import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RequestRow } from './types';

/** 32 random bytes → base64url (~43 chars). */
export function generateRequestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRequestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape check before touching the DB (also rejects a pasted 64-hex hash). */
export function looksLikeRequestToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(v) && !/^[0-9a-f]{64}$/.test(v);
}

export const TOKEN_TTL_DAYS = 60;

/** Mint + store one token for a request; returns the CLEAR token (put it in the email, nowhere else). */
export async function mintRequestToken(
  writer: SupabaseClient,
  req: Pick<RequestRow, 'id' | 'org_id' | 'location_id'>,
  now: Date,
): Promise<string> {
  const token = generateRequestToken();
  const expires = new Date(now.getTime() + TOKEN_TTL_DAYS * 86_400_000);
  const { error } = await writer.schema('core').from('request_tokens').insert({
    org_id: req.org_id,
    location_id: req.location_id,
    request_id: req.id,
    token_hash: hashRequestToken(token),
    expires_at: expires.toISOString(),
  });
  if (error) throw new Error(`Could not create the request link: ${error.message}`);
  return token;
}

export type TokenLookup =
  | { ok: true; tokenId: string; request: RequestRow }
  | { ok: false; state: 'not_found' | 'expired' | 'closed' };

/** Resolve a presented token (service role). Closed requests → 'closed' (410), never their contents. */
export async function resolveRequestToken(admin: SupabaseClient, token: string, now: Date = new Date()): Promise<TokenLookup> {
  if (!looksLikeRequestToken(token)) return { ok: false, state: 'not_found' };
  const { data: t } = await admin
    .schema('core')
    .from('request_tokens')
    .select('id, request_id, org_id, expires_at, revoked_at')
    .eq('token_hash', hashRequestToken(token))
    .maybeSingle();
  if (!t) return { ok: false, state: 'not_found' };
  const row = t as { id: string; request_id: string; org_id: string; expires_at: string; revoked_at: string | null };
  if (row.revoked_at || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, state: 'expired' };
  const { data: r } = await admin
    .schema('core')
    .from('requests')
    .select('*')
    .eq('id', row.request_id)
    .eq('org_id', row.org_id)
    .maybeSingle();
  if (!r) return { ok: false, state: 'not_found' };
  const request = r as RequestRow;
  if (!['open', 'sent', 'snoozed'].includes(request.status)) return { ok: false, state: 'closed' };
  return { ok: true, tokenId: row.id, request };
}
