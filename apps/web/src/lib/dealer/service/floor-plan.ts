/**
 * Floor-plan subledger service (FPB §3.1–3.4, V1/V2): lines, programs, flooring,
 * interest accrual + lender true-up, curtailments, payoff proposal + release, fees.
 */

import { decideDisposition, loadAutonomyGovernance } from '@/lib/autonomy/disposition';
import { addDays, dayNumber, maxDate } from '../dates';
import { computeInterest, effectiveRateBps, interestTrueUp } from '../engine/interest';
import {
  applyPrincipalPayment,
  assertReleaser,
  parseCurtailmentRules,
  planFlooring,
  canAutoRelease,
} from '../engine/notes';
import { feePlan, flooringPlan, interestAccrualPlan, interestBilledPlan, openAccountFlooringPlan, principalPaymentPlan } from '../engine/floor-plan-postings';
import { normalizeRef } from '../engine/statement-match';
import { CARRIED_UNIT_STATUSES, LIVE_NOTE_STATUSES, type CollateralType, type DeptRole } from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';
import { loadDepartmentMap, loadRoleMap, postPlan, stableHash } from './posting';
import { byKey, coerceMoney, getRow, insertRow, updateRow, type FloorTxnRow, type LineRow, type NoteRow, type ProgramRow, type UnitRow, type CostRow } from './rows';
import { loadSettings, requireEnabled } from './settings';
import { findUnitBySerial, insertUnit, type NewUnitInput } from './units';
import { audit } from './audit';

/** Autonomy feature keys the dealer pack writes (report to lead for lib/autonomy/catalog.ts). */
export const DEALER_FLOORING_FEATURE = 'DEALER_FLOORING';
export const DEALER_INTEREST_FEATURE = 'DEALER_INTEREST_ACCRUAL';

// ── lines + programs ──────────────────────────────────────────────────────────

export interface LineInput {
  lenderVendorId: string;
  name: string;
  creditLimitCents: number;
  liabilityAccountId?: string | null;
  interestDueDay?: number | null;
  scheduledPaymentDay?: number | null;
  statementDay?: number | null;
  sauCodes?: string[];
  debtInstrumentId?: string | null;
  status?: LineRow['status'];
  notes?: string | null;
}

async function assertVendor(d: DealerCtx, vendorId: string, what: string): Promise<void> {
  const { data, error } = await d.admin.schema('core').from('vendors').select('id').eq('org_id', d.orgId).eq('id', vendorId).maybeSingle();
  if (error) dbFail(`${what} lookup failed`, error);
  if (!data) throw new DealerError('VALIDATION', `${what} is not a vendor in this organization`);
}

async function assertLiabilityAccount(d: DealerCtx, accountId: string): Promise<void> {
  const { data, error } = await d.admin
    .from('accounts')
    .select('id, account_type, is_active, company_location_id')
    .eq('org_id', d.orgId)
    .eq('id', accountId)
    .maybeSingle();
  if (error) dbFail('Account lookup failed', error);
  const a = data as { account_type: string; is_active: boolean; company_location_id: string | null } | null;
  if (!a || a.account_type !== 'LIABILITY' || !a.is_active || (a.company_location_id && a.company_location_id !== d.locationId)) {
    throw new DealerError('VALIDATION', "A line's own payable account must be an active LIABILITY account of this client");
  }
}

function lineValues(p: Partial<LineInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (p.lenderVendorId !== undefined) v.lender_vendor_id = p.lenderVendorId;
  if (p.name !== undefined) v.name = p.name;
  if (p.creditLimitCents !== undefined) v.credit_limit_cents = p.creditLimitCents;
  if (p.liabilityAccountId !== undefined) v.liability_account_id = p.liabilityAccountId;
  if (p.interestDueDay !== undefined) v.interest_due_day = p.interestDueDay;
  if (p.scheduledPaymentDay !== undefined) v.scheduled_payment_day = p.scheduledPaymentDay;
  if (p.statementDay !== undefined) v.statement_day = p.statementDay;
  if (p.sauCodes !== undefined) v.sau_codes = p.sauCodes;
  if (p.debtInstrumentId !== undefined) v.debt_instrument_id = p.debtInstrumentId;
  if (p.status !== undefined) v.status = p.status;
  if (p.notes !== undefined) v.notes = p.notes;
  return v;
}

export async function createLine(d: DealerCtx, input: LineInput): Promise<LineRow> {
  await assertVendor(d, input.lenderVendorId, 'Lender');
  if (input.liabilityAccountId) await assertLiabilityAccount(d, input.liabilityAccountId);
  const row = await insertRow<LineRow>(d, 'floor_plan_lines', { ...lineValues(input), created_by: d.userId }, 'Floor-plan line');
  await audit(d, 'line.create', 'floor_plan_lines', row.id, `Added floor-plan line ${input.name}`);
  return row;
}

export async function updateLine(d: DealerCtx, id: string, patch: Partial<LineInput>): Promise<LineRow> {
  const line = await getRow<LineRow>(d, 'floor_plan_lines', id, 'Floor-plan line');
  if (patch.lenderVendorId) await assertVendor(d, patch.lenderVendorId, 'Lender');
  if (patch.liabilityAccountId) await assertLiabilityAccount(d, patch.liabilityAccountId);
  if (patch.liabilityAccountId !== undefined && patch.liabilityAccountId !== line.liability_account_id) {
    const { count } = await d.admin.from('floor_plan_transactions').select('id', { count: 'exact', head: true })
      .eq('org_id', d.orgId).eq('line_id', id).eq('status', 'POSTED');
    if ((count ?? 0) > 0) throw new DealerError('CONFLICT', "The line's payable account cannot change once postings exist");
  }
  const row = await updateRow<LineRow>(d, 'floor_plan_lines', id, lineValues(patch), 'Floor-plan line');
  await audit(d, 'line.update', 'floor_plan_lines', id, `Updated floor-plan line ${line.name}`, { patch });
  return row ?? line;
}

