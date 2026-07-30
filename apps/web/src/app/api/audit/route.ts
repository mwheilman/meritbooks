export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requireManageUsers } from '@/lib/team/guard';
import type { ActorType } from '@/lib/trust/action-log';

interface AuditRow {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  summary: string | null;
  subjectTable: string | null;
  subjectId: string | null;
  tier: string | null;
  confidence: number | null;
  createdAt: string;
}

// Raw shape returned from core.action_log.
interface LogRow {
  id: string;
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  summary: string | null;
  subject_table: string | null;
  subject_id: string | null;
  tier: string | null;
  confidence: number | null;
  created_at: string;
}

const ACTOR_TYPES: ActorType[] = ['HUMAN', 'AI', 'SYSTEM'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /api/audit
 * The recent action log for the caller's org, newest first. RLS scopes rows to
 * the org; the manage-users gate keeps the trail admin-only (same authority that
 * governs Team & Access). Optional `?actorType=HUMAN|AI|SYSTEM` and `?limit`.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const { searchParams } = new URL(req.url);
  const actorTypeParam = searchParams.get('actorType');
  const actorType = ACTOR_TYPES.includes(actorTypeParam as ActorType)
    ? (actorTypeParam as ActorType)
    : null;

  const limitRaw = Number(searchParams.get('limit'));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT;

  let query = supabase
    .schema('core')
    .from('action_log')
    .select(
      'id, actor_type, actor_user_id, action, summary, subject_table, subject_id, tier, confidence, created_at'
    )
    .eq('org_id', orgId!)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (actorType) query = query.eq('actor_type', actorType);

  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const logRows = (rows ?? []) as LogRow[];

  // Resolve HUMAN actor display names in ONE lookup (no N+1).
  // NOTE: core.users RLS only exposes the caller's own row (self_read), so names
  // for OTHER human actors won't resolve under the RLS client — those fall back
  // to "Team member". See report: an org-scoped read policy on core.users (or a
  // service-scoped name lookup) is needed to attribute other users by name.
  const actorIds = Array.from(
    new Set(
      logRows
        .filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id)
        .map((r) => r.actor_user_id as string)
    )
  );

  const nameById = new Map<string, string>();
  if (actorIds.length > 0) {
    // Resolve display names via the service role: core.users is self_read under
    // RLS, so the user client would only see the viewer's own name. This route is
    // admin-gated and the ids come from org-scoped action_log rows, so a
    // name-only lookup here is safe.
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

  const data: AuditRow[] = logRows.map((r) => {
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
      subjectTable: r.subject_table,
      subjectId: r.subject_id,
      tier: r.tier,
      confidence: r.confidence,
      createdAt: r.created_at,
    };
  });

  return NextResponse.json({ data });
}
