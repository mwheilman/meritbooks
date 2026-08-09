export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import {
  planFor,
  planBreakdown,
  USAGE_RATES_BPS,
  ENTERPRISE_MIN_COMPANIES,
  type MrrBreakdown,
} from '@/lib/billing/pricing';

/**
 * GET /api/billing/plan
 *
 * This tenant's subscription plan and its computed monthly cost — a deterministic
 * READ over the shared pricing model. It reports what the tenant WOULD be billed under
 * its plan at its current active-company count; it does NOT charge anything (live billing
 * is a separate, gated step). RLS scopes every read to the caller's org.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  if (!orgId) {
    return NextResponse.json({ error: 'No organization in context', code: 'NO_ORG' }, { status: 400 });
  }

  // Org billing fields (RLS restricts to this org anyway; filter is defense-in-depth).
  const { data: org, error: orgErr } = await supabase
    .schema('core')
    .from('organizations')
    .select('id, name, billing_plan, custom_mrr_cents')
    .eq('id', orgId)
    .single();
  if (orgErr || !org) {
    return NextResponse.json(
      { error: orgErr?.message ?? 'Organization not found', code: 'ORG_READ_FAILED' },
      { status: 500 },
    );
  }

  // Active companies = active core.locations for this org (RLS-scoped).
  const { count: activeCompanies, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);
  if (locErr) {
    return NextResponse.json({ error: locErr.message, code: 'LOCATIONS_READ_FAILED' }, { status: 500 });
  }

  const count = activeCompanies ?? 0;
  const { plan, customCents } = planFor(org);
  const breakdown: MrrBreakdown = planBreakdown(plan, count, customCents);

  return NextResponse.json({
    org: { id: org.id, name: org.name ?? null },
    plan,
    activeCompanies: count,
    customMrrCents: customCents,
    breakdown,
    usage: {
      // Informational only — processing economics, never part of the subscription MRR.
      achBps: USAGE_RATES_BPS.ach,
      cardBps: USAGE_RATES_BPS.card,
    },
    enterpriseMinCompanies: ENTERPRISE_MIN_COMPANIES,
    // Live charging is NOT wired. This endpoint computes and displays only.
    billingActivated: false,
  });
}