export interface ProgramInput {
  lineId: string;
  oemVendorId?: string | null;
  name: string;
  freeFloorDays: number;
  rateType: 'FIXED' | 'INDEX_PLUS';
  rateBps: number;
  indexName?: string | null;
  indexRateBps?: number | null;
  spreadBps?: number | null;
  sauPenaltyRateBps?: number | null;
  dayCount: 'ACT_365' | 'ACT_360';
  payoffTerms: 'PAY_AS_SOLD' | 'DAYS_AFTER_SALE';
  payoffDays: number;
  maxTermDays?: number | null;
  curtailDemos?: boolean;
  curtailmentSchedule: unknown;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  status?: 'DRAFT' | 'ACTIVE' | 'RETIRED';
}

function programValues(p: Partial<ProgramInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const map: [keyof ProgramInput, string][] = [
    ['lineId', 'line_id'], ['oemVendorId', 'oem_vendor_id'], ['name', 'name'], ['freeFloorDays', 'free_floor_days'],
    ['rateType', 'rate_type'], ['rateBps', 'rate_bps'], ['indexName', 'index_name'], ['indexRateBps', 'index_rate_bps'],
    ['spreadBps', 'spread_bps'], ['sauPenaltyRateBps', 'sau_penalty_rate_bps'], ['dayCount', 'day_count'],
    ['payoffTerms', 'payoff_terms'], ['payoffDays', 'payoff_days'], ['maxTermDays', 'max_term_days'],
    ['curtailDemos', 'curtail_demos'], ['curtailmentSchedule', 'curtailment_schedule'],
    ['effectiveFrom', 'effective_from'], ['effectiveTo', 'effective_to'], ['status', 'status'],
  ];
  for (const [k, col] of map) if (p[k] !== undefined) v[col] = p[k];
  return v;
}

export async function createProgram(d: DealerCtx, input: ProgramInput): Promise<ProgramRow> {
  await getRow<LineRow>(d, 'floor_plan_lines', input.lineId, 'Floor-plan line');
  if (input.oemVendorId) await assertVendor(d, input.oemVendorId, 'Manufacturer');
  parseCurtailmentRules(input.curtailmentSchedule);
  effectiveRateBps({ rate_type: input.rateType, rate_bps: input.rateBps, index_rate_bps: input.indexRateBps, spread_bps: input.spreadBps });
  const row = await insertRow<ProgramRow>(d, 'floor_plan_programs', programValues(input), 'Floor-plan program');
  await audit(d, 'program.create', 'floor_plan_programs', row.id, `Added floor-plan program ${input.name}`);
  return row;
}

export async function updateProgram(d: DealerCtx, id: string, patch: Partial<ProgramInput>): Promise<ProgramRow> {
  const prog = await getRow<ProgramRow>(d, 'floor_plan_programs', id, 'Floor-plan program');
  if (patch.curtailmentSchedule !== undefined) parseCurtailmentRules(patch.curtailmentSchedule);
  if (patch.oemVendorId) await assertVendor(d, patch.oemVendorId, 'Manufacturer');
  const row = await updateRow<ProgramRow>(d, 'floor_plan_programs', id, programValues(patch), 'Floor-plan program');
  if (row) {
    effectiveRateBps(row);
  }
  await audit(d, 'program.update', 'floor_plan_programs', id, `Updated floor-plan program ${prog.name}`, { patch });
  return row ?? prog;
}

// ── flooring ──────────────────────────────────────────────────────────────────

export interface FloorInput {
  lineId: string;
  programId?: string | null;
  collateralType: CollateralType;
  lenderInvoiceNumber: string;
  flooredDate: string;
  principalCents: number;
  description?: string | null;
  scheduledDueDate?: string | null;
  /** WHOLE_GOOD: an existing unit, or a new unit to register. */
  unitId?: string | null;
  unit?: Omit<NewUnitInput, 'source'> & { source?: NewUnitInput['source'] };
  importBatchId?: string | null;
  /** Opening import (go-live): no GL; balances come from the migrated trial balance. */
  opening?: { interestAccruedThrough?: string | null } | null;
  /** Importer evidence for the autonomy dial: the DMS-reported unit invoice cost. */
  dmsInvoiceCostCents?: number | null;
}

export type FloorMode = 'PROPOSE' | 'POST_NOW' | 'AUTONOMY';

export interface FloorResult {
  note: NoteRow;
  unit: UnitRow | null;
  txn: FloorTxnRow;
  created: boolean;
  disposition: 'POSTED' | 'PROPOSED' | 'OPENING' | 'EXISTING';
  reason?: string;
}

