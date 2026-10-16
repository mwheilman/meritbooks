/**
 * Which migration adapter serves a request — an explicit, pure, unit-tested decision
 * (FPB principle 7 "Never fake it" / blocker B3).
 *
 *   • LIVE   only when the provider is QBO, the platform has the Intuit app keys, and
 *            THIS org has a `connected` QBO row.
 *   • MOCK   only when the caller explicitly asked for sample data AND the runtime is
 *            not production. In production a sample request is refused outright —
 *            fixture data can never reach a real company's books.
 *   • otherwise NOT_CONNECTED with a plain-English reason (and the guided-export
 *            fallback stays available in the UI).
 *
 * The mock is NEVER chosen implicitly: a missing/broken live connection degrades to
 * not-connected, not to sample data.
 */

import type { MigrationProviderId } from './types';

export type ProviderSelection =
  | { kind: 'live' }
  | { kind: 'mock' }
  | { kind: 'not_connected'; reason: string }
  | { kind: 'sample_blocked'; reason: string };

export interface ProviderSelectionInput {
  providerId: MigrationProviderId;
  /** The caller asked for fixture/sample data. */
  requestedMock: boolean;
  isProduction: boolean;
  /** Intuit app keys present (QBO_* env). */
  qboConfigured: boolean;
  /** This org's QBO connection status, or null when none exists. */
  connectionStatus: 'connected' | 'pending' | 'error' | null;
  /** The plain-English error on an 'error' connection, if any. */
  connectionError?: string | null;
}

/**
 * The single production rule (lib/runtime/production.ts) — re-exported here so
 * existing imports keep working. Stricter rule: Vercel PREVIEW counts as production
 * (previews may hit the production database), matching the sample-data guard.
 */
export { isProductionRuntime } from '@/lib/runtime/production';

const LABEL: Record<MigrationProviderId, string> = {
  quickbooks: 'QuickBooks Online',
  xero: 'Xero',
  sage: 'Sage',
};

export function selectMigrationProvider(input: ProviderSelectionInput): ProviderSelection {
  if (input.requestedMock) {
    if (input.isProduction) {
      return {
        kind: 'sample_blocked',
        reason: 'Sample data isn’t available for real companies. Connect your books or upload your reports instead.',
      };
    }
    return { kind: 'mock' };
  }

  if (input.providerId !== 'quickbooks') {
    return {
      kind: 'not_connected',
      reason: `A direct ${LABEL[input.providerId]} connection isn’t available yet. Export your trial balance from ${LABEL[input.providerId]} and drop the file here instead.`,
    };
  }
  if (!input.qboConfigured) {
    return {
      kind: 'not_connected',
      reason:
        'QuickBooks connect isn’t set up on this MeritBooks deployment yet. You can still export two reports from QuickBooks and drop them here.',
    };
  }
  if (input.connectionStatus === 'connected') return { kind: 'live' };
  if (input.connectionStatus === 'error') {
    return {
      kind: 'not_connected',
      reason:
        input.connectionError ??
        'The QuickBooks connection needs attention. Click “Connect QuickBooks” to link it again.',
    };
  }
  return {
    kind: 'not_connected',
    reason: 'Not connected — click “Connect QuickBooks” to link your company first.',
  };
}
