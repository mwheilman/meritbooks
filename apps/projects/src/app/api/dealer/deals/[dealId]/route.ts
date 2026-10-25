export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { loadDealWorkspace } from '@/lib/pm/dealer/deal-queries';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { approvalSummary, decideObject } from '@/lib/approvals/server';
import { Day, FiTypeZ, FinanceZ, LineTypeZ, Meter, Qty4, Rate, Text, Uuid, Year } from '@/lib/pm/dealer/schemas';

const Money = z.number().int().min(0).max(1e12);
const Treatment = z.enum(['TRANSACTION_PRICE', 'COST_REDUCTION', 'PASS_THROUGH']);

const TradeFields = {
  assetId: Uuid.nullish(),
  serialNumber: Text(80).nullish(),
  make: Text(60).nullish(),
  model: Text(80).nullish(),
  modelYear: Year.nullish(),
  meterReading: Meter.nullish(),
  description: Text(300).nullish(),
  conditionNotes: Text(2000).nullish(),
  acvCents: Money.nullish(),
  allowanceCents: Money.optional(),
  payoffCents: Money.optional(),
  lienholderVendorId: Uuid.nullish(),
  lienAccountRef: Text(60).nullish(),
};

const FiFields = {
  productType: FiTypeZ,
  providerVendorId: Uuid.nullish(),
  description: Text(200).nullish(),
  priceCents: Money.default(0),
  costCents: Money.default(0),
  termMonths: z.number().int().min(1).max(240).nullish(),
  contractNumber: Text(60).nullish(),
};

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('header'),
    customerId: Uuid.nullish(),
    financeType: FinanceZ.optional(),
    financeVendorId: Uuid.nullish(),
    taxRateEstimate: Rate.nullish(),
    taxExempt: z.boolean().optional(),
    taxExemptRef: Text(60).nullish(),
    amountFinancedCents: Money.nullish(),
    financeReserveCents: Money.optional(),
    subventionCents: Money.optional(),
    financeRef: Text(60).nullish(),
    notes: Text(2000).nullish(),
  }),
  z.object({
    op: z.literal('add_line'),
    lineType: LineTypeZ,
    unitId: Uuid.nullish(),
    partId: Uuid.nullish(),
    description: Text(300).nullish(),
    qty: Qty4.default(1),
    unitPriceCents: Money.nullish(),
    taxable: z.boolean().optional(),
    programRef: Text(60).nullish(),
    oemVendorId: Uuid.nullish(),
    rebateTreatment: Treatment.nullish(),
  }),
  z.object({
    op: z.literal('update_line'),
    lineId: Uuid,
    qty: Qty4.optional(),
    unitPriceCents: Money.optional(),
    description: Text(300).optional(),
    taxable: z.boolean().optional(),
    programRef: Text(60).nullish(),
    rebateTreatment: Treatment.nullish(),
  }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({ op: z.literal('add_trade'), ...TradeFields }),
  z.object({ op: z.literal('update_trade'), tradeId: Uuid, ...TradeFields }),
  z.object({ op: z.literal('remove_trade'), tradeId: Uuid }),
  z.object({ op: z.literal('add_fi'), ...FiFields }),
  z.object({ op: z.literal('update_fi'), fiId: Uuid, ...FiFields }),
  z.object({ op: z.literal('remove_fi'), fiId: Uuid }),
  z.object({ op: z.literal('issue_quote'), validUntil: Day.nullish() }),
  z.object({ op: z.literal('accept_quote'), quoteId: Uuid }),
  z.object({ op: z.literal('decline_quote'), quoteId: Uuid, reason: Text(300).nullish() }),
  z.object({ op: z.literal('write') }),
  z.object({ op: z.literal('approve'), overrideReason: Text(500).nullish() }),
  z.object({ op: z.literal('reopen'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('fund'), financeRef: Text(60).nullish(), amountFinancedCents: Money.nullish(), fundedOn: Day.nullish() }),
  z.object({ op: z.literal('check'), key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), done: z.boolean().default(true) }),
  z.object({ op: z.literal('deliver'), acknowledgePayoff: z.boolean().default(false), deliveredOn: Day.nullish() }),
  z.object({ op: z.literal('unwind'), reason: z.string().trim().min(1, 'Say why the deal is being unwound').max(500) }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('deposit'), amountCents: z.number().int().positive('The deposit must be more than zero').max(1e12), memo: Text(200).nullish() }),
]);

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'dealer_deal' }, async ({ db, params }) => {
  const w = await loadDealWorkspace(db, params.dealId!);
  if (!w) throw new HttpError(404, 'That deal was not found.', 'NOT_FOUND');
  return w;
});

