export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { hasModule } from '@/lib/services/entitlements';
import { listCommitmentOptions } from '@/lib/projects-seam/commitment-match';

/**
 * GET /api/ap/commitments?vendor_id=&job_id=&location_id= — the open Merit Projects commitments
 * (job POs / subcontracts, JOB_COMMITMENT → migration 194) a vendor bill can be matched to, with
 * committed, received, billed and remaining amounts per line. What bill entry / intake shows as the
 * match suggestions. Empty for orgs that do not use Projects. bills:view; RLS-scoped reads.
 */
const q = z.object({
  vendor_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
});

export const GET = apiQueryHandler(q, async (p, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'bills', 'view', { route: '/api/ap/commitments' });
  if (!guard.ok) return guard.response;
  const projects = await hasModule(supabase, orgId, 'projects').catch(() => false);
  if (!projects) return NextResponse.json({ projects: false, commitments: [] });
  try {
    const commitments = await listCommitmentOptions(supabase, orgId, { vendorId: p.vendor_id, jobId: p.job_id ?? null, locationId: p.location_id ?? null });
    return NextResponse.json({ projects: true, commitments });
  } catch (e) {
    console.error('[ap/commitments]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load the open commitments. Please try again.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
});
