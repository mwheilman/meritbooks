export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadRevRecReport } from '@/lib/services/rev-rec-reporting';

/**
 * GET /api/rev-rec/reporting?month=YYYY-MM&location_id=<uuid>
 *
 * Read-only reporting on top of the recognition engine:
 *   - deferred-revenue rollforward (ties to account 2410)
 *   - per-job recognition waterfall (recognized-to-date vs remaining)
 *   - revenue recognized this period by method
 *
 * Company-scoped via `location_id` (attached automatically by the shared query
 * hook when a single company is active); tenant isolation is enforced by RLS.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const url = new URL(request.url);
  const monthRaw = url.searchParams.get('month');
  const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null;
  const locationId = url.searchParams.get('location_id');

  try {
    const report = await loadRevRecReport(supabase, orgId, { locationId, month });
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load rev-rec report' },
      { status: 500 },
    );
  }
}
