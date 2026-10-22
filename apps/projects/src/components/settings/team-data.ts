import 'server-only';
/**
 * Who is on the team, and with which Projects role, read on the caller's RLS client (no service
 * role). Source: pm.v_company_team (1110) — one row per (company × member × Projects role or set)
 * for companies where the caller holds projects.team:view, with the member's name and email.
 * core.memberships (org-readable) adds everyone else in the workspace, their status, Books role
 * and the opt-in projects_only flag.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PERSONAS, type PersonaKey } from '@/lib/access/types';
import { PERSONA_LABEL } from '@/lib/access/templates';

export interface MemberRole {
  /** The persona template the role comes from; null for a Projects permission set. */
  persona: PersonaKey | null;
  /** The tenant role's own name ("Service manager"), else the persona name. */
  title: string;
  /** Company ids the role covers. */
  companies: ReadonlyArray<string>;
}

export interface Member {
  membershipId: string;
  name: string | null;
  email: string | null;
  /** The Books membership role (owner, admin, …). */
  booksRole: string;
  status: string;
  isMe: boolean;
  /** Owner / admin seats always keep Merit Books access (pm.set_projects_only refuses them). */
  isAdminSeat: boolean;
  /** core.memberships.projects_only: this seat sees no Merit Books data. null = flag not readable. */
  projectsOnly: boolean | null;
  roles: MemberRole[];
}

export interface TeamDirectory {
  members: Member[];
  /** Set when a read failed: show it, never an empty team. */
  error: string | null;
}

const PERSONA_SET: ReadonlySet<string> = new Set(PERSONAS);
const ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'org_admin', 'company_admin']);

/** Same rule as core.rbac_normalize_legacy_role(...) = 'company_admin'. */
export function isAdminSeatRole(role: string | null | undefined): boolean {
  return ADMIN_ROLES.has((role ?? '').trim().toLowerCase().replace(/^org:/, ''));
}

interface MembershipRow { id: string; user_id: string; role: string; status: string; projects_only?: boolean }
interface CompanyTeamRow {
  location_id: string;
  membership_id: string;
  display_name: string | null;
  email: string | null;
  membership_role: string | null;
  role_key: string | null;
  role_name: string | null;
}

export async function loadTeamDirectory(db: SupabaseClient, clerkUserId: string): Promise<TeamDirectory> {
  const core = db.schema('core');
  const memberships = async (): Promise<{ rows: MembershipRow[]; flag: boolean } | null> => {
    const withFlag = await core.from('memberships').select('id, user_id, role, status, projects_only').in('status', ['active', 'invited']).limit(2000);
    if (!withFlag.error) return { rows: (withFlag.data ?? []) as MembershipRow[], flag: true };
    // Before 1110 is applied the column does not exist: list the team without the flag.
    const plain = await core.from('memberships').select('id, user_id, role, status').in('status', ['active', 'invited']).limit(2000);
    return plain.error ? null : { rows: (plain.data ?? []) as MembershipRow[], flag: false };
  };
  const [mRes, tRes, meRes] = await Promise.all([
    memberships(),
    db.schema('pm').from('v_company_team').select('location_id, membership_id, display_name, email, membership_role, role_key, role_name').limit(10000),
    core.from('users').select('id, first_name, last_name, email').eq('clerk_user_id', clerkUserId).maybeSingle(),
  ]);
  if (!mRes || tRes.error) return { members: [], error: 'We couldn’t load the team. Try again; if it repeats, tell support.' };

  const names = new Map<string, { name: string | null; email: string | null }>();
  const roles = new Map<string, Map<string, MemberRole>>();
  for (const t of (tRes.data ?? []) as CompanyTeamRow[]) {
    if (!names.has(t.membership_id)) names.set(t.membership_id, { name: t.display_name, email: t.email });
    if (!t.role_key) continue;
    const persona = PERSONA_SET.has(t.role_key) ? (t.role_key as PersonaKey) : null;
    const byKey = roles.get(t.membership_id) ?? new Map<string, MemberRole>();
    const r = byKey.get(t.role_key) ?? { persona, title: t.role_name || (persona ? PERSONA_LABEL[persona] : t.role_key), companies: [] };
    if (!r.companies.includes(t.location_id)) r.companies = [...r.companies, t.location_id];
    byKey.set(t.role_key, r);
    roles.set(t.membership_id, byKey);
  }
  const me = meRes.error ? null : (meRes.data as { id: string; first_name: string | null; last_name: string | null; email: string | null } | null);

  const members: Member[] = mRes.rows.map((m) => {
    const isMe = !!me && m.user_id === me.id;
    const n = names.get(m.id);
    const myName = isMe && me ? [me.first_name, me.last_name].filter(Boolean).join(' ') || null : null;
    return {
      membershipId: m.id,
      name: n?.name ?? myName,
      email: n?.email ?? (isMe ? me?.email ?? null : null),
      booksRole: m.role,
      status: m.status,
      isMe,
      isAdminSeat: isAdminSeatRole(m.role),
      projectsOnly: mRes.flag ? !!m.projects_only : null,
      roles: [...(roles.get(m.id)?.values() ?? [])],
    };
  });
  members.sort((a, b) => Number(b.isMe) - Number(a.isMe) || (a.name ?? '~').localeCompare(b.name ?? '~'));
  return { members, error: null };
}

/** The member's Projects roles at this company. */
export function rolesAt(m: Member, companyId: string): MemberRole[] {
  return m.roles.filter((r) => r.companies.includes(companyId));
}
