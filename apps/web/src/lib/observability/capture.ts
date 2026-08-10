/**
 * captureError — the single entry point for the internal observability layer.
 *
 * Turns any thrown value into a scrubbed, fingerprinted row in
 * `public.app_error_log` (service-role write), and — only if a `SENTRY_DSN` is
 * configured — additionally forwards it to Sentry. It is BEST-EFFORT and MUST
 * NEVER throw into the caller: a failed insert or a broken forwarder can never be
 * allowed to convert a handled error into an unhandled one, or to break a request
 * that was otherwise fine.
 *
 * Server-only (writes with the admin client). Client trees report via
 * POST /api/observability/client-error, which calls this with source='ui'.
 */

import { createAdminSupabase } from '@/lib/supabase/server';
import { scrubString, scrubMeta, digestFor } from './scrub';
import { forwardToSentry } from './sentry-forwarder';

export type ErrorLevel = 'ERROR' | 'WARN' | 'FATAL';
export type ErrorSource = 'api' | 'ui' | 'job' | 'webhook';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_MESSAGE = 4000;
const MAX_STACK = 8000;

export interface CaptureInput {
  level?: ErrorLevel;
  source: ErrorSource;
  route?: string | null;
  /** The thrown value (Error, string, or anything). */
  error: unknown;
  /** Override the message (defaults to the error's message). */
  message?: string | null;
  userId?: string | null;
  /** Only written when it is a real UUID (the column is a nullable uuid). */
  orgId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
}

function toErrorParts(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message || String(error), stack: error.stack ?? null };
  }
  if (typeof error === 'string') return { name: 'Error', message: error, stack: null };
  try {
    return { name: 'Error', message: JSON.stringify(error), stack: null };
  } catch {
    return { name: 'Error', message: String(error), stack: null };
  }
}

/**
 * Capture an error. Returns the computed digest on success (best-effort), or null
 * if capture itself failed. Guaranteed not to throw.
 */
export async function captureError(input: CaptureInput): Promise<{ digest: string } | null> {
  try {
    const level: ErrorLevel = input.level ?? 'ERROR';
    const source: ErrorSource = input.source;
    const route = input.route ?? null;

    const parts = toErrorParts(input.error);
    const message = scrubString(input.message ?? parts.message).slice(0, MAX_MESSAGE);
    const stack = parts.stack ? scrubString(parts.stack).slice(0, MAX_STACK) : null;
    const digest = digestFor({ name: parts.name, message, stack, route });
    const meta = input.meta ? scrubMeta(input.meta) : null;
    // org_id is a nullable uuid — never write a non-uuid (e.g. a Clerk 'org_...' id).
    const orgId = input.orgId && UUID_RE.test(input.orgId) ? input.orgId : null;
    const userId = input.userId ?? null;
    const requestId = input.requestId ?? null;

    // 1) Best-effort table write (the always-on sink). Supabase returns an error
    //    object rather than throwing; log it but never propagate.
    try {
      const admin = createAdminSupabase();
      const { error: insertError } = await admin.from('app_error_log').insert({
        org_id: orgId,
        level,
        source,
        route,
        message,
        stack,
        digest,
        user_id: userId,
        request_id: requestId,
        meta,
      });
      if (insertError) {
        // eslint-disable-next-line no-console
        console.error('[observability] app_error_log insert failed:', insertError.message);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[observability] app_error_log insert threw:', e);
    }

    // 2) Optional Sentry forward — a no-op unless SENTRY_DSN is set.
    await forwardToSentry({
      level,
      source,
      route,
      name: parts.name,
      message,
      stack,
      digest,
      userId,
      orgId,
      requestId,
      meta,
    }).catch(() => {
      /* forwarder is already internally guarded; belt-and-suspenders */
    });

    return { digest };
  } catch (e) {
    // Absolute backstop: observability must never break the caller.
    try {
      // eslint-disable-next-line no-console
      console.error('[observability] captureError failed:', e);
    } catch {
      /* noop */
    }
    return null;
  }
}

/**
 * Wrap a job / webhook / cron body so any thrown error is captured (source='job'
 * by default) and then re-thrown unchanged. Use for background work that has no
 * apiHandler around it:
 *
 *   await withJobCapture({ route: 'cron/report-packs' }, async () => { ...work... });
 */
export async function withJobCapture<T>(
  ctx: { route: string; source?: ErrorSource; orgId?: string | null; requestId?: string | null; meta?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await captureError({
      level: 'ERROR',
      source: ctx.source ?? 'job',
      route: ctx.route,
      error,
      orgId: ctx.orgId ?? null,
      requestId: ctx.requestId ?? null,
      meta: ctx.meta ?? null,
    });
    throw error;
  }
}
