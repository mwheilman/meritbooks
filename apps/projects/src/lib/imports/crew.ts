/**
 * "Bring your crew" (UX step 8): role chips are the pack's own titles (manifest v2 `roles`, e.g.
 * "Technician" → projects_labor in field service, "Superintendent" → projects_supervisor in
 * commercial); each person is pre-filled from the imported employees and Books' team with the chip
 * that best fits their title. Field roles (crew, supervisor) are Projects-only seats by default —
 * they get Projects and nothing in Books. Pure.
 */
import { normName } from '../onboarding/import/values';

export interface RoleChip {
  title: string;
  roleKey: string;
  projectsOnly: boolean;
}

export interface CrewPerson {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  roleKey: string | null;
  projectsOnly: boolean;
  source: 'import' | 'books_team' | 'manual';
  importRowId: string | null;
  employeeId: string | null;
}

export const FIELD_ROLES = new Set(['projects_labor', 'projects_supervisor']);
const INVITABLE = new Set(['projects_gm', 'projects_office_manager', 'projects_project_accountant', 'projects_dispatcher', 'projects_purchasing',
  'projects_pm', 'projects_supervisor', 'projects_labor', 'projects_sales']);

const FALLBACK_TITLES: Record<string, string> = {
  projects_gm: 'General manager', projects_office_manager: 'Office manager', projects_project_accountant: 'Bookkeeper', projects_dispatcher: 'Scheduler',
  projects_purchasing: 'Purchasing', projects_pm: 'Project manager', projects_supervisor: 'Lead', projects_labor: 'Crew member', projects_sales: 'Estimator',
};

/** Chips from the pack's titles (owner excluded), one per title, in pack order; a fallback per role when the pack has none. */
export function roleChips(roles: readonly { title: string; template: string }[] | null | undefined): RoleChip[] {
  const out: RoleChip[] = [];
  const seen = new Set<string>();
  for (const r of roles ?? []) {
    if (!INVITABLE.has(r.template) || seen.has(r.title.toLowerCase())) continue;
    seen.add(r.title.toLowerCase());
    out.push({ title: r.title, roleKey: r.template, projectsOnly: FIELD_ROLES.has(r.template) });
  }
  for (const [roleKey, title] of Object.entries(FALLBACK_TITLES)) {
    if (!out.some((c) => c.roleKey === roleKey)) out.push({ title, roleKey, projectsOnly: FIELD_ROLES.has(roleKey) });
  }
  return out;
}

const KEYWORDS: [RegExp, string][] = [
  [/\b(gm|general manager|operations manager|ops manager|vice president|vp)\b/, 'projects_gm'],
  [/\b(bookkeeper|accountant|accounting|controller|ar|ap|billing)\b/, 'projects_project_accountant'],
  [/\b(dispatch|dispatcher|csr|customer service|scheduler|coordinator|service writer)\b/, 'projects_dispatcher'],
  [/\b(purchasing|buyer|procurement|parts manager|parts counter)\b/, 'projects_purchasing'],
  [/\b(office|admin|administrator|receptionist)\b/, 'projects_office_manager'],
  [/\b(estimator|sales|salesperson|comfort advisor|designer|account manager)\b/, 'projects_sales'],
  [/\b(project manager|pm|project executive|production manager)\b/, 'projects_pm'],
  [/\b(lead|foreman|superintendent|super|crew lead|crew leader|service manager|shop foreman|supervisor)\b/, 'projects_supervisor'],
  [/\b(tech|technician|installer|plumber|electrician|carpenter|laborer|crew|apprentice|helper|mechanic|field|journeyman)\b/, 'projects_labor'],
];

/** The chip a person's title / team points at (exact pack title first, then keywords). */
export function suggestRole(title: string | null, hint: string | null, chips: RoleChip[]): RoleChip | null {
  const t = normName(title ?? '');
  const exact = chips.find((c) => normName(c.title) === t && t !== '');
  if (exact) return exact;
  for (const text of [t, normName(hint ?? '')]) {
    if (!text) continue;
    for (const [re, roleKey] of KEYWORDS) if (re.test(text)) return chips.find((c) => c.roleKey === roleKey) ?? null;
  }
  return null;
}

/** Imported employees + Books' team → one list (deduped by email, then by name). */
export function crewList(input: {
  roster: { id: string; data: Record<string, unknown> }[];
  team: { id: string; name: string; email: string | null; title: string | null; role: string | null }[];
  chips: RoleChip[];
}): CrewPerson[] {
  const out: CrewPerson[] = [];
  const byEmail = new Map<string, CrewPerson>();
  const byName = new Map<string, CrewPerson>();
  const add = (p: CrewPerson) => {
    const e = p.email?.toLowerCase() ?? null;
    const existing = (e && byEmail.get(e)) || byName.get(normName(p.name));
    if (existing) {
      existing.phone ??= p.phone;
      existing.title ??= p.title;
      existing.email ??= p.email;
      existing.employeeId ??= p.employeeId;
      return;
    }
    out.push(p);
    if (e) byEmail.set(e, p);
    byName.set(normName(p.name), p);
  };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  for (const t of input.team) {
    const chip = suggestRole(t.title, t.role, input.chips);
    add({ key: `team:${t.id}`, name: t.name, email: t.email, phone: null, title: t.title, roleKey: chip?.roleKey ?? null, projectsOnly: chip?.projectsOnly ?? false, source: 'books_team', importRowId: null, employeeId: t.id });
  }
  for (const r of input.roster) {
    const name = str(r.data.name) ?? [str(r.data.first_name), str(r.data.last_name)].filter(Boolean).join(' ');
    if (!name) continue;
    const chip = suggestRole(str(r.data.title), str(r.data.role_hint), input.chips);
    add({ key: `import:${r.id}`, name, email: str(r.data.email), phone: str(r.data.phone), title: str(r.data.title), roleKey: chip?.roleKey ?? null, projectsOnly: chip?.projectsOnly ?? false, source: 'import', importRowId: r.id, employeeId: null });
  }
  return out;
}
