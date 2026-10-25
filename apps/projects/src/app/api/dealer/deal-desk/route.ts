export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * The deal desk additions (1125): the payment menu (DLR-13), the OEM incentive library and claims to
 * receipt (DLR-14), contracts in transit (DLR-24) and the unwind with the deposit choice (DLR-25).
 * Dealer-net figures and incentive amounts come back only with Job financials (the functions strip
 * them); the route masks deal money on top.
 */
const Downs = z.string().regex(/^\d{1,10}(,\d{1,10}){0,3}$/, 'Down payments are cents, comma separated');
const views = {
  menu: view('dlr_payment_menu', z.object({ deal: Uuid, downs: Downs.default('0') }), (q) => ({ p_deal: q.deal, p_downs: q.downs.split(',').map(Number) })),
  eligible: view('dlr_eligible_incentives', z.object({ deal: Uuid }), (q) => ({ p_deal: q.deal })),
  incentives: view('dlr_incentive_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  cit: view('dlr_cit_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'dealer_deal', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Incentive = z.object({
  code: z.string().regex(/^[A-Za-z0-9_.-]{2,40}$/, 'Codes are 2–40 letters, digits, . _ or -'), name: Req(160, 'The name'),
  kind: z.enum(['RETAIL_REBATE', 'DEALER_CASH', 'SPIFF', 'VOLUME', 'COOP', 'DEMO_ALLOWANCE', 'OTHER']), brand: Text(40).nullish(), oem_vendor_id: Uuid.nullish(),
  model_pattern: Text(120).nullish(), categories: z.array(Text(60)).max(20).default([]), new_only: z.boolean().default(true), starts_on: IsoDate.nullish(), ends_on: IsoDate.nullish(),
  amount_cents: PosCents.default(0), pct_of_price: z.number().min(0).max(1).default(0), payee: z.enum(['DEALER', 'SALESPERSON', 'CUSTOMER']).default('DEALER'),
  claim_deadline_days: z.number().int().min(0).max(730).nullish(), volume_target_units: z.number().int().min(1).max(100000).nullish(), bulletin_ref: Text(120).nullish(),
  notes: Text(1000).nullish(), is_active: z.boolean().default(true),
}).refine((r) => r.amount_cents > 0 || r.pct_of_price > 0, { message: 'Give an amount or a percent of price', path: ['amount_cents'] });

const ops = {
  attach_menu: op('dlr_attach_payment_menu', z.object({ quoteId: Uuid, downs: z.array(PosCents).min(1).max(4).default([0]), chosen: Text(40).nullish() }),
    (b) => ({ p_quote: b.quoteId, p_downs: b.downs, p_chosen: b.chosen ?? null })),
  apply_incentive: op('dlr_apply_incentive', z.object({ dealId: Uuid, incentiveId: Uuid, remove: z.boolean().default(false) }),
    (b) => ({ p_deal: b.dealId, p_incentive: b.incentiveId, p_remove: b.remove })),
  save_incentives: op('dlr_save_incentives', z.object({ companyId: Uuid, rows: z.array(Incentive).min(1).max(300) }), (b) => ({ p_location: b.companyId, p_rows: b.rows })),
  update_claim: op('dlr_update_incentive_claim', z.object({
    claimId: Uuid, status: z.enum(['SUBMITTED', 'PAID', 'DENIED', 'DUE', 'VOID']), claimRef: Text(80).nullish(), paidOn: IsoDate.nullish(), paidCents: PosCents.nullish(),
    reason: Text(500).nullish(), notes: Text(1000).nullish(),
  }), (b) => ({ p_claim: b.claimId, p_status: b.status, p_attrs: { claim_ref: b.claimRef ?? null, paid_on: b.paidOn ?? null, paid_cents: b.paidCents ?? null, reason: b.reason ?? null, notes: b.notes ?? null } })),
  set_stip: op('dlr_set_stip', z.object({ dealId: Uuid, key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), received: z.boolean(), label: Text(120).nullish(), required: z.boolean().nullish(), documentId: Uuid.nullish(), note: Text(300).nullish() }),
    (b) => ({ p_deal: b.dealId, p_key: b.key, p_received: b.received, p_attrs: { label: b.label ?? null, required: b.required ?? null, document_id: b.documentId ?? null, note: b.note ?? null } })),
  lender_status: op('dlr_set_lender_status', z.object({ dealId: Uuid, status: z.enum(['NOT_SUBMITTED', 'SUBMITTED', 'CONDITIONED', 'APPROVED', 'FUNDED', 'REJECTED']), conditions: Text(1000).nullish(), fundedOn: IsoDate.nullish(), fundedCents: PosCents.nullish(), booksReceiptRef: Text(80).nullish() }),
    (b) => ({ p_deal: b.dealId, p_status: b.status, p_attrs: { conditions: b.conditions ?? null, funded_on: b.fundedOn ?? null, funded_cents: b.fundedCents ?? null, books_receipt_ref: b.booksReceiptRef ?? null } })),
  unwind: op('dlr_unwind_deal', z.object({ dealId: Uuid, reason: Req(500, 'The reason'), reasonCode: z.enum(['FINANCING_DECLINED', 'BUYER_REMORSE', 'UNIT_DEFECT', 'PAPERWORK', 'OTHER']), depositAction: z.enum(['REFUND', 'HOLD', 'APPLY_TO_NEW_DEAL', 'NONE']) }),
    (b) => ({ p_deal: b.dealId, p_reason: b.reason, p_reason_code: b.reasonCode, p_deposit_action: b.depositAction })),
};

export const POST = route({
  access: { cap: 'projects.store', action: 'edit' },
  ops: { unwind: { cap: 'projects.store', action: 'approve' } },
  mask: 'dealer_deal', body: deskBody(ops),
}, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));
