export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { runDueSchedules } from '@/lib/posting/schedule-engine';
import { runDepreciation } from '@/lib/posting/depreciation-engine';
import { runTaxDepreciation } from '@/lib/posting/tax-depreciation';
import { runDueRecurring } from '@/lib/posting/recurring-engine';

/**
 * POST /api/period-engine { action, asOf? }
 *   action: 'run-all' | 'run-recurring' | 'run-schedules' | 'run-depreciation' | 'run-tax-depreciation'
 *   asOf:   YYYY-MM-DD (default: today) — bounds which periods are due.
 *
 * Posts every due, not-yet-posted period for the requested engine(s). Each engine
 * is idempotent (run ledgers), so re-running is safe. Tax depreciation is computed
 * in parallel and is NOT posted to the financial GL.
 */
export async function POST(request: Request) {
  await auth().catch(() => null);

  let action = 'run-all';
  let asOf = new Date().toISOString().slice(0, 10);
  try {
    const body = await request.json();
    if (body?.action) action = body.action;
    if (body?.asOf) asOf = body.asOf;
  } catch {
    // body optional; defaults apply
  }

  const valid = ['run-all', 'run-recurring', 'run-schedules', 'run-depreciation', 'run-tax-depreciation'];
  if (!valid.includes(action)) {
    return NextResponse.json({ error: `action must be one of: ${valid.join(', ')}` }, { status: 422 });
  }

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    const out: Record<string, unknown> = { action, asOf, orgId };

    if (action === 'run-all' || action === 'run-recurring') {
      out.recurring = await runDueRecurring(supabase, orgId, asOf);
    }
    if (action === 'run-all' || action === 'run-schedules') {
      out.schedules = await runDueSchedules(supabase, orgId, asOf);
    }
    if (action === 'run-all' || action === 'run-depreciation') {
      out.depreciation = await runDepreciation(supabase, orgId, asOf);
    }
    if (action === 'run-all' || action === 'run-tax-depreciation') {
      out.tax_depreciation = await runTaxDepreciation(supabase, orgId, asOf);
    }

    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : `${action} failed` }, { status: 500 });
  }
}
