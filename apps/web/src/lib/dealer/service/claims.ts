/**
 * Manufacturer receivables: warranty claims (FPB §3.8, V6) and incentive programs +
 * claims (FPB §3.9, V7). Every money event lands in dealer_claim_events with its JE.
 */

import { addDays } from '../dates';
import {
  assertClaimFoots,
  assertResolvable,
  assertSettleable,
  computeClaim,
  openCents,
  receivableSettlementPlan,
  recognitionPlan,
  statusAfterSettlement,
  warrantyDebitPlan,
  warrantyWriteOffPlan,
} from '../engine/warranty';
import { incentiveAccrualPlan, incentiveWriteOffPlan, defaultTreatment } from '../engine/incentive';
import type { DealerRole } from '../roles';
import type { ClaimEventType, IncentiveTreatment, OemSettlementMethod, ProgramType, WarrantyStatus } from '../types';
import type { DealerCtx } from './context';
import { DealerError } from './errors';
import { loadRoleMap, postPlan } from './posting';
import { byKey, getRow, insertRow, updateRow, type CostRow, type IncentiveRow, type UnitRow, type WarrantyRow } from './rows';
import { loadSettings, requireEnabled } from './settings';
import { audit } from './audit';

async function event(
  d: DealerCtx,
  e: {
    kind: 'WARRANTY' | 'INCENTIVE';
    claimId: string;
    type: ClaimEventType;
    date: string;
    amountCents: number;
    glEntryId?: string | null;
    oemStatementLineId?: string | null;
    note?: string | null;
    key: string;
  },
): Promise<void> {
  if (await byKey(d, 'dealer_claim_events', e.key)) return;
  await insertRow(d, 'dealer_claim_events', {
    claim_kind: e.kind,
    warranty_claim_id: e.kind === 'WARRANTY' ? e.claimId : null,
    incentive_claim_id: e.kind === 'INCENTIVE' ? e.claimId : null,
    event_type: e.type,
    event_date: e.date,
    amount_cents: e.amountCents,
    gl_entry_id: e.glEntryId ?? null,
    oem_statement_line_id: e.oemStatementLineId ?? null,
    actor: d.userId,
    note: e.note ?? null,
    idempotency_key: e.key,
  }, 'Claim event');
}

// ── warranty ──────────────────────────────────────────────────────────────────

export interface WarrantyInput {
  oemVendorId: string;
  oemClaimNumber?: string | null;
  dealerClaimRef?: string | null;
  repairOrderRef?: string | null;
  jobId?: string | null;
  unitId?: string | null;
  serialNumber?: string | null;
  customerId?: string | null;
  failureDate?: string | null;
  repairDate?: string | null;
  filingDeadline?: string | null;
  laborHours: number | string;
  laborRateCents: number;
  partsCostCents: number;
  partsMarkupBps: number;
  subletCents?: number;
  freightCents?: number;
  otherCents?: number;
  importBatchId?: string | null;
}

function warrantyValues(w: WarrantyInput): Record<string, unknown> {
  const c = computeClaim({
    laborHours: w.laborHours, laborRateCents: w.laborRateCents, partsCostCents: w.partsCostCents, partsMarkupBps: w.partsMarkupBps,
    subletCents: w.subletCents ?? 0, freightCents: w.freightCents ?? 0, otherCents: w.otherCents ?? 0,
  });
  return {
    oem_vendor_id: w.oemVendorId,
    oem_claim_number: w.oemClaimNumber ?? null,
    dealer_claim_ref: w.dealerClaimRef ?? null,
    repair_order_ref: w.repairOrderRef ?? null,
    job_id: w.jobId ?? null,
    unit_id: w.unitId ?? null,
    serial_number: w.serialNumber ?? null,
    customer_id: w.customerId ?? null,
    failure_date: w.failureDate ?? null,
    repair_date: w.repairDate ?? null,
    filing_deadline: w.filingDeadline ?? null,
    labor_hours: (c.laborHoursHundredths / 100).toFixed(2),
    labor_rate_cents: w.laborRateCents,
    labor_cents: c.laborCents,
    parts_cost_cents: w.partsCostCents,
    parts_markup_bps: w.partsMarkupBps,
    parts_cents: c.partsCents,
    sublet_cents: c.subletCents,
    freight_cents: c.freightCents,
    other_cents: c.otherCents,
    claimed_cents: c.claimedCents,
    import_batch_id: w.importBatchId ?? null,
  };
}

