import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadTeamDirectory, rolesAt } from '@/components/settings/team-data';
import type { TeamSlot } from './team-slots';

export interface JobTeamMember {
  membershipId: string;
  slot: TeamSlot;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface TeamCandidate {
  membershipId: string;
  label: string;
}

export interface JobTeam {
  members: JobTeamMember[];
  /** People who can be added (only loaded for callers with projects.team:edit). */
  candidates: TeamCandidate[];
  error: string | null;
}

/** pm.v_job_team for one job (RLS class J), plus who can be added when the caller edits teams. */
export async function loadJobTeam(
  db: SupabaseClient,
  jobId: string,
  edit: { clerkUserId: string; companyId: string } | null,
): Promise<JobTeam> {
  const [res, dir] = await Promise.all([
    db.schema('pm').from('v_job_team').select('membership_id, slot, display_name, email, role_name').eq('job_id', jobId).order('slot'),
    edit ? loadTeamDirectory(db, edit.clerkUserId) : Promise.resolve(null),
  ]);
  if (res.error) return { members: [], candidates: [], error: 'We couldn’t load the team on this job.' };
  const members = ((res.data ?? []) as Array<{ membership_id: string; slot: TeamSlot; display_name: string | null; email: string | null; role_name: string | null }>).map((r) => ({
    membershipId: r.membership_id, slot: r.slot, name: r.display_name, email: r.email, role: r.role_name,
  }));
  const onTeam = new Set(members.map((m) => m.membershipId));
  const candidates: TeamCandidate[] = dir && edit
    ? dir.members
        .filter((m) => !onTeam.has(m.membershipId) && m.status === 'active' && rolesAt(m, edit.companyId).length > 0)
        .map((m) => ({
          membershipId: m.membershipId,
          label: `${m.name ?? m.email ?? 'Team member'} · ${rolesAt(m, edit.companyId).map((r) => r.title).join(', ')}`,
        }))
    : [];
  return { members, candidates, error: null };
}
