/**
 * Sample-data guard — FPB-onboarding principle 7 ("Never fake it") / blocker B3.
 *
 * The direct-API migration providers ship provider-native FIXTURES so the whole
 * pull → conversion → tie-out path is exercisable before any OAuth credentials exist.
 * Those fixtures are demo data. They must never reach a real company's books in
 * production. This module is the single place that decides:
 *
 *   1. Whether sample imports may be OFFERED at all (`sampleImportsEnabledClient` for
 *      the browser, `sampleImportsAllowed` for servers — which also honours a per-org
 *      sandbox allowlist).
 *   2. Whether a staged conversion session CAME FROM sample data
 *      (`isSampleSourcedSession`) — by an explicit marker, by the name marker the
 *      conversion adapter stamps on every fixture line, or by fingerprinting the
 *      session against the fixtures themselves (which also catches sessions staged
 *      before the marker existed).
 *   3. The exact refusal the go-live post returns (`sampleSessionPostBlock`).
 *
 * Pure + dependency-light (fixtures + the shared transform only), so it is safe to
 * import from client components, API routes and tests alike.
 */

import { isProductionRuntime } from '@/lib/runtime/production';
import { getProviderFixture } from '@/lib/integrations/erp/providers/fixtures';
import { transformTrialBalanceRow } from '@/lib/integrations/erp/providers/mapping';
import {
  MIGRATION_PROVIDER_IDS,
  type ProviderTrialBalanceRow,
} from '@/lib/integrations/erp/providers/types';

/**
 * Prefix stamped on every source-account NAME of a fixture-sourced trial balance.
 * It rides inside the session's `sourceLines` (the conversion route persists names
 * verbatim), so it is visible in the review UI — loud by design — and detectable at
 * post time with no schema change.
 */
export const SAMPLE_SOURCE_NAME_PREFIX = '[SAMPLE DATA] ';

/** Optional explicit marker key a session blob may carry (`sampleSource: 'quickbooks'`). */
export const SAMPLE_SOURCE_FIELD = 'sampleSource' as const;

// ─────────────────────────────────────────────────────────────────────────────
// 1. May sample data be offered / accepted here?
// ─────────────────────────────────────────────────────────────────────────────

/** The env-var flag that explicitly enables sample imports on a production build. */
export const SAMPLE_IMPORTS_FLAG = 'NEXT_PUBLIC_ENABLE_SAMPLE_IMPORTS' as const;
/** Server-only, comma-separated Books org uuids that are sandbox/demo tenants. */
export const SAMPLE_ORG_ALLOWLIST = 'SAMPLE_DATA_ORG_IDS' as const;

type EnvLike = Record<string, string | undefined>;

function parseOrgAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Server-side: may sample/fixture data be offered or accepted for this org?
 * True when the build is not production, the explicit flag is on, or the org is an
 * allow-listed sandbox/demo tenant. Fails closed: production with nothing set ⇒ false.
 */
export function sampleImportsAllowed(
  opts: { orgId?: string | null; env?: EnvLike } = {},
): boolean {
  const env = opts.env ?? (process.env as EnvLike);
  if (!isProductionRuntime(env)) return true;
  if (env[SAMPLE_IMPORTS_FLAG] === 'true') return true;
  const orgId = opts.orgId?.trim().toLowerCase();
  if (orgId && parseOrgAllowlist(env[SAMPLE_ORG_ALLOWLIST]).has(orgId)) return true;
  return false;
}

/**
 * Browser-side twin of `sampleImportsAllowed` (no org allowlist — that list is a
 * server secret). The env reads are written LITERALLY so Next inlines them at build.
 */
