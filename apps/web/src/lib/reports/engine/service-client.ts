/**
 * The service-role client the engine's three governed read RPCs run on (server only).
 *
 * public.report_balances / report_drill_lines / period_balances_tieout are NOT executable by
 * `authenticated` (migration 185/186 contract): a member could otherwise call them straight
 * from the browser with any company list, month range or drill window and bypass number
 * governance. The engine calls them ONLY through this client, ALWAYS with p_org = the
 * caller's org and an explicit, non-empty company list that was already checked against
 * the caller's client scope (adapter.resolveCompanies / assertScopedCompanies), and only
 * after the route's permission + governance checks.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';

let testOverride: (() => SupabaseClient) | null = null;

/** The client for the governed RPCs: an explicit one (tests / callers holding one), else the service role. */
export function engineServiceClient(explicit?: SupabaseClient | null): SupabaseClient {
  if (explicit) return explicit;
  if (testOverride) return testOverride();
  return createAdminSupabase();
}

/**
 * Tests only: route the governed RPC reads to a harness client (e.g. a PGlite client running
 * as service_role). Refused in production.
 */
export function setEngineServiceClientForTests(fn: (() => SupabaseClient) | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setEngineServiceClientForTests is not available in production');
  testOverride = fn;
}
