export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';

/**
 * PATCH a single entity's accounting config — the per-entity fiscal-year start
 * (the report compiler + fiscal-period engine key off it), default rev-rec
 * method, and active flag. Gated on `settings_acct:edit`; written with the service
 * role pinned to the session org (core.locations is not member-writable — mig 167).
 */

const REV_REC_METHODS = [
  'POINT_OF_SALE', 'AS_BILLED', 'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT',
  'MILESTONE', 'RATABLY', 'SUBSCRIPTION', 'CASH',
] as const;

const updateSchema = z.object({
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  rev_rec_method: z.enum(REV_REC_METHODS).optional(),
  is_active: z.boolean().optional(),
  industry: z.string().max(100).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';

  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });
  }

  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // M4 (migration 167): service-role write AFTER the permission check above; the
  // org_id filter is what keeps it inside the caller's tenant.
  const { data, error } = await createAdminSupabase()
    .schema('core').from('locations')
    .update(parsed.data)
    .eq('id', params.id)
    .eq('org_id', orgId)
    .select('id');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  return NextResponse.json({ success: true });
}
