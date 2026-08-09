export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  parseAuditFilters,
  applyAuditFilters,
  resolveActorNames,
  summarize,
  SUMMARY_CAP,
  type SummaryRow,
} from '@/lib/trust/audit-query';

interface AiDecisionRow {
  status: string | null;
}

/**
 * GET /api/audit/summary — aggregate view of the (optionally filtered) action
 * log: totals by actor type, by tier, per-actor, per-module, and the distinct
 * action list (which doubles as the action-type filter facet). Also folds in the
 * AI decision-log dispositions (public.ai_decisions) for the same date window.
 *
 * Aggregation is done in-app over a capped, minimal-column scan (no GROUP-BY RPC,
 * so no migration). `capped` tells the client the counts cover the most-recent
 * SUMMARY_CAP matching rows.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const guard = await requirePermission(userId, 'audit_trail', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const filters = parseAuditFilters(searchParams);

  const base = supabase
    .schema('core')
    .from('action_log')
    .select('actor_type, actor_user_id, action, subject_table, tier')
    .eq('org_id', orgId!);

  const { data: rows, error } = await applyAuditFilters(base, filters)
    .order('created_at', { ascending: false })
    .limit(SUMMARY_CAP);

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const scan = (rows ?? []) as SummaryRow[];
  const capped = scan.length >= SUMMARY_CAP;

  const actorIds = scan
    .filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id)
    .map((r) => r.actor_user_id as string);
  const nameById = await resolveActorNames(createAdminSupabase(), actorIds);

  const summary = summarize(scan, nameById, capped);

  // ── AI decision-log dispositions for the same date window (public.ai_decisions,
  //    org-scoped via RLS). Independent of the action_log actor filters. ──
  const ai = { total: 0, proposed: 0, approved: 0, rejected: 0, expired: 0 };
  {
    let q = supabase
      .from('ai_decisions')
      .select('status')
      .eq('org_id', orgId!);
    if (filters.from) q = q.gte('created_at', `${filters.from}T00:00:00.000Z`);
    if (filters.to) q = q.lte('created_at', `${filters.to}T23:59:59.999Z`);

    const { data: aiRows } = await q.limit(SUMMARY_CAP);
    for (const r of (aiRows ?? []) as AiDecisionRow[]) {
      ai.total += 1;
      switch (r.status) {
        case 'PROPOSED':
          ai.proposed += 1;
          break;
        case 'APPROVED':
          ai.approved += 1;
          break;
        case 'REJECTED':
          ai.rejected += 1;
          break;
        case 'EXPIRED':
          ai.expired += 1;
          break;
      }
    }
  }

  return NextResponse.json({ ...summary, aiDecisions: ai });
}