export async function createWarrantyClaim(d: DealerCtx, input: WarrantyInput): Promise<WarrantyRow> {
  const values = warrantyValues(input);
  assertClaimFoots(values as Parameters<typeof assertClaimFoots>[0]);
  if (input.unitId) await getRow<UnitRow>(d, 'dealer_units', input.unitId, 'Unit');
  return insertRow<WarrantyRow>(d, 'warranty_claims', { ...values, created_by: d.userId }, 'Warranty claim');
}

export async function updateWarrantyClaim(d: DealerCtx, id: string, input: WarrantyInput): Promise<WarrantyRow> {
  const claim = await getRow<WarrantyRow>(d, 'warranty_claims', id, 'Warranty claim');
  if (claim.status !== 'DRAFT') throw new DealerError('CONFLICT', 'Only a draft claim can be edited');
  return (await updateRow<WarrantyRow>(d, 'warranty_claims', id, warrantyValues(input), 'Warranty claim', { status: 'DRAFT' })) ?? claim;
}

async function recognize(d: DealerCtx, claim: WarrantyRow, date: string): Promise<string> {
  if (claim.recognized_gl_entry_id) return claim.recognized_gl_entry_id;
  const settings = await loadSettings(d);
  const plan = recognitionPlan({
    laborCents: claim.labor_cents, partsCents: claim.parts_cents, subletCents: claim.sublet_cents, freightCents: claim.freight_cents,
    otherCents: claim.other_cents, partsCostCents: claim.parts_cost_cents, relieveParts: settings.warranty_relieve_parts_inventory,
    memo: `Warranty claim ${claim.oem_claim_number ?? claim.id.slice(0, 8)}`,
  });
  const posted = await postPlan(d, plan, { entryDate: date, key: `wty:rec:${claim.id}`, sourceId: claim.id });
  await updateRow(d, 'warranty_claims', claim.id, { recognized_gl_entry_id: posted.glEntryId, gl_entry_id: posted.glEntryId }, 'Warranty claim');
  await event(d, { kind: 'WARRANTY', claimId: claim.id, type: 'RECOGNIZED', date, amountCents: claim.claimed_cents, glEntryId: posted.glEntryId, key: `wev:rec:${claim.id}` });
  return posted.glEntryId;
}

/** Repair order closed: recognizes the receivable when the client's policy is ON_RO_CLOSE. */
export async function closeRepairOrder(d: DealerCtx, claimId: string, roClosedDate: string): Promise<WarrantyRow> {
  const settings = await requireEnabled(d);
  const claim = await getRow<WarrantyRow>(d, 'warranty_claims', claimId, 'Warranty claim');
  await updateRow(d, 'warranty_claims', claimId, { ro_closed_date: roClosedDate }, 'Warranty claim');
  if (settings.warranty_recognition === 'ON_RO_CLOSE') await recognize(d, claim, roClosedDate);
  return getRow<WarrantyRow>(d, 'warranty_claims', claimId, 'Warranty claim');
}

/** Submitted to the manufacturer: the receivable exists from here at the latest. */
export async function submitWarrantyClaim(d: DealerCtx, claimId: string, submittedDate: string, oemClaimNumber?: string | null): Promise<WarrantyRow> {
  await requireEnabled(d);
  const claim = await getRow<WarrantyRow>(d, 'warranty_claims', claimId, 'Warranty claim');
  if (claim.status !== 'DRAFT') throw new DealerError('CONFLICT', `A ${claim.status} claim cannot be submitted`);
  if (oemClaimNumber) await updateRow(d, 'warranty_claims', claimId, { oem_claim_number: oemClaimNumber }, 'Warranty claim');
  await recognize(d, { ...claim, oem_claim_number: oemClaimNumber ?? claim.oem_claim_number }, submittedDate);
  const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claimId, { status: 'SUBMITTED', submitted_date: submittedDate }, 'Warranty claim', { status: 'DRAFT' });
  await event(d, { kind: 'WARRANTY', claimId, type: 'SUBMITTED', date: submittedDate, amountCents: claim.claimed_cents, key: `wev:sub:${claimId}` });
  return row ?? claim;
}

