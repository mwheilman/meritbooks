export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { matchCardCharge } from '@/lib/expenses/expense-reports';

const schema = z.object({ bank_transaction_id: z.string().uuid() });

/**
 * POST /api/expenses/lines/[lineId]/match-card — reconcile a line to a corporate
 * -card charge (bank_transaction on a CREDIT_CARD account). No GL post: the card
 * charge already booked DR expense / CR Credit Card Payable in the feed; this only
 * flags the line CORPORATE_CARD so it is not also reimbursed.
 */
export async function POST(request: Request, { params }: { params: { lineId: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'bank_transaction_id is required' }, { status: 422 });

  try {
    const res = await matchCardCharge(supabase, orgId, params.lineId, parsed.data.bank_transaction_id);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to match card charge' }, { status: 400 });
  }
}
