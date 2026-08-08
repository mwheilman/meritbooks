/**
 * Org-scoped Supabase client for SESSION-LESS background work (the scheduled
 * report-pack delivery cron).
 *
 * WHY THIS EXISTS
 *
 * The report engines (run.ts → board-package/queries.ts) rely on Row-Level
 * Security for tenant isolation — they do NOT filter by org_id in application
 * code. That is correct and safe for user-facing routes (createAuthedSupabase
 * forwards the caller's verified Clerk token and get_org_id() returns their org).
 * But a cron has no user session, and the service-role admin client BYPASSES RLS
 * entirely — running the engines under it would read EVERY tenant's ledger. That
 * is the cardinal cross-tenant leak on a book of record.
 *
 * SOLUTION
 *
 * Mint a short-lived, org-scoped JWT signed with the project's legacy Supabase
 * JWT secret (the same HS256 secret that signs the anon/service keys). It carries
 * `role: authenticated` and `org_id: <tenant uuid>` — exactly the claims a real
 * user token carries — so PostgREST verifies it, exposes the claims to Postgres,
 * get_org_id() returns THIS org, and the org_isolation RLS policies enforce
 * isolation AT THE DATABASE. The engines are byte-identical to the user path;
 * only the identity differs.
 *
 * FAILS CLOSED: if SUPABASE_JWT_SECRET is not configured we return null. The
 * caller then reports the pack as undeliverable rather than falling back to the
 * RLS-bypassing admin client — no configuration gap can ever cause a leak.
 *
 * No new dependency: the JWT is assembled with Node's crypto HMAC.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Assemble an HS256 JWT with the given payload, signed by `secret`. */
function signJwtHS256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64url(sig)}`;
}

/**
 * A Supabase client scoped to `orgId` via a self-signed authenticated JWT, so
 * RLS enforces tenant isolation exactly as for a real user. Returns null when
 * SUPABASE_JWT_SECRET is unset (caller must fail closed — never substitute admin).
 *
 * `orgId` MUST be a real core.organizations.id (get_org_id() Case 1 verifies the
 * uuid maps to an existing tenant before honoring it).
 */
export function createOrgScopedSupabase(orgId: string): SupabaseClient | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!secret || !url || !anonKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const token = signJwtHS256(
    {
      role: 'authenticated',
      org_id: orgId,
      iss: 'meritbooks-report-scheduler',
      aud: 'authenticated',
      iat: now,
      exp: now + 300, // 5 minutes — long enough to render one pack, no longer
    },
    secret,
  );

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