export interface SettleInput {
  claimId: string;
  amountCents: number;
  method?: OemSettlementMethod;
  date: string;
  oemStatementLineId?: string | null;
  reference?: string | null;
}

/** OEM credit / payment against a warranty claim. A short credit leaves it PARTIAL. */
export async function settleWarrantyClaim(d: DealerCtx, input: SettleInput): Promise<WarrantyRow> {
  const settings = await requireEnabled(d);
  const claim = await getRow<WarrantyRow>(d, 'warranty_claims', input.claimId, 'Warranty claim');
  assertSettleable(claim.status);
  if (!claim.recognized_gl_entry_id) throw new DealerError('CONFLICT', 'The claim receivable has not been recognized');
  const open = openCents(claim);
  if (input.amountCents > open) throw new DealerError('VALIDATION', `Settlement ${input.amountCents} exceeds the open amount ${open}`);
  const method = input.method ?? settings.oem_settlement_default;
  const key = `wty:set:${claim.id}:${input.oemStatementLineId ?? `${input.date}:${input.amountCents}:${input.reference ?? ''}`}`;
  const plan = receivableSettlementPlan({ receivableRole: 'WARRANTY_RECEIVABLE', amountCents: input.amountCents, method, memo: `Warranty claim ${claim.oem_claim_number ?? ''} settled` });
  const posted = await postPlan(d, plan, { entryDate: input.date, key, sourceId: claim.id });
  if (await byKey(d, 'dealer_claim_events', `wev:${key}`)) return claim;
  const settled = claim.settled_cents + input.amountCents;
  const status = statusAfterSettlement({ ...claim, settled_cents: settled });
  const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claim.id, { settled_cents: settled, status }, 'Warranty claim', { settled_cents: claim.settled_cents });
  if (!row) throw new DealerError('CONFLICT', 'The claim changed while settling — refresh and retry');
  await event(d, {
    kind: 'WARRANTY', claimId: claim.id, type: method === 'CASH' ? 'CASH_RECEIVED' : 'CREDIT_APPLIED', date: input.date,
    amountCents: input.amountCents, glEntryId: posted.glEntryId, oemStatementLineId: input.oemStatementLineId, key: `wev:${key}`,
  });
  if (input.oemStatementLineId) {
    await d.admin.from('oem_statement_lines').update({ match_status: 'SETTLED', matched_warranty_claim_id: claim.id, settlement_gl_entry_id: posted.glEntryId })
      .eq('org_id', d.orgId).eq('id', input.oemStatementLineId);
  }
  return row;
}

export type WarrantyResolution =
  | { action: 'ACCEPT_SHORT_PAY'; date: string; note?: string | null }
  | { action: 'WRITE_OFF'; date: string; note?: string | null }
  | { action: 'REJECTED_BY_OEM'; date: string; reason: string }
  | { action: 'RESUBMIT'; date: string; note?: string | null }
  | { action: 'DEBIT'; date: string; amountCents: number; note?: string | null };

/** Approver-only resolutions post GL; REJECTED_BY_OEM / RESUBMIT only move status. */
export function warrantyResolutionNeedsApproval(a: WarrantyResolution['action']): boolean {
  return a === 'ACCEPT_SHORT_PAY' || a === 'WRITE_OFF' || a === 'DEBIT';
}

