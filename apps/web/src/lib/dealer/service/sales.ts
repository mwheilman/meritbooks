/**
 * Unit sales (deals) + trade-ins (FPB §3.4, §3.5, V8).
 *
 * DEAL mode posts the whole deal JE and creates the Books invoice for what the
 * customer owes, stamped with that JE, so AR / collections / statements / the AR
 * control tie all keep working on the existing invoice flows. A customer deposit is
 * then applied to that invoice through the mig 140 service (DR deposits / CR AR).
 * BOOKS_INVOICE mode links an invoice already posted by AR and relieves cost only.
 *
 * In the same request the floored note moves to SOLD_UNPAID and a payoff is PROPOSED
 * (the SOT clock starts the day the sale is recorded). Releasing it is a separate,
 * different-person step (floor-plan.ts releasePayoff).
 */

import { createInvoice } from '@/lib/invoices/create-invoice';
import { applyDeposit } from '@/lib/customer-deposits/service';
import { costOfSalePlan, dealPlan, lienPayoffPlan, valueTradeIn, overAllowanceBps } from '../engine/sale';
import { transitionOnSale, assertReleaser } from '../engine/notes';
import { salesRolesFor } from '../roles';
import { CARRIED_UNIT_STATUSES, LIVE_NOTE_STATUSES, type TradeValuationPolicy } from '../types';
import type { DealerCtx } from './context';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { DealerError, dbFail } from './errors';
import { loadRoleMap, postPlan } from './posting';
import { byKey, coerceMoney, getRow, insertRow, updateRow, type NoteRow, type ProgramRow, type UnitRow } from './rows';
import { addDays } from '../dates';
import { loadSettings, requireEnabled } from './settings';
import { insertUnit } from './units';
import { proposePayoff } from './floor-plan';
import { audit } from './audit';

export interface TradeInRow {
  id: string;
  sale_id: string | null;
  customer_id: string | null;
  used_unit_id: string | null;
  serial_number: string | null;
  make_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  allowance_cents: number;
  acv_cents: number;
  valuation_policy: TradeValuationPolicy;
  recorded_value_cents: number;
  over_allowance_cents: number;
  under_allowance_cents: number;
  lien_payoff_cents: number;
  lienholder_vendor_id: string | null;
  lien_status: 'NONE' | 'OWED' | 'PROPOSED' | 'PAID';
  lien_proposed_by: string | null;
  appraised_by: string | null;
  approved_by: string | null;
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'VOID';
}

export interface SaleRow {
  id: string;
  unit_id: string;
  invoice_id: string | null;
  posting_mode: 'DEAL' | 'BOOKS_INVOICE';
  customer_id: string | null;
  sale_date: string;
  sale_price_cents: number;
  tax_cents: number;
  deposit_id: string | null;
  deposit_applied_cents: number;
  retail_rebate_cents: number;
  retail_rebate_program_id: string | null;
  trade_in_id: string | null;
  cogs_cents: number | null;
  source: 'BOOKS' | 'DMS';
  external_deal_ref: string | null;
  status: 'PROPOSED' | 'POSTED' | 'VOID';
  gl_entry_id: string | null;
  proposed_by: string | null;
}

export interface TradeInput {
  serialNumber: string;
  makeVendorId?: string | null;
  model?: string | null;
  modelYear?: number | null;
  allowanceCents: number;
  acvCents: number;
  lienPayoffCents?: number;
  lienholderVendorId?: string | null;
}

export interface CreateSaleInput {
  unitId: string;
  customerId?: string | null;
  saleDate: string;
  salePriceCents: number;
  taxCents?: number;
  depositId?: string | null;
  depositAppliedCents?: number;
  retailRebateCents?: number;
  retailRebateProgramId?: string | null;
  invoiceId?: string | null;
  trade?: TradeInput | null;
  salesperson?: string | null;
  retailFinanceVendorId?: string | null;
  source?: 'BOOKS' | 'DMS';
  externalDealRef?: string | null;
  importBatchId?: string | null;
}

