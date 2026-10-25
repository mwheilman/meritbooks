export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/notify/worker';
import { fsPublicRpc } from '@/lib/fieldservice/public-db';

/**
 * Field-service automations, every 10 minutes (Vercel Cron, Bearer CRON_SECRET): 24 h / 2 h
 * reminders, unsold-estimate follow-ups and the hand-off of every due field-service text / email
 * to the notifications queue (public.fs_cron_tick — server key, fails closed). The notification
 * worker then sends them under consent, STOP, quiet hours and go-live.
 */
async function run(req: NextRequest): Promise<NextResponse> {
  if (!requireCronSecret(req.headers.get('authorization'))) return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
  const r = await fsPublicRpc<{ reminders: number; followups: number; delivered: number }>('fs_cron_tick', {});
  if (r.error) {
    console.error('[fs cron]', r.error.code, r.error.message);
    return NextResponse.json({ error: 'Field-service automations did not run.', code: 'FAILED' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...(r.data ?? {}) });
}

export const GET = run;
export const POST = run;