export async function resolveWarrantyClaim(d: DealerCtx, claimId: string, r: WarrantyResolution): Promise<WarrantyRow> {
  await requireEnabled(d);
  const claim = await getRow<WarrantyRow>(d, 'warranty_claims', claimId, 'Warranty claim');
  switch (r.action) {
    case 'REJECTED_BY_OEM': {
      assertResolvable(claim.status);
      const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claimId, { status: 'REJECTED', rejection_reason: r.reason }, 'Warranty claim');
      await event(d, { kind: 'WARRANTY', claimId, type: 'REJECTED', date: r.date, amountCents: openCents(claim), note: r.reason, key: `wev:rej:${claimId}:${r.date}` });
      return row ?? claim;
    }
    case 'RESUBMIT': {
      if (claim.status !== 'REJECTED' && claim.status !== 'PARTIAL') throw new DealerError('CONFLICT', 'Only a rejected or short-paid claim can be resubmitted');
      const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claimId, { status: 'RESUBMITTED', submitted_date: r.date }, 'Warranty claim');
      await event(d, { kind: 'WARRANTY', claimId, type: 'RESUBMITTED', date: r.date, amountCents: openCents(claim), note: r.note, key: `wev:resub:${claimId}:${r.date}` });
      return row ?? claim;
    }
    case 'ACCEPT_SHORT_PAY':
    case 'WRITE_OFF': {
      assertResolvable(claim.status);
      const open = openCents(claim);
      if (open <= 0) throw new DealerError('CONFLICT', 'Nothing is open on this claim');
      if (r.action === 'ACCEPT_SHORT_PAY' && claim.settled_cents === 0) throw new DealerError('CONFLICT', 'No credit received yet — write the claim off instead');
      const key = `wty:wo:${claim.id}:${claim.written_off_cents}`;
      const posted = await postPlan(d, warrantyWriteOffPlan(open, `Warranty claim ${claim.oem_claim_number ?? ''} ${r.action === 'WRITE_OFF' ? 'written off' : 'short-pay accepted'}`), { entryDate: r.date, key, sourceId: claim.id });
      const written = claim.written_off_cents + open;
      const status: WarrantyStatus = statusAfterSettlement({ ...claim, written_off_cents: written });
      const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claimId, { written_off_cents: written, status }, 'Warranty claim', { written_off_cents: claim.written_off_cents });
      await event(d, { kind: 'WARRANTY', claimId, type: r.action === 'WRITE_OFF' ? 'WRITTEN_OFF' : 'SHORT_PAY_ACCEPTED', date: r.date, amountCents: open, glEntryId: posted.glEntryId, note: r.note, key: `wev:${key}` });
      await audit(d, `warranty.${r.action.toLowerCase()}`, 'warranty_claims', claimId, `Warranty ${r.action} ${open}`);
      return row ?? claim;
    }
    case 'DEBIT': {
      if (claim.status !== 'PAID' && claim.status !== 'PARTIAL' && claim.status !== 'DEBITED' && claim.status !== 'WRITTEN_OFF') {
        throw new DealerError('CONFLICT', 'A manufacturer debit applies to a claim that was already settled');
      }
      const key = `wty:debit:${claim.id}:${r.date}:${r.amountCents}`;
      const posted = await postPlan(d, warrantyDebitPlan(r.amountCents, `Warranty chargeback on claim ${claim.oem_claim_number ?? ''}`), { entryDate: r.date, key, sourceId: claim.id });
      if (await byKey(d, 'dealer_claim_events', `wev:${key}`)) return claim;
      const row = await updateRow<WarrantyRow>(d, 'warranty_claims', claimId, { debited_cents: claim.debited_cents + r.amountCents, status: 'DEBITED' }, 'Warranty claim');
      await event(d, { kind: 'WARRANTY', claimId, type: 'DEBITED', date: r.date, amountCents: r.amountCents, glEntryId: posted.glEntryId, note: r.note, key: `wev:${key}` });
      await audit(d, 'warranty.debit', 'warranty_claims', claimId, `Manufacturer debit ${r.amountCents}`);
      return row ?? claim;
    }
    default: {
      const never: never = r;
      throw new DealerError('VALIDATION', `Unknown action ${(never as { action: string }).action}`);
    }
  }
}

// ── OEM incentive programs ────────────────────────────────────────────────────

export interface OemProgramInput {
  oemVendorId: string;
  programCode?: string | null;
  name: string;
  programType: ProgramType;
  treatment?: IncentiveTreatment;
  paidDirect?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  claimDeadlineDays?: number | null;
  rules?: Record<string, unknown>;
  sourceDocumentId?: string | null;
}

export interface OemProgramRow {
  id: string;
  oem_vendor_id: string;
  name: string;
  program_type: ProgramType;
  treatment: IncentiveTreatment;
  paid_direct: boolean;
  claim_deadline_days: number | null;
  status: 'DRAFT' | 'ACTIVE' | 'EXPIRED';
}

