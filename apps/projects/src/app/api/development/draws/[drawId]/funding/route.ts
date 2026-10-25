export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('funding'), sourceId: Uuid.nullish(), approvedCents: Cents.nullish(), fundedCents: Cents.nullish(), fundedOn: Day.nullish(), titleDateDownOn: Day.nullish(),
    adjustmentReason: Text(500).nullish() }),
  z.object({ op: z.literal('disbursement'), vendorId: Uuid.nullish(), amountCents: Cents.refine((n) => n > 0, 'More than zero'),
    method: z.enum(['DIRECT_VIA_TITLE', 'SPONSOR_PAYMENT', 'ACH', 'WIRE', 'CHECK']).default('SPONSOR_PAYMENT'), paidOn: Day.nullish(), reference: Text(120).nullish(), drawInvoiceId: Uuid.nullish() }),
]);

/** Draw funding per source (with any adjustment and the title date-down) and disbursements (RED-29). */
export const POST = route({ access: { cap: 'projects.billing', action: 'edit' }, mask: ['draw'], body: Body }, async ({ db, params, body }) => {
  if (body.op === 'funding') {
    return { fundingId: await resRpc<string>(db, 'dev_record_funding', { p_draw: params.drawId!, p_source: body.sourceId ?? null, p_approved_cents: body.approvedCents ?? null,
      p_funded_cents: body.fundedCents ?? null, p_funded_on: body.fundedOn ?? null, p_title_date_down_on: body.titleDateDownOn ?? null, p_adjustment_reason: body.adjustmentReason ?? null }) };
  }
  return { disbursementId: await resRpc<string>(db, 'dev_record_disbursement', { p_draw: params.drawId!, p_vendor: body.vendorId ?? null, p_amount_cents: body.amountCents,
    p_method: body.method, p_paid_on: body.paidOn ?? null, p_reference: body.reference ?? null, p_draw_invoice: body.drawInvoiceId ?? null }) };
});
