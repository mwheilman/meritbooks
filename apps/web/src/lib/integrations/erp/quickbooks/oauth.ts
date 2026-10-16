/**
 * Intuit OAuth 2.0 — authorize URL, code exchange, refresh (with rotation), revoke.
 *
 * `fetch` is injected so every call is unit-testable with a mocked fetch. Client
 * credentials go in HTTP Basic auth (Intuit's documented scheme). Nothing here logs
 * or returns a raw token in an error message.
 *
 * Token lifetimes (Intuit, 2026): access token 1 hour (`expires_in`); refresh token
 * rotates — Intuit may return a NEW refresh_token on any refresh and the old value
 * goes stale — so the caller MUST persist whatever refresh_token comes back, every
 * time. Refresh tokens now carry a hard max lifetime (5 years for the accounting
 * scope) reported via `x_refresh_token_expires_in`.
 */

import {
  QBO_AUTHORIZE_URL,
  QBO_REVOKE_URL,
  QBO_SCOPE,
  QBO_TOKEN_URL,
  type QboConfig,
} from './config';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The token set we persist (encrypted, in Vault). Times are epoch ms. */
export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  /** Null when Intuit didn't report it. */
  refreshExpiresAt: number | null;
  realmId: string;
}

/** The refresh token is dead (revoked, expired, or already rotated away). */
export class QboAuthRevokedError extends Error {
  readonly code = 'QBO_AUTH_REVOKED';
  constructor(message = 'QuickBooks disconnected this link. Reconnect QuickBooks to continue.') {
    super(message);
    this.name = 'QboAuthRevokedError';
  }
}

/** Any other OAuth failure (Intuit down, misconfigured app, bad redirect URI…). */
export class QboOAuthError extends Error {
  readonly code = 'QBO_OAUTH_ERROR';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'QboOAuthError';
  }
}

export function buildAuthorizeUrl(config: QboConfig, state: string): string {
  const u = new URL(QBO_AUTHORIZE_URL);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', QBO_SCOPE);
  u.searchParams.set('redirect_uri', config.redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

function basicAuth(config: QboConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  x_refresh_token_expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postToken(
  config: QboConfig,
  body: URLSearchParams,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<RawTokenResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(config),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new QboOAuthError(
      err instanceof Error && err.name === 'AbortError'
        ? 'QuickBooks sign-in timed out. Please try again.'
        : 'Could not reach QuickBooks to finish sign-in. Please try again.',
    );
  } finally {
    clearTimeout(timer);
  }

  let json: RawTokenResponse = {};
  try {
    json = (await res.json()) as RawTokenResponse;
  } catch {
    json = {};
  }
  if (!res.ok) {
    // invalid_grant = the code/refresh token is no longer valid (revoked, expired,
    // reused after rotation). Everything else is an app/config/transient problem.
    if (json.error === 'invalid_grant') throw new QboAuthRevokedError();
    throw new QboOAuthError(
      `QuickBooks rejected the sign-in (${typeof json.error === 'string' ? json.error : res.status}).`,
      res.status,
    );
  }
  return json;
}

function toTokenSet(json: RawTokenResponse, realmId: string, now: number): QboTokenSet {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : '';
  if (!accessToken || !refreshToken) {
    throw new QboOAuthError('QuickBooks returned an incomplete sign-in response.');
  }
  const expiresIn = Number(json.expires_in);
  const refreshIn = Number(json.x_refresh_token_expires_in);
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    refreshExpiresAt: Number.isFinite(refreshIn) && refreshIn > 0 ? now + refreshIn * 1000 : null,
    realmId,
  };
}

/** Exchange the one-time authorization code for tokens. */
export async function exchangeCode(
  config: QboConfig,
  code: string,
  realmId: string,
  fetchImpl: FetchLike = fetch,
  opts: { now?: number; timeoutMs?: number } = {},
): Promise<QboTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });
  const json = await postToken(config, body, fetchImpl, opts.timeoutMs ?? 15_000);
  return toTokenSet(json, realmId, opts.now ?? Date.now());
}

/**
 * Refresh the access token. ALWAYS returns the refresh token Intuit sent back
 * (rotation) — the caller must persist the returned set before using it.
 * Throws QboAuthRevokedError on invalid_grant.
 */
export async function refreshTokens(
  config: QboConfig,
  current: QboTokenSet,
  fetchImpl: FetchLike = fetch,
  opts: { now?: number; timeoutMs?: number } = {},
): Promise<QboTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  const json = await postToken(config, body, fetchImpl, opts.timeoutMs ?? 15_000);
  const next = toTokenSet(json, current.realmId, opts.now ?? Date.now());
  // Keep the prior hard expiry if Intuit omitted it this time.
  if (next.refreshExpiresAt === null) next.refreshExpiresAt = current.refreshExpiresAt;
  return next;
}

/**
 * Revoke at Intuit (revoking the refresh token kills the whole grant). Best-effort:
 * returns false instead of throwing so a disconnect still deletes our copy.
 */
export async function revokeToken(
  config: QboConfig,
  token: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(QBO_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(config),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