function programValues(p: Partial<OemProgramInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (p.oemVendorId !== undefined) v.oem_vendor_id = p.oemVendorId;
  if (p.programCode !== undefined) v.program_code = p.programCode;
  if (p.name !== undefined) v.name = p.name;
  if (p.programType !== undefined) v.program_type = p.programType;
  if (p.treatment !== undefined) v.treatment = p.treatment;
  if (p.paidDirect !== undefined) v.paid_direct = p.paidDirect;
  if (p.startDate !== undefined) v.start_date = p.startDate;
  if (p.endDate !== undefined) v.end_date = p.endDate;
  if (p.claimDeadlineDays !== undefined) v.claim_deadline_days = p.claimDeadlineDays;
  if (p.rules !== undefined) v.rules = p.rules;
  if (p.sourceDocumentId !== undefined) v.source_document_id = p.sourceDocumentId;
  return v;
}

/** Programs start DRAFT (an AI-drafted program never goes live unapproved). */
export async function createOemProgram(d: DealerCtx, input: OemProgramInput): Promise<OemProgramRow> {
  return insertRow<OemProgramRow>(d, 'oem_programs', {
    ...programValues(input),
    treatment: input.treatment ?? defaultTreatment(input.programType),
    created_by: d.userId,
  }, 'Manufacturer program');
}

export async function updateOemProgram(d: DealerCtx, id: string, patch: Partial<OemProgramInput>): Promise<OemProgramRow> {
  const p = await getRow<OemProgramRow>(d, 'oem_programs', id, 'Manufacturer program');
  if (p.status === 'ACTIVE' && (patch.treatment !== undefined || patch.programType !== undefined)) {
    const { count } = await d.admin.from('oem_incentive_claims').select('id', { count: 'exact', head: true }).eq('org_id', d.orgId).eq('program_id', id);
    if ((count ?? 0) > 0) throw new DealerError('CONFLICT', 'The treatment cannot change once claims exist under the program');
  }
  return (await updateRow<OemProgramRow>(d, 'oem_programs', id, programValues(patch), 'Manufacturer program')) ?? p;
}

export async function setOemProgramStatus(d: DealerCtx, id: string, status: 'ACTIVE' | 'EXPIRED'): Promise<OemProgramRow> {
  const p = await getRow<OemProgramRow>(d, 'oem_programs', id, 'Manufacturer program');
  const values = status === 'ACTIVE' ? { status, approved_by: d.userId, approved_at: new Date().toISOString() } : { status };
  const row = await updateRow<OemProgramRow>(d, 'oem_programs', id, values, 'Manufacturer program');
  await audit(d, `program.${status.toLowerCase()}`, 'oem_programs', id, `${status === 'ACTIVE' ? 'Approved' : 'Expired'} program ${p.name}`);
  return row ?? p;
}

// ── incentive claims ──────────────────────────────────────────────────────────

export interface AccrueIncentiveInput {
  programId: string;
  unitId?: string | null;
  saleId?: string | null;
  amountCents: number;
  earnedDate: string;
  claimReference?: string | null;
}