export async function floorUnit(d: DealerCtx, input: FloorInput, mode: FloorMode): Promise<FloorResult> {
  if (!input.opening) await requireEnabled(d);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', input.lineId, 'Floor-plan line');
  if (line.status === 'CLOSED') throw new DealerError('CONFLICT', 'This floor-plan line is closed');
  const program = input.programId ? await getRow<ProgramRow>(d, 'floor_plan_programs', input.programId, 'Floor-plan program') : null;
  if (program && program.line_id !== line.id) throw new DealerError('VALIDATION', 'Program does not belong to this line');
  if (program && program.status !== 'ACTIVE') throw new DealerError('CONFLICT', `Program ${program.name} is not active`);
  if (input.collateralType === 'WHOLE_GOOD' && !input.unitId && !input.unit) {
    throw new DealerError('VALIDATION', 'A whole-good note needs a unit (unitId or unit)');
  }

  const serialKey = input.unitId ?? (input.unit ? normalizeRef(input.unit.serialNumber) : 'OA');
  const noteKey = `floor:${line.id}:${normalizeRef(input.lenderInvoiceNumber)}:${serialKey}`;
  const existingNote = await byKey<NoteRow>(d, 'floor_plan_notes', noteKey);
  if (existingNote) {
    // Re-importing the same flooring posts nothing (AC2).
    const txn = (await byKey<FloorTxnRow>(d, 'floor_plan_transactions', `fpt:floor:${existingNote.id}`))!;
    const unit = existingNote.unit_id ? await getRow<UnitRow>(d, 'dealer_units', existingNote.unit_id, 'Unit') : null;
    return { note: existingNote, unit, txn, created: false, disposition: 'EXISTING' };
  }

  // Resolve / register the unit.
  let unit: UnitRow | null = null;
  let preexisting = false;
  if (input.collateralType === 'WHOLE_GOOD') {
    if (input.unitId) {
      unit = await getRow<UnitRow>(d, 'dealer_units', input.unitId, 'Unit');
      preexisting = true;
    } else if (input.unit) {
      unit = await findUnitBySerial(d, input.unit.serialNumber, input.unit.makeVendorId ?? null);
      preexisting = !!unit;
      if (!unit) {
        unit = await insertUnit(d, {
          ...input.unit,
          source: input.unit.source ?? (input.opening ? 'OPENING' : 'LENDER'),
          receivedDate: input.unit.receivedDate ?? input.flooredDate,
          importBatchId: input.importBatchId ?? null,
        });
      }
    }
    if (!unit) throw new DealerError('VALIDATION', 'Unit could not be resolved');
    if (!CARRIED_UNIT_STATUSES.includes(unit.status)) throw new DealerError('CONFLICT', `Unit ${unit.serial_number} is ${unit.status} and cannot be floored`);
    if (unit.is_consignment) throw new DealerError('CONFLICT', 'Consignment units are not floored');
  }

  const flooring = planFlooring({ flooredDate: input.flooredDate, originalPrincipalCents: input.principalCents, program });
  const note = await insertRow<NoteRow>(d, 'floor_plan_notes', {
    line_id: line.id,
    program_id: program?.id ?? null,
    unit_id: unit?.id ?? null,
    collateral_type: input.collateralType,
    lender_invoice_number: input.lenderInvoiceNumber.trim(),
    description: input.description ?? null,
    floored_date: input.flooredDate,
    original_principal_cents: input.principalCents,
    principal_balance_cents: input.principalCents,
    free_floor_end_date: flooring.freeFloorEndDate,
    maturity_date: flooring.maturityDate,
    scheduled_due_date: input.scheduledDueDate ?? null,
    interest_accrued_through: input.opening?.interestAccruedThrough ?? input.flooredDate,
    is_opening: !!input.opening,
    import_batch_id: input.importBatchId ?? null,
    idempotency_key: noteKey,
    created_by: d.userId,
  }, `Floor-plan note ${input.lenderInvoiceNumber}`);

  if (flooring.curtailments.length > 0) {
    const { error } = await d.admin.from('floor_plan_curtailments').insert(
      flooring.curtailments.map((c) => ({
        org_id: d.orgId, location_id: d.locationId, note_id: note.id, sequence: c.sequence, due_date: c.dueDate, amount_cents: c.amountCents,
      })),
    );
    if (error) dbFail('Creating the curtailment schedule failed', error);
  }

  const opening = !!input.opening;
  const txn = await insertRow<FloorTxnRow>(d, 'floor_plan_transactions', {
    line_id: line.id,
    note_id: note.id,
    txn_type: opening ? 'OPENING' : 'FLOOR',
    txn_date: input.flooredDate,
    principal_cents: input.principalCents,
    status: opening ? 'POSTED' : 'PROPOSED',
    proposed_by: d.userId,
    posted_at: opening ? new Date().toISOString() : null,
    memo: opening ? 'Opening balance (no GL — ties to the migrated trial balance)' : null,
    idempotency_key: `fpt:floor:${note.id}`,
  }, 'Flooring transaction');

  if (unit) {
    await insertRow<CostRow>(d, 'dealer_unit_costs', {
      unit_id: unit.id,
      cost_type: 'BASE_INVOICE',
      amount_cents: input.principalCents,
      source_type: opening ? 'OPENING' : 'FLOOR_PLAN_NOTE',
      source_id: note.id,
      status: opening ? 'POSTED' : 'PROPOSED',
      idempotency_key: `cost:floor:${note.id}`,
      proposed_by: d.userId,
      posted_by: opening ? d.userId : null,
      posted_at: opening ? new Date().toISOString() : null,
    }, 'Base invoice cost');
  }

  if (opening) {
    return { note, unit, txn, created: true, disposition: 'OPENING' };
  }

  let post = mode === 'POST_NOW';
  let reason: string | undefined;
  if (mode === 'AUTONOMY') {
    // Exact match = the unit already came from the DMS and its DMS invoice cost equals
    // the lender's floored principal. Anything else is routed to a human.
    const exact = preexisting && input.dmsInvoiceCostCents != null && input.dmsInvoiceCostCents === input.principalCents;
    const gov = await loadAutonomyGovernance(d.db, d.orgId, DEALER_FLOORING_FEATURE);
    const decision = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: exact ? 'auto' : 'review',
      amountCents: input.principalCents,
    });
    post = decision.disposition === 'AUTO';
    reason = decision.reason;
  }
  if (!post) return { note, unit, txn, created: true, disposition: 'PROPOSED', reason };
  const posted = await postFlooring(d, txn.id, mode === 'AUTONOMY' ? `autonomy:${DEALER_FLOORING_FEATURE}` : d.userId);
  return { note: posted.note, unit, txn: posted.txn, created: true, disposition: 'POSTED', reason };
}

