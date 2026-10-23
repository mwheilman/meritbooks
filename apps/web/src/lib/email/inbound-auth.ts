/**
 * Inbound webhook verification — FAILS CLOSED.
 *
 *   postmark  Postmark does NOT sign webhooks; its documented protection is HTTP Basic
 *             auth embedded in the webhook URL (https://user:pass@host/path) plus
 *             optional IP allowlisting. We require Basic auth: user =
 *             INBOUND_EMAIL_BASIC_USER (default "meritbooks"), password =
 *             INBOUND_EMAIL_SECRET.
 *   sendgrid  Inbound Parse security policy: ECDSA (P-256 / SHA-256) signature in
 *             X-Twilio-Email-Event-Webhook-Signature over
 *             X-Twilio-Email-Event-Webhook-Timestamp + the RAW multipart body, verified
 *             with SENDGRID_INBOUND_PUBLIC_KEY; the timestamp must be within ±5 min (a
 *             captured request cannot be replayed later). Without a key: Basic auth.
 *   generic   HMAC-SHA256(secret, `${timestamp}.${rawBody}`) in x-inbound-signature
 *             (hex, optional "sha256=" prefix) with x-inbound-timestamp (unix seconds,
 *             ±5 min) — or the shared secret in x-inbound-email-secret / Bearer / Basic
 *             (the pre-2D contract).
 *
 * Every comparison is constant-time. No configured credential — or a shared secret shorter
 * than 16 characters — → every request fails. `preVerifyInboundHeaders` runs the checks
 * that need no body (IP allowlist, Basic auth, signature-header presence + timestamp)
 * BEFORE the route reads up to 40 MB of an unauthenticated body.
 * Pure: takes headers + raw bytes + config, so it is unit-tested without a server.
 */

import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { usableSecret, type InboundConfig } from './inbound-config';

/** Signed-request freshness window (seconds). */
export const SIGNATURE_WINDOW_SECONDS = 300;

function freshTimestamp(ts: string, now: Date): boolean {
  if (!/^\d{1,12}$/.test(ts.trim())) return false;
  const t = Number(ts);
  return Number.isFinite(t) && Math.abs(now.getTime() / 1000 - t) <= SIGNATURE_WINDOW_SECONDS;
}

export type VerifyResult = { ok: true; method: string } | { ok: false; reason: string };

export interface VerifyInput {
  cfg: InboundConfig;
  headers: Headers;
  rawBody: Uint8Array;
  /** Caller IP (first x-forwarded-for hop), for the optional allowlist. */
  ip: string | null;
  now?: Date;
}

