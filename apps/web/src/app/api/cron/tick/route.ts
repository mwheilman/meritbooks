export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // report packs render PDFs; node:crypto for the secret compare
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/scheduler/cron-auth';
import { dispatchTick } from '@/lib/scheduler/dispatch';

/**
 * GET /api/cron/tick — the ONE scheduler dispatcher (INT-01 / IA M-12).
 *
 * Vercel Cron calls this every 5 minutes (apps/web/vercel.json) with
 * `Authorization: Bearer $CRON_SECRET`. Each tick runs whatever registered jobs are
 * due (lib/scheduler/registry.ts), per tenant, under single-flight DB locks, and
 * logs every attempt to core.job_runs.
 *
 * AUTH: secret only, constant-time, FAILS CLOSED (401) when CRON_SECRET is unset or
 * the header is missing/wrong. No Clerk session is ever accepted — the path is
 * public at the middleware layer ONLY so that a session-less cron reaches this guard.
 *
 * POST is accepted with the same secret for a manual ops trigger (curl).
 */
async function handle(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }
  try {
    const report = await dispatchTick();
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    // Only reachable when the scheduler tables themselves can't be read (e.g. the
    // migration isn't applied). Individual job failures never land here.
    const message = e instanceof Error ? e.message : 'tick failed';
    console.error(JSON.stringify({ evt: 'scheduler.tick_error', error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return handle(req);
}
