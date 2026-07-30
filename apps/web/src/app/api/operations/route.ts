export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import type { ActorType, Tier } from '@/lib/trust/action-log';

// Raw shape returned from core.action_log.
interface LogRow {
  id: string;
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  summary: string | null;
  tier: string | null;
  confidence: number | string | null;
  created_at: string;
}

interface RecentActivity {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  summary: string | null;
  tier: Tier | null;
  confidence: number | null;
  createdAt: string;
}

interface OperationsResponse {
  totals: { all: number; last24h: number; last7d: number };
  byActor: Record<ActorType, number>;
  aiTiers: Record<Tier, number>;
  autonomyRate: number | null;
  recent: RecentActivity[];
}

const WINDOW_DAYS = 30;
const MAX_ROWS = 2000;
const RECENT_COUNT = 25;
const TIERS: Tier[] = ['auto', 'review', 'escalate'];

function asTier(value: string | null): Tier | null {
  return value && (TIERS as string[]).includes(value) ? (value as Tier) : null;
}

/**
 * GET /api/operations
 * Manager-facing operations overview computed from the org's recent action_log.
 * RLS scopes rows to the caller's org. Counting is done in JS over the fetched
 * window (last 30 days, capped) — simplest and correct for a starter dashboard.
 * Human actor display names are resolved via the service role because core.users
 * is self_read under RLS (same pattern as /api/audit).
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .schema('core')
    .from('action_log')
    .select('id, actor_type, actor_user_id, action, summary, tier, confidence, created_at')
    .eq('org_id', orgId!)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const logRows = (rows ?? []) as LogRow[];

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

  const totals = { all: logRows.length, last24h: 0, last7d: 0 };
  const byActor: Record<ActorType, number> = { HUMAN: 0, AI: 0, SYSTEM: 0 };
  const aiTiers: Record<Tier, number> = { auto: 0, review: 0, escalate: 0 };

  for (const r of logRows) {
    const t = new Date(r.created_at).getTime();
    if (t >= cutoff24h) totals.last24h += 1;
    if (t >= cutoff7d) totals.last7d += 1;

    if (r.actor_type === 'HUMAN' || r.actor_type === 'AI' || r.actor_type === 'SYSTEM') {
      byActor[r.actor_type] += 1;
    }

    if (r.actor_type === 'AI') {
      const tier = asTier(r.tier);
      if (tier) aiTiers[tier] += 1;
    }
  }

  const aiTierTotal = aiTiers.auto + aiTiers.review + aiTiers.escalate;
  const autonomyRate = aiTierTotal > 0 ? aiTiers.auto / aiTierTotal : null;

  // Resolve HUMAN actor display names in ONE service-role lookup (no N+1).
  // core.users is self_read under RLS, so the RLS client would only see the
  // viewer's own name. This read is name-only and the ids come from org-scoped
  // action_log rows, so it's safe. Mirrors /api/audit.
  const recentRows = logRows.slice(0, RECENT_COUNT);
  const actorIds = Array.from(
    new Set(
      recentRows
        .filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id)
        .map((r) => r.actor_user_id as string)
    )
  );

  const nameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const admin = createAdminSupabase();
    const { data: users } = await admin
      .schema('core')
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', actorIds);

    for (const u of (users ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
      nameById.set(u.id, full || u.email || 'Team member');
    }
  }

  const recent: RecentActivity[] = recentRows.map((r) => {
    let actorName: string;
    if (r.actor_type === 'AI') actorName = 'AI';
    else if (r.actor_type === 'SYSTEM') actorName = 'System';
    else actorName = (r.actor_user_id && nameById.get(r.actor_user_id)) || 'Team member';

    return {
      id: r.id,
      actorType: r.actor_type,
      actorName,
      action: r.action,
      summary: r.summary,
      tier: asTier(r.tier),
      confidence: r.confidence == null ? null : Number(r.confidence),
      createdAt: r.created_at,
    };
  });

  const body: OperationsResponse = { totals, byActor, aiTiers, autonomyRate, recent };
  return NextResponse.json(body);
}