/** Approve + post a PROPOSED flooring transaction. */
export async function postFlooring(d: DealerCtx, txnId: string, approvedBy: string = d.userId): Promise<{ txn: FloorTxnRow; note: NoteRow }> {
  await requireEnabled(d);
  const txn = await getRow<FloorTxnRow>(d, 'floor_plan_transactions', txnId, 'Flooring transaction');
  if (txn.txn_type !== 'FLOOR') throw new DealerError('VALIDATION', 'Not a flooring transaction');
  const note = await getRow<NoteRow>(d, 'floor_plan_notes', txn.note_id!, 'Floor-plan note');
  if (txn.status === 'POSTED') return { txn, note };
  if (txn.status !== 'PROPOSED') throw new DealerError('CONFLICT', `A ${txn.status} flooring cannot be posted`);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', note.line_id, 'Floor-plan line');
  const unit = note.unit_id ? await getRow<UnitRow>(d, 'dealer_units', note.unit_id, 'Unit') : null;
  const memo = `Floor plan: ${line.name} inv ${note.lender_invoice_number}${unit ? ` S/N ${unit.serial_number}` : ' (open account)'}`;
  const plan = unit
    ? flooringPlan({ principalCents: note.original_principal_cents, inventoryRole: unit.inventory_role, deptRole: unit.department_role, lineLiabilityAccountId: line.liability_account_id, memo })
    : openAccountFlooringPlan({ principalCents: note.original_principal_cents, lineLiabilityAccountId: line.liability_account_id, memo });
  const posted = await postPlan(d, plan, { entryDate: txn.txn_date, key: `fpt:${txn.id}`, sourceId: note.id });
  const now = new Date().toISOString();
  const updated = await updateRow<FloorTxnRow>(
    d, 'floor_plan_transactions', txn.id,
    { status: 'POSTED', gl_entry_id: posted.glEntryId, approved_by: approvedBy, posted_at: now },
    'Flooring transaction', { status: 'PROPOSED' },
  );
  if (unit) {
    const { error } = await d.admin
      .from('dealer_unit_costs')
      .update({ status: 'POSTED', gl_entry_id: posted.glEntryId, posted_by: approvedBy, posted_at: now })
      .eq('org_id', d.orgId).eq('idempotency_key', `cost:floor:${note.id}`).eq('status', 'PROPOSED');
    if (error) dbFail('Posting the base cost failed', error);
  }
  return { txn: updated ?? (await getRow<FloorTxnRow>(d, 'floor_plan_transactions', txn.id, 'Flooring transaction')), note };
}

/** Void a flooring that was never posted (wrong import line). */
export async function voidFlooring(d: DealerCtx, txnId: string, reason: string): Promise<void> {
  const txn = await getRow<FloorTxnRow>(d, 'floor_plan_transactions', txnId, 'Flooring transaction');
  if (txn.txn_type !== 'FLOOR' || txn.status !== 'PROPOSED') throw new DealerError('CONFLICT', 'Only a proposed flooring can be voided');
  await updateRow(d, 'floor_plan_transactions', txn.id, { status: 'VOID', disposition: reason }, 'Flooring transaction', { status: 'PROPOSED' });
  await updateRow(d, 'floor_plan_notes', txn.note_id!, { status: 'VOID' }, 'Floor-plan note');
  await d.admin.from('dealer_unit_costs').update({ status: 'VOID' }).eq('org_id', d.orgId).eq('idempotency_key', `cost:floor:${txn.note_id}`).eq('status', 'PROPOSED');
  await d.admin.from('floor_plan_curtailments').update({ status: 'WAIVED', waived_by: d.userId, waived_reason: 'Flooring voided' }).eq('org_id', d.orgId).eq('note_id', txn.note_id!).eq('status', 'DUE');
  await audit(d, 'floor.void', 'floor_plan_transactions', txn.id, `Voided proposed flooring: ${reason}`);
}

// ── curtailments ──────────────────────────────────────────────────────────────

async function deptForNote(d: DealerCtx, note: NoteRow): Promise<DeptRole> {
  if (!note.unit_id) return 'PARTS';
  const unit = await getRow<UnitRow>(d, 'dealer_units', note.unit_id, 'Unit');
  return unit.department_role;
}

export interface CurtailmentPayment {
  curtailmentId?: string | null;
  noteId?: string | null;
  amountCents?: number | null;
  paidDate: string;
  bankTransactionId?: string | null;
}

/**
 * Record a curtailment paid (or the lender's auto-debit matched on the bank feed):
 * DR floor plan payable / CR bank. Unit cost is unchanged (FPB §3.3).
 */
