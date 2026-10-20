/**
 * Payroll provider REGISTRY + per-tenant resolution.
 *
 * One descriptor per adapter. `createPayrollProvider` builds an adapter from a
 * tenant's `core.provider_connections` row (capability 'PAYROLL', migration 041):
 *   provider   → which adapter ('gusto' | 'check' | 'file' | 'mock')
 *   account_handle → provider company id (Gusto company_uuid / Check company)
 *   secret_ref → Vault secret (Gusto: token-pair JSON; Check: API key)
 *   metadata   → non-secret adapter settings (file adapter: systemName,
 *                employeePortalUrl, earningsCsv template)
 *
 * `resolvePayrollProvider(db, orgId)`:
 *   - no active PAYROLL connection (or RLS denies the read) → Mock (dev fallback;
 *     no core capability depends on a provider being installed — FPB §4/§12);
 *   - a known provider → that adapter, EVEN IF its credentials are missing/expired.
 *     A tenant that connected a real provider must never silently get Mock
 *     estimates (they could be approved, released and posted as if real). The
 *     unconfigured adapter reports NOT_CONFIGURED from status() and throws
 *     PayrollProviderNotConfiguredError on use, which the run routes surface.
 *   - 'file' → the File adapter (always configured; run operations throw a clear
 *     capability error instead of returning mock estimates for a real tenant).
 *   - an unknown provider string → Mock (nothing to call).
 *
 * SERVER-ONLY: reading a Vault secret uses the service-role RPC. With an RLS
 * client the secret read fails and resolution degrades safely.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readProviderSecret, rotateProviderSecret } from '@/lib/money/secrets';
import { CheckPayrollEngine, CHECK_CAPABILITIES } from './check';
import { FilePayrollProvider, FILE_CAPABILITIES, type FileProviderConfig } from './file';
import { GustoPayrollProvider, GUSTO_CAPABILITIES } from './gusto';
import { parseGustoTokens } from './gusto-mappers';
import { MockPayrollEngine, MOCK_CAPABILITIES } from './mock';
import {
  isPayrollProviderId,
  type PayrollProvider,
  type PayrollProviderCapabilities,
  type PayrollProviderId,
} from './types';

/** Everything an adapter factory may need, already resolved (secret read server-side). */
export interface ProviderConnectionContext {
  provider: string;
  environment: 'test' | 'live';
  accountHandle: string | null;
  /** Plain secret read from Vault (never logged). */
  secret: string | null;
  /** Non-secret adapter settings from provider_connections.metadata. */
  metadata: Record<string, unknown> | null;
  /** Persist a rotated secret (Gusto token refresh). */
  persistSecret?: (secret: string) => Promise<void>;
}

export interface PayrollProviderDescriptor {
  id: PayrollProviderId;
  displayName: string;
  capabilities: PayrollProviderCapabilities;
  /** True when the adapter needs a Vault secret (API credentials / tokens). */
  requiresSecret: boolean;
  /** Server env vars the adapter reads (documentation + setup checks). */
  envVars: readonly string[];
  create(ctx: ProviderConnectionContext): PayrollProvider;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function fileConfigFrom(metadata: Record<string, unknown> | null): FileProviderConfig {
  const m = metadata ?? {};
  const csv = (m.earningsCsv && typeof m.earningsCsv === 'object' ? m.earningsCsv : null) as FileProviderConfig['earningsCsv'] | null;
  return {
    systemName: str(m.systemName),
    employeePortalUrl: str(m.employeePortalUrl),
    earningsCsv: csv ?? undefined,
  };
}

export const PAYROLL_PROVIDER_REGISTRY: Readonly<Record<PayrollProviderId, PayrollProviderDescriptor>> = Object.freeze({
  gusto: {
    id: 'gusto',
    displayName: 'Gusto',
    capabilities: GUSTO_CAPABILITIES,
    requiresSecret: true,
    envVars: ['GUSTO_CLIENT_ID', 'GUSTO_CLIENT_SECRET', 'GUSTO_API_BASE_URL (optional)'],
    create: (ctx) =>
      new GustoPayrollProvider({
        companyUuid: ctx.accountHandle,
        tokens: parseGustoTokens(ctx.secret),
        environment: ctx.environment,
        persistTokens: ctx.persistSecret ? (t) => ctx.persistSecret!(JSON.stringify(t)) : undefined,
      }),
  },
  check: {
    id: 'check',
    displayName: 'Check',
    capabilities: CHECK_CAPABILITIES,
    requiresSecret: true,
    envVars: ['CHECK_API_BASE_URL (optional)'],
    create: (ctx) =>
      new CheckPayrollEngine({ accountHandle: ctx.accountHandle, apiKey: ctx.secret, environment: ctx.environment }),
  },
  file: {
    id: 'file',
    displayName: 'Any payroll system (file import / export)',
    capabilities: FILE_CAPABILITIES,
    requiresSecret: false,
    envVars: [],
    create: (ctx) => new FilePayrollProvider(fileConfigFrom(ctx.metadata)),
  },
  mock: {
    id: 'mock',
    displayName: 'Sandbox (no provider)',
    capabilities: MOCK_CAPABILITIES,
    requiresSecret: false,
    envVars: [],
    create: () => new MockPayrollEngine(),
  },
});

/** Selectable providers for a settings screen (sandbox last). */
export function listPayrollProviders(): PayrollProviderDescriptor[] {
  return (['gusto', 'file', 'check', 'mock'] as const).map((id) => PAYROLL_PROVIDER_REGISTRY[id]);
}

/** Build an adapter for a connection; null for an unknown provider string. */
export function createPayrollProvider(ctx: ProviderConnectionContext): PayrollProvider | null {
  if (!isPayrollProviderId(ctx.provider)) return null;
  return PAYROLL_PROVIDER_REGISTRY[ctx.provider].create(ctx);
}

interface PayrollConnectionRow {
  provider: string;
  environment: 'test' | 'live';
  account_handle: string | null;
  secret_ref: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Resolve the active payroll provider for a tenant. Never throws for the
 * "no provider" case. Only genuinely unexpected errors propagate.
 */
export async function resolvePayrollProvider(db: SupabaseClient, orgId: string): Promise<PayrollProvider> {
  const { data, error } = await db
    .schema('core')
    .from('provider_connections')
    .select('provider, environment, account_handle, secret_ref, status, metadata')
    .eq('org_id', orgId)
    .eq('capability', 'PAYROLL')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<PayrollConnectionRow>();

  if (error || !data || !isPayrollProviderId(data.provider)) return new MockPayrollEngine();

  const descriptor = PAYROLL_PROVIDER_REGISTRY[data.provider];
  let secret: string | null = null;
  if (descriptor.requiresSecret && data.secret_ref) {
    secret = await readProviderSecret(db, data.secret_ref).catch(() => null);
  }
  const secretRef = data.secret_ref;
  const provider = descriptor.create({
    provider: data.provider,
    environment: data.environment,
    accountHandle: data.account_handle,
    secret,
    metadata: data.metadata ?? null,
    persistSecret: secretRef ? (s) => rotateProviderSecret(db, secretRef, s) : undefined,
  });
  return provider;
}
