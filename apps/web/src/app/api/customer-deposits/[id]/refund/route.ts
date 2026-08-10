export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';
import { refundDeposit } from '@/lib/customer-deposits/service';

/**
 * POST /api/customer-deposits/[id]/refund
 * Refund the UNAPPLIED remainder: DR Customer Deposits (2420) / CR Cash, mark the
 * deposit REFUNDED. Guarded against double-refund by optimistic concurrency.
 *
 * Authorization: paying customer cash back out is an approval-level act — gated on
 * `invoices:approve` (reuses the AR-approval gate; no new permission invented).
 */
const refundSchema = z
  .object({
    refund_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    rail: z.enum(['cash', 'check', 'ach', 'wire', 'debit_card']).optional(),
  })
  .optional();

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId, orgId: claimOrgId } = authResult;

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = refundSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  try {
    const supabase = createAdminSupabase();
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const result = await refundDeposit(supabase, {
      orgId,
      actor: userId,
      depositId: params.id,
      refundDate: parsed.data?.refund_date,
      rail: parsed.data?.rail,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'REFUND_ERROR' }, { status: 422 });
    }
    console.error('[customer-deposits refund]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