export async function payCurtailment(d: DealerCtx, input: CurtailmentPayment): Promise<{ txn: FloorTxnRow; note: NoteRow }> {
  await requireEnabled(d);
  let noteId = input.noteId ?? null;
  let amount = input.amountCents ?? null;
  let curt: { id: string; note_id: string; amount_cents: number; status: string } | null = null;
  if (input.curtailmentId) {
    curt = await getRow(d, 'floor_plan_curtailments', input.curtailmentId, 'Curtailment');
    if (curt!.status === 'PAID') throw new DealerError('CONFLICT', 'This curtailment is already paid');
    if (curt!.status === 'WAIVED') throw new DealerError('CONFLICT', 'This curtailment was waived');
    noteId = curt!.note_id;
    amount = amount ?? Number(curt!.amount_cents);
  }
  if (!noteId || !amount) throw new DealerError('VALIDATION', 'Give a curtailmentId, or a noteId and amountCents');
  const note = await getRow<NoteRow>(d, 'floor_plan_notes', noteId, 'Floor-plan note');
  const next = applyPrincipalPayment(note, amount);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', note.line_id, 'Floor-plan line');
  const key = curt ? `fpt:curt:${curt.id}` : `fpt:curt:${note.id}:${input.paidDate}:${amount}`;
  const existing = await byKey<FloorTxnRow>(d, 'floor_plan_transactions', key);
  if (existing) return { txn: existing, note };

  const plan = principalPaymentPlan({
    amountCents: amount, deptRole: await deptForNote(d, note), kind: 'CURTAILMENT',
    lineLiabilityAccountId: line.liability_account_id, memo: `Curtailment: ${line.name} inv ${note.lender_invoice_number}`,
  });
  const posted = await postPlan(d, plan, { entryDate: input.paidDate, key, sourceId: note.id });
  const txn = await insertRow<FloorTxnRow>(d, 'floor_plan_transactions', {
    line_id: note.line_id, note_id: note.id, txn_type: 'CURTAILMENT', txn_date: input.paidDate, principal_cents: amount,
    status: 'POSTED', gl_entry_id: posted.glEntryId, bank_transaction_id: input.bankTransactionId ?? null,
    curtailment_id: curt?.id ?? null, proposed_by: d.userId, approved_by: d.userId, posted_at: new Date().toISOString(),
    idempotency_key: key,
  }, 'Curtailment');
  const updatedNote = await updateRow<NoteRow>(
    d, 'floor_plan_notes', note.id,
    { principal_balance_cents: next.balanceCents, status: next.status, ...(next.status === 'PAID_OFF' ? { paid_off_date: input.paidDate } : {}) },
    'Floor-plan note', { principal_balance_cents: note.principal_balance_cents },
  );
  if (!updatedNote) throw new DealerError('CONFLICT', 'The note changed while recording the curtailment — refresh and retry');
  if (curt) await updateRow(d, 'floor_plan_curtailments', curt.id, { status: 'PAID', paid_txn_id: txn.id }, 'Curtailment');
  return { txn, note: updatedNote };
}

export async function waiveCurtailment(d: DealerCtx, curtailmentId: string, reason: string): Promise<void> {
  const c = await getRow<{ status: string }>(d, 'floor_plan_curtailments', curtailmentId, 'Curtailment');
  if (c.status !== 'DUE' && c.status !== 'MISSED') throw new DealerError('CONFLICT', `A ${c.status} curtailment cannot be waived`);
  await updateRow(d, 'floor_plan_curtailments', curtailmentId, { status: 'WAIVED', waived_by: d.userId, waived_reason: reason }, 'Curtailment');
  await audit(d, 'curtailment.waive', 'floor_plan_curtailments', curtailmentId, `Waived curtailment: ${reason}`);
}

// ── payoff: propose (anyone who records a sale) → release (a different person) ─

export async function proposePayoff(d: DealerCtx, noteId: string, proposedDate: string): Promise<FloorTxnRow> {
  const note = await getRow<NoteRow>(d, 'floor_plan_notes', noteId, 'Floor-plan note');
  if (!LIVE_NOTE_STATUSES.includes(note.status)) throw new DealerError('CONFLICT', `A ${note.status} note has nothing to pay off`);
  const key = `fpt:payoff:${note.id}`;
  const existing = await byKey<FloorTxnRow>(d, 'floor_plan_transactions', key);
  if (existing && existing.status !== 'VOID') {
    // Keep the open proposal current with the latest balance (curtailments since).
    if (existing.status === 'PROPOSED' && existing.principal_cents !== note.principal_balance_cents) {
      return (await updateRow<FloorTxnRow>(d, 'floor_plan_transactions', existing.id, { principal_cents: note.principal_balance_cents }, 'Payoff', { status: 'PROPOSED' })) ?? existing;
    }
    return existing;
  }
  return insertRow<FloorTxnRow>(d, 'floor_plan_transactions', {
    line_id: note.line_id, note_id: note.id, txn_type: 'PAYOFF', txn_date: proposedDate,
    principal_cents: note.principal_balance_cents, status: 'PROPOSED', proposed_by: d.userId,
    memo: canAutoRelease() ? null : 'Proposed payoff — a different person must release it', idempotency_key: key,
  }, 'Payoff proposal');
}

export async function releasePayoff(
  d: DealerCtx,
  txnId: string,
  input: { paidDate: string; bankTransactionId?: string | null; paymentId?: string | null },
): Promise<{ txn: FloorTxnRow; note: NoteRow }> {
  await requireEnabled(d);
  const txn = await getRow<FloorTxnRow>(d, 'floor_plan_transactions', txnId, 'Payoff');
  if (txn.txn_type !== 'PAYOFF') throw new DealerError('VALIDATION', 'Not a payoff');
  const note = await getRow<NoteRow>(d, 'floor_plan_notes', txn.note_id!, 'Floor-plan note');
  if (txn.status === 'POSTED') return { txn, note };
  if (txn.status !== 'PROPOSED') throw new DealerError('CONFLICT', `A ${txn.status} payoff cannot be released`);
  try {
    assertReleaser(txn.proposed_by, d.userId);
  } catch (e) {
    throw new DealerError('SEPARATION_OF_DUTIES', (e as Error).message);
  }
  const amount = note.principal_balance_cents;
  if (amount <= 0) throw new DealerError('CONFLICT', 'The note has no balance left');
  const next = applyPrincipalPayment(note, amount);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', note.line_id, 'Floor-plan line');
  const plan = principalPaymentPlan({
    amountCents: amount, deptRole: await deptForNote(d, note), kind: 'PAYOFF',
    lineLiabilityAccountId: line.liability_account_id, memo: `Payoff: ${line.name} inv ${note.lender_invoice_number}`,
  });
  const posted = await postPlan(d, plan, { entryDate: input.paidDate, key: `fpt:${txn.id}`, sourceId: note.id });
  const updated = await updateRow<FloorTxnRow>(
    d, 'floor_plan_transactions', txn.id,
    {
      status: 'POSTED', principal_cents: amount, txn_date: input.paidDate, gl_entry_id: posted.glEntryId, released_by: d.userId,
      approved_by: d.userId, bank_transaction_id: input.bankTransactionId ?? null, payment_id: input.paymentId ?? null,
      posted_at: new Date().toISOString(),
    },
    'Payoff', { status: 'PROPOSED' },
  );
  const updatedNote = await updateRow<NoteRow>(
    d, 'floor_plan_notes', note.id,
    { principal_balance_cents: next.balanceCents, status: 'PAID_OFF', paid_off_date: input.paidDate },
    'Floor-plan note', { principal_balance_cents: note.principal_balance_cents },
  );
  // Remaining scheduled curtailments are moot once paid off.
  await d.admin.from('floor_plan_curtailments').update({ status: 'WAIVED', waived_by: d.userId, waived_reason: 'Note paid off' })
    .eq('org_id', d.orgId).eq('note_id', note.id).in('status', ['DUE', 'MISSED']);
  await audit(d, 'payoff.release', 'floor_plan_transactions', txn.id, `Released payoff ${amount} on ${line.name} inv ${note.lender_invoice_number}`, {
    proposedBy: txn.proposed_by,
  });
  return {
    txn: updated ?? (await getRow<FloorTxnRow>(d, 'floor_plan_transactions', txn.id, 'Payoff')),
    note: updatedNote ?? (await getRow<NoteRow>(d, 'floor_plan_notes', note.id, 'Floor-plan note')),
  };
}

