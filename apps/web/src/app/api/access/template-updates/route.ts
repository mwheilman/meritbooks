export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { resolveGovActor } from '@/lib/access-governance/server';
import { describeSuggestion } from '@/lib/access-governance/describe';
import type { RoleSuggestion, SuggestionChange } from '@/lib/access-governance/types';

/**
 * GET /api/access/template-updates — open MeritBooks suggestions for roles that came from a
 * MeritBooks standard role (05-RBAC-SPEC §1.7, §6.1, §6.10). RLS limits rows to tenant
 * admins and holders of core.access.roles:view. Each change is one plain-English sentence;
 * no template or version language reaches the screen.
 */

interface UpdateRow {
  id: string;
  derived_role_id: string;
  status: 'available' | 'partially_adopted';
  changes: SuggestionChange[];
  decisions: Record<string, 'added' | 'skipped'>;
  note_dismissed_at: string | null;
  created_at: string;
}

export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await ctx.supabase
    .schema('core')
    .from('template_updates')
    .select('id, derived_role_id, status, changes, decisions, note_dismissed_at, created_at')
    .eq('org_id', actor.orgId)
    .is('decided_at', null)
    .in('status', ['available', 'partially_adopted'])
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  const rows = (data ?? []) as UpdateRow[];
  if (!rows.length) return NextResponse.json({ data: { suggestions: [], noteVisible: false } });

  const roleIds = [...new Set(rows.map((r) => r.derived_role_id))];
  const [roles, holders] = await Promise.all([
    ctx.supabase.schema('core').from('role_definitions').select('id, name').in('id', roleIds),
    ctx.supabase
      .schema('core')
      .from('access_assignments')
      .select('role_id, membership_id')
      .eq('org_id', actor.orgId)
      .eq('status', 'active')
      .in('role_id', roleIds),
  ]);
  const roleName = new Map(((roles.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  const holderSets = new Map<string, Set<string>>();
  for (const h of (holders.data ?? []) as Array<{ role_id: string; membership_id: string }>) {
    const s = holderSets.get(h.role_id) ?? new Set<string>();
    s.add(h.membership_id);
    holderSets.set(h.role_id, s);
  }

  const suggestions: RoleSuggestion[] = rows.map((r) => ({
    id: r.id,
    roleId: r.derived_role_id,
    roleName: roleName.get(r.derived_role_id) ?? 'A role',
    holders: holderSets.get(r.derived_role_id)?.size ?? 0,
    status: r.status,
    noteDismissed: r.note_dismissed_at !== null,
    createdAt: r.created_at,
    changes: (Array.isArray(r.changes) ? r.changes : []).map((c) => ({
      ...c,
      sentence: describeSuggestion(c),
      decision: r.decisions?.[c.id] ?? null,
    })),
  }));
  return NextResponse.json({
    data: { suggestions, noteVisible: suggestions.some((s) => !s.noteDismissed && s.changes.some((c) => c.decision === null)) },
  });
});
