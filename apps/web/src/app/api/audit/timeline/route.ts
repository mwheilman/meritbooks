export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  resolveActorNames,
  actorDisplayName,
  moduleFor,
  type ActorType,
  type RawLogRow,
} from '@/lib/trust/audit-query';

interface TimelineEvent {
  id: string;
  source: 'action_log' | 'ai_decision';
  actorType: ActorType;
  actorName: string;
  action: string;
  module: string;
  summary: string | null;
  tier: string | null;
  confidence: number | null;
  status: string | null; // ai_decision disposition, when source === 'ai_decision'
  createdAt: string;
}

interface AiDecisionRow {
  id: string;
  feature: string;
  input_summary: string | null;
  confidence: number | null;
  status: string | null;
  reasoning: string | null;
  created_at: string;
}

const MAX_EVENTS = 500;

/**
 * GET /api/audit/timeline?subjectTable=..&subjectId=.. — the full chronological
 * history of ONE record: every core.action_log row for it, merged with any
 * public.ai_decisions that produced it (linked by posted_gl_entry_id when the
 * subject is a GL entry). Newest first. Org-scoped by RLS + explicit org filter.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const guard = await requirePermission(userId, 'audit_trail', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const subjectTable = (searchParams.get('subjectTable') ?? '').trim().slice(0, 80);
  const subjectId = (searchParams.get('subjectId') ?? '').trim().slice(0, 128);
  if (!subjectId) {
    return NextResponse.json({ error: 'subjectId is required', code: 'BAD_REQUEST' }, { status: 400 });
  }

  // 1. Action-log rows for this record.
  let q = supabase
    .schema('core')
    .from('action_log')
    .select(
      'id, actor_type, actor_user_id, action, summary, subject_table, subject_id, tier, confidence, created_at',
    )
    .eq('org_id', orgId!)
    .eq('subject_id', subjectId);
  if (subjectTable) q = q.eq('subject_table', subjectTable);

  const { data: logs, error } = await q.order('created_at', { ascending: false }).limit(MAX_EVENTS);
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  const logRows = (logs ?? []) as RawLogRow[];

  // 2. Linked AI decisions (only meaningful for GL entries, which ai_decisions
  //    references via posted_gl_entry_id).
  let aiRows: AiDecisionRow[] = [];
  if (!subjectTable || subjectTable === 'gl_entries') {
    const { data: ai } = await supabase
      .from('ai_decisions')
      .select('id, feature, input_summary, confidence, status, reasoning, created_at')
      .eq('org_id', orgId!)
      .eq('posted_gl_entry_id', subjectId)
      .order('created_at', { ascending: false })
      .limit(MAX_EVENTS);
    aiRows = (ai ?? []) as AiDecisionRow[];
  }

  // 3. Resolve human actor names once.
  const nameById = await resolveActorNames(
    createAdminSupabase(),
    logRows.filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id).map((r) => r.actor_user_id as string),
  );

  const events: TimelineEvent[] = [
    ...logRows.map((r) => ({
      id: r.id,
      source: 'action_log' as const,
      actorType: r.actor_type,
      actorName: actorDisplayName(r.actor_type, r.actor_user_id, nameById),
      action: r.action,
      module: moduleFor(r.action, r.subject_table).label,
      summary: r.summary,
      tier: r.tier,
      confidence: r.confidence,
      status: null,
      createdAt: r.created_at,
    })),
    ...aiRows.map((r) => ({
      id: `ai_${r.id}`,
      source: 'ai_decision' as const,
      actorType: 'AI' as ActorType,
      actorName: 'AI',
      action: `ai.${r.feature.toLowerCase()}.proposed`,
      module: 'AI Assist',
      summary: r.input_summary ?? r.reasoning,
      tier: null,
      confidence: r.confidence,
      status: r.status,
      createdAt: r.created_at,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return NextResponse.json({ data: events, subjectTable: subjectTable || null, subjectId });
}