export function sampleImportsEnabledClient(): boolean {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.NEXT_PUBLIC_ENABLE_SAMPLE_IMPORTS === 'true'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Did this trial balance / session come from the fixtures?
// ─────────────────────────────────────────────────────────────────────────────

/** Order-independent signature of a TB: sorted "code|debit|credit" for non-zero lines. */
function tbSignature(
  lines: { code: string; debitCents: number; creditCents: number }[],
): string {
  return lines
    .filter((l) => l.code.trim().length > 0 && (l.debitCents !== 0 || l.creditCents !== 0))
    .map((l) => `${l.code.trim()}|${Math.trunc(l.debitCents)}|${Math.trunc(l.creditCents)}`)
    .sort()
    .join(';');
}

let fixtureSignatures: Set<string> | null = null;

/** Signatures of every provider fixture TB, computed through the SAME transform. */
function getFixtureSignatures(): Set<string> {
  if (fixtureSignatures) return fixtureSignatures;
  const sigs = new Set<string>();
  for (const id of MIGRATION_PROVIDER_IDS) {
    const rows = getProviderFixture(id).trialBalance.map((r) => transformTrialBalanceRow(id, r));
    sigs.add(
      tbSignature(rows.map((r) => ({ code: r.accountCode, debitCents: r.debitCents, creditCents: r.creditCents }))),
    );
  }
  fixtureSignatures = sigs;
  return sigs;
}

/** True when a normalized provider TB is exactly one of the shipped fixtures. */
export function isFixtureTrialBalance(rows: ProviderTrialBalanceRow[]): boolean {
  if (rows.length === 0) return false;
  const sig = tbSignature(
    rows.map((r) => ({ code: r.accountCode, debitCents: r.debitCents, creditCents: r.creditCents })),
  );
  return getFixtureSignatures().has(sig);
}

/** Minimal structural view of a conversion session blob (ConversionSessionData-compatible). */
export interface SampleCheckableSession {
  sourceLines?: {
    sourceAccount: string;
    sourceName: string | null;
    debitCents: number;
    creditCents: number;
  }[] | null;
  [SAMPLE_SOURCE_FIELD]?: unknown;
}

/**
 * Did this staged conversion session come from sample (fixture) data?
 *   (a) an explicit `sampleSource` marker on the blob, or
 *   (b) any source line carrying the SAMPLE name prefix the adapter stamps, or
 *   (c) the source lines ARE a shipped fixture TB (catches pre-marker sessions).
 * Defensive: a malformed blob is treated as NOT sample (the other post gates still run).
 */
export function isSampleSourcedSession(data: SampleCheckableSession | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;

  const marker = data[SAMPLE_SOURCE_FIELD];
  if (marker !== undefined && marker !== null && marker !== false && marker !== '') return true;

  const lines = Array.isArray(data.sourceLines) ? data.sourceLines : [];
  if (lines.length === 0) return false;

  if (lines.some((l) => typeof l?.sourceName === 'string' && l.sourceName.startsWith(SAMPLE_SOURCE_NAME_PREFIX))) {
    return true;
  }

  const sig = tbSignature(
    lines.map((l) => ({
      code: String(l?.sourceAccount ?? ''),
      debitCents: Number(l?.debitCents ?? 0) || 0,
      creditCents: Number(l?.creditCents ?? 0) || 0,
    })),
  );
  return getFixtureSignatures().has(sig);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The go-live refusal
// ─────────────────────────────────────────────────────────────────────────────

export interface SamplePostBlock {
  error: string;
  code: 'SAMPLE_DATA_BLOCKED';
}

/**
 * Returns the 409 body the go-live post must return when the session is sample-sourced
 * and sample data isn't allowed for this org/deployment; otherwise null (proceed).
 */
export function sampleSessionPostBlock(
  data: SampleCheckableSession | null | undefined,
  opts: { orgId?: string | null; env?: EnvLike } = {},
): SamplePostBlock | null {
  if (!isSampleSourcedSession(data)) return null;
  if (sampleImportsAllowed(opts)) return null;
  return {
    code: 'SAMPLE_DATA_BLOCKED',
    error:
      'Blocked: this conversion was built from SAMPLE data, not your real books, so it can’t be posted. ' +
      'Start a new conversion from your own trial balance (upload the export from your prior system) or connect your accounting system.',
  };
}

/**
 * Returns the 403 body an import route must return when a client asks for fixture data
 * (`useFixture: true`) where sample data isn't allowed; otherwise null (proceed).
 */
export function sampleImportRequestBlock(
  useFixture: boolean | undefined,
  opts: { orgId?: string | null; env?: EnvLike } = {},
): SamplePostBlock | null {
  if (!useFixture) return null;
  if (sampleImportsAllowed(opts)) return null;
  return {
    code: 'SAMPLE_DATA_BLOCKED',
    error: 'Sample data isn’t available here — connect your accounting system or upload an export of your real books.',
  };
}
