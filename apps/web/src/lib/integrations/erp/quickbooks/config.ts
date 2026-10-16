/**
 * QuickBooks Online (Intuit) app configuration — read from the platform env at call
 * time. These are the MeritBooks APP credentials (one Intuit developer app for the
 * whole platform), NOT a tenant's tokens. Per-tenant tokens live in Supabase Vault
 * (see token-store.ts) and are never read from env.
 *
 * DEGRADE-SAFE: `readQboConfig` returns null when any required value is missing, and
 * every caller turns that into an honest "QuickBooks connect isn't set up yet" — the
 * guided-export (upload) path stays available. Nothing throws on a missing var.
 *
 * Endpoints confirmed against Intuit docs (2026-10):
 *   authorize  https://appcenter.intuit.com/connect/oauth2
 *   token      https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   revoke     https://developer.api.intuit.com/v2/oauth2/tokens/revoke
 *   API base   https://quickbooks.api.intuit.com           (production)
 *              https://sandbox-quickbooks.api.intuit.com   (sandbox)
 *   minorversion 75 — Intuit retired 1–74 on 2025-08-01; 75 is the floor.
 */

export type QboEnvironment = 'sandbox' | 'production';

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QboEnvironment;
  /** HMAC key for the OAuth `state` parameter (≥ 32 chars). */
  stateSecret: string;
}

export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
export const QBO_MINOR_VERSION = '75';

/** The connection-registry key (core.erp_connections.erp_id) for QBO. */
export const QBO_ERP_ID = 'quickbooks';

export function qboApiBaseUrl(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/** The env var names Mike sets (documented in docs/QBO-CONNECT-SETUP.md). */
export const QBO_ENV_VARS = [
  'QBO_CLIENT_ID',
  'QBO_CLIENT_SECRET',
  'QBO_REDIRECT_URI',
  'QBO_ENVIRONMENT',
  'QBO_STATE_SECRET',
] as const;

export type QboConfigStatus =
  | { configured: true; config: QboConfig }
  | { configured: false; missing: string[]; reason: string };

/** Full status, including which variables are missing (names only — never values). */
export function getQboConfigStatus(env: NodeJS.ProcessEnv = process.env): QboConfigStatus {
  const clientId = (env.QBO_CLIENT_ID ?? '').trim();
  const clientSecret = (env.QBO_CLIENT_SECRET ?? '').trim();
  const redirectUri = (env.QBO_REDIRECT_URI ?? '').trim();
  const stateSecret = (env.QBO_STATE_SECRET ?? '').trim();
  const envRaw = (env.QBO_ENVIRONMENT ?? '').trim().toLowerCase();

  const missing: string[] = [];
  if (!clientId) missing.push('QBO_CLIENT_ID');
  if (!clientSecret) missing.push('QBO_CLIENT_SECRET');
  if (!redirectUri) missing.push('QBO_REDIRECT_URI');
  if (envRaw !== 'sandbox' && envRaw !== 'production') missing.push('QBO_ENVIRONMENT');
  if (stateSecret.length < 32) missing.push('QBO_STATE_SECRET');

  if (missing.length > 0) {
    return {
      configured: false,
      missing,
      reason:
        'QuickBooks connect isn’t set up on this MeritBooks deployment yet. ' +
        'You can still export two reports from QuickBooks and drop them here.',
    };
  }
  return {
    configured: true,
    config: {
      clientId,
      clientSecret,
      redirectUri,
      environment: envRaw as QboEnvironment,
      stateSecret,
    },
  };
}

export function readQboConfig(env: NodeJS.ProcessEnv = process.env): QboConfig | null {
  const s = getQboConfigStatus(env);
  return s.configured ? s.config : null;
}
