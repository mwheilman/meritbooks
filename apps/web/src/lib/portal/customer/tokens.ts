import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * CUSTOMER PORTAL magic-link tokens (migration 141).
 *
 * A portal visitor is NOT a Clerk user and never gets a tenant session. Access is
 * granted by an opaque, revocable, org+customer-scoped token (the magic link),
 * mirroring the /pay/[token] hosted-pay model but scoped to a whole CUSTOMER
 * (their invoice list + statements) rather than a single invoice.
 *
 * This module splits deliberately: the status/usability decision is a set of PURE
 * functions with NO I/O (unit-tested in tokens.test.ts), and the resolver does the
 * one narrowed admin read. The public portal validates a token server-side,
 * resolves org_id + customer_id, and every downstream query filters by BOTH — the
 * visitor can never reach another customer's or tenant's rows.
 */

export type PortalTokenStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface PortalTokenRow {
  id: string;
  org_id: string;
  customer_id: string;
  token: string;
  label: string | null;
  status: string; // 'ACTIVE' | 'REVOKED' | 'EXPIRED' (stored)
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Effective status of a token as of `now`. Fails CLOSED: a revoked row is always
 * REVOKED; a row past its `expires_at` is EXPIRED even if the stored status still
 * reads ACTIVE (a lazy expiry so we never depend on a sweeper having run). Only a
 * stored-ACTIVE, unexpired token is ACTIVE.
 */
export function portalTokenStatus(
  row: Pick<PortalTokenRow, 'status' | 'expires_at'>,
  now: Date = new Date(),
): PortalTokenStatus {
  if (row.status === 'REVOKED') return 'REVOKED';
  if (row.status === 'EXPIRED') return 'EXPIRED';
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isNaN(exp) && exp <= now.getTime()) return 'EXPIRED';
  }
  return 'ACTIVE';
}

/** A token grants access only when its effective status is ACTIVE. */
export function isPortalTokenUsable(
  row: Pick<PortalTokenRow, 'status' | 'expires_at'>,
  now: Date = new Date(),
): boolean {
  return portalTokenStatus(row, now) === 'ACTIVE';
}

/**
 * Opaque, URL-safe, high-entropy portal token: 32 random bytes as hex. Long
 * enough to be unguessable, plain ASCII (same construction as invite tokens).
 */
export function generatePortalToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ResolvedPortalToken {
  orgId: string;
  customerId: string;
  row: PortalTokenRow;
}

/**
 * Resolve a raw token to its org + customer, or null when the token is unknown or
 * not ACTIVE (revoked / expired-by-status / expired-by-date). MUST be called with
 * the SERVICE-ROLE (admin) client: the visitor has no session, so RLS can't scope
 * them — the token itself is the credential, and the return value is what every
 * downstream query is narrowed by. On success, best-effort stamps last_used_at.
 */
export async function resolvePortalToken(
  admin: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<ResolvedPortalToken | null> {
  const trimmed = (token ?? '').trim();
  // Reject anything that isn't the exact token shape we mint (64 hex chars). This
  // keeps malformed/probe values from ever hitting the table.
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;

  const { data } = await admin
    .from('customer_portal_tokens')
    .select('id, org_id, customer_id, token, label, status, expires_at, last_used_at, created_by, created_at')
    .eq('token', trimmed)
    .maybeSingle();
  if (!data) return null;

  const row = data as PortalTokenRow;
  if (!isPortalTokenUsable(row, now)) return null;

  // Best-effort access stamp — never block the read on a write failure.
  await admin
    .from('customer_portal_tokens')
    .update({ last_used_at: now.toISOString() })
    .eq('id', row.id)
    .then(undefined, () => undefined);

  return { orgId: row.org_id, customerId: row.customer_id, row };
}
