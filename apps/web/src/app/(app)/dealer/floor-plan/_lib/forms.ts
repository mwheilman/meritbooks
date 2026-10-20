/**
 * Client-side validation + request bodies for the floor-plan setup forms (lines,
 * programs, manual flooring). Pure. Each validator mirrors the Zod schema it feeds
 * (lineCreate / programCreate / floorBody in lib/validations/dealer.ts) so a form
 * the client accepts is one the server accepts.
 */

import type { CollateralType, DayCount, LineStatus, PayoffTerms, ProgramStatus, RateType, UnitCondition } from '@/lib/dealer/types';
import type { CurtailmentRule } from '@/lib/dealer/engine/notes';
import { pctToBps } from '@/lib/dealer/ui/format';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export type Errors = Record<string, string>;

function intIn(s: string, min: number, max: number): number | null {
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

function optInt(s: string, min: number, max: number, field: string, label: string, errors: Errors): number | null {
  if (s.trim() === '') return null;
  const n = intIn(s, min, max);
  if (n === null) errors[field] = `${label} must be a whole number from ${min} to ${max}.`;
  return n;
}

// ── lines ─────────────────────────────────────────────────────────────────────

export interface LineDraft {
  lenderVendorId: string | null;
  name: string;
  creditLimitCents: number | null;
  liabilityAccountId: string | null;
  interestDueDay: string;
  scheduledPaymentDay: string;
  statementDay: string;
  sauCodes: string[];
  status: LineStatus;
  notes: string;
}

export interface LineBody {
  lenderVendorId: string;
  name: string;
  creditLimitCents: number;
  liabilityAccountId: string | null;
  interestDueDay: number | null;
  scheduledPaymentDay: number | null;
  statementDay: number | null;
  sauCodes: string[];
  status: LineStatus;
  notes: string | null;
}

export function validateLine(v: LineDraft): { body: LineBody | null; errors: Errors } {
  const errors: Errors = {};
  if (!v.lenderVendorId) errors.lenderVendorId = 'Choose the lender (a vendor).';
  const name = v.name.trim();
  if (!name) errors.name = 'Give the line a name.';
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters.';
  if (v.creditLimitCents === null || v.creditLimitCents < 0) errors.creditLimitCents = 'Enter the credit limit (0 or more).';
  const interestDueDay = optInt(v.interestDueDay, 1, 31, 'interestDueDay', 'Interest due day', errors);
  const scheduledPaymentDay = optInt(v.scheduledPaymentDay, 1, 31, 'scheduledPaymentDay', 'Scheduled payment day', errors);
  const statementDay = optInt(v.statementDay, 1, 31, 'statementDay', 'Statement day', errors);
  const codes = [...new Set(v.sauCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (codes.length > 20) errors.sauCodes = 'At most 20 codes.';
  else if (codes.some((c) => c.length > 20)) errors.sauCodes = 'Each code must be 20 characters or fewer.';
  if (v.notes.length > 2000) errors.notes = 'Keep notes under 2,000 characters.';
  if (Object.keys(errors).length) return { body: null, errors };
  return {
    body: {
      lenderVendorId: v.lenderVendorId!,
      name,
      creditLimitCents: v.creditLimitCents!,
      liabilityAccountId: v.liabilityAccountId,
      interestDueDay,
      scheduledPaymentDay,
      statementDay,
      sauCodes: codes,
      status: v.status,
      notes: v.notes.trim() || null,
    },
    errors,
  };
}

// ── programs ──────────────────────────────────────────────────────────────────

export interface ProgramDraft {
  lineId: string | null;
  oemVendorId: string | null;
  name: string;
  freeFloorDays: string;
  rateType: RateType;
  ratePct: string;
  indexName: string;
  indexRatePct: string;
  spreadPct: string;
  penaltyPct: string;
  dayCount: DayCount;
  payoffTerms: PayoffTerms;
  payoffDays: string;
  maxTermDays: string;
  curtailDemos: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  status: ProgramStatus;
}

export interface ProgramBody {
  lineId: string;
  oemVendorId: string | null;
  name: string;
  freeFloorDays: number;
  rateType: RateType;
  rateBps: number;
  indexName: string | null;
  indexRateBps: number | null;
  spreadBps: number | null;
  sauPenaltyRateBps: number | null;
  dayCount: DayCount;
  payoffTerms: PayoffTerms;
  payoffDays: number;
  maxTermDays: number | null;
  curtailDemos: boolean;
  curtailmentSchedule: CurtailmentRule[];
  effectiveFrom?: string;
  effectiveTo: string | null;
  status: ProgramStatus;
}

/** Effective annual rate (bps) the program would charge — what interest uses. */
export function draftEffectiveRateBps(v: Pick<ProgramDraft, 'rateType' | 'ratePct' | 'indexRatePct' | 'spreadPct'>): number | null {
  if (v.rateType === 'FIXED') return pctToBps(v.ratePct);
  const idx = pctToBps(v.indexRatePct);
  const spread = pctToBps(v.spreadPct);
  if (idx === null || spread === null) return null;
  return Math.max(0, idx + spread);
}

export function validateProgram(v: ProgramDraft, schedule: { rules: CurtailmentRule[]; ok: boolean }): { body: ProgramBody | null; errors: Errors } {
  const errors: Errors = {};
  if (!v.lineId) errors.lineId = 'Choose the floor-plan line this program belongs to.';
  const name = v.name.trim();
  if (!name) errors.name = 'Give the program a name.';
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters.';
  const freeFloorDays = intIn(v.freeFloorDays, 0, 3650);
  if (freeFloorDays === null) errors.freeFloorDays = 'Free-floor days must be a whole number from 0 to 3650.';

  let rateBps: number | null = null;
  let indexRateBps: number | null = null;
  let spreadBps: number | null = null;
  if (v.rateType === 'FIXED') {
    rateBps = pctToBps(v.ratePct);
    if (rateBps === null || rateBps < 0 || rateBps > 100_000) errors.ratePct = 'Enter the annual rate as a percent (for example 9.5).';
  } else {
    indexRateBps = pctToBps(v.indexRatePct);
    spreadBps = pctToBps(v.spreadPct);
    if (indexRateBps === null || indexRateBps < 0 || indexRateBps > 100_000) errors.indexRatePct = 'Enter the current index rate as a percent.';
    if (spreadBps === null || spreadBps < -10_000 || spreadBps > 100_000) errors.spreadPct = 'Enter the spread over the index as a percent (can be negative).';
    if (indexRateBps !== null && spreadBps !== null) rateBps = Math.max(0, indexRateBps + spreadBps);
    if (!v.indexName.trim()) errors.indexName = 'Name the index (for example the lender’s base rate).';
    else if (v.indexName.trim().length > 100) errors.indexName = 'Keep the index name under 100 characters.';
  }
  let sauPenaltyRateBps: number | null = null;
  if (v.penaltyPct.trim() !== '') {
    sauPenaltyRateBps = pctToBps(v.penaltyPct);
    if (sauPenaltyRateBps === null || sauPenaltyRateBps < 0 || sauPenaltyRateBps > 100_000) errors.penaltyPct = 'Enter the penalty rate as a percent, or leave it blank.';
  }
  let payoffDays = 0;
  if (v.payoffTerms === 'DAYS_AFTER_SALE') {
    const n = intIn(v.payoffDays, 1, 365);
    if (n === null) errors.payoffDays = 'Enter how many days after the sale the payoff is due (1–365).';
    else payoffDays = n;
  }
  const maxTermDays = optInt(v.maxTermDays, 1, 7300, 'maxTermDays', 'Maximum term', errors);
  if (v.effectiveFrom && !ISO.test(v.effectiveFrom)) errors.effectiveFrom = 'Use a full date.';
  if (v.effectiveTo && !ISO.test(v.effectiveTo)) errors.effectiveTo = 'Use a full date.';
  if (v.effectiveFrom && v.effectiveTo && ISO.test(v.effectiveFrom) && ISO.test(v.effectiveTo) && v.effectiveTo < v.effectiveFrom) {
    errors.effectiveTo = 'The end date can’t be before the start date.';
  }
  if (!schedule.ok) errors.curtailmentSchedule = 'Fix the curtailment schedule rows marked below.';
  if (Object.keys(errors).length) return { body: null, errors };
  return {
    body: {
      lineId: v.lineId!,
      oemVendorId: v.oemVendorId,
      name,
      freeFloorDays: freeFloorDays!,
      rateType: v.rateType,
      rateBps: rateBps ?? 0,
      indexName: v.rateType === 'INDEX_PLUS' ? v.indexName.trim() : null,
      indexRateBps: v.rateType === 'INDEX_PLUS' ? indexRateBps : null,
      spreadBps: v.rateType === 'INDEX_PLUS' ? spreadBps : null,
      sauPenaltyRateBps,
      dayCount: v.dayCount,
      payoffTerms: v.payoffTerms,
      payoffDays,
      maxTermDays,
      curtailDemos: v.curtailDemos,
      curtailmentSchedule: schedule.rules,
      ...(v.effectiveFrom ? { effectiveFrom: v.effectiveFrom } : {}),
      effectiveTo: v.effectiveTo || null,
      status: v.status,
    },
    errors,
  };
}

// ── manual flooring ───────────────────────────────────────────────────────────

export interface FloorDraft {
  lineId: string | null;
  programId: string | null;
  collateralType: CollateralType;
  lenderInvoiceNumber: string;
  flooredDate: string;
  principalCents: number | null;
  description: string;
  scheduledDueDate: string;
  unitMode: 'existing' | 'new';
  unitId: string | null;
  serialNumber: string;
  makeVendorId: string | null;
  model: string;
  modelYear: string;
  condition: UnitCondition;
  postNow: boolean;
}

export interface FloorRequest {
  lineId: string;
  programId: string | null;
  collateralType: CollateralType;
  lenderInvoiceNumber: string;
  flooredDate: string;
  principalCents: number;
  description: string | null;
  scheduledDueDate: string | null;
  unitId?: string;
  unit?: { serialNumber: string; makeVendorId: string | null; model: string | null; modelYear: number | null; condition: UnitCondition; source: 'MANUAL' };
  postNow: boolean;
}

export function validateFloor(v: FloorDraft): { body: FloorRequest | null; errors: Errors } {
  const errors: Errors = {};
  if (!v.lineId) errors.lineId = 'Choose the floor-plan line.';
  const inv = v.lenderInvoiceNumber.trim();
  if (!inv) errors.lenderInvoiceNumber = 'Enter the lender’s invoice number for this flooring.';
  else if (inv.length > 100) errors.lenderInvoiceNumber = 'Keep it under 100 characters.';
  if (!ISO.test(v.flooredDate)) errors.flooredDate = 'Enter the date the lender floored it.';
  if (v.principalCents === null || v.principalCents <= 0) errors.principalCents = 'Enter the amount the lender paid (above zero).';
  if (v.description.length > 500) errors.description = 'Keep the description under 500 characters.';
  if (v.scheduledDueDate && !ISO.test(v.scheduledDueDate)) errors.scheduledDueDate = 'Use a full date.';
  let unit: FloorRequest['unit'];
  let unitId: string | undefined;
  if (v.collateralType === 'WHOLE_GOOD') {
    if (v.unitMode === 'existing') {
      if (!v.unitId) errors.unitId = 'Choose the unit, or switch to “New unit”.';
      else unitId = v.unitId;
    } else {
      const serial = v.serialNumber.trim();
      if (!serial) errors.serialNumber = 'Enter the serial number.';
      else if (serial.length > 100) errors.serialNumber = 'Keep it under 100 characters.';
      let modelYear: number | null = null;
      if (v.modelYear.trim()) {
        modelYear = intIn(v.modelYear, 1900, 2200);
        if (modelYear === null) errors.modelYear = 'Enter a 4-digit model year.';
      }
      if (v.model.length > 200) errors.model = 'Keep the model under 200 characters.';
      unit = { serialNumber: serial, makeVendorId: v.makeVendorId, model: v.model.trim() || null, modelYear, condition: v.condition, source: 'MANUAL' };
    }
  }
  if (Object.keys(errors).length) return { body: null, errors };
  return {
    body: {
      lineId: v.lineId!,
      programId: v.programId,
      collateralType: v.collateralType,
      lenderInvoiceNumber: inv,
      flooredDate: v.flooredDate,
      principalCents: v.principalCents!,
      description: v.description.trim() || null,
      scheduledDueDate: v.scheduledDueDate || null,
      ...(unitId ? { unitId } : {}),
      ...(unit ? { unit } : {}),
      postNow: v.postNow,
    },
    errors,
  };
}