function tradeRow(b: z.infer<typeof Op> & { op: 'add_trade' | 'update_trade' }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[keyof typeof b, string]> = [
    ['assetId', 'asset_id'], ['serialNumber', 'serial_number'], ['make', 'make'], ['model', 'model'], ['modelYear', 'model_year'],
    ['meterReading', 'meter_reading'], ['description', 'description'], ['conditionNotes', 'condition_notes'], ['acvCents', 'acv_cents'],
    ['allowanceCents', 'allowance_cents'], ['payoffCents', 'payoff_cents'], ['lienholderVendorId', 'lienholder_vendor_id'], ['lienAccountRef', 'lien_account_ref'],
  ];
  for (const [k, col] of map) if (b[k] !== undefined) out[col] = b[k] === '' ? null : b[k];
  if (typeof out.serial_number === 'string') out.serial_number = (out.serial_number as string).toUpperCase();
  return out;
}

function fiRow(b: z.infer<typeof Op> & { op: 'add_fi' | 'update_fi' }): Record<string, unknown> {
  return {
    product_type: b.productType, provider_vendor_id: b.providerVendorId ?? null, description: b.description || null, price_cents: b.priceCents,
    cost_cents: b.costCents, term_months: b.termMonths ?? null, contract_number: b.contractNumber || null,
  };
}

