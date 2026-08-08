export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createServerSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

/**
 * PATCH a single entity's accounting config — the per-entity fiscal-year start
 * (the report compiler + fiscal-period engine key off it), default rev-rec
 * method, and active flag. RLS-scoped; gated on `settings_acct:edit`.
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

  const supabase = await createServerSupabase();

  // RLS also enforces org isolation; the explicit org_id filter is defense-in-depth.
  const { error } = await supabase
    .schema('core').from('locations')
    .update(parsed.data)
    .eq('id', params.id)
    .eq('org_id', orgId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
