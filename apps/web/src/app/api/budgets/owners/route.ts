export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError } from '@/lib/budgets/route-support';
import { loadDepartments, loadOwnerEmails, loadOwners } from '@/lib/budgets/service/data';
import { canAssignOwners, ownerCandidates, setOwner } from '@/lib/budgets/service/plans';
import { canSeeDepartment } from '@/lib/budgets/scope';
import { ownersQuery, setOwnerSchema } from '@/lib/validations/budgets';

/**
 * GET /api/budgets/owners?location_id — departments with their standing budget owner, and (budget
 *     admins: fpa.budgets:approve / close_mgmt:manage) owner emails + the people who can own one.
 * PUT — assign or clear a department's owner (budget admins). Open draft versions pick it up.
 */
export const GET = apiQueryHandler(ownersQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const [departments, owners] = await Promise.all([loadDepartments(b.reader, q.location_id, b.orgId), loadOwners(b.reader, b.orgId)]);
    // Assigning owners (and seeing their emails / the member directory) is a budget-admin act.
    const admin = canAssignOwners(b);
    const visible = owners.filter((o) => canSeeDepartment(b.access, o.departmentId));
    const emails = admin ? await loadOwnerEmails(b, visible.map((o) => o.departmentId)) : new Map<string, string>();
    return NextResponse.json({
      departments: departments.filter((d) => canSeeDepartment(b.access, d.id)),
      owners: visible.map((o) => (admin ? { ...o, ownerEmail: emails.get(o.departmentId) ?? null } : o)),
      candidates: admin ? await ownerCandidates(b) : [],
      canAssign: admin,
    });
  } catch (e) {
    return budgetError(e, 'owners GET');
  }
});

export const PUT = apiHandler(setOwnerSchema, async (i, ctx) => {
  const b = await budgetCtx(ctx, i.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const depts = await loadDepartments(b.reader, i.location_id, b.orgId);
    if (!depts.some((d) => d.id === i.department_id)) return NextResponse.json({ error: 'That department is not part of this company.', code: 'VALIDATION_ERROR' }, { status: 422 });
    await setOwner(b, i.department_id, i.location_id, i.owner_user_id ? { userId: i.owner_user_id, name: i.owner_name ?? null, email: i.owner_email ?? null } : null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return budgetError(e, 'owners PUT');
  }
});
