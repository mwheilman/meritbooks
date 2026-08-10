/**
 * Optional Sentry forwarding — degrade-safe by design.
 *
 * Contract (from the observability spec): absent DSN = TABLE-ONLY. If
 * `SENTRY_DSN` is unset we NEVER import a Sentry package and NEVER touch the
 * network — the `app_error_log` table is the whole story. If a DSN *is* set AND
 * `@sentry/node` happens to be installed, we lazily import it (init once) and
 * forward. A missing package or any runtime failure is swallowed: observability
 * must never add a failure mode to the request path.
 *
 * `@sentry/node` is NOT a declared dependency — the import specifier is hidden
 * from the bundler (via a runtime `import()` builder) so `next build` succeeds
 * whether or not the package exists in node_modules.
 */

export type ForwardLevel = 'ERROR' | 'WARN' | 'FATAL';

export interface SentryPayload {
  level: ForwardLevel;
  source: string;
  route: string | null;
  name: string;
  message: string;
  stack: string | null;
  digest: string;
  userId: string | null;
  orgId: string | null;
  requestId: string | null;
  meta: unknown;
}

/** Minimal surface we use — we never depend on Sentry's full type package. */
interface MinimalSentry {
  init: (opts: Record<string, unknown>) => void;
  captureException: (exception: unknown, captureContext?: Record<string, unknown>) => void;
}

// Hide the specifier from webpack/Next static analysis so an absent package is a
// caught runtime miss, not a build-time module-not-found error.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const runtimeImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;

let loadState: 'unloaded' | 'loading' | 'ready' | 'disabled' = 'unloaded';
let client: MinimalSentry | null = null;
let loadPromise: Promise<MinimalSentry | null> | null = null;

/** True only when a non-empty SENTRY_DSN is configured. */
export function sentryEnabled(): boolean {
  const dsn = process.env.SENTRY_DSN;
  return typeof dsn === 'string' && dsn.trim().length > 0;
}

async function loadSentry(): Promise<MinimalSentry | null> {
  if (!sentryEnabled()) return null;
  if (loadState === 'ready') return client;
  if (loadState === 'disabled') return null;
  if (loadPromise) return loadPromise;

  loadState = 'loading';
  loadPromise = (async () => {
    try {
      const mod = (await runtimeImport('@sentry/node')) as Partial<MinimalSentry> | null;
      if (!mod || typeof mod.init !== 'function' || typeof mod.captureException !== 'function') {
        loadState = 'disabled';
        return null;
      }
      const s = mod as MinimalSentry;
      s.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
      client = s;
      loadState = 'ready';
      return s;
    } catch {
      // Package not installed or init failed — permanently disable, quietly.
      loadState = 'disabled';
      return null;
    }
  })();
  return loadPromise;
}

const SENTRY_LEVEL: Record<ForwardLevel, string> = {
  ERROR: 'error',
  WARN: 'warning',
  FATAL: 'fatal',
};

/**
 * Forward a captured error to Sentry IF (and only if) a DSN is configured and the
 * SDK is available. Best-effort — resolves without throwing in every path.
 */
export async function forwardToSentry(payload: SentryPayload): Promise<void> {
  if (!sentryEnabled()) return; // table-only mode: no import, no network
  try {
    const s = await loadSentry();
    if (!s) return;
    const err = new Error(payload.message);
    err.name = payload.name;
    if (payload.stack) err.stack = payload.stack;
    s.captureException(err, {
      level: SENTRY_LEVEL[payload.level],
      tags: {
        source: payload.source,
        route: payload.route ?? 'unknown',
        digest: payload.digest,
      },
      extra: { meta: payload.meta, requestId: payload.requestId, orgId: payload.orgId },
      user: payload.userId ? { id: payload.userId } : undefined,
    });
  } catch {
    // never let the forwarder throw into the caller
  }
}