// ── interest ──────────────────────────────────────────────────────────────────

export interface AccrualPreviewRow {
  noteId: string;
  lineId: string;
  unitId: string | null;
  deptRole: DeptRole;
  fromExclusive: string;
  toInclusive: string;
  rateBps: number;
  interestBearingDays: number;
  penaltyDays: number;
  interestCents: number;
}

export interface AccrualResult {
  periodEnd: string;
  rows: AccrualPreviewRow[];
  totalCents: number;
  skipped: { noteId: string; reason: string }[];
  posted: boolean;
  glEntryId: string | null;
}

/**
 * Month-end (or any date) accrual for every note with interest-bearing days since its
 * last accrual. `post=false` → preview + PROPOSED rows; `post=true` → one batch JE
 * (a line per department) and POSTED rows; notes advance interest_accrued_through.
 */
export async function accrueInterest(d: DealerCtx, input: { periodEnd: string; post: boolean }): Promise<AccrualResult> {
  if (input.post) await requireEnabled(d);
  const { data: notesRaw, error } = await d.admin
    .from('floor_plan_notes')
    .select('*')
    .eq('org_id', d.orgId)
    .eq('location_id', d.locationId)
    .in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT', 'PAID_OFF', 'RETURNED'])
    .lt('interest_accrued_through', input.periodEnd);
  if (error) dbFail('Note lookup failed', error);
  const notes = ((notesRaw ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<NoteRow>(r));
  const programIds = [...new Set(notes.map((n) => n.program_id).filter((x): x is string => !!x))];
  const unitIds = [...new Set(notes.map((n) => n.unit_id).filter((x): x is string => !!x))];
  const noteIds = notes.map((n) => n.id);
  const [progRes, unitRes, txnRes] = await Promise.all([
    programIds.length ? d.admin.from('floor_plan_programs').select('*').eq('org_id', d.orgId).in('id', programIds) : Promise.resolve({ data: [], error: null }),
    unitIds.length ? d.admin.from('dealer_units').select('id, department_role').eq('org_id', d.orgId).in('id', unitIds) : Promise.resolve({ data: [], error: null }),
    noteIds.length
      ? d.admin.from('floor_plan_transactions').select('note_id, txn_type, txn_date, principal_cents, status').eq('org_id', d.orgId).in('note_id', noteIds).eq('status', 'POSTED').in('txn_type', ['CURTAILMENT', 'PAYOFF', 'ADJUSTMENT'])
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [progRes, unitRes, txnRes]) if (r.error) dbFail('Accrual inputs lookup failed', r.error);
  const programs = new Map(((progRes.data ?? []) as ProgramRow[]).map((p) => [p.id, p]));
  const deptByUnit = new Map(((unitRes.data ?? []) as { id: string; department_role: DeptRole }[]).map((u) => [u.id, u.department_role]));
  const paydowns = new Map<string, { date: string; cents: number }[]>();
  for (const t of (txnRes.data ?? []) as { note_id: string; txn_date: string; principal_cents: number }[]) {
    const list = paydowns.get(t.note_id) ?? [];
    list.push({ date: t.txn_date, cents: Number(t.principal_cents) });
    paydowns.set(t.note_id, list);
  }

  const rows: AccrualPreviewRow[] = [];
  const skipped: { noteId: string; reason: string }[] = [];
  const settledNoBalance: string[] = [];
  for (const n of notes) {
    const from = n.interest_accrued_through ?? n.floored_date;
    if (dayNumber(input.periodEnd) <= dayNumber(from)) continue;
    const program = n.program_id ? programs.get(n.program_id) : undefined;
    if (!program) {
      skipped.push({ noteId: n.id, reason: 'No floor-plan program on the note — no rate to accrue' });
      continue;
    }
    // Reconstruct the balance timeline backwards from today's balance: the balance at
    // the window start = current balance + every paydown dated after it.
    const later = (paydowns.get(n.id) ?? []).filter((p) => dayNumber(p.date) > dayNumber(from));
    const startBalance = n.principal_balance_cents + later.reduce((s, p) => s + p.cents, 0);
    if (startBalance <= 0) {
      if (!LIVE_NOTE_STATUSES.includes(n.status)) settledNoBalance.push(n.id);
      continue;
    }
    const rate = effectiveRateBps(program);
    const r = computeInterest({
      originalPrincipalCents: startBalance,
      events: later.map((p) => ({ date: p.date, deltaCents: -p.cents })),
      freeFloorEndDate: n.free_floor_end_date ?? n.floored_date,
      rateBps: rate,
      dayCount: program.day_count,
      fromExclusive: from,
      toInclusive: input.periodEnd,
      payoffDueDate: n.payoff_due_date,
      penaltyRateBps: program.sau_penalty_rate_bps,
    });
    rows.push({
      noteId: n.id, lineId: n.line_id, unitId: n.unit_id,
      deptRole: n.unit_id ? (deptByUnit.get(n.unit_id) ?? 'WG_NEW') : 'PARTS',
      fromExclusive: from, toInclusive: input.periodEnd, rateBps: rate,
      interestBearingDays: r.interestBearingDays, penaltyDays: r.penaltyDays, interestCents: r.interestCents,
    });
  }
  // Persist each note's accrual for this period as a PROPOSED row (idempotent by key).
  // A note whose accrual for this period is already POSTED is never accrued twice.
  const pending: AccrualPreviewRow[] = [];
  for (const r of rows) {
    const key = `fpt:int:${r.noteId}:${input.periodEnd}`;
    const existing = await byKey<FloorTxnRow>(d, 'floor_plan_transactions', key);
    if (existing?.status === 'POSTED') {
      skipped.push({ noteId: r.noteId, reason: 'Already accrued for this period' });
      continue;
    }
    pending.push(r);
    if (existing) {
      await updateRow(d, 'floor_plan_transactions', existing.id, { interest_cents: r.interestCents }, 'Accrual', { status: 'PROPOSED' });
    } else {
      await insertRow(d, 'floor_plan_transactions', {
        line_id: r.lineId, note_id: r.noteId, txn_type: 'INTEREST_ACCRUAL', txn_date: input.periodEnd, period_end: input.periodEnd,
        interest_cents: r.interestCents, status: 'PROPOSED', proposed_by: d.userId, idempotency_key: key,
        memo: `${r.interestBearingDays} interest-bearing days at ${r.rateBps} bps`,
      }, 'Interest accrual');
    }
  }
  const totalCents = pending.reduce((s, r) => s + r.interestCents, 0);
  if (!input.post || totalCents === 0) {
    return { periodEnd: input.periodEnd, rows: pending, totalCents, skipped, posted: false, glEntryId: null };
  }

  const plan = interestAccrualPlan(pending.map((r) => ({ amountCents: r.interestCents, deptRole: r.deptRole })), `Floor plan interest accrual through ${input.periodEnd}`);
  const posted = await postPlan(d, plan, {
    entryDate: input.periodEnd,
    key: `int:${d.locationId}:${input.periodEnd}:${stableHash(pending.map((r) => r.noteId))}`,
    roleMap: await loadRoleMap(d),
    deptMap: await loadDepartmentMap(d),
  });
  const now = new Date().toISOString();
  for (const r of pending) {
    const { error: uErr } = await d.admin
      .from('floor_plan_transactions')
      .update({ status: 'POSTED', gl_entry_id: posted.glEntryId, approved_by: d.userId, posted_at: now })
      .eq('org_id', d.orgId).eq('idempotency_key', `fpt:int:${r.noteId}:${input.periodEnd}`).eq('status', 'PROPOSED');
    if (uErr) dbFail('Marking accruals posted failed', uErr);
    await updateRow(d, 'floor_plan_notes', r.noteId, { interest_accrued_through: input.periodEnd }, 'Floor-plan note');
  }
  // Settled notes with nothing left to accrue stop being re-scanned.
  for (const n of settledNoBalance) {
    await updateRow(d, 'floor_plan_notes', n, { interest_accrued_through: input.periodEnd }, 'Floor-plan note');
  }
  return { periodEnd: input.periodEnd, rows: pending, totalCents, skipped, posted: true, glEntryId: posted.glEntryId };
}

/** Outstanding accrued (posted, not yet cleared) interest on a line. */
export async function accruedOutstanding(d: DealerCtx, lineId: string): Promise<number> {
  const { data, error } = await d.admin
    .from('floor_plan_transactions')
    .select('txn_type, interest_cents, accrual_cleared_cents')
    .eq('org_id', d.orgId).eq('line_id', lineId).eq('status', 'POSTED')
    .in('txn_type', ['INTEREST_ACCRUAL', 'INTEREST_BILLED', 'INTEREST_PAID']);
  if (error) dbFail('Accrued interest lookup failed', error);
  let out = 0;
  for (const t of (data ?? []) as { txn_type: string; interest_cents: number; accrual_cleared_cents: number }[]) {
    out += t.txn_type === 'INTEREST_ACCRUAL' ? Number(t.interest_cents) : -Number(t.accrual_cleared_cents);
  }
  return out;
}

export interface InterestBilledInput {
  lineId: string;
  billedCents: number;
  billDate: string;
  /** Defaults to the line's whole outstanding accrual. */
  accrualClearedCents?: number | null;
  bankTransactionId?: string | null;
  /** Post a true-up beyond tolerance (needs approval permission; checked by the route). */
  acceptVariance?: boolean;
  reference?: string | null;
}

/** §3.2.3: the lender bill/debit clears the accrual; the difference is a true-up (DL-9 over tolerance). */
export async function recordInterestBilled(d: DealerCtx, input: InterestBilledInput): Promise<{ txn: FloorTxnRow; trueUpCents: number }> {
  const settings = await requireEnabled(d);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', input.lineId, 'Floor-plan line');
  const key = `fpt:billed:${line.id}:${input.billDate}:${input.reference ?? input.billedCents}`;
  const existing = await byKey<FloorTxnRow>(d, 'floor_plan_transactions', key);
  if (existing) return { txn: existing, trueUpCents: Number(existing.interest_cents) - Number(existing.accrual_cleared_cents) };
  const outstanding = await accruedOutstanding(d, line.id);
  const cleared = Math.max(0, Math.min(input.accrualClearedCents ?? outstanding, outstanding));
  const t = interestTrueUp({
    billedCents: input.billedCents, accruedCents: cleared,
    toleranceCents: settings.interest_tolerance_cents, toleranceBps: settings.interest_tolerance_bps,
  });
  if (!t.withinTolerance && !input.acceptVariance) {
    throw new DealerError('INTEREST_VARIANCE', `Billed interest differs from the accrual by ${t.trueUpCents}¢ (tolerance ${t.toleranceAppliedCents}¢). Review before posting.`, {
      billedCents: input.billedCents, accruedCents: cleared, trueUpCents: t.trueUpCents, toleranceCents: t.toleranceAppliedCents, detector: 'DL-9',
    });
  }
  const plan = interestBilledPlan({ billedCents: input.billedCents, accrualClearedCents: cleared, deptRole: 'WG_NEW', memo: `Floor plan interest billed: ${line.name} ${input.billDate}` });
  const posted = await postPlan(d, plan, { entryDate: input.billDate, key });
  const txn = await insertRow<FloorTxnRow>(d, 'floor_plan_transactions', {
    line_id: line.id, note_id: null, txn_type: 'INTEREST_BILLED', txn_date: input.billDate,
    interest_cents: input.billedCents, accrual_cleared_cents: cleared, status: 'POSTED', gl_entry_id: posted.glEntryId,
    bank_transaction_id: input.bankTransactionId ?? null, proposed_by: d.userId, approved_by: d.userId,
    posted_at: new Date().toISOString(), memo: input.reference ?? null, disposition: t.withinTolerance ? null : 'VARIANCE_ACCEPTED',
    idempotency_key: key,
  }, 'Interest billed');
  return { txn, trueUpCents: t.trueUpCents };
}

export async function recordFee(
  d: DealerCtx,
  input: { lineId: string; noteId?: string | null; feeCents: number; feeDate: string; memo: string; bankTransactionId?: string | null },
): Promise<FloorTxnRow> {
  await requireEnabled(d);
  const line = await getRow<LineRow>(d, 'floor_plan_lines', input.lineId, 'Floor-plan line');
  const note = input.noteId ? await getRow<NoteRow>(d, 'floor_plan_notes', input.noteId, 'Floor-plan note') : null;
  if (note && note.line_id !== line.id) throw new DealerError('VALIDATION', 'Note is not on this line');
  const key = `fpt:fee:${line.id}:${note?.id ?? '-'}:${input.feeDate}:${input.feeCents}:${stableHash([input.memo])}`;
  const existing = await byKey<FloorTxnRow>(d, 'floor_plan_transactions', key);
  if (existing) return existing;
  const plan = feePlan({ feeCents: input.feeCents, deptRole: note ? await deptForNote(d, note) : 'WG_NEW', memo: `Floor plan fee: ${line.name} — ${input.memo}` });
  const posted = await postPlan(d, plan, { entryDate: input.feeDate, key });
  return insertRow<FloorTxnRow>(d, 'floor_plan_transactions', {
    line_id: line.id, note_id: note?.id ?? null, txn_type: 'FEE', txn_date: input.feeDate, fee_cents: input.feeCents,
    status: 'POSTED', gl_entry_id: posted.glEntryId, bank_transaction_id: input.bankTransactionId ?? null,
    proposed_by: d.userId, approved_by: d.userId, posted_at: new Date().toISOString(), memo: input.memo, idempotency_key: key,
  }, 'Fee');
}

/** Mark DUE curtailments past their date as MISSED (DL-2 input; nightly). */
export async function markMissedCurtailments(d: DealerCtx, asOf: string): Promise<number> {
  const { data, error } = await d.admin
    .from('floor_plan_curtailments')
    .update({ status: 'MISSED' })
    .eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'DUE').lt('due_date', asOf)
    .select('id');
  if (error) dbFail('Marking missed curtailments failed', error);
  return (data ?? []).length;
}

/** First day after the last accrual — for UI hints. */
export function nextAccrualStart(note: Pick<NoteRow, 'interest_accrued_through' | 'floored_date' | 'free_floor_end_date'>): string {
  const from = note.interest_accrued_through ?? note.floored_date;
  return addDays(maxDate(from, note.free_floor_end_date ?? from), 1);
}

export { loadSettings };

export interface NoteDetail {
  note: NoteRow;
  transactions: FloorTxnRow[];
  curtailments: { id: string; sequence: number; due_date: string; amount_cents: number; status: string; paid_txn_id: string | null }[];
}

/** One note with its money events and curtailment schedule (RLS reads). */
export async function getNoteDetail(d: DealerCtx, noteId: string): Promise<NoteDetail> {
  const [n, t, c] = await Promise.all([
    d.db.from('floor_plan_notes').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', noteId).maybeSingle(),
    d.db.from('floor_plan_transactions').select('*').eq('org_id', d.orgId).eq('note_id', noteId).order('txn_date').order('created_at'),
    d.db.from('floor_plan_curtailments').select('id, sequence, due_date, amount_cents, status, paid_txn_id').eq('org_id', d.orgId).eq('note_id', noteId).order('sequence'),
  ]);
  for (const r of [n, t, c]) if (r.error) dbFail('Note detail lookup failed', r.error);
  if (!n.data) throw new DealerError('NOT_FOUND', 'Floor-plan note not found for this client');
  return {
    note: coerceMoney<NoteRow>(n.data as Record<string, unknown>),
    transactions: ((t.data ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<FloorTxnRow>(r)),
    curtailments: ((c.data ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<NoteDetail['curtailments'][number]>(r)),
  };
}
