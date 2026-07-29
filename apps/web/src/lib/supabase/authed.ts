import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';

/**
 * Request-scoped Supabase client that runs as the AUTHENTICATED USER rather than
 * the service role.
 *
 * It forwards the caller's Clerk session token as a Bearer credential. Supabase's
 * Clerk third-party-auth integration verifies the token and exposes its claims to
 * Postgres, so `get_org_id()` returns the caller's org (the `org_id` claim) and
 * the `org_isolation` RLS policies enforce tenant isolation AT THE DATABASE — not
 * merely in application code. This is the difference between "the route remembered
 * to filter by org" and "the database refuses to return another tenant's rows".
 *
 * Use this for user-facing API routes (the default via apiHandler). Use
 * createAdminSupabase() (service role, RLS-bypassing) ONLY where there is no user
 * session and the code must scope the tenant itself: the Stripe webhook and the
 * public customer pay page.
 */
export function createAuthedSupabase(accessToken: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

/**
 * Server-side (server component / server action) user-scoped client. Pulls the
 * Clerk session token via auth() and forwards it, so RLS engages the same way it
 * does in the API routes. Returns null if there is no session token (caller
 * should degrade gracefully). This is the server-action analogue of
 * requireAuthedContext() — use it INSTEAD of createServerSupabase() (which sends
 * no Clerk token, so RLS returns nothing) in authenticated server code.
 */
export async function createAuthedServerSupabase(): Promise<SupabaseClient | null> {
  const { getToken } = await auth();
  const token = await getToken().catch(() => null);
  return token ? createAuthedSupabase(token) : null;
}
