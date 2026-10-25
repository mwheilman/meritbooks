export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { cookies } from 'next/headers';
import { portalHandler, portalJson } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { portalBaseUrl, portalServerKey } from '@/lib/portal/config';
import { deliverSecret, signInText, type Dispatch } from '@/lib/portal/deliver';
import { COOKIE_BASE, nonceValue, sessionToken } from '@/lib/portal/session';
import { inBackground } from '@/lib/portal/background';
import { NONCE_COOKIE, NONCE_MAX_AGE, SESSION_COOKIE, SESSION_MAX_AGE, isAddress, newToken, sha256Hex, sixDigitCode } from '@/lib/portal/tokens';

/**
 * PUBLIC (no Clerk): portal sign-in.
 *   start          → the database (server key) picks ONE company that recorded this address, records
 *                    the message without the secret, and hands back where to send it; the link +
 *                    code go straight to the provider from here (never stored).
 *   verify         → the code typed in the browser that asked opens a session for that one company.
 *   switch         → a fresh code FROM another company to the address this session proved.
 *   verify_switch  → that code opens a session for the other company.
 *   sign_out       → revokes the session.
 * The answer never says whether an address has access.
 */
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), identifier: z.string().trim().min(5).max(254), locale: z.enum(['en', 'es']).default('en'), orgId: z.string().uuid().nullish() }),
  z.object({ op: z.literal('verify'), identifier: z.string().trim().min(5).max(254), code: z.string().regex(/^\d{6}$/) }),
  z.object({ op: z.literal('switch'), orgId: z.string().uuid() }),
  z.object({ op: z.literal('verify_switch'), code: z.string().regex(/^\d{6}$/) }),
  z.object({ op: z.literal('sign_out') }),
]);

interface StartResult { ok: boolean; sent?: boolean; reason?: string | null; dispatch?: Dispatch | null }
interface OpenResult { ok: boolean; reason: string | null; locale?: 'en' | 'es'; org_id?: string }

export const POST = portalHandler({ body: Body, auth: false }, async ({ body, meta }) => {
  const jar = cookies();
  if (body.op === 'sign_out') {
    const s = sessionToken();
    if (s) await portalRpc<boolean>('sign_out', { p_session: s }).catch(() => false);
    jar.set(SESSION_COOKIE, '', { ...COOKIE_BASE, maxAge: 0 });
    return { ok: true };
  }
  if (body.op === 'start' || body.op === 'switch') {
    const key = portalServerKey();
    if (!key) return portalJson(503, { error: 'The portal is not set up yet. Contact the company.', code: 'not_set_up' });
    const session = body.op === 'switch' ? sessionToken() : null;
    if (body.op === 'switch' && !session) return portalJson(401, { error: 'Sign in again.', code: 'auth' });
    const nonce = nonceValue() ?? newToken();
    const token = newToken();
    const code = sixDigitCode();
    const common = { p_server_key: key, p_nonce_hash: sha256Hex(nonce), p_token: token, p_code: code, p_ip: meta.ip, p_base_url: portalBaseUrl() };
    if (body.op === 'start' && !isAddress(body.identifier)) return portalJson(422, { error: 'Enter an email address or a mobile number.', code: 'invalid' });
    jar.set(NONCE_COOKIE, nonce, { ...COOKIE_BASE, maxAge: NONCE_MAX_AGE });
    // Answer at once, the same way whether or not the address has access (no timing oracle);
    // the database work and the send run after the response.
    inBackground(async () => {
      const r = body.op === 'start'
        ? await portalRpc<StartResult>('auth_start', { ...common, p_identifier: body.identifier, p_locale: body.locale, p_org: body.orgId ?? null })
        : await portalRpc<StartResult>('auth_switch', { ...common, p_session: session, p_org: body.orgId });
      if (r.dispatch) await deliverSecret(r.dispatch, signInText(r.dispatch, code, `${portalBaseUrl()}/portal/auth/${token}`));
    });
    return { ok: true };
  }
  const nonce = nonceValue();
  if (!nonce) return portalJson(422, { ok: false, reason: 'expired', error: 'That code expired. Send a new link.', code: 'invalid' });
  const fresh = newToken();
  let r: OpenResult;
  if (body.op === 'verify') {
    const key = portalServerKey();
    if (!key) return portalJson(503, { error: 'The portal is not set up yet. Contact the company.', code: 'not_set_up' });
    r = await portalRpc<OpenResult>('auth_verify_code', {
      p_server_key: key, p_identifier: body.identifier, p_code: body.code, p_nonce: nonce, p_session_hash: sha256Hex(fresh), p_ip: meta.ip, p_user_agent: meta.userAgent,
    });
  } else {
    const current = sessionToken();
    if (!current) return portalJson(401, { error: 'Sign in again.', code: 'auth' });
    const key = portalServerKey();
    if (!key) return portalJson(503, { error: 'The portal is not set up yet. Contact the company.', code: 'not_set_up' });
    r = await portalRpc<OpenResult>('auth_verify_switch', {
      p_server_key: key, p_session: current, p_code: body.code, p_nonce: nonce, p_session_hash: sha256Hex(fresh), p_ip: meta.ip, p_user_agent: meta.userAgent,
    });
  }
  if (!r.ok) return portalJson(r.reason === 'rate_limited' ? 429 : 422, { ok: false, reason: r.reason, code: 'invalid', error: 'That code did not work.' });
  jar.set(SESSION_COOKIE, fresh, { ...COOKIE_BASE, maxAge: SESSION_MAX_AGE });
  jar.set(NONCE_COOKIE, '', { ...COOKIE_BASE, maxAge: 0 });
  return { ok: true, locale: r.locale ?? 'en', orgId: r.org_id ?? null };
});