export async function accrueIncentive(d: DealerCtx, input: AccrueIncentiveInput): Promise<{ claim: IncentiveRow; warnings: string[] }> {
  const settings = await requireEnabled(d);
  const program = await getRow<OemProgramRow>(d, 'oem_programs', input.programId, 'Manufacturer program');
  if (program.status !== 'ACTIVE') throw new DealerError('CONFLICT', 'Approve (activate) the program before accruing under it');
  const unit = input.unitId ? await getRow<UnitRow>(d, 'dealer_units', input.unitId, 'Unit') : null;
  const key = `inc:${program.id}:${unit?.id ?? '-'}:${input.saleId ?? '-'}:${input.claimReference ?? input.earnedDate}`;
  const existing = await byKey<IncentiveRow>(d, 'oem_incentive_claims', key);
  if (existing) return { claim: existing, warnings: [] };
  const roleMap = await loadRoleMap(d);
  const sold = !!unit && (unit.status === 'SOLD' || unit.status === 'DELIVERED');
  const r = incentiveAccrualPlan({
    treatment: program.treatment, programType: program.program_type, paidDirect: program.paid_direct, amountCents: input.amountCents,
    unit: unit ? { inventoryRole: unit.inventory_role, condition: unit.condition, sold } : null,
    costReductionInStock: settings.cost_reduction_in_stock,
    coOpRoleMapped: !!roleMap.get('CO_OP_ADVERTISING_RECOVERY')?.account_id,
    memo: `Incentive ${program.name}${unit ? ` S/N ${unit.serial_number}` : ''}`,
  });
  const posted = await postPlan(d, r.plan, { entryDate: input.earnedDate, key, roleMap, sourceId: program.id });
  const claim = await insertRow<IncentiveRow>(d, 'oem_incentive_claims', {
    program_id: program.id, unit_id: unit?.id ?? null, sale_id: input.saleId ?? null, claim_reference: input.claimReference ?? null,
    earned_date: input.earnedDate,
    claim_deadline: program.claim_deadline_days != null ? addDays(input.earnedDate, program.claim_deadline_days) : null,
    treatment: program.treatment, accrual_target_role: r.targetRole, accrued_cents: input.amountCents,
    gl_entry_id: posted.glEntryId, idempotency_key: key, created_by: d.userId,
  }, 'Incentive claim');
  if (unit && r.unitCostReductionCents > 0) {
    await insertRow<CostRow>(d, 'dealer_unit_costs', {
      unit_id: unit.id, cost_type: 'REBATE_REDUCTION', amount_cents: -r.unitCostReductionCents, source_type: 'INCENTIVE',
      source_id: claim.id, status: 'POSTED', gl_entry_id: posted.glEntryId, idempotency_key: `cost:inc:${claim.id}`,
      proposed_by: d.userId, posted_by: d.userId, posted_at: new Date().toISOString(),
    }, 'Rebate cost reduction');
  }
  await event(d, { kind: 'INCENTIVE', claimId: claim.id, type: 'ACCRUED', date: input.earnedDate, amountCents: input.amountCents, glEntryId: posted.glEntryId, key: `iev:acc:${claim.id}` });
  return { claim, warnings: r.warnings };
}

export async function submitIncentive(d: DealerCtx, claimId: string, submittedDate: string, claimedCents?: number | null, claimReference?: string | null): Promise<IncentiveRow> {
  const claim = await getRow<IncentiveRow>(d, 'oem_incentive_claims', claimId, 'Incentive claim');
  if (claim.status !== 'ACCRUED' && claim.status !== 'REJECTED') throw new DealerError('CONFLICT', `A ${claim.status} claim cannot be submitted`);
  const claimed = claimedCents ?? claim.accrued_cents;
  const row = await updateRow<IncentiveRow>(d, 'oem_incentive_claims', claimId, {
    status: 'SUBMITTED', submitted_date: submittedDate, claimed_cents: claimed, ...(claimReference ? { claim_reference: claimReference } : {}),
  }, 'Incentive claim');
  await event(d, { kind: 'INCENTIVE', claimId, type: claim.status === 'REJECTED' ? 'RESUBMITTED' : 'SUBMITTED', date: submittedDate, amountCents: claimed, key: `iev:sub:${claimId}:${submittedDate}` });
  return row ?? claim;
}

function incentiveOpen(c: IncentiveRow): number {
  return c.accrued_cents - c.settled_cents - c.written_off_cents;
}

export async function settleIncentive(d: DealerCtx, input: SettleInput): Promise<IncentiveRow> {
  const settings = await requireEnabled(d);
  const claim = await getRow<IncentiveRow>(d, 'oem_incentive_claims', input.claimId, 'Incentive claim');
  if (!['ACCRUED', 'SUBMITTED', 'PARTIAL'].includes(claim.status)) throw new DealerError('CONFLICT', `A ${claim.status} claim cannot be settled`);
  const open = incentiveOpen(claim);
  if (input.amountCents > open) throw new DealerError('VALIDATION', `Settlement ${input.amountCents} exceeds the open amount ${open}`);
  const method = input.method ?? settings.oem_settlement_default;
  const key = `inc:set:${claim.id}:${input.oemStatementLineId ?? `${input.date}:${input.amountCents}:${input.reference ?? ''}`}`;
  const posted = await postPlan(d, receivableSettlementPlan({ receivableRole: 'OEM_INCENTIVE_RECEIVABLE', amountCents: input.amountCents, method, memo: 'Manufacturer incentive settled' }), { entryDate: input.date, key, sourceId: claim.id });
  if (await byKey(d, 'dealer_claim_events', `iev:${key}`)) return claim;
  const settled = claim.settled_cents + input.amountCents;
  const status = settled + claim.written_off_cents >= claim.accrued_cents ? 'PAID' : 'PARTIAL';
  const row = await updateRow<IncentiveRow>(d, 'oem_incentive_claims', claim.id, { settled_cents: settled, status }, 'Incentive claim', { settled_cents: claim.settled_cents });
  if (!row) throw new DealerError('CONFLICT', 'The claim changed while settling — refresh and retry');
  await event(d, { kind: 'INCENTIVE', claimId: claim.id, type: method === 'CASH' ? 'CASH_RECEIVED' : 'CREDIT_APPLIED', date: input.date, amountCents: input.amountCents, glEntryId: posted.glEntryId, oemStatementLineId: input.oemStatementLineId, key: `iev:${key}` });
  if (input.oemStatementLineId) {
    await d.admin.from('oem_statement_lines').update({ match_status: 'SETTLED', matched_incentive_claim_id: claim.id, settlement_gl_entry_id: posted.glEntryId })
      .eq('org_id', d.orgId).eq('id', input.oemStatementLineId);
  }
  return row;
}

