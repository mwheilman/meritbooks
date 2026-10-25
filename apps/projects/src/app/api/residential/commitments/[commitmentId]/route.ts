export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { resRpc } from '@/lib/residential/rpc';
import { publicLink, tradeToken } from '@/lib/residential/sign';
import { Cents, Day, Fraction, Text, Uuid } from '@/lib/residential/schemas';

/** Payment eligibility: COI / W-9 / licence / lien waiver / hold reasons. */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: 'commitment' }, async ({ db, params }) =>
  resRpc(db, 'res_compliance_gate', { p_commitment: params.commitmentId! }));

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send_to_trade') }),
  z.object({ op: z.literal('vendor_deposit'), pct: Fraction.nullish(), amountCents: Cents.nullish(), expectedDelivery: Day.nullish(), memo: Text(500).nullish() }),
  z.object({ op: z.literal('invoice'), invoiceNumber: Text(60).min(1, 'Invoice number'), invoiceDate: Day.nullish(), amountCents: Cents.refine((n) => n > 0, 'More than zero'),
    documentId: Uuid.nullish(), source: z.enum(['PORTAL', 'OFFICE', 'EMAIL', 'PHOTO']).default('OFFICE'),
    lines: z.array(z.object({ commitmentLineId: Uuid.nullish(), description: Text(500).optional(), qty: z.number().min(0).max(1e9).nullish(), unitCostCents: Cents.nullish(), amountCents: Cents.nullish() })).max(200).default([]) }),
]);

export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: 'commitment', body: Op }, async ({ req, db, params, body }) => {
  const c = params.commitmentId!;
  switch (body.op) {
    case 'send_to_trade': {
      const t = tradeToken();
      return resRpc(db, 'res_send_po_to_trade', { p_commitment: c, p_token_hash: t.hash, p_link: publicLink(linkBase(req), 'po', t.token) });
    }
    case 'vendor_deposit':
      return { depositId: await resRpc<string>(db, 'res_request_vendor_deposit', { p_commitment: c, p_pct: body.pct ?? null, p_amount_cents: body.amountCents ?? null, p_expected_delivery: body.expectedDelivery ?? null, p_memo: body.memo ?? null }) };
    case 'invoice':
      return resRpc(db, 'res_submit_trade_invoice', { p_commitment: c, p_invoice_number: body.invoiceNumber, p_invoice_date: body.invoiceDate ?? null, p_amount_cents: body.amountCents,
        p_lines: body.lines.map((l) => ({ commitment_line_id: l.commitmentLineId ?? null, description: l.description ?? null, qty: l.qty ?? null, unit_cost_cents: l.unitCostCents ?? null, amount_cents: l.amountCents ?? null })),
        p_document: body.documentId ?? null, p_source: body.source });
  }
});
