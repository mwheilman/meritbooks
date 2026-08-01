export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';

/**
 * Tax-year statutory params (Section 179 cap/phase-out, bonus %).
 *
 * GET  → list the org's params (the AI's annual review proposes new years as
 *        confirmed=false; this is what a human reviews).
 * POST { tax_year, section_179_max_cents?, section_179_phaseout_threshold_cents?,
 *        bonus_pct?, confirm? } → override values and/or mark a year confirmed.
 *        Confirming is a human action; the actor is captured on confirmed_by.
 */
export async function GET() {
  const a = await auth().catch(() => null);
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;
  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const { data, error } = await supabase
      .from('tax_year_params')
      .select('tax_year, section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct, source, confirmed, confirmed_by, confirmed_at')
      .eq('org_id', orgId)
      .order('tax_year', { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, params: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'list failed' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const taxYear = Number(body.tax_year);
  if (!Number.isInteger(taxYear)) return NextResponse.json({ error: 'tax_year (integer) is required' }, { status: 422 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.section_179_max_cents != null) update.section_179_max_cents = Number(body.section_179_max_cents);
    if (body.section_179_phaseout_threshold_cents != null) update.section_179_phaseout_threshold_cents = Number(body.section_179_phaseout_threshold_cents);
    if (body.bonus_pct != null) update.bonus_pct = Number(body.bonus_pct);
    if (body.source != null) update.source = String(body.source);
    if (body.confirm === true) {
      update.confirmed = true;
      update.confirmed_by = userId;
      update.confirmed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('tax_year_params')
      .update(update)
      .eq('org_id', orgId)
      .eq('tax_year', taxYear)
      .select('tax_year, section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct, source, confirmed')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: `No params row for tax_year ${taxYear}` }, { status: 404 });
    return NextResponse.json({ ok: true, params: data });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'update failed' }, { status: 500 });
  }
}
