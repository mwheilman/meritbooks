export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export interface InboxItem {
  id: string;
  received_at: string;
  from_address: string | null;
  subject: string | null;
  document_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_on: string | null;
  amount_cents: number | null;
  suggested: { job_id?: string; commitment_id?: string; cost_code_id?: string; draw_id?: string | null; confidence?: string };
  duplicate_of: string | null;
  status: 'NEW' | 'CONFIRMED' | 'DISMISSED';
  draw_invoice_id: string | null;
}

/** The sponsor's central invoice inbox (RED-21): new items first, duplicates flagged. */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing', 'commitment'], query: z.object({ company: Uuid, status: z.enum(['NEW', 'CONFIRMED', 'DISMISSED', 'ALL']).default('NEW') }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.company);
    let q = pm(db).from('dev_invoice_inbox').select('id, received_at, from_address, subject, document_id, vendor_id, vendor_name, invoice_number, invoice_on, amount_cents, suggested, duplicate_of, status, draw_invoice_id')
      .eq('location_id', query.company);
    if (query.status !== 'ALL') q = q.eq('status', query.status);
    return { items: resWrote<InboxItem[]>(await q.order('received_at', { ascending: false }).limit(300)) };
  });

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ingest'), companyId: Uuid, fromAddress: Text(254).nullish(), subject: Text(300).nullish(), documentId: Uuid.nullish(), vendorId: Uuid.nullish(),
    vendorName: Text(200).nullish(), invoiceNumber: Text(60).nullish(), invoiceOn: Day.nullish(), amountCents: Cents.nullish(), referenceText: Text(2000).nullish() }),
  z.object({ op: z.literal('confirm'), itemId: Uuid, drawId: Uuid, costCodeId: Uuid.nullish(), commitmentId: Uuid.nullish(), allowDuplicate: z.boolean().default(false) }),
  z.object({ op: z.literal('dismiss'), itemId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.billing', action: 'edit' }, mask: ['billing', 'commitment'], body: Body }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'ingest':
      assertCompany(tenant, body.companyId);
      return resRpc(db, 'dev_inbox_ingest', { p_location: body.companyId, p_item: {
        from_address: body.fromAddress ?? null, subject: body.subject ?? null, document_id: body.documentId ?? null, vendor_id: body.vendorId ?? null, vendor_name: body.vendorName ?? null,
        invoice_number: body.invoiceNumber ?? null, invoice_on: body.invoiceOn ?? null, amount_cents: body.amountCents ?? null, reference_text: body.referenceText ?? null } });
    case 'confirm': return resRpc(db, 'dev_inbox_confirm', { p_item: body.itemId, p_draw: body.drawId, p_cost_code: body.costCodeId ?? null, p_commitment: body.commitmentId ?? null, p_allow_duplicate: body.allowDuplicate });
    case 'dismiss': return { itemId: await resRpc<string>(db, 'dev_inbox_dismiss', { p_item: body.itemId }) };
  }
});
