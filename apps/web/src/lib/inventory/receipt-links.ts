/**
 * Receipt links — turn an AP bill line, or a goods-receipt line against a PO, into
 * an inventory RECEIPT so receiving stock and booking the payable are connected.
 *
 * VALUATION-ONLY, NO DOUBLE GL. The bill (or the eventual bill against the PO)
 * already books the inventory asset / expense; an inventory RECEIPT here only
 * advances on-hand + valuation — it posts nothing to the ledger (exactly the
 * posture receiveInventory already enforces). Quantity and unit cost are read from
 * the SOURCE (never trusted from the client) so the subledger can't drift from AP.
 *
 * Idempotency: each RECEIPT records ref_type + ref_id (the source doc) and stores
 * the source LINE id in `reference`. A re-run reads back the source-line ids already
 * received against that doc and skips them — receiving the same bill/GR twice can't
 * double-count stock.
 *
 * The item mapping (which source line stocks which inventory item) is supplied by
 * the caller, because bill/PO lines reference core.items while inventory lives in its
 * own public.inventory_items table with no persisted link. Money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PostingError } from '../posting/account-roles';
import { receiveInventory } from './inventory-service';

type DB = SupabaseClient;

export const BILL_REF_TYPE = 'BILL';
export const GOODS_RECEIPT_REF_TYPE = 'GOODS_RECEIPT';

// ── Pure derivation ──────────────────────────────────────────────────────────

export interface BillLineLike {
  quantity: number;
  unitCostCents: number;
  amountCents: number;
}

/**
 * PURE. Derive the RECEIPT qty + total cost from a bill line: prefer the line's
 * extended amount (what AP actually booked); fall back to qty × unit cost. Returns
 * null when there is nothing receivable (non-positive qty or zero value).
 */
