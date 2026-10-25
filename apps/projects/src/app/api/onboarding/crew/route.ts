export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { crewList, roleChips } from '@/lib/imports/crew';
import { inviteCrew, listInvites, rosterRows } from '@/lib/imports/server';
import { teamMembers } from '@/lib/onboarding/load';
import { getCompanyExperience } from '@/lib/packs/experience-server';

const Query = z.object({ companyId: z.string().uuid() });
const Person = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254).nullable(),
  phone: z.string().trim().max(40).nullable(),
  title: z.string().trim().max(80).nullable(),
  roleKey: z.string().regex(/^projects_[a-z_]+$/),
  projectsOnly: z.boolean(),
  source: z.enum(['import', 'books_team', 'manual']),
  importRowId: z.string().uuid().nullish(),
  employeeId: z.string().uuid().nullish(),
}).refine((p) => p.email || p.phone, { message: 'Add an email or a mobile number' });
const Body = z.object({ companyId: z.string().uuid(), people: z.array(Person).min(1).max(200) });

/** GET /api/onboarding/crew?companyId — role chips from the pack's titles, pre-filled people, invites so far. */
export const GET = route({ access: { cap: 'projects.team', action: 'edit' }, query: Query, mask: false }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  const [exp, roster, team, invites] = await Promise.all([
    getCompanyExperience(db, query.companyId), rosterRows(db, query.companyId), teamMembers(db), listInvites(db, query.companyId),
  ]);
  const chips = roleChips(exp?.experience.roles);
  return { chips, people: crewList({ roster, team, chips }), invites };
});

/**
 * POST /api/onboarding/crew — record the invites (pm.onboarding_invite_crew). A person already in
 * the workspace gets the role now; everyone else gets it the moment their seat appears (the 1121
 * claim trigger). The sign-in invitation itself is sent by Merit Books' team invite.
 */
export const POST = route({ access: { cap: 'projects.team', action: 'edit' }, body: Body, mask: false }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const out = await inviteCrew(db, body.companyId, body.people.map((p) => ({
    name: p.name, email: p.email, phone: p.phone, title: p.title, role_key: p.roleKey, projects_only: p.projectsOnly, source: p.source,
    import_row_id: p.importRowId ?? null, employee_id: p.employeeId ?? null,
  })));
  return { invites: out, accepted: out.filter((i) => i.status === 'ACCEPTED').length, pending: out.filter((i) => i.status === 'PENDING').length };
});
