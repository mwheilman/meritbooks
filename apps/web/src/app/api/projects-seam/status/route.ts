export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadSeamStatus } from '@/lib/projects-seam/status';

/**
 * GET /api/projects-seam/status?location_id= — the Books side of the Merit Projects seam:
 * messages waiting / rejected by type, commitments and matched bills, bills on a commitment
 * payment hold, 3-way warnings, labor hours awaiting payroll and the payroll allocations.
 * jobs:view. RLS-scoped. Returns projectsEnabled=false (and nothing else) for Books-only orgs.
 */
const q = z.object({ location_id: z.string().uuid().optional() });

export const GET = apiQueryHandler(q, async (p, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'jobs', 'view', { route: '/api/projects-seam/status' });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await loadSeamStatus(supabase, orgId, { locationId: p.location_id ?? null }));
});
