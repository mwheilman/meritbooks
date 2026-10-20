export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requirePortfolioContext } from '@/lib/companies/portfolio/guard';
import { loadControlTower } from '@/lib/companies/portfolio/tower';
import { statusToSync } from '@/lib/companies/portfolio/tower-stage';
import type { OnboardingStatus } from '@/lib/companies/portfolio/types';
import { createAdminSupabase } from '@/lib/supabase/admin';

/**
 * Onboarding Control Tower.
 *
 * GET  → one row per active company with its stage (Created → Balances uploaded →
 *        Matched → Checked → Live), onboarding owner, stored vs derived onboarding
 *        status, and the next action. Pure read (RLS client, org-scoped).
 *
 * POST → reconcile `core.locations.onboarding_status` with what the data shows, so the
 *        Portfolio / Entities board stays consistent. FORWARD-ONLY: a company is moved
 *        not_started → in_progress once balances are uploaded, and → complete once its
 *        opening entry is posted; nothing is ever moved backwards (manual statuses and
 *        owner-assigned "in progress" are respected). Returns how many were updated.
 *
 * Gate: authenticated + settings_acct:edit + resolved org (fail closed).
 */

export async function GET() {
  const ctx = await requirePortfolioContext();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const data = await loadControlTower(ctx.supabase, ctx.orgId);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not load the Control Tower', code: 'LOAD_FAILED' },
      { status: 500 },
    );
  }
}

export async function POST() {
  const ctx = await requirePortfolioContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  let data;
  try {
    data = await loadControlTower(supabase, orgId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not load the Control Tower', code: 'LOAD_FAILED' },
      { status: 500 },
    );
  }
  if (!data.statusAvailable) return NextResponse.json({ updated: 0, available: false });

  // Group the forward moves by target status → one UPDATE per status.
  const byStatus = new Map<OnboardingStatus, string[]>();
  for (const r of data.rows) {
    const to = statusToSync(r.storedStatus, r.derivedStatus);
    if (!to) continue;
    const ids = byStatus.get(to) ?? [];
    ids.push(r.locationId);
    byStatus.set(to, ids);
  }

  let updated = 0;
  for (const [status, ids] of byStatus) {
    const patch: Record<string, unknown> = { onboarding_status: status };
    if (status === 'complete') patch.onboarding_completed_at = new Date().toISOString();
    // M4 (migration 167): core.locations is service-role-write only — written after
    // the settings_acct:edit gate (requirePortfolioContext), pinned to the session org.
    const { data: rows, error } = await createAdminSupabase()
      .schema('core').from('locations')
      .update(patch)
      .eq('org_id', orgId)
      .in('id', ids)
      .select('id');
    if (error) {
      return NextResponse.json({ error: `Could not update onboarding status: ${error.message}`, updated }, { status: 500 });
    }
    updated += (rows ?? []).length;
  }
  return NextResponse.json({ updated, available: true });
}