/** Record a deal (PROPOSED). Nothing posts until postSale. DMS deals arrive this way. */
export async function createSale(d: DealerCtx, input: CreateSaleInput): Promise<{ sale: SaleRow; trade: TradeInRow | null }> {
  const unit = await getRow<UnitRow>(d, 'dealer_units', input.unitId, 'Unit');
  if (!CARRIED_UNIT_STATUSES.includes(unit.status)) throw new DealerError('CONFLICT', `Unit ${unit.serial_number} is ${unit.status}`);
  if (input.externalDealRef) {
    const { data, error } = await d.admin.from('dealer_unit_sales').select('id').eq('org_id', d.orgId).eq('location_id', d.locationId)
      .eq('external_deal_ref', input.externalDealRef).neq('status', 'VOID').maybeSingle();
    if (error) dbFail('Deal lookup failed', error);
    if (data) {
      const sale = await getRow<SaleRow>(d, 'dealer_unit_sales', (data as { id: string }).id, 'Sale');
      const trade = sale.trade_in_id ? await getRow<TradeInRow>(d, 'trade_ins', sale.trade_in_id, 'Trade-in') : null;
      return { sale, trade };
    }
  }
  const mode = input.invoiceId ? 'BOOKS_INVOICE' : 'DEAL';
  if (mode === 'BOOKS_INVOICE') {
    if (input.trade || (input.retailRebateCents ?? 0) > 0 || (input.taxCents ?? 0) > 0 || (input.depositAppliedCents ?? 0) > 0) {
      throw new DealerError('VALIDATION', 'With an existing invoice, record tax, deposit, trade and rebate on the invoice — or post the deal without an invoice');
    }
    const { data: inv, error } = await d.admin.from('invoices').select('id, location_id, gl_entry_id, status, customer_id')
      .eq('org_id', d.orgId).eq('id', input.invoiceId!).maybeSingle();
    if (error) dbFail('Invoice lookup failed', error);
    const i = inv as { location_id: string; gl_entry_id: string | null; status: string; customer_id: string } | null;
    if (!i || i.location_id !== d.locationId) throw new DealerError('VALIDATION', 'Invoice not found for this client');
    if (!i.gl_entry_id || i.status === 'DRAFT' || i.status === 'VOIDED') throw new DealerError('CONFLICT', 'The invoice must be posted (not draft or void)');
    input = { ...input, customerId: input.customerId ?? i.customer_id };
  } else if (!input.customerId) {
    throw new DealerError('VALIDATION', 'A deal needs a customer (the Books invoice is created for them)');
  }
  if ((input.retailRebateCents ?? 0) > 0) {
    if (!input.retailRebateProgramId) throw new DealerError('VALIDATION', 'A retail rebate needs the manufacturer program it comes from');
    const program = await getRow<{ treatment: string; status: string; paid_direct: boolean }>(d, 'oem_programs', input.retailRebateProgramId, 'Manufacturer program');
    if (program.status !== 'ACTIVE') throw new DealerError('CONFLICT', 'The rebate program is not active (approve it first)');
    if (program.treatment !== 'TRANSACTION_PRICE') throw new DealerError('VALIDATION', 'Only a transaction-price (retail rebate) program can reduce what the customer owes');
    if (program.paid_direct) throw new DealerError('VALIDATION', 'This program is paid by the manufacturer directly to the customer — leave it off the deal');
  }

  let trade: TradeInRow | null = null;
  if (input.trade) {
    const settings = await loadSettings(d);
    const v = valueTradeIn({ allowanceCents: input.trade.allowanceCents, acvCents: input.trade.acvCents, policy: settings.trade_valuation_policy });
    const lien = input.trade.lienPayoffCents ?? 0;
    if (lien > 0 && !input.trade.lienholderVendorId) throw new DealerError('VALIDATION', 'A lien payoff needs the lienholder (vendor)');
    trade = await insertRow<TradeInRow>(d, 'trade_ins', {
      customer_id: input.customerId ?? null,
      serial_number: input.trade.serialNumber.trim(),
      make_vendor_id: input.trade.makeVendorId ?? null,
      model: input.trade.model ?? null,
      model_year: input.trade.modelYear ?? null,
      allowance_cents: input.trade.allowanceCents,
      acv_cents: input.trade.acvCents,
      valuation_policy: settings.trade_valuation_policy,
      recorded_value_cents: v.recordedValueCents,
      lien_payoff_cents: lien,
      lienholder_vendor_id: input.trade.lienholderVendorId ?? null,
      lien_status: lien > 0 ? 'OWED' : 'NONE',
      appraised_by: d.userId,
      appraised_at: new Date().toISOString(),
    }, 'Trade-in');
  }

  const sale = await insertRow<SaleRow>(d, 'dealer_unit_sales', {
    unit_id: unit.id,
    invoice_id: input.invoiceId ?? null,
    posting_mode: mode,
    customer_id: input.customerId ?? null,
    sale_date: input.saleDate,
    sale_price_cents: input.salePriceCents,
    tax_cents: input.taxCents ?? 0,
    deposit_id: input.depositId ?? null,
    deposit_applied_cents: input.depositAppliedCents ?? 0,
    retail_rebate_cents: input.retailRebateCents ?? 0,
    retail_rebate_program_id: input.retailRebateProgramId ?? null,
    trade_in_id: trade?.id ?? null,
    salesperson: input.salesperson ?? null,
    retail_finance_vendor_id: input.retailFinanceVendorId ?? null,
    source: input.source ?? 'BOOKS',
    external_deal_ref: input.externalDealRef ?? null,
    import_batch_id: input.importBatchId ?? null,
    proposed_by: d.userId,
  }, 'Sale');
  if (trade) trade = (await updateRow<TradeInRow>(d, 'trade_ins', trade.id, { sale_id: sale.id }, 'Trade-in')) ?? trade;
  return { sale, trade };
}

