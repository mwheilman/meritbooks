/**
 * Payroll engine resolution (GATE 12.3 Phase A).
 *
 * `resolvePayrollEngine(db, orgId)` picks the provider-agnostic PayrollEngine for
 * a tenant from `core.provider_connections` (capability 'PAYROLL', status
 * 'active', migration 041):
 *   - provider 'check' AND configured (account_handle + a resolvable Vault secret)
 *       → CheckPayrollEngine (the licensed, regulated provider).
 *   - otherwise → MockPayrollEngine (deterministic dev / no-provider fallback), so
 *     no core capability depends on a provider being installed (FPB §4/§12).
 *
 * SERVER-ONLY. Resolving the Check API key reads the Vault via the SECURITY
 * DEFINER RPC `read_provider_secret`, executable by service_role only — so `db`
 * MUST be the admin (service-role) Supabase client when a real provider is
 * expected. With an RLS client the secret read fails and resolution degrades to
 * the Mock engine (safe by default; never crashes).
 *
 * Re-exports the engine types so consumers import everything from one place.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readProviderSecret } from '@/lib/money/secrets';
import { CheckPayrollEngine } from './check';
import { MockPayrollEngine } from './mock';
import type { PayrollEngine } from './types';

export * from './types';
export { MockPayrollEngine, MOCK_EMPLOYEE_TAX_RATE, MOCK_EMPLOYER_TAX_RATE } from './mock';
export { CheckPayrollEngine, type CheckEngineConfig } from './check';

interface PayrollConnectionRow {
  provider: string;
  environment: 'test' | 'live';
  account_handle: string | null;
  secret_ref: string | null;
  status: string;
}

/**
 * Resolve the active PayrollEngine for a tenant. Never throws for the "no
 * provider" case — it returns the Mock engine so upstream (preview, workflow)
 * keeps working. Only genuinely unexpected DB errors propagate.
 */
export async function resolvePayrollEngine(
  db: SupabaseClient,
  orgId: string,
): Promise<PayrollEngine> {
  const { data, error } = await db
    .schema('core')
    .from('provider_connections')
    .select('provider, environment, account_handle, secret_ref, status')
    .eq('org_id', orgId)
    .eq('capability', 'PAYROLL')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<PayrollConnectionRow>();

  // No active connection (or the read was denied by RLS) → dev/no-provider fallback.
  if (error || !data) return new MockPayrollEngine();

  if (data.provider === 'check') {
    // Resolve the per-tenant API key from Vault. If it can't be read (missing ref,
    // RLS client, or unknown secret) we degrade to Mock rather than hand back a
    // half-configured Check engine.
    let apiKey: string | null = null;
    if (data.secret_ref) {
      apiKey = await readProviderSecret(db, data.secret_ref).catch(() => null);
    }
    const check = new CheckPayrollEngine({
      accountHandle: data.account_handle,
      apiKey,
      environment: data.environment,
    });
    if (check.isConfigured()) return check;
  }

  // Unknown/unsupported provider or Check not fully configured → Mock fallback.
  return new MockPayrollEngine();
}
