export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getRun } from '@/lib/agents/runner';

/**
 * GET /api/agents/[id] — one run with its full step timeline.
 * RBAC: bills:view. Returns 404 when the run is absent (or the tables don't exist).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'view');
  if (!guard.ok) return guard.response;

  const run = await getRun({ supabase, orgId, userId, locationId: null }, params.id);
  if (!run) return NextResponse.json({ error: 'Run not found', code: 'NOT_FOUND' }, { status: 404 });

  return NextResponse.json({ data: run });
}