/** Sales-manager approval of the trade ACV / over-allowance (FPB §3.5.1, AC7). */
export async function approveTrade(d: DealerCtx, tradeId: string): Promise<TradeInRow> {
  const trade = await getRow<TradeInRow>(d, 'trade_ins', tradeId, 'Trade-in');
  if (trade.status !== 'DRAFT') throw new DealerError('CONFLICT', `A ${trade.status} trade cannot be approved`);
  const row = await updateRow<TradeInRow>(d, 'trade_ins', tradeId, { status: 'APPROVED', approved_by: d.userId, approved_at: new Date().toISOString() }, 'Trade-in', { status: 'DRAFT' });
  await audit(d, 'trade.approve', 'trade_ins', tradeId, `Approved trade ACV ${trade.acv_cents} / allowance ${trade.allowance_cents}`);
  return row ?? trade;
}

export interface PostSaleResult {
  sale: SaleRow;
  glEntryId: string;
  invoiceId: string | null;
  usedUnitId: string | null;
  payoffProposalId: string | null;
  warnings: string[];
}

export async function postSale(d: DealerCtx, saleId: string): Promise<PostSaleResult> {
  const settings = await requireEnabled(d);
  let sale = await getRow<SaleRow>(d, 'dealer_unit_sales', saleId, 'Sale');
  if (sale.status === 'VOID') throw new DealerError('CONFLICT', 'This sale was voided');
  const unit = await getRow<UnitRow>(d, 'dealer_units', sale.unit_id, 'Unit');
  const warnings: string[] = [];

  // Every cost row must be settled (posted or voided) so unit cost ties to the GL.
  const { count: proposedCosts, error: pcErr } = await d.admin.from('dealer_unit_costs').select('id', { count: 'exact', head: true })
    .eq('org_id', d.orgId).eq('unit_id', unit.id).eq('status', 'PROPOSED');
  if (pcErr) dbFail('Unit cost lookup failed', pcErr);
  if ((proposedCosts ?? 0) > 0 && sale.status === 'PROPOSED') {
    throw new DealerError('CONFLICT', "Post or void the unit's proposed cost rows (including an unposted flooring) before selling it");
  }

  let trade = sale.trade_in_id ? await getRow<TradeInRow>(d, 'trade_ins', sale.trade_in_id, 'Trade-in') : null;
  if (trade && trade.status === 'DRAFT') {
    if (trade.acv_cents >= settings.trade_acv_approval_threshold_cents) {
      throw new DealerError('CONFLICT', 'The trade ACV needs sales-manager approval before the deal posts');
    }
    trade = (await updateRow<TradeInRow>(d, 'trade_ins', trade.id, { status: 'APPROVED', approved_by: 'policy:under-approval-threshold', approved_at: new Date().toISOString() }, 'Trade-in')) ?? trade;
  }
  if (trade && trade.status === 'APPROVED' && trade.approved_by === d.userId && trade.appraised_by === d.userId) {
    warnings.push('The same person appraised, approved and posted this trade.');
  }

  const cost = Number(unit.cost_cents);
  const saleUnit = { inventoryRole: unit.inventory_role, condition: unit.condition, departmentRole: unit.department_role };
  const memo = `Unit sale S/N ${unit.serial_number}${sale.external_deal_ref ? ` (deal ${sale.external_deal_ref})` : ''}`;
  let invoiceId = sale.invoice_id;
  let glEntryId: string;

  if (sale.posting_mode === 'DEAL') {
    const built = dealPlan({
      unit: saleUnit,
      salePriceCents: sale.sale_price_cents,
      taxCents: sale.tax_cents,
      retailRebateCents: sale.retail_rebate_cents,
      trade: trade
        ? {
            allowanceCents: trade.allowance_cents,
            valuation: { recordedValueCents: trade.recorded_value_cents, overAllowanceCents: Number(trade.over_allowance_cents), underAllowanceCents: Number(trade.under_allowance_cents) },
            lienPayoffCents: trade.lien_payoff_cents,
          }
        : null,
      costCents: cost,
      memo,
    });
    if (trade && overAllowanceBps(Number(trade.over_allowance_cents), sale.sale_price_cents) > settings.over_allowance_warn_bps) {
      warnings.push('Over-allowance exceeds the client threshold (DL-11).');
    }
    if (built.receivableCents > 0 && !invoiceId) {
      invoiceId = await createDealInvoice(d, sale, unit, trade, built.receivableCents);
      sale = (await updateRow<SaleRow>(d, 'dealer_unit_sales', sale.id, { invoice_id: invoiceId }, 'Sale')) ?? sale;
    }
    const posted = await postPlan(d, built.plan, { entryDate: sale.sale_date, key: `sale:${sale.id}`, sourceId: invoiceId ?? sale.id });
    glEntryId = posted.glEntryId;
    if (invoiceId) {
      // invoices: service-role write (migration 172 sweep) — d.admin IS the service role
      // (openDealerContext, after the permission + RLS client check); org pinned.
      const { error } = await serviceWriter(d.admin).from('invoices').update({ status: 'SENT', gl_entry_id: glEntryId })
        .eq('org_id', d.orgId).eq('id', invoiceId).eq('status', 'DRAFT');
      if (error) dbFail('Stamping the deal invoice failed', error);
    }
  } else {
    const plan = costOfSalePlan({ unit: saleUnit, costCents: cost, memo });
    const posted = await postPlan(d, plan, { entryDate: sale.sale_date, key: `sale:${sale.id}`, sourceId: sale.invoice_id });
    glEntryId = posted.glEntryId;
  }

  sale = (await updateRow<SaleRow>(d, 'dealer_unit_sales', sale.id, {
    status: 'POSTED', gl_entry_id: glEntryId, cogs_cents: cost, posted_by: d.userId, posted_at: new Date().toISOString(),
  }, 'Sale')) ?? sale;

  // Deposit → the deal invoice (mig 140 flow; idempotent via its own guard).
  if (sale.posting_mode === 'DEAL' && sale.deposit_id && sale.deposit_applied_cents > 0 && invoiceId) {
    const { count } = await d.admin.from('customer_deposit_applications').select('id', { count: 'exact', head: true })
      .eq('org_id', d.orgId).eq('deposit_id', sale.deposit_id).eq('invoice_id', invoiceId);
    if ((count ?? 0) === 0) {
      await applyDeposit(d.admin, { orgId: d.orgId, actor: d.userId, depositId: sale.deposit_id, invoiceId, amountCents: sale.deposit_applied_cents });
    }
  }

  // Trade → used unit at recorded value (its cost row carries the deal JE).
  let usedUnitId: string | null = trade?.used_unit_id ?? null;
  if (trade && !usedUnitId) {
    const used = await insertUnit(d, {
      serialNumber: trade.serial_number ?? `TRADE-${trade.id.slice(0, 8)}`,
      makeVendorId: trade.make_vendor_id, model: trade.model, modelYear: trade.model_year,
      condition: 'USED', source: 'TRADE_IN', receivedDate: sale.sale_date,
    });
    usedUnitId = used.id;
    if (trade.recorded_value_cents > 0) {
      await insertRow(d, 'dealer_unit_costs', {
        unit_id: used.id, cost_type: 'BASE_INVOICE', amount_cents: trade.recorded_value_cents, source_type: 'TRADE_IN',
        source_id: trade.id, status: 'POSTED', gl_entry_id: glEntryId, idempotency_key: `cost:trade:${trade.id}`,
        proposed_by: d.userId, posted_by: d.userId, posted_at: new Date().toISOString(),
      }, 'Trade-in cost');
    }
  }
  if (trade) {
    await updateRow(d, 'trade_ins', trade.id, { status: 'POSTED', used_unit_id: usedUnitId, sale_id: sale.id }, 'Trade-in');
  }

  // Retail rebate → an incentive receivable already booked inside the deal JE.
  if (sale.retail_rebate_cents > 0 && sale.retail_rebate_program_id) {
    const key = `inc:sale:${sale.id}`;
    if (!(await byKey(d, 'oem_incentive_claims', key))) {
      const program = await getRow<{ id: string; claim_deadline_days: number | null }>(d, 'oem_programs', sale.retail_rebate_program_id, 'Manufacturer program');
      await insertRow(d, 'oem_incentive_claims', {
        program_id: program.id, unit_id: unit.id, sale_id: sale.id, earned_date: sale.sale_date,
        claim_deadline: program.claim_deadline_days != null ? addDays(sale.sale_date, program.claim_deadline_days) : null,
        treatment: 'TRANSACTION_PRICE', accrual_target_role: salesRolesFor(unit.inventory_role, unit.condition).sales,
        accrued_cents: sale.retail_rebate_cents, claimed_cents: sale.retail_rebate_cents, gl_entry_id: glEntryId,
        idempotency_key: key, created_by: d.userId,
      }, 'Retail rebate claim');
    }
  }

  // Unit → SOLD; live note → SOLD_UNPAID; payoff PROPOSED (never released here).
  await updateRow(d, 'dealer_units', unit.id, { status: 'SOLD', sold_date: sale.sale_date }, 'Unit');
  const { data: noteRaw, error: nErr } = await d.admin.from('floor_plan_notes').select('*').eq('org_id', d.orgId).eq('unit_id', unit.id)
    .in('status', LIVE_NOTE_STATUSES as unknown as string[]).maybeSingle();
  if (nErr) dbFail('Note lookup failed', nErr);
  let payoffProposalId: string | null = null;
  if (noteRaw) {
    const note = coerceMoney<NoteRow>(noteRaw as Record<string, unknown>);
    if (note.status !== 'SOLD_UNPAID') {
      const program = note.program_id ? await getRow<ProgramRow>(d, 'floor_plan_programs', note.program_id, 'Floor-plan program') : null;
      const t = transitionOnSale(note, sale.sale_date, program);
      await updateRow(d, 'floor_plan_notes', note.id, { status: t.status, sold_date: t.soldDate, payoff_due_date: t.payoffDueDate, sold_detected_by: 'BOOKS_SALE' }, 'Floor-plan note');
    }
    payoffProposalId = (await proposePayoff(d, note.id, sale.sale_date)).id;
  }
  await audit(d, 'sale.post', 'dealer_unit_sales', sale.id, `Posted sale of unit ${unit.serial_number}`, { glEntryId, invoiceId });
  return { sale, glEntryId, invoiceId, usedUnitId, payoffProposalId, warnings };
}

