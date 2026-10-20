/**
 * Payroll engine resolution (GATE 12.3).
 *
 * `resolvePayrollEngine(db, orgId)` returns the tenant's payroll provider from
 * `core.provider_connections` (capability 'PAYROLL', status 'active', migration
 * 041) via the provider REGISTRY (`lib/payroll/providers/registry.ts`). Every
 * provider implements the full `PayrollProvider` contract, which extends the run
 * contract (`PayrollEngine`) the run workflow builds against.
 *
 *   - no active connection → MockPayrollEngine (dev / no-provider fallback, so no
 *     core capability depends on a provider being installed — FPB §4/§12);
 *   - 'gusto' | 'check' → that adapter (unconfigured adapters throw
 *     PayrollProviderNotConfiguredError on use instead of returning mock numbers);
 *   - 'file' → FilePayrollProvider (payroll runs in the tenant's own system).
 *
 * SERVER-ONLY. Secret reads use the service-role RPC; with an RLS client they
 * fail and the adapter degrades to not-configured (safe by default; never crashes).
 *
 * Re-exports the engine types so consumers import everything from one place.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePayrollProvider } from '../providers/registry';
import type { PayrollProvider } from '../providers/types';

export * from './types';
export { MockPayrollEngine, MOCK_EMPLOYEE_TAX_RATE, MOCK_EMPLOYER_TAX_RATE } from '../providers/mock';
export { CheckPayrollEngine, type CheckEngineConfig } from '../providers/check';
export { PayrollCapabilityUnsupportedError, type PayrollProvider } from '../providers/types';

/** Resolve the active payroll provider (a superset of PayrollEngine) for a tenant. */
export async function resolvePayrollEngine(db: SupabaseClient, orgId: string): Promise<PayrollProvider> {
  return resolvePayrollProvider(db, orgId);
}