/** Every desk move: lines, trades, F&I, quotes and the stage machine (QUOTE → … → DELIVERED / UNWOUND / LOST). */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, ops: { approve: { cap: 'projects.store', action: 'approve' }, fund: { cap: 'projects.store', action: 'approve' }, unwind: { cap: 'projects.store', action: 'approve' }, reopen: { cap: 'projects.store', action: 'approve' } }, mask: 'dealer_deal', body: Op }, async ({ db, params, body, tenant }) => {
  const d = await downs<{ id: string; location_id: string; stage: string }>(db, 'dealer_deals', 'id, location_id, stage', params.dealId!, 'That deal was not found.');
  assertCompany(tenant, d.location_id);
  const pm = db.schema('pm');
  const nextNo = async (): Promise<{ line_no: number; sort: number }> => {
    const last = rows<{ line_no: number; sort: number }>(await pm.from('dealer_deal_lines').select('line_no, sort').eq('deal_id', d.id).order('line_no', { ascending: false }).limit(1), 'last line');
    return { line_no: (last[0]?.line_no ?? 0) + 1, sort: (last[0]?.sort ?? -1) + 1 };
  };
  switch (body.op) {
    case 'header': {
      const map: Array<[keyof typeof body, string]> = [
        ['customerId', 'customer_id'], ['financeType', 'finance_type'], ['financeVendorId', 'finance_vendor_id'], ['taxRateEstimate', 'tax_rate_estimate'],
        ['taxExempt', 'tax_exempt'], ['taxExemptRef', 'tax_exempt_ref'], ['amountFinancedCents', 'amount_financed_cents'], ['financeReserveCents', 'finance_reserve_cents'],
        ['subventionCents', 'subvention_cents'], ['financeRef', 'finance_ref'], ['notes', 'notes'],
      ];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('dealer_deals').update(patch).eq('id', d.id).select('id'), 'update deal');
      if (!r.length) throw new HttpError(422, 'The deal is past the desk, so its terms are locked. Reopen it to change them.', 'PM_DEAL_LOCKED');
      return { ok: true };
    }
    case 'add_line': {
      if (body.lineType === 'UNIT' && !body.unitId) throw new HttpError(422, 'Pick the unit from stock.', 'VALIDATION');
      if (body.lineType !== 'UNIT' && !body.partId && !body.description) throw new HttpError(422, 'Describe the line.', 'VALIDATION');
      const n = await nextNo();
      await dwrite(pm.from('dealer_deal_lines').insert({
        deal_id: d.id, ...n, line_type: body.lineType, asset_id: body.lineType === 'UNIT' ? body.unitId : null, part_id: body.lineType === 'UNIT' ? null : body.partId ?? null,
        description: body.description || '', qty: body.lineType === 'UNIT' ? 1 : body.qty, unit_price_cents: body.unitPriceCents ?? null,
        taxable: body.taxable ?? !(body.lineType === 'REBATE' || body.lineType === 'INCENTIVE'), program_ref: body.programRef || null,
        oem_vendor_id: body.oemVendorId ?? null, rebate_treatment: body.rebateTreatment ?? null,
      }).select('id'), 'add line');
      return { ok: true };
    }
    case 'update_line': {
      const patch: Record<string, unknown> = {};
      if (body.qty !== undefined) patch.qty = body.qty;
      if (body.unitPriceCents !== undefined) patch.unit_price_cents = body.unitPriceCents;
      if (body.description !== undefined && body.description) patch.description = body.description;
      if (body.taxable !== undefined) patch.taxable = body.taxable;
      if (body.programRef !== undefined) patch.program_ref = body.programRef || null;
      if (body.rebateTreatment !== undefined) patch.rebate_treatment = body.rebateTreatment;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('dealer_deal_lines').update(patch).eq('id', body.lineId).eq('deal_id', d.id).select('id'), 'update line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_line': {
      const r = await dwrite<unknown[]>(pm.from('dealer_deal_lines').delete().eq('id', body.lineId).eq('deal_id', d.id).select('id'), 'remove line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'add_trade': {
      const row = tradeRow(body);
      if (!row.asset_id && !row.serial_number) throw new HttpError(422, 'Key the trade’s serial number, or pick it from the customer’s equipment.', 'VALIDATION');
      if ((body.payoffCents ?? 0) > 0 && !body.lienholderVendorId) throw new HttpError(422, 'A trade with a payoff needs the lienholder.', 'VALIDATION');
      await dwrite(pm.from('dealer_trades').insert({ deal_id: d.id, ...row }).select('id'), 'add trade');
      return { ok: true };
    }
    case 'update_trade': {
      const row = tradeRow(body);
      if (!Object.keys(row).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('dealer_trades').update(row).eq('id', body.tradeId).eq('deal_id', d.id).select('id'), 'update trade');
      if (!r.length) throw new HttpError(404, 'That trade was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_trade': {
      const r = await dwrite<unknown[]>(pm.from('dealer_trades').delete().eq('id', body.tradeId).eq('deal_id', d.id).select('id'), 'remove trade');
      if (!r.length) throw new HttpError(404, 'That trade was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'add_fi':
      await dwrite(pm.from('dealer_fi_products').insert({ deal_id: d.id, ...fiRow(body) }).select('id'), 'add F&I product');
      return { ok: true };
    case 'update_fi': {
      const r = await dwrite<unknown[]>(pm.from('dealer_fi_products').update(fiRow(body)).eq('id', body.fiId).eq('deal_id', d.id).select('id'), 'update F&I product');
      if (!r.length) throw new HttpError(404, 'That product was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_fi': {
      const r = await dwrite<unknown[]>(pm.from('dealer_fi_products').delete().eq('id', body.fiId).eq('deal_id', d.id).select('id'), 'remove F&I product');
      if (!r.length) throw new HttpError(404, 'That product was not found on this deal.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'issue_quote': {
      const id = await dcall<string>(db, 'issue_dealer_quote', { p_deal: d.id, p_valid_until: body.validUntil ?? null });
      return { ok: true, quoteId: id };
    }
    case 'accept_quote':
      await dcall(db, 'accept_dealer_quote', { p_quote: body.quoteId });
      return { ok: true };
    case 'decline_quote':
      await dcall(db, 'decline_dealer_quote', { p_quote: body.quoteId, p_reason: body.reason || null });
      return { ok: true };
    case 'write':
      await dcall(db, 'write_deal', { p_deal: d.id });
      return { ok: true };
    case 'approve': {
      // desk approval through the approvals engine (1113): below the floor adds the GM / owner step;
      // pm.approve_deal (gross, floor reason) runs at the last step with the approver's reason
      const a = await decideObject(db, 'dealer_deal', d.id, { reason: body.overrideReason || null });
      if (a.status === 'not_needed') {
        const r = await dcall<Record<string, unknown>>(db, 'approve_deal', { p_deal: d.id, p_override_reason: body.overrideReason || null });
        return { ok: true, approval: r };
      }
      return { ok: true, approved: a.status === 'approved', approval: a.result ?? null, engine: approvalSummary(a) };
    }
    case 'reopen':
      await dcall(db, 'reopen_deal', { p_deal: d.id, p_reason: body.reason || null });
      return { ok: true };
    case 'fund':
      await dcall(db, 'mark_deal_funded', { p_deal: d.id, p_attrs: { ...(body.financeRef ? { finance_ref: body.financeRef } : {}), ...(body.amountFinancedCents != null ? { amount_financed_cents: body.amountFinancedCents } : {}), ...(body.fundedOn ? { funded_on: body.fundedOn } : {}) } });
      return { ok: true };
    case 'check':
      await dcall(db, 'check_deal_delivery_item', { p_deal: d.id, p_key: body.key, p_done: body.done });
      return { ok: true };
    case 'deliver': {
      const out = await dcall<string>(db, 'deliver_deal', { p_deal: d.id, p_acknowledge_payoff: body.acknowledgePayoff, p_delivered_on: body.deliveredOn ?? null });
      return { ok: true, outboxId: out };
    }
    case 'unwind':
      await dcall(db, 'unwind_deal', { p_deal: d.id, p_reason: body.reason });
      return { ok: true };
    case 'cancel':
      await dcall(db, 'cancel_deal', { p_deal: d.id, p_reason: body.reason || null });
      return { ok: true };
    case 'deposit': {
      const id = await dcall<string>(db, 'request_deal_deposit', { p_deal: d.id, p_amount_cents: body.amountCents, p_memo: body.memo || null });
      return { ok: true, depositId: id };
    }
  }
});
