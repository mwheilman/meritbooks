export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * A single purchase order with its lines, goods receipts, and bill links + match
 * results. PATCH changes status (issue a DRAFT → OPEN, CANCEL an open PO, or CLOSE
 * a fully-received one). RLS-scoped; never moves money.
 */

const patchSchema = z.object({
  status: z.enum(['DRAFT', 'OPEN', 'PARTIAL', 'CLOSED', 'CANCELLED']),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { data: po, error } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, vendor_id, location_id, status, order_date, expected_date, memo, subtotal_cents, tax_cents, total_cents, received_total_cents, billed_total_cents, created_at',
    )
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'PO_FETCH_FAILED' }, { status: 500 });
  if (!po) return NextResponse.json({ error: 'Purchase order not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data: lines } = await supabase
    .from('purchase_order_lines')
    .select(
      'id, line_number, description, account_id, item_id, department_id, job_id, quantity, unit_cost_cents, amount_cents, received_qty, billed_qty',
    )
    .eq('po_id', po.id)
    .order('line_number');

  const { data: receipts } = await supabase
    .from('goods_receipts')
    .select('id, receipt_number, received_date, received_by_user, notes, created_at')
    .eq('po_id', po.id)
    .order('received_date', { ascending: false });

  const { data: links } = await supabase
    .from('bill_po_links')
    .select('id, bill_id, match_status, match_result, exception_decision_id, matched_by_user, matched_at, created_at')
    .eq('po_id', po.id)
    .order('created_at', { ascending: false });

  // Stitch vendor name + account numbers from core/public.
  let vendorName = 'Unknown vendor';
  {
    const { data: v } = await supabase
      .schema('core')
      .from('vendors')
      .select('name, display_name')
      .eq('id', po.vendor_id)
      .maybeSingle();
    if (v) vendorName = (v.display_name as string) || (v.name as string);
  }
  const acctIds = [...new Set((lines ?? []).map((l) => l.account_id).filter(Boolean))] as string[];
  const acctById = new Map<string, { number: string; name: string }>();
  if (acctIds.length > 0) {
    const { data: accts } = await supabase
      .from('accounts')
      .select('id, account_number, name')
      .in('id', acctIds);
    for (const a of (accts ?? []) as Array<{ id: string; account_number: string; name: string }>) {
      acctById.set(a.id, { number: a.account_number, name: a.name });
    }
  }

  return NextResponse.json({
    purchase_order: { ...po, vendor_name: vendorName },
    lines: (lines ?? []).map((l) => ({
      ...l,
      account_number: l.account_id ? acctById.get(l.account_id as string)?.number ?? null : null,
      account_name: l.account_id ? acctById.get(l.account_id as string)?.name ?? null : null,
    })),
    receipts: receipts ?? [],
    bill_links: links ?? [],
  });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  const { data: updated, error } = await supabase
    .from('purchase_orders')
    .update({ status: parsed.data.status })
    .eq('id', params.id)
    .select('id, po_number, status')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'PO_UPDATE_FAILED' }, { status: 500 });
  if (!updated) return NextResponse.json({ error: 'Purchase order not found', code: 'NOT_FOUND' }, { status: 404 });

  await logHumanAction(supabase, userId, orgId, {
    action: 'purchase_order.status_change',
    subjectTable: 'purchase_orders',
    subjectId: params.id,
    summary: `${updated.po_number} → ${parsed.data.status}`,
  });

  return NextResponse.json({ purchase_order_id: updated.id, status: updated.status });
}