export function deriveReceiptFromBillLine(line: BillLineLike): { qty: number; totalCostCents: number } | null {
  const qty = Number(line.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const extended = Number(line.amountCents);
  const totalCostCents = extended > 0 ? Math.round(extended) : Math.round(qty * Number(line.unitCostCents ?? 0));
  if (totalCostCents < 0) return null;
  return { qty, totalCostCents };
}

// ── Shared result shape ──────────────────────────────────────────────────────

export interface LineOutcome {
  sourceLineId: string;
  inventoryItemId: string;
  status: 'received' | 'skipped_already' | 'skipped_empty' | 'error';
  qty?: number;
  totalCostCents?: number;
  movementId?: string;
  error?: string;
}

export interface ReceiptLinkResult {
  refType: string;
  refId: string;
  received: number;
  skipped: number;
  errors: number;
  lines: LineOutcome[];
}

/** Read the set of source-line ids already received against a given source doc. */
async function alreadyReceivedLineIds(db: DB, orgId: string, refType: string, refId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const { data } = await db
    .from('inventory_movements')
    .select('reference')
    .eq('org_id', orgId)
    .eq('movement_type', 'RECEIPT')
    .eq('ref_type', refType)
    .eq('ref_id', refId);
  for (const row of data ?? []) {
    const ref = (row as { reference?: string | null }).reference;
    if (ref) seen.add(ref);
  }
  return seen;
}

// ── Bill → inventory receipts ─────────────────────────────────────────────────

export interface ReceiveFromBillInput {
  orgId: string;
  billId: string;
  lines: Array<{ billLineId: string; inventoryItemId: string }>;
  createdBy?: string | null;
}

export async function receiveFromBill(db: DB, input: ReceiveFromBillInput): Promise<ReceiptLinkResult> {
  const { data: bill, error: billErr } = await db
    .from('bills')
    .select('id, status, bill_date')
    .eq('id', input.billId)
    .maybeSingle();
  if (billErr) throw new PostingError(`Bill lookup failed: ${billErr.message}`);
  if (!bill) throw new PostingError('Bill not found');
  if ((bill as { status?: string }).status === 'VOIDED') {
    throw new PostingError('Cannot receive stock against a voided bill.');
  }
  const receivedDate = (bill as { bill_date?: string }).bill_date ?? new Date().toISOString().slice(0, 10);

  const { data: billLines, error: linesErr } = await db
    .from('bill_lines')
    .select('id, quantity, unit_cost_cents, amount_cents')
    .eq('bill_id', input.billId);
  if (linesErr) throw new PostingError(`Bill line lookup failed: ${linesErr.message}`);
  const lineById = new Map(
    (billLines ?? []).map((l) => [
      l.id as string,
      {
        quantity: Number((l as { quantity: number }).quantity),
        unitCostCents: Number((l as { unit_cost_cents: number }).unit_cost_cents ?? 0),
        amountCents: Number((l as { amount_cents: number }).amount_cents ?? 0),
      },
    ]),
  );

  const seen = await alreadyReceivedLineIds(db, input.orgId, BILL_REF_TYPE, input.billId);
  const result: ReceiptLinkResult = { refType: BILL_REF_TYPE, refId: input.billId, received: 0, skipped: 0, errors: 0, lines: [] };

  for (const map of input.lines) {
    const outcome: LineOutcome = { sourceLineId: map.billLineId, inventoryItemId: map.inventoryItemId, status: 'error' };
    const src = lineById.get(map.billLineId);
    if (!src) {
      outcome.error = 'Bill line is not on this bill.';
      result.errors += 1;
      result.lines.push(outcome);
      continue;
    }
    if (seen.has(map.billLineId)) {
      outcome.status = 'skipped_already';
      result.skipped += 1;
      result.lines.push(outcome);
      continue;
    }
    const derived = deriveReceiptFromBillLine(src);
    if (!derived) {
      outcome.status = 'skipped_empty';
      result.skipped += 1;
      result.lines.push(outcome);
      continue;
    }
    try {
      const rec = await receiveInventory(db, {
        orgId: input.orgId,
        itemId: map.inventoryItemId,
        qty: derived.qty,
        totalCostCents: derived.totalCostCents,
        receivedDate,
        reference: map.billLineId,
        refType: BILL_REF_TYPE,
        refId: input.billId,
        memo: 'Received from bill',
        createdBy: input.createdBy ?? null,
      });
      seen.add(map.billLineId);
      outcome.status = 'received';
      outcome.qty = derived.qty;
      outcome.totalCostCents = derived.totalCostCents;
      outcome.movementId = rec.movement_id;
      result.received += 1;
    } catch (e) {
      outcome.error = e instanceof Error ? e.message : 'Receipt failed';
      result.errors += 1;
    }
    result.lines.push(outcome);
  }
  return result;
}

// ── Goods receipt → inventory receipts ────────────────────────────────────────

export interface ReceiveFromGoodsReceiptInput {
  orgId: string;
  goodsReceiptId: string;
  lines: Array<{ poLineId: string; inventoryItemId: string }>;
  createdBy?: string | null;
}

export async function receiveFromGoodsReceipt(db: DB, input: ReceiveFromGoodsReceiptInput): Promise<ReceiptLinkResult> {
  const { data: gr, error: grErr } = await db
    .from('goods_receipts')
    .select('id, po_id, received_date')
    .eq('id', input.goodsReceiptId)
    .maybeSingle();
  if (grErr) throw new PostingError(`Goods receipt lookup failed: ${grErr.message}`);
  if (!gr) throw new PostingError('Goods receipt not found');
  const receivedDate = (gr as { received_date?: string }).received_date ?? new Date().toISOString().slice(0, 10);
  const poId = (gr as { po_id: string }).po_id;

  // Quantity received per PO line comes from THIS receipt's lines; unit cost from the PO line.
  const { data: grLines } = await db
    .from('goods_receipt_lines')
    .select('po_line_id, quantity_received')
    .eq('receipt_id', input.goodsReceiptId);
  const qtyByPoLine = new Map<string, number>();
  for (const l of grLines ?? []) {
    const poLineId = (l as { po_line_id: string }).po_line_id;
    const q = Number((l as { quantity_received: number }).quantity_received ?? 0);
    qtyByPoLine.set(poLineId, (qtyByPoLine.get(poLineId) ?? 0) + q);
  }

  const { data: poLines } = await db
    .from('purchase_order_lines')
    .select('id, unit_cost_cents')
    .eq('po_id', poId);
  const unitCostByPoLine = new Map(
    (poLines ?? []).map((l) => [l.id as string, Number((l as { unit_cost_cents: number }).unit_cost_cents ?? 0)]),
  );

  const seen = await alreadyReceivedLineIds(db, input.orgId, GOODS_RECEIPT_REF_TYPE, input.goodsReceiptId);
  const result: ReceiptLinkResult = {
    refType: GOODS_RECEIPT_REF_TYPE,
    refId: input.goodsReceiptId,
    received: 0,
    skipped: 0,
    errors: 0,
    lines: [],
  };

  for (const map of input.lines) {
    const outcome: LineOutcome = { sourceLineId: map.poLineId, inventoryItemId: map.inventoryItemId, status: 'error' };
    const qty = qtyByPoLine.get(map.poLineId);
    if (qty === undefined) {
      outcome.error = 'PO line was not received on this goods receipt.';
      result.errors += 1;
      result.lines.push(outcome);
      continue;
    }
    if (seen.has(map.poLineId)) {
      outcome.status = 'skipped_already';
      result.skipped += 1;
      result.lines.push(outcome);
      continue;
    }
    if (!(qty > 0)) {
      outcome.status = 'skipped_empty';
      result.skipped += 1;
      result.lines.push(outcome);
      continue;
    }
    const unitCost = unitCostByPoLine.get(map.poLineId) ?? 0;
    const totalCostCents = Math.round(qty * unitCost);
    try {
      const rec = await receiveInventory(db, {
        orgId: input.orgId,
        itemId: map.inventoryItemId,
        qty,
        totalCostCents,
        receivedDate,
        reference: map.poLineId,
        refType: GOODS_RECEIPT_REF_TYPE,
        refId: input.goodsReceiptId,
        memo: 'Received from goods receipt',
        createdBy: input.createdBy ?? null,
      });
      seen.add(map.poLineId);
      outcome.status = 'received';
      outcome.qty = qty;
      outcome.totalCostCents = totalCostCents;
      outcome.movementId = rec.movement_id;
      result.received += 1;
    } catch (e) {
      outcome.error = e instanceof Error ? e.message : 'Receipt failed';
      result.errors += 1;
    }
    result.lines.push(outcome);
  }
  return result;
}
