export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';

const Uuid = z.string().uuid();

const Body = z.object({
  /** The phone's lasting id for this capture (unique per org): a re-send returns the first receipt. */
  clientId: z.string().trim().min(8).max(80),
  jobId: Uuid,
  /** The uploaded receipt photo's document id, when the phone already has it… */
  documentId: Uuid.nullish(),
  /** …or the id of the /api/field/photos command it was (or will be) sent under, so a receipt can queue offline behind its photo. */
  photoCommandId: Uuid.nullish(),
  costCodeId: Uuid.nullish(),
  vendorName: z.string().trim().max(200).nullish(),
  amountCents: z.number().int().min(0).max(1e10).nullish(),
  taxCents: z.number().int().min(0).max(1e10).nullish(),
  purchasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  cardLast4: z.string().regex(/^\d{4}$/).nullish(),
  memo: z.string().trim().max(500).nullish(),
}).refine((b) => !!b.documentId || !!b.photoCommandId, { message: 'Attach the receipt photo (documentId or photoCommandId)', path: ['photoCommandId'] });

export interface FieldReceiptResponse {
  receiptId: string;
  status: 'CAPTURED' | 'CODED' | 'SENT' | 'VOID';
  /** The photo command has not landed yet; the receipt links to it when it does. */
  photoPending: boolean;
  /** True when this clientId was already captured by this person (the first receipt is returned, nothing new is written). */
  duplicate: boolean;
  /** A crew member's cost code is kept as a suggestion for the office (coding needs financials or commitments edit). */
  suggestedCostCodeId: string | null;
}

/**
 * POST /api/field/receipts — additive (RES-62): a crew member photographs a receipt on a job they
 * are on. The photo goes through /api/field/photos (its command id can be sent here before the
 * upload finishes). Dedupe is in the database: res_receipt_captures.client_id is unique per org,
 * so a retry from the offline queue — even after a restart — returns the first receipt. With a
 * cost code it is CODED and handed to Books; without one it waits for the office. The amount is
 * masked from everyone but the capturer and the job's money roles.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  const r = await resRpc<{ receipt_id: string; status: FieldReceiptResponse['status']; photo_pending: boolean; replayed: boolean; suggested_cost_code_id?: string | null }>(db, 'res_capture_receipt', {
    p_job: body.jobId, p_document: body.documentId ?? null, p_client_id: body.clientId, p_photo_command: body.photoCommandId ?? null, p_fields: {
      cost_code_id: body.costCodeId ?? null, vendor_name: body.vendorName ?? null, amount_cents: body.amountCents ?? null, tax_cents: body.taxCents ?? null,
      purchased_on: body.purchasedOn ?? null, card_last4: body.cardLast4 ?? null, memo: body.memo ?? null } });
  const out: FieldReceiptResponse = { receiptId: r.receipt_id, status: r.status, photoPending: r.photo_pending, duplicate: r.replayed, suggestedCostCodeId: r.suggested_cost_code_id ?? null };
  return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
});