async function createDealInvoice(d: DealerCtx, sale: SaleRow, unit: UnitRow, trade: TradeInRow | null, receivable: number): Promise<string> {
  const roleMap = await loadRoleMap(d);
  const acct = (role: string): string => {
    const id = roleMap.get(role)?.account_id;
    if (!id) throw new DealerError('UNMAPPED_ROLE', `Map '${role}' for this client before posting deals`);
    return id;
  };
  const roles = salesRolesFor(unit.inventory_role, unit.condition);
  const lines: { description: string; account_id: string; unit_price_cents: number }[] = [
    { description: `${unit.model ?? 'Unit'} S/N ${unit.serial_number}`, account_id: acct(roles.sales), unit_price_cents: sale.sale_price_cents },
  ];
  if (trade) {
    lines.push({ description: `Trade-in allowance S/N ${trade.serial_number ?? ''}`.trim(), account_id: acct('USED_WHOLE_GOODS_INVENTORY'), unit_price_cents: -trade.allowance_cents });
    if (trade.lien_payoff_cents > 0) {
      lines.push({ description: 'Payoff of lien on trade-in', account_id: acct('TRADE_LIEN_PAYOFF'), unit_price_cents: trade.lien_payoff_cents });
    }
  }
  if (sale.retail_rebate_cents > 0) {
    lines.push({ description: 'Manufacturer retail rebate', account_id: acct('OEM_INCENTIVE_RECEIVABLE'), unit_price_cents: -sale.retail_rebate_cents });
  }
  const subtotal = lines.reduce((s, l) => s + l.unit_price_cents, 0);
  if (subtotal + sale.tax_cents !== receivable) throw new DealerError('POSTING_FAILED', 'Deal invoice does not equal the receivable');
  const out = await createInvoice(d.admin, {
    orgId: d.orgId,
    actor: d.userId,
    input: {
      location_id: d.locationId,
      customer_id: sale.customer_id!,
      invoice_date: sale.sale_date,
      due_date: sale.sale_date,
      memo: `Dealer deal — unit S/N ${unit.serial_number}. Posted by the dealer pack.`,
      tax_cents: sale.tax_cents,
      post_to_gl: false,
      lines: lines.map((l) => ({ ...l, quantity: 1 })),
    },
  });
  if (!out.ok) throw new DealerError('POSTING_FAILED', `Creating the deal invoice failed: ${out.error}`);
  if (out.result.total_cents !== receivable) throw new DealerError('POSTING_FAILED', 'Deal invoice total does not equal the receivable');
  return out.result.invoice_id;
}

