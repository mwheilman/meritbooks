export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { PostingError } from '@/lib/posting/account-roles';
import { postProposedMovement } from '@/lib/inventory/inventory-service';

/**
 * POST /api/inventory/movements/[id]/approve — the HUMAN GATE. Approves a PROPOSED
 * ISSUE/ADJUST and posts the balanced entry BY ROLE (DR COGS / CR Inventory Asset,
 * or the reverse for a write-up). Gated on 'journal_entries' post — the same
 * permission any GL posting requires, so COGS posting can't route around the ledger's
 * authorization (separation of duties from item creation).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  try {
    const result = await postProposedMovement(supabase, orgId, params.id, { postedBy: userId });
    await logHumanAction(supabase, userId, orgId, {
      action: 'inventory_movement.post',
      subjectTable: 'inventory_movements',
      subjectId: params.id,
      summary: `Posted inventory movement — COGS ${(result.cogs_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (GL ${result.gl_entry_id ?? 'n/a'})`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Post failed', code: 'POST_ERROR' },
      { status },
    );
  }
}
