export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAuthedContext } from '@/lib/api-handler';
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
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

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

  // Clearing an owner ⇒ delete the row (a null assignee is the "unassigned" state).
  if (body.assigneeEmployeeId === null) {
    const { error } = await supabase
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

  const { error } = await supabase
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
