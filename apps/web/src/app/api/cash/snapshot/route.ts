export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { snapshotSchema } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter } from '@/lib/cash/forecast/route-support';
import { takeSnapshots } from '@/lib/cash/forecast/service';

/**
 * POST /api/cash/snapshot {location_id?} — "Snapshot now": saves this week's base forecast for the
 * scope (one row per company × week; a second press the same week is a no-op) so accuracy can be
 * scored before the weekly job has run. Minimum-cash alerts are left to the weekly job.
 * cash.forecast:edit; service-role write after the client-scope assert on every company covered.
 * The combined (all-companies) row is written only for a caller with all-clients scope asking for
 * every company (security review H4) — a scoped caller snapshots its own companies only.
 */
export const POST = apiHandler(snapshotSchema, async (body, ctx) => {
  const c = await cashRouteCtx(ctx, body.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, c.companies.map((x) => x.id));
    const out = await takeSnapshots(c.supabase, w, { orgId: c.orgId, today: c.today, source: 'MANUAL', actor: c.userId, companies: c.companies, alerts: false,
      combined: c.scopeBypass && !c.locationId,
    });
    return NextResponse.json(out, { status: out.written ? 201 : 200 });
  } catch (e) {
    return cashError(e, 'snapshot');
  }
});
