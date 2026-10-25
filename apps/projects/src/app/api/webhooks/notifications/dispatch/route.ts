export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse, type NextRequest } from 'next/server';
import { requireCronSecret, runWorkerOnce } from '@/lib/notify/worker';

/**
 * The notification worker (Vercel Cron, every 5 minutes): speed-to-lead sweep, then the
 * email / text / push queue, then digests. Public path (no Clerk session — /api/webhooks is
 * public in middleware); authenticated by `Authorization: Bearer $CRON_SECRET` instead, so it
 * cannot use route(). Idempotent: overlapping runs never double-send (DB claims).
 */
async function run(req: NextRequest): Promise<NextResponse> {
  if (!requireCronSecret(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 401 });
  }
  try {
    const r = await runWorkerOnce();
    if (!r.ok) return NextResponse.json({ error: r.reason, code: 'NOT_CONFIGURED' }, { status: 503 });
    return NextResponse.json(r.summary);
  } catch (e) {
    console.error('[notify worker]', e);
    return NextResponse.json({ error: 'The notification worker failed. It retries on the next run.', code: 'INTERNAL' }, { status: 500 });
  }
}

export const GET = (req: NextRequest) => run(req);
export const POST = (req: NextRequest) => run(req);
