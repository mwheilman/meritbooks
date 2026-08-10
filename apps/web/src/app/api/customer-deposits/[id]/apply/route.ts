export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';
import { applyDeposit } from '@/lib/customer-deposits/service';

/**
 * POST /api/customer-deposits/[id]/apply
 * Draw a deposit down against an open invoice: DR Customer Deposits (2420) / CR
 * A/R for the applied amount, advance the invoice, increment applied_cents (never
 * exceeding amount_cents — guarded in code + DB CHECK + optimistic concurrency).
 *
 * Authorization: applying customer cash to AR is an AR approval act — gated on
 * `invoices:approve` (the same permission the cash-application apply path uses).
 */
const applySchema = z.object({
  invoice_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
});

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId, orgId: claimOrgId } = authResult;

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = applySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  try {
    const supabase = createAdminSupabase();
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const result = await applyDeposit(supabase, {
      orgId,
      actor: userId,
      depositId: params.id,
      invoiceId: parsed.data.invoice_id,
      amountCents: parsed.data.amount_cents,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'APPLY_ERROR' }, { status: 422 });
    }
    console.error('[customer-deposits apply]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
