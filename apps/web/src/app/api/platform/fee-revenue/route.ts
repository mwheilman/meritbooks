export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePlatformStaff } from '../_lib/platform-auth';
import { computeFeeRevenue } from '../_lib/fee-revenue';

/**
 * GET /api/platform/fee-revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Cross-tenant application-fee income the platform operator earned. Legitimately
 * cross-tenant, so it runs on the admin (service-role) client — but ONLY after the
 * request is confirmed to be platform staff. A non-staff caller gets 403; an
 * unauthenticated caller gets 401. Fails closed.
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
    const report = await computeFeeRevenue(admin, { from, to });
    return NextResponse.json(report);
  } catch (e) {
    console.error('[platform/fee-revenue]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to build fee-revenue report', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
