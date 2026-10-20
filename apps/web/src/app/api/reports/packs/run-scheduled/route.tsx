export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createAdminSupabase } from '@/lib/supabase/server';
import { deliverDuePacks } from '@/lib/reports/compiler/scheduled-delivery';

/**
 * POST /api/reports/packs/run-scheduled — legacy SERVER-TO-SERVER delivery worker.
 *
 * The M-12 scheduler now delivers packs per tenant via the `reports.packs` job
 * (/api/cron/tick → lib/scheduler/jobs/report-packs.ts), so this route is only a
 * manual/ops trigger. Both call the same engine
 * (lib/reports/compiler/scheduled-delivery.tsx), which keeps ledger reads on a
 * per-org RLS-scoped client and only delivers packs a user explicitly scheduled.
 *
 * Auth is SECRET-ONLY (constant-time compare on `x-report-pack-secret`) and FAILS
 * CLOSED: if REPORT_PACK_CRON_SECRET is unset, the endpoint is disabled. No Clerk
 * session can trigger it (this fans out across tenants).
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorize(req: Request): boolean {
  const secret = process.env.REPORT_PACK_CRON_SECRET;
  const presented = req.headers.get('x-report-pack-secret');
  return Boolean(secret && secret.length > 0 && presented && safeEqual(presented, secret));
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const result = await deliverDuePacks(createAdminSupabase(), { orgId: null });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({
    available: result.available,
    processed: result.processed,
    delivered: result.delivered,
    failed: result.failed,
    results: result.results,
  });
}
