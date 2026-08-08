export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * DELETE /api/tax/filings/[id] — un-mark a sales-tax filing (removes the FILED/REMITTED
 * record, returning the period to unfiled/owed on the calendar). Hard delete: a filing
 * record carries no GL side (no remittance JE is posted here), so removing it is safe
 * and reversible. RLS org isolation + settings_acct:edit.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const { error } = await supabase
    .from('sales_tax_filings')
    .delete()
    .eq('id', params.id)
    .eq('org_id', orgId ?? '');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
