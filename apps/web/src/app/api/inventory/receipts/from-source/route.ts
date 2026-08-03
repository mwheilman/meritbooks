export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { PostingError } from '@/lib/posting/account-roles';
import { receiveFromBill, receiveFromGoodsReceipt } from '@/lib/inventory/receipt-links';

/**
 * POST /api/inventory/receipts/from-source — create inventory RECEIPT movements from
 * an AP bill's lines, or from a goods-receipt's lines against a PO. Valuation-only:
 * the bill (existing or eventual) books the GL asset; this just advances on-hand +
 * cost, reading qty/unit-cost from the source. Idempotent per source line. RLS-scoped.
 *
 * Gated on 'fixed_assets' create (the interim inventory permission — REPORTED to the
 * lead) since it writes inventory subledger rows; it posts nothing to the ledger.
 */

const lineMap = z.object({
  inventory_item_id: z.string().uuid(),
});

const bodySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('BILL'),
    bill_id: z.string().uuid(),
    lines: z
      .array(lineMap.extend({ bill_line_id: z.string().uuid() }))
      .min(1, 'At least one line is required.')
      .max(500),
  }),
  z.object({
    source: z.literal('GOODS_RECEIPT'),
    goods_receipt_id: z.string().uuid(),
    lines: z
      .array(lineMap.extend({ po_line_id: z.string().uuid() }))
      .min(1, 'At least one line is required.')
      .max(500),
  }),
]);

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_root';
      (details[path] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }
  const body = parsed.data;

  try {
    const result =
      body.source === 'BILL'
        ? await receiveFromBill(supabase, {
            orgId,
            billId: body.bill_id,
            lines: body.lines.map((l) => ({ billLineId: l.bill_line_id, inventoryItemId: l.inventory_item_id })),
            createdBy: null,
          })
        : await receiveFromGoodsReceipt(supabase, {
            orgId,
            goodsReceiptId: body.goods_receipt_id,
            lines: body.lines.map((l) => ({ poLineId: l.po_line_id, inventoryItemId: l.inventory_item_id })),
            createdBy: null,
          });

    await logHumanAction(supabase, userId, orgId, {
      action: 'inventory_receipt.from_source',
      subjectTable: body.source === 'BILL' ? 'bills' : 'goods_receipts',
      subjectId: result.refId,
      summary: `Received ${result.received} line(s) into inventory from ${body.source === 'BILL' ? 'bill' : 'goods receipt'} (${result.skipped} skipped, ${result.errors} errored)`,
    });

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Receipt linking failed', code: 'RECEIPT_LINK_ERROR' },
      { status },
    );
  }
}
