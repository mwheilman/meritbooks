export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';
import { applyCashApplicationProposal } from '@/lib/controls/cash-application';

/**
 * POST /api/cash-application/apply
 *
 * A human APPROVES a cash-application proposal (feature 'CASH_APPLICATION'), and
 * the payment is applied through the EXISTING gated customer-payment path
 * (recordCustomerPayment → DR Cash / CR AR, reduce each invoice balance). The AI
 * never moves money (canon §3); this only records receipt of a deposit already in
 * the bank feed. No parallel posting path — it delegates to lib/posting/lifecycle.
 *
 * Body:
 *   { proposal_id: uuid,
 *     applications?: [{ invoice_id: uuid, amount_cents: int>0 }] }  // human adjust
 * When `applications` is omitted the proposal's own invoices are applied at their
 * full live balance. Supports single, sum-to-total, and partial application.
 *
 * Double-post safety: the deposit must be UNPOSTED and the proposal is atomically
 * claimed PROPOSED→APPROVED before posting (see applyCashApplicationProposal).
 *
 * Authorization: applying customer cash to AR is an AR approval act — gated on
 * invoices:approve (the same permission the cash-application SCAN route uses).
 * NOTE(NEEDS CENTRAL): there is still no dedicated payments/cash-application
 * permission in rbac/permissions.ts (task #33/#53); this reuses the AR-approve
 * permission as the closest fit — see the report.
 */

const applySchema = z.object({
  proposal_id: z.string().uuid(),
  applications: z
    .array(
      z.object({
        invoice_id: z.string().uuid(),
        amount_cents: z.number().int().min(1),
      }),
    )
    .min(1)
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
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

    const result = await applyCashApplicationProposal(supabase, {
      orgId,
      userId,
      proposalId: parsed.data.proposal_id,
      applications: parsed.data.applications?.map((a) => ({
        invoiceId: a.invoice_id,
        amountCents: a.amount_cents,
      })),
    });

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'APPLY_ERROR' }, { status: 422 });
    }
    console.error('[cash-application/apply]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
