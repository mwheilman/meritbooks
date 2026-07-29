export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { currentPeriodMonth } from '@meritbooks/core-ai';

/**
 * GET /api/ai/usage — Core-owned spend visibility for the current tenant.
 *
 * Reads the metering ledger + monthly counters (core.ai_usage_log / ai_usage_counters)
 * and resolves the tenant's tier caps. This is the data source for the future
 * per-tenant AI usage/cost dashboard. It is the ONLY place total spend is exposed;
 * modules never sum spend themselves (§3A.8).
 */

type Supa = SupabaseClient;

async function getOrg(supabase: Supa, orgId: string): Promise<{ id: string; ai_tier: string } | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id, ai_tier').eq('id', orgId).single();
  return (data as { id: string; ai_tier: string } | null) ?? null;
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const org = await getOrg(supabase, orgId);
  if (!org) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const periodMonth = currentPeriodMonth();

  const { data: tier } = await supabase
    .schema('core').from('ai_tier_config')
    .select('tier, monthly_cap_cents, per_user_cap_cents, soft_warn_pct, overage_policy')
    .eq('tier', org.ai_tier || 'default')
    .maybeSingle();

  const { data: counters } = await supabase
    .schema('core').from('ai_usage_counters')
    .select('scope, scope_key, cost_cents, call_count')
    .eq('org_id', org.id)
    .eq('period_month', periodMonth);

  const rows = (counters ?? []) as { scope: string; scope_key: string; cost_cents: number; call_count: number }[];
  const tenantRow = rows.find((r) => r.scope === 'TENANT');
  const tenantCost = tenantRow ? Number(tenantRow.cost_cents) : 0;
  const cap = tier?.monthly_cap_cents != null ? Number(tier.monthly_cap_cents) : null;

  const { data: recent } = await supabase
    .schema('core').from('ai_usage_log')
    .select('module, feature, model, model_used, status, tokens_input, tokens_output, cost_cents, correlation_id, occurred_at')
    .eq('org_id', org.id)
    .order('occurred_at', { ascending: false })
    .limit(50);

  const byFeature = rows
    .filter((r) => r.scope === 'FEATURE')
    .map((r) => ({ key: r.scope_key, costCents: Number(r.cost_cents), calls: Number(r.call_count) }));
  const byUser = rows
    .filter((r) => r.scope === 'USER')
    .map((r) => ({ userId: r.scope_key, costCents: Number(r.cost_cents), calls: Number(r.call_count) }));

  return NextResponse.json({
    periodMonth,
    tier: tier?.tier ?? 'default',
    overagePolicy: tier?.overage_policy ?? 'HARD_STOP',
    softWarnPct: tier?.soft_warn_pct != null ? Number(tier.soft_warn_pct) : 80,
    tenant: {
      costCents: tenantCost,
      calls: tenantRow ? Number(tenantRow.call_count) : 0,
      capCents: cap,
      pctUsed: cap && cap > 0 ? Math.round((tenantCost / cap) * 1000) / 10 : null,
      state: cap == null ? 'unconfigured' : tenantCost >= cap ? 'hard'
        : tenantCost >= cap * ((tier?.soft_warn_pct != null ? Number(tier.soft_warn_pct) : 80) / 100) ? 'soft' : 'under',
    },
    byFeature,
    byUser,
    recent: recent ?? [],
  });
}
