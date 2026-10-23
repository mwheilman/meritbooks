/**
 * Inbound email configuration — everything read from env, in one place.
 *
 *   INBOUND_EMAIL_PROVIDER          postmark (default) | sendgrid | generic
 *   INBOUND_EMAIL_DOMAIN            the domain the MX record points at, e.g. inbound.meritbooks.app
 *   INBOUND_EMAIL_SECRET            postmark / generic: the webhook password (Basic auth) / shared secret
 *   INBOUND_EMAIL_BASIC_USER        Basic-auth user name in the webhook URL (default "meritbooks")
 *   SENDGRID_INBOUND_PUBLIC_KEY     sendgrid: the ECDSA verification key from the security policy
 *   INBOUND_EMAIL_ALLOWED_IPS       optional comma list of IPs / IPv4 CIDRs the webhook accepts
 *   INBOUND_EMAIL_AUTHSERV_IDS      optional comma list of mail-server hosts whose
 *                                   Authentication-Results header we trust (in addition to
 *                                   the provider's own) — the SPF/DKIM/DMARC verdict source
 *   INBOUND_EMAIL_PROVIDER_ADDRESS  optional: the provider's own inbound address (Postmark
 *                                   "…@inbound.postmarkapp.com") — <that>+<alias>@… routes
 *                                   to <alias>, so the owner can test before DNS is done
 *
 * Server-only. Never returns a secret to a caller — only booleans.
 */

import type { InboundProviderId } from './inbound-types';

/** Used to DISPLAY addresses before the env is set (migration 135's domain). */
export const DEFAULT_INBOUND_DOMAIN = 'inbound.meritbooks.app';
export const DEFAULT_BASIC_USER = 'meritbooks';

/** Each provider's MX target, for the setup guide and the MX check. */
export const PROVIDER_MX_HOST: Record<InboundProviderId, string | null> = {
  postmark: 'inbound.postmarkapp.com',
  sendgrid: 'mx.sendgrid.net',
  generic: null,
};

export const PROVIDER_LABEL: Record<InboundProviderId, string> = {
  postmark: 'Postmark',
  sendgrid: 'SendGrid Inbound Parse',
  generic: 'Custom relay',
};

export interface InboundEnv {
  INBOUND_EMAIL_PROVIDER?: string;
  INBOUND_EMAIL_DOMAIN?: string;
  INBOUND_EMAIL_SECRET?: string;
  INBOUND_EMAIL_BASIC_USER?: string;
  SENDGRID_INBOUND_PUBLIC_KEY?: string;
  INBOUND_EMAIL_ALLOWED_IPS?: string;
  INBOUND_EMAIL_PROVIDER_ADDRESS?: string;
  INBOUND_EMAIL_AUTHSERV_IDS?: string;
}

/** A shared secret shorter than this is treated as NOT configured (fail closed). */
export const MIN_SECRET_LENGTH = 16;

export interface InboundConfig {
  provider: InboundProviderId;
  /** The configured domain, lowercased; null when unset. */
  domain: string | null;
  /** The domain addresses are shown on (configured, else the default). */
  displayDomain: string;
  basicUser: string;
  secret: string | null;
  sendgridPublicKey: string | null;
  allowedIps: string[];
  providerAddress: string | null;
  /** Extra trusted Authentication-Results authserv-ids. */
  trustedAuthservIds: string[];
}

