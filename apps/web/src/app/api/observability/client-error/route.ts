/**
 * POST /api/observability/client-error
 *
 * Sink for browser-side errors (the global error page + <ErrorBoundary> report
 * here). Captures with source='ui'. Deliberately lenient about auth — a client
 * error can happen before or after a session exists (e.g. on an auth screen) — so
 * it attaches identity when resolvable but never fails closed on its absence.
 *
 * Rate-limited per client IP so a render-loop on one browser cannot flood the
 * table. Best-effort in every path; always returns 200/429 quickly.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { captureError } from '@/lib/observability/capture';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    // opportunistic sweep so the map cannot grow unbounded
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

interface ClientErrorBody {
  message?: unknown;
  stack?: unknown;
  componentStack?: unknown;
  route?: unknown;
  label?: unknown;
  digest?: unknown;
}

export async function POST(req: Request) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  if (rateLimited(ip)) {
    return NextResponse.json({ ok: false, code: 'RATE_LIMITED' }, { status: 429 });
  }

  let body: ClientErrorBody = {};
  try {
    body = (await req.json()) as ClientErrorBody;
  } catch {
    // malformed body — still record a minimal event below
  }

  const message = typeof body.message === 'string' && body.message ? body.message.slice(0, 2000) : 'Unhandled client error';
  const stack =
    typeof body.stack === 'string'
      ? body.stack.slice(0, 8000)
      : typeof body.componentStack === 'string'
        ? body.componentStack.slice(0, 8000)
        : null;
  const route = typeof body.route === 'string' ? body.route.slice(0, 500) : null;
  const label = typeof body.label === 'string' ? body.label.slice(0, 200) : undefined;

  // Best-effort identity (never fail closed on a missing session).
  let userId: string | null = null;
  let orgId: string | null = null;
  try {
    const a = await auth();
    userId = a?.userId ?? null;
    const claims = a?.sessionClaims as Record<string, unknown> | null;
    if (claims && typeof claims.org_id === 'string') orgId = claims.org_id; // captureError only writes it if UUID-shaped
  } catch {
    /* unauthenticated context is fine */
  }

  const err = new Error(message);
  err.name = 'ClientError';
  if (stack) err.stack = stack;

  await captureError({
    level: 'ERROR',
    source: 'ui',
    route,
    error: err,
    userId,
    orgId,
    meta: { clientReported: true, label, reportedDigest: typeof body.digest === 'string' ? body.digest : undefined },
  });

  return NextResponse.json({ ok: true });
}
