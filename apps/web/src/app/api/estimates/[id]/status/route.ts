export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { canSetStatus, MANUAL_STATUSES } from '@/lib/estimates/estimate-logic';

/**
 * POST /api/estimates/[id]/status — mark an estimate SENT / ACCEPTED / DECLINED /
 * EXPIRED. CONVERTED is never reachable here (only the convert path sets it), and
 * a CONVERTED estimate is locked. The pure `canSetStatus` guard is the rule.
 */
const schema = z.object({
  status: z.enum(MANUAL_STATUSES as unknown as [string, ...string[]]),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }
  const supabase = createAdminSupabase();

  const { data: est } = await supabase
    .from('estimates')
    .select('id, status, converted_invoice_id')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const decision = canSetStatus(est.status as string, parsed.data.status);
  if (!decision.ok) return NextResponse.json({ error: decision.reason }, { status: 409 });

  const { error } = await supabase
    .from('estimates')
    .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', params.id)
    .neq('status', 'CONVERTED');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: parsed.data.status });
}
