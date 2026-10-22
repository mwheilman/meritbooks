export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { serviceWriter } from '@/lib/db/scoped-writer';

/**
 * DELETE /api/tax/filings/[id] — un-mark a sales-tax filing (removes the FILED/REMITTED
 * record, returning the period to unfiled/owed on the calendar). Hard delete: a filing
 * record carries no GL side (no remittance JE is posted here), so removing it is safe
 * and reversible. RLS org isolation + settings_acct:edit.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  // sales_tax_filings is SELECT-only for members (migration 172): service-role delete after
  // the settings_acct:edit check, org pinned (org-level table — no client scope).
  const { error } = await serviceWriter()
    .from('sales_tax_filings')
    .delete()
    .eq('id', params.id)
    .eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