export async function voidSale(d: DealerCtx, saleId: string, reason: string): Promise<SaleRow> {
  const sale = await getRow<SaleRow>(d, 'dealer_unit_sales', saleId, 'Sale');
  if (sale.status !== 'PROPOSED') throw new DealerError('CONFLICT', 'Only an unposted sale can be voided — reverse a posted sale through the invoice + a correcting entry');
  if (sale.trade_in_id) await updateRow(d, 'trade_ins', sale.trade_in_id, { status: 'VOID' }, 'Trade-in');
  if (sale.invoice_id && sale.posting_mode === 'DEAL') {
    // A deal invoice created by a failed post attempt is still DRAFT (no GL) — void it.
    const { error } = await serviceWriter(d.admin).from('invoices').update({ status: 'VOIDED' })
      .eq('org_id', d.orgId).eq('id', sale.invoice_id).eq('status', 'DRAFT').is('gl_entry_id', null);
    if (error) dbFail('Voiding the draft deal invoice failed', error);
  }
  const row = await updateRow<SaleRow>(d, 'dealer_unit_sales', saleId, { status: 'VOID' }, 'Sale', { status: 'PROPOSED' });
  await audit(d, 'sale.void', 'dealer_unit_sales', saleId, `Voided proposed sale: ${reason}`);
  return row ?? sale;
}