export type IncentiveResolution =
  | { action: 'WRITE_OFF'; date: string; note?: string | null }
  | { action: 'REJECTED_BY_OEM'; date: string; reason: string };

export async function resolveIncentive(d: DealerCtx, claimId: string, r: IncentiveResolution): Promise<IncentiveRow> {
  await requireEnabled(d);
  const claim = await getRow<IncentiveRow>(d, 'oem_incentive_claims', claimId, 'Incentive claim');
  if (r.action === 'REJECTED_BY_OEM') {
    if (!['SUBMITTED', 'PARTIAL'].includes(claim.status)) throw new DealerError('CONFLICT', `A ${claim.status} claim cannot be rejected`);
    const row = await updateRow<IncentiveRow>(d, 'oem_incentive_claims', claimId, { status: 'REJECTED' }, 'Incentive claim');
    await event(d, { kind: 'INCENTIVE', claimId, type: 'REJECTED', date: r.date, amountCents: incentiveOpen(claim), note: r.reason, key: `iev:rej:${claimId}:${r.date}` });
    return row ?? claim;
  }
  const open = incentiveOpen(claim);
  if (open <= 0) throw new DealerError('CONFLICT', 'Nothing is open on this claim');
  if (!claim.accrual_target_role) throw new DealerError('CONFLICT', 'The accrual target is unknown; write this off with a manual entry');
  const unit = claim.unit_id ? await getRow<UnitRow>(d, 'dealer_units', claim.unit_id, 'Unit') : null;
  const w = incentiveWriteOffPlan({
    targetRole: claim.accrual_target_role as DealerRole, amountCents: open,
    unit: unit ? { inventoryRole: unit.inventory_role, condition: unit.condition, sold: unit.status === 'SOLD' || unit.status === 'DELIVERED' } : null,
    memo: 'Manufacturer incentive written off',
  });
  const key = `inc:wo:${claim.id}:${claim.written_off_cents}`;
  const posted = await postPlan(d, w.plan, { entryDate: r.date, key, sourceId: claim.id });
  if (unit && w.addBackToUnitCents > 0) {
    await insertRow<CostRow>(d, 'dealer_unit_costs', {
      unit_id: unit.id, cost_type: 'OTHER', amount_cents: w.addBackToUnitCents, source_type: 'INCENTIVE', source_id: claim.id,
      status: 'POSTED', gl_entry_id: posted.glEntryId, idempotency_key: `cost:incwo:${claim.id}:${claim.written_off_cents}`,
      proposed_by: d.userId, posted_by: d.userId, posted_at: new Date().toISOString(), memo: 'Rebate not collected — cost restored',
    }, 'Rebate reversal');
  }
  const written = claim.written_off_cents + open;
  const status = claim.settled_cents > 0 ? 'PAID' : 'WRITTEN_OFF';
  const row = await updateRow<IncentiveRow>(d, 'oem_incentive_claims', claimId, { written_off_cents: written, status }, 'Incentive claim', { written_off_cents: claim.written_off_cents });
  await event(d, { kind: 'INCENTIVE', claimId, type: 'WRITTEN_OFF', date: r.date, amountCents: open, glEntryId: posted.glEntryId, note: r.note, key: `iev:${key}` });
  await audit(d, 'incentive.write_off', 'oem_incentive_claims', claimId, `Incentive written off ${open}`);
  return row ?? claim;
}