function clean(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

export function parseProvider(v: string | undefined | null): InboundProviderId {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'sendgrid' || s === 'generic' ? s : 'postmark';
}

export function readInboundConfig(env: InboundEnv = process.env as InboundEnv): InboundConfig {
  const domain = clean(env.INBOUND_EMAIL_DOMAIN)?.toLowerCase().replace(/^@/, '') ?? null;
  return {
    provider: parseProvider(env.INBOUND_EMAIL_PROVIDER),
    domain,
    displayDomain: domain ?? DEFAULT_INBOUND_DOMAIN,
    basicUser: clean(env.INBOUND_EMAIL_BASIC_USER) ?? DEFAULT_BASIC_USER,
    secret: clean(env.INBOUND_EMAIL_SECRET),
    sendgridPublicKey: clean(env.SENDGRID_INBOUND_PUBLIC_KEY),
    allowedIps: (env.INBOUND_EMAIL_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    providerAddress: clean(env.INBOUND_EMAIL_PROVIDER_ADDRESS)?.toLowerCase() ?? null,
    trustedAuthservIds: (env.INBOUND_EMAIL_AUTHSERV_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

/** Does the configured provider have the credential it needs to verify a request? */
export function hasVerifier(cfg: InboundConfig): boolean {
  if (cfg.provider === 'sendgrid') return Boolean(cfg.sendgridPublicKey || usableSecret(cfg));
  return Boolean(usableSecret(cfg));
}

/** The shared secret, or null when unset or too short to be safe. */
export function usableSecret(cfg: Pick<InboundConfig, 'secret'>): string | null {
  return cfg.secret && cfg.secret.length >= MIN_SECRET_LENGTH ? cfg.secret : null;
}

export type InboundSetupState = 'active' | 'not_configured';

export interface InboundSetupStatus {
  state: InboundSetupState;
  provider: InboundProviderId;
  providerLabel: string;
  domain: string;
  domainConfigured: boolean;
  credentialConfigured: boolean;
  /** Plain-English list of what is still missing (admin-facing, no secrets). */
  missing: string[];
  mxHost: string | null;
}

/**
 * "Active" = the app can verify the provider AND knows its domain. Whether the MX
 * record is right is a separate (DNS) check — see checkInboundMx.
 */
export function inboundSetupStatus(cfg: InboundConfig = readInboundConfig()): InboundSetupStatus {
  const missing: string[] = [];
  if (!cfg.domain) missing.push('INBOUND_EMAIL_DOMAIN (the inbound email domain) is not set on the server.');
  if (!hasVerifier(cfg)) {
    missing.push(
      cfg.provider === 'sendgrid'
        ? 'SENDGRID_INBOUND_PUBLIC_KEY (or an INBOUND_EMAIL_SECRET of at least 16 characters) is not set on the server.'
        : 'INBOUND_EMAIL_SECRET (the webhook password, at least 16 characters) is not set on the server.',
    );
  }
  return {
    state: missing.length === 0 ? 'active' : 'not_configured',
    provider: cfg.provider,
    providerLabel: PROVIDER_LABEL[cfg.provider],
    domain: cfg.displayDomain,
    domainConfigured: Boolean(cfg.domain),
    credentialConfigured: hasVerifier(cfg),
    missing,
    mxHost: PROVIDER_MX_HOST[cfg.provider],
  };
}

/** Compose an alias's full address. */
export function aliasAddress(localPart: string, aliasDomain: string | null, cfg: InboundConfig = readInboundConfig()): string {
  return `${localPart}@${aliasDomain ?? cfg.displayDomain}`;
}

export type MxCheck = { state: 'ok' | 'missing' | 'wrong' | 'unknown'; hosts: string[] };

/** Best-effort DNS check that the domain's MX points at the provider. Never throws. */
export async function checkInboundMx(cfg: InboundConfig = readInboundConfig()): Promise<MxCheck> {
  if (!cfg.domain) return { state: 'unknown', hosts: [] };
  try {
    const dns = await import('node:dns');
    const records = await Promise.race([
      dns.promises.resolveMx(cfg.domain),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    const hosts = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
    if (hosts.length === 0) return { state: 'missing', hosts };
    const want = PROVIDER_MX_HOST[cfg.provider];
    if (!want) return { state: 'ok', hosts };
    return { state: hosts.includes(want) ? 'ok' : 'wrong', hosts };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { state: 'missing', hosts: [] };
    return { state: 'unknown', hosts: [] };
  }
}