// ── trade lien payoff: propose → release (different person) ─────────────────────

export async function proposeLienPayoff(d: DealerCtx, tradeId: string): Promise<TradeInRow> {
  const trade = await getRow<TradeInRow>(d, 'trade_ins', tradeId, 'Trade-in');
  if (trade.status !== 'POSTED' || trade.lien_status !== 'OWED') throw new DealerError('CONFLICT', 'There is no owed lien on this trade');
  return (await updateRow<TradeInRow>(d, 'trade_ins', tradeId, { lien_status: 'PROPOSED', lien_proposed_by: d.userId }, 'Trade-in', { lien_status: 'OWED' })) ?? trade;
}

export async function releaseLienPayoff(d: DealerCtx, tradeId: string, paidDate: string): Promise<TradeInRow> {
  await requireEnabled(d);
  const trade = await getRow<TradeInRow>(d, 'trade_ins', tradeId, 'Trade-in');
  if (trade.lien_status === 'PAID') return trade;
  if (trade.lien_status !== 'PROPOSED') throw new DealerError('CONFLICT', 'Propose the lien payoff first');
  try {
    assertReleaser(trade.lien_proposed_by, d.userId);
  } catch (e) {
    throw new DealerError('SEPARATION_OF_DUTIES', (e as Error).message);
  }
  const plan = lienPayoffPlan(trade.lien_payoff_cents, 'WG_USED', `Trade-in lien payoff S/N ${trade.serial_number ?? ''}`);
  const posted = await postPlan(d, plan, { entryDate: paidDate, key: `lien:${trade.id}`, sourceId: trade.id });
  const row = await updateRow<TradeInRow>(d, 'trade_ins', tradeId, {
    lien_status: 'PAID', lien_released_by: d.userId, lien_paid_date: paidDate, lien_gl_entry_id: posted.glEntryId,
  }, 'Trade-in', { lien_status: 'PROPOSED' });
  await audit(d, 'lien.release', 'trade_ins', tradeId, `Released lien payoff ${trade.lien_payoff_cents}`, { proposedBy: trade.lien_proposed_by });
  return row ?? trade;
}