/** Constant-time string equality that does not leak length (compares digests). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function basicCredentials(headers: Headers): { user: string; pass: string } | null {
  const authz = headers.get('authorization');
  if (!authz || !/^basic\s+/i.test(authz)) return null;
  try {
    const decoded = Buffer.from(authz.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function checkBasic(cfg: InboundConfig, headers: Headers): boolean {
  const secret = usableSecret(cfg);
  if (!secret) return false;
  const c = basicCredentials(headers);
  if (!c) return false;
  // evaluate both comparisons (no short-circuit timing difference on the user name)
  const userOk = safeEqual(c.user, cfg.basicUser);
  const passOk = safeEqual(c.pass, secret);
  return userOk && passOk;
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Exact match, or IPv4 CIDR (a.b.c.d/n). */
export function ipAllowed(ip: string | null, allow: string[]): boolean {
  if (allow.length === 0) return true;
  if (!ip) return false;
  const clean = ip.trim().replace(/^::ffff:/, '');
  for (const entry of allow) {
    if (entry === clean) return true;
    const [base, bitsRaw] = entry.split('/');
    if (bitsRaw === undefined) continue;
    const bits = Number(bitsRaw);
    const a = ipv4ToInt(clean);
    const b = ipv4ToInt(base);
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** HMAC signature for the generic adapter (exported so relays/tests sign identically). */
export function signGeneric(secret: string, timestamp: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** Generic: a credential that needs no body (shared-secret header / Bearer / Basic). */
function genericHeaderCredential(cfg: InboundConfig, headers: Headers, secret: string): VerifyResult | null {
  const header = headers.get('x-inbound-email-secret');
  if (header && safeEqual(header, secret)) return { ok: true, method: 'shared_secret' };
  const authz = headers.get('authorization');
  if (authz && /^bearer\s+/i.test(authz)) {
    const presented = authz.replace(/^bearer\s+/i, '').trim();
    if (presented && safeEqual(presented, secret)) return { ok: true, method: 'bearer' };
  }
  if (checkBasic(cfg, headers)) return { ok: true, method: 'basic' };
  return null;
}

function verifyGeneric(cfg: InboundConfig, headers: Headers, rawBody: Uint8Array, now: Date): VerifyResult {
  const secret = usableSecret(cfg);
  if (!secret) return { ok: false, reason: 'not_configured' };
  const sig = headers.get('x-inbound-signature');
  const ts = headers.get('x-inbound-timestamp');
  if (sig && ts) {
    if (!freshTimestamp(ts, now)) return { ok: false, reason: 'stale_timestamp' };
    const want = signGeneric(secret, ts, rawBody);
    const got = sig.replace(/^sha256=/i, '').trim().toLowerCase();
    return safeEqual(got, want) ? { ok: true, method: 'hmac' } : { ok: false, reason: 'bad_signature' };
  }
  const h = genericHeaderCredential(cfg, headers, secret);
  if (h) return h;
  return { ok: false, reason: 'bad_credentials' };
}

function verifySendgrid(cfg: InboundConfig, headers: Headers, rawBody: Uint8Array, now: Date): VerifyResult {
  if (cfg.sendgridPublicKey) {
    const sig = headers.get('x-twilio-email-event-webhook-signature');
    const ts = headers.get('x-twilio-email-event-webhook-timestamp');
    if (!sig || !ts) return { ok: false, reason: 'missing_signature' };
    if (!freshTimestamp(ts, now)) return { ok: false, reason: 'stale_timestamp' };
    try {
      const keyDer = Buffer.from(cfg.sendgridPublicKey.replace(/-----[^-]+-----|\s+/g, ''), 'base64');
      const key = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
      const data = Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(rawBody)]);
      const ok = cryptoVerify('sha256', data, key, Buffer.from(sig, 'base64'));
      return ok ? { ok: true, method: 'ecdsa' } : { ok: false, reason: 'bad_signature' };
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
  }
  if (!usableSecret(cfg)) return { ok: false, reason: 'not_configured' };
  return checkBasic(cfg, headers) ? { ok: true, method: 'basic' } : { ok: false, reason: 'bad_credentials' };
}

/**
 * The checks that need NO body, run before the route reads it. Returns a failure, or
 * null = "plausible, now read the body and run verifyInboundRequest". (A pass here is
 * never sufficient on its own — signatures still need the body.)
 */
export function preVerifyInboundHeaders(input: Omit<VerifyInput, 'rawBody'>): Extract<VerifyResult, { ok: false }> | null {
  const { cfg, headers } = input;
  const now = input.now ?? new Date();
  if (!ipAllowed(input.ip, cfg.allowedIps)) return { ok: false, reason: 'ip_not_allowed' };
  switch (cfg.provider) {
    case 'postmark':
      if (!usableSecret(cfg)) return { ok: false, reason: 'not_configured' };
      return checkBasic(cfg, headers) ? null : { ok: false, reason: 'bad_credentials' };
    case 'sendgrid': {
      if (cfg.sendgridPublicKey) {
        const sig = headers.get('x-twilio-email-event-webhook-signature');
        const ts = headers.get('x-twilio-email-event-webhook-timestamp');
        if (!sig || !ts) return { ok: false, reason: 'missing_signature' };
        return freshTimestamp(ts, now) ? null : { ok: false, reason: 'stale_timestamp' };
      }
      if (!usableSecret(cfg)) return { ok: false, reason: 'not_configured' };
      return checkBasic(cfg, headers) ? null : { ok: false, reason: 'bad_credentials' };
    }
    case 'generic': {
      const secret = usableSecret(cfg);
      if (!secret) return { ok: false, reason: 'not_configured' };
      const sig = headers.get('x-inbound-signature');
      const ts = headers.get('x-inbound-timestamp');
      if (sig && ts) return freshTimestamp(ts, now) ? null : { ok: false, reason: 'stale_timestamp' };
      return genericHeaderCredential(cfg, headers, secret) ? null : { ok: false, reason: 'bad_credentials' };
    }
    default:
      return { ok: false, reason: 'unknown_provider' };
  }
}

export function verifyInboundRequest(input: VerifyInput): VerifyResult {
  const { cfg, headers, rawBody } = input;
  const now = input.now ?? new Date();
  if (!ipAllowed(input.ip, cfg.allowedIps)) return { ok: false, reason: 'ip_not_allowed' };
  switch (cfg.provider) {
    case 'postmark':
      if (!usableSecret(cfg)) return { ok: false, reason: 'not_configured' };
      return checkBasic(cfg, headers) ? { ok: true, method: 'basic' } : { ok: false, reason: 'bad_credentials' };
    case 'sendgrid':
      return verifySendgrid(cfg, headers, rawBody, now);
    case 'generic':
      return verifyGeneric(cfg, headers, rawBody, now);
    default:
      return { ok: false, reason: 'unknown_provider' };
  }
}
