export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { companyJobIds, inList } from '@/lib/dealer/rpc';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export interface ReceiptRow {
  id: string;
  job_id: string;
  cost_code_id: string | null;
  document_id: string | null;
  vendor_name: string | null;
  amount_cents: number | null;
  tax_cents: number | null;
  purchased_on: string | null;
  card_last4: string | null;
  status: 'CAPTURED' | 'CODED' | 'SENT' | 'VOID';
  memo: string | null;
  created_at: string;
}

/** Receipts captured in the field (RES-62), uncoded first. Amounts through the masked view (the capturer sees their own). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['cost'], query: z.object({ company: Uuid, status: z.enum(['CAPTURED', 'CODED', 'SENT', 'ALL']).default('ALL') }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.company);
    const jobs = await companyJobIds(db, query.company);
    const all = resWrote<ReceiptRow[]>(await pm(db).from('v_res_receipt_captures_masked')
      .select('id, job_id, cost_code_id, document_id, vendor_name, amount_cents, tax_cents, purchased_on, card_last4, status, memo, created_at').in('job_id', inList(jobs))
      .neq('status', 'VOID').order('created_at', { ascending: false }).limit(1000));
    const counts = { CAPTURED: 0, CODED: 0, SENT: 0, ALL: all.length };
    for (const r of all) if (r.status in counts) counts[r.status as 'CAPTURED' | 'CODED' | 'SENT'] += 1;
    const receipts = query.status === 'ALL' ? all : all.filter((r) => r.status === query.status || (query.status === 'CODED' && r.status === 'SENT'));
    return { receipts, counts };
  });

const Body = z.object({ receiptId: Uuid, costCodeId: Uuid, vendorId: Uuid.nullish(), vendorName: Text(200).nullish(), amountCents: Cents.nullish(), taxCents: Cents.nullish(),
  purchasedOn: Day.nullish(), booksTxnRef: Text(120).nullish(), memo: Text(500).nullish() });

/** The office codes a receipt (or a supply-house card charge, with its Books transaction reference). */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: ['cost'], body: Body }, async ({ db, body }) => {
  const f: Record<string, unknown> = {};
  if (body.vendorId) f.vendor_id = body.vendorId;
  if (body.vendorName) f.vendor_name = body.vendorName;
  if (body.amountCents != null) f.amount_cents = body.amountCents;
  if (body.taxCents != null) f.tax_cents = body.taxCents;
  if (body.purchasedOn) f.purchased_on = body.purchasedOn;
  if (body.booksTxnRef) f.books_txn_ref = body.booksTxnRef;
  if (body.memo) f.memo = body.memo;
  return resRpc(db, 'res_code_receipt', { p_receipt: body.receiptId, p_cost_code: body.costCodeId, p_fields: f });
});
