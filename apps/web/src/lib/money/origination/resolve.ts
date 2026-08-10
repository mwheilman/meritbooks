/**
 * Resolve the active money-out ORIGINATION provider for a tenant.
 *
 * Mirrors resolvePayrollEngine: provider-agnostic, degrade-safe. Today there is no
 * real ACH/wire rail wired, so this returns the deterministic SANDBOX adapter for
 * every tenant. When a real provider is onboarded it plugs in behind the SAME
 * `OriginationProvider` interface and this resolver picks it from
 * `core.provider_connections` (capability 'PAYMENT_ORIGINATION') exactly the way the
 * payroll resolver picks Check — a credential swap, not a rewrite. Until then the
 * SANDBOX default guarantees the lane never depends on a rail being connected.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OriginationProvider } from './provider';
import { SandboxOriginationProvider } from './sandbox';

/**
 * Return the tenant's origination provider. Never throws — falls back to SANDBOX.
 * `db` / `orgId` are accepted now so the real-provider lookup can be added here
 * later without touching a single caller.
 */
export async function resolveOriginationProvider(
  _db: SupabaseClient,
  _orgId: string,
): Promise<OriginationProvider> {
  // No real rail is connected in this build — deterministic sandbox for everyone.
  // (Real provider selection from core.provider_connections plugs in here later.)
  return new SandboxOriginationProvider();
}
