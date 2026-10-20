export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { allOrgLocations, isOrgEmployee } from '@/lib/team/org-locations';
import {
  loadAssignments,
  loadEmployeeNames,
  PORTFOLIO_FUNCTIONS,
  type PortfolioFunction,
} from '@/lib/portfolio/board';

/**
 * Portfolio ownership assignments — who owns which function (close / AR / AP /
 * review) for each entity.
 *
 * GET  → the assignable roster (active employees) + current assignments + an
 *        `available` flag. DEGRADE-SAFE: when the RESERVED core.practice_assignments
 *        table is not present yet, `available` is false, assignments are empty,
 *        and the board still works.
 *
 * PUT  → upsert (or clear) a single (location, function) owner. DEGRADE-SAFE: if
 *        the table is absent the write is a no-op with `{ applied: false }`.
 *
 * RLS-scoped — tenant isolation enforced by the database. Employees + locations
 * live in `core`.
 */

// ── GET ──────────────────────────────────────────────────────────────────────

interface RosterMember {
  employeeId: string;
  name: string;
}

interface AssignmentDTO {
  locationId: string;
  function: PortfolioFunction;
  employeeId: string;
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  // R0b — the roster + owners render on the portfolio board; same read gate as the board.
  const guard = await requirePermission(userId, 'reports', 'view');
  if (!guard.ok) return guard.response;

  const [assignments, empNames] = await Promise.all([
    loadAssignments(supabase),
    loadEmployeeNames(supabase),
  ]);

  const roster: RosterMember[] = [...empNames.entries()]
    .map(([employeeId, name]) => ({ employeeId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const flat: AssignmentDTO[] = [];
  for (const [locationId, fns] of assignments.byLocation) {
    for (const fn of PORTFOLIO_FUNCTIONS) {
      const employeeId = fns.get(fn);
      if (employeeId) flat.push({ locationId, function: fn, employeeId });
    }
  }

  return NextResponse.json({
    available: assignments.available,
    roster,
    assignments: flat,
  });
}

// ── PUT (upsert / clear one owner) ───────────────────────────────────────────

const putSchema = z.object({
  locationId: z.string().uuid(),
  function: z.enum(PORTFOLIO_FUNCTIONS),
  // null clears the owner for that (location, function).
  assigneeEmployeeId: z.string().uuid().nullable(),
});

type PutBody = z.infer<typeof putSchema>;

export const PUT = apiHandler(putSchema, async (body: PutBody, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const { supabase, orgId } = ctx;
  // R0b — assigning who owns close / AR / AP / review for an entity is a close-management
  // action (it routes work and accountability). Fails closed (403).
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage');
  if (!guard.ok) return guard.response;

  // core.practice_assignments is SELECT-only for members (migration 154): writes run
  // as the service role, authorized by close_mgmt:manage above and pinned to the
  // session org. Because the service role bypasses RLS, the client-supplied entity and
  // assignee are confirmed to be THIS org's before anything is written.
  if (!(await allOrgLocations(supabase, orgId, [body.locationId]))) {
    return NextResponse.json({ error: 'Entity not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (body.assigneeEmployeeId !== null && !(await isOrgEmployee(supabase, orgId, body.assigneeEmployeeId))) {
    return NextResponse.json({ error: 'Assignee not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  const admin = createAdminSupabase();

  // Clearing an owner ⇒ delete the row (a null assignee is the "unassigned" state).
  if (body.assigneeEmployeeId === null) {
    const { error } = await admin
      .schema('core')
      .from('practice_assignments')
      .delete()
      .eq('org_id', orgId)
      .eq('location_id', body.locationId)
      .eq('function', body.function);
    if (error) {
      return NextResponse.json(
        { applied: false, reason: 'Assignments table unavailable (apply the migration first).' },
        { status: 200 },
      );
    }
    return NextResponse.json({ applied: true, cleared: true });
  }

  const { error } = await admin
    .schema('core')
    .from('practice_assignments')
    .upsert(
      {
        org_id: orgId,
        location_id: body.locationId,
        function: body.function,
        assignee_employee_id: body.assigneeEmployeeId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,location_id,function' },
    );

  if (error) {
    return NextResponse.json(
      { applied: false, reason: 'Assignments table unavailable (apply the migration first).' },
      { status: 200 },
    );
  }
  return NextResponse.json({ applied: true });
});
