export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePlatformStaff } from '../_lib/platform-auth';
import { computeOperatorOverview } from '../_lib/operator-metrics';

/**
 * GET /api/platform/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Cross-tenant BUSINESS overview for the platform operator: tenant/seat counts,
 * realized processor-fee revenue, and the operator's instrumented costs (AI/API spend
 * and storage). Legitimately cross-tenant, so it runs on the admin (service-role)
 * client — but ONLY after the request is confirmed to be platform staff. A non-staff
 * caller gets 403; an unauthenticated caller gets 401. Fails closed.
 *
 * The window (from/to) applies to AI cost (occurred_at), realized fee (payment_date),
 * and new-tenant counting. Storage usage is a point-in-time snapshot and is NOT windowed.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string | null): string | null => (v && ISO_DATE.test(v) ? v : null);

export async function GET(req: Request) {
  const { clerkUserId, isPlatformStaff } = await resolvePlatformStaff();
  if (!clerkUserId) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  if (!isPlatformStaff) {
    return NextResponse.json(
      { error: 'Forbidden — platform staff only', code: 'NOT_PLATFORM_STAFF' },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(req.url);
  const from = validDate(searchParams.get('from'));
  const to = validDate(searchParams.get('to'));

  try {
    const admin = createAdminSupabase();
    const overview = await computeOperatorOverview(admin, { from, to });
    return NextResponse.json(overview);
  } catch (e) {
    console.error('[platform/overview]', e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'Failed to build operator overview',
        code: 'INTERNAL_ERROR',
      },
      { status: 500 },
    );
  }
}
