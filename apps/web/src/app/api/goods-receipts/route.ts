export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * Record a GOODS RECEIPT against a purchase order (the "received" leg of the 3-way
 * match). Each line advances the PO line's cumulative received_qty and the PO's
 * received-value roll-up; the PO transitions OPEN → PARTIAL → CLOSED as receipts
 * accumulate. RLS-scoped; posts nothing to the ledger (receiving is not a GL event
 * in this build — the bill is what posts).
 */

const receiptLineSchema = z.object({
  po_line_id: z.string().uuid(),
  quantity_received: z.number().nonnegative(),
});

const createSchema = z.object({
  po_id: z.string().uuid(),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receipt_number: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(receiptLineSchema).min(1, 'A receipt needs at least one line.'),
});
type CreateBody = z.infer<typeof createSchema>;

export async function POST(request: Request) {
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
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_root';
      (details[path] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }
  const body: CreateBody = parsed.data;

  // Load the PO + its lines (RLS enforces org).
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, status, po_number')
    .eq('id', body.po_id)
    .maybeSingle();
  if (!po) return NextResponse.json({ error: 'Purchase order not found', code: 'NOT_FOUND' }, { status: 404 });
  if (po.status === 'CANCELLED') {
    return NextResponse.json({ error: 'Cannot receive against a cancelled PO.', code: 'PO_CANCELLED' }, { status: 409 });
  }

  const { data: poLines } = await supabase
    .from('purchase_order_lines')
    .select('id, quantity, unit_cost_cents, received_qty')
    .eq('po_id', po.id);
  const lineById = new Map(
    (poLines ?? []).map((l) => [
      l.id as string,
      { quantity: Number(l.quantity), unitCost: Number(l.unit_cost_cents), received: Number(l.received_qty) },
    ]),
  );

  // Validate every receipt line references a line on THIS PO.
  for (const rl of body.lines) {
    if (!lineById.has(rl.po_line_id)) {
      return NextResponse.json(
        { error: 'A receipt line references a line that is not on this PO.', code: 'BAD_PO_LINE' },
        { status: 422 },
      );
    }
  }

  const receivedDate = body.received_date ?? new Date().toISOString().slice(0, 10);
  const { data: receipt, error: rErr } = await supabase
    .from('goods_receipts')
    .insert({
      org_id: orgId,
      po_id: po.id,
      receipt_number: body.receipt_number ?? null,
      received_date: receivedDate,
      received_by_user: userId,
      notes: body.notes ?? null,
      created_by: null,
    })
    .select('id')
    .single();
  if (rErr || !receipt) {
    return NextResponse.json({ error: rErr?.message ?? 'Failed to create receipt', code: 'RECEIPT_FAILED' }, { status: 500 });
  }

  const grLineRows = body.lines
    .filter((rl) => rl.quantity_received > 0)
    .map((rl) => ({
      org_id: orgId,
      receipt_id: receipt.id,
      po_line_id: rl.po_line_id,
      quantity_received: rl.quantity_received,
    }));
  if (grLineRows.length > 0) {
    const { error: glErr } = await supabase.from('goods_receipt_lines').insert(grLineRows);
    if (glErr) {
      await supabase.from('goods_receipts').delete().eq('id', receipt.id);
      return NextResponse.json({ error: glErr.message, code: 'RECEIPT_LINES_FAILED' }, { status: 500 });
    }
  }

  // Advance each PO line's cumulative received_qty.
  let receivedValueDeltaCents = 0;
  for (const rl of body.lines) {
    if (rl.quantity_received <= 0) continue;
    const cur = lineById.get(rl.po_line_id)!;
    const newReceived = cur.received + rl.quantity_received;
    receivedValueDeltaCents += Math.round(rl.quantity_received * cur.unitCost);
    await supabase
      .from('purchase_order_lines')
      .update({ received_qty: newReceived })
      .eq('id', rl.po_line_id);
    cur.received = newReceived;
  }

  // Recompute PO status: CLOSED if every line fully received, else PARTIAL.
  const allReceived = Array.from(lineById.values()).every((l) => l.received + 1e-9 >= l.quantity);
  const anyReceived = Array.from(lineById.values()).some((l) => l.received > 1e-9);
  const nextStatus = allReceived ? 'CLOSED' : anyReceived ? 'PARTIAL' : po.status;

  // Read current received_total to increment it.
  const { data: poNow } = await supabase
    .from('purchase_orders')
    .select('received_total_cents')
    .eq('id', po.id)
    .maybeSingle();
  const newReceivedTotal = Number(poNow?.received_total_cents ?? 0) + receivedValueDeltaCents;

  await supabase
    .from('purchase_orders')
    .update({ status: nextStatus, received_total_cents: newReceivedTotal })
    .eq('id', po.id);

  await logHumanAction(supabase, userId, orgId, {
    action: 'goods_receipt.create',
    subjectTable: 'goods_receipts',
    subjectId: receipt.id as string,
    summary: `Received goods against ${po.po_number} (${(receivedValueDeltaCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`,
  });

  return NextResponse.json(
    { goods_receipt_id: receipt.id, po_status: nextStatus, received_value_cents: receivedValueDeltaCents },
    { status: 201 },
  );
}
