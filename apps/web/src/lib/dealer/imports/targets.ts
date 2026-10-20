/**
 * Dealer imports — validate ONE mapped row into a typed D1 request body, or a list of
 * plain-English problems (pure, client-safe). Spreadsheet rows (after column mapping)
 * and AI proposals (after normalization) both arrive here as `Cells` (field key → text),
 * so a person reviewing either sees exactly the same checks.
 *
 * Nothing here posts. The bodies go to the D1 routes (units / floor / sales / warranty /
 * statements / oem-programs) which create PROPOSED rows a human approves.
 */

import type { z } from 'zod';
import type {
  floorBody,
  lenderStatementImport,
  oemProgramCreate,
  oemStatementImport,
  saleCreate,
  unitCreate,
  warrantyCreate,
} from '@/lib/validations/dealer';
import { computeClaim } from '../engine/warranty';
import type { ImportFileKind, StatementKind, UnitCondition } from '../types';
import { KIND_FIELDS, type EnumOption, type TargetField } from './fields';
import {
  normKey,
  parseBoolCell,
  parseDateCell,
  parseHoursCell,
  parseIntCell,
  parseMoneyCell,
  parsePctCell,
  parseTextCell,
  type Parsed,
} from './values';
import { normHeader } from '@/lib/import/spreadsheet';

type Body<S extends z.ZodTypeAny> = Omit<z.input<S>, 'locationId'>;
export type UnitBody = Body<typeof unitCreate>;
export type FloorBody = Body<typeof floorBody>;
export type SaleBody = Body<typeof saleCreate>;
export type WarrantyBody = Body<typeof warrantyCreate>;
export type ProgramBody = Body<typeof oemProgramCreate>;
export type LenderStatementBody = Body<typeof lenderStatementImport>;
export type LenderLine = LenderStatementBody['lines'][number];
export type OemStatementBody = Body<typeof oemStatementImport>;
export type OemLine = OemStatementBody['lines'][number];
export type OemLineType = OemLine['lineType'];

/** Field key → raw cell text. */
export type Cells = Record<string, string>;

/** Names already in Books, keyed by `normKey(name)` / `normKey(serial)`. */
export interface Resolution {
  unitsBySerial: Record<string, string>;
  customersByName: Record<string, string>;
  vendorsByName: Record<string, string>;
}

export interface ImportContext {
  kind: ImportFileKind;
  importBatchId: string | null;
  /** Floor-plan line (units: floor the units on it; lender statements: the statement's line). */
  lineId?: string | null;
  programId?: string | null;
  /** Manufacturer (warranty, OEM statements, programs). */
  oemVendorId?: string | null;
  retailRebateProgramId?: string | null;
  defaultCondition?: UnitCondition;
  defaultOemLineType?: OemLineType | null;
  /** Books lookups for names/serials; absent = not checked yet. */
  resolve?: Resolution | null;
}

export type RowPlan =
  | { target: 'unit'; body: UnitBody }
  | { target: 'floor'; body: FloorBody }
  | { target: 'sale'; body: SaleBody }
  | { target: 'warranty'; body: WarrantyBody }
  | { target: 'program'; body: ProgramBody }
  | { target: 'lenderLine'; line: LenderLine }
  | { target: 'oemLine'; line: OemLine };

export type RowCheck = { ok: true; plan: RowPlan; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

// ── enum matching ─────────────────────────────────────────────────────────────

/** Match a cell to an enum option: code, label, then synonyms (exact, then contained). */
export function matchEnum(raw: string, options: readonly EnumOption[]): string | null {
  const n = normHeader(raw);
  if (!n) return null;
  const code = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  for (const o of options) if (o.value === code) return o.value;
  for (const o of options) {
    if (normHeader(o.label) === n) return o.value;
    if ((o.synonyms ?? []).some((s) => normHeader(s) === n)) return o.value;
  }
  for (const o of options) {
    if ((o.synonyms ?? []).some((s) => s.length > 2 && n.includes(normHeader(s)))) return o.value;
  }
  return null;
}

// ── a typed reader over one row's cells ───────────────────────────────────────

class RowReader {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  constructor(private readonly cells: Cells, private readonly fields: readonly TargetField[]) {}

  private field(key: string): TargetField {
    const f = this.fields.find((x) => x.key === key);
    if (!f) throw new Error(`Unknown import field ${key}`);
    return f;
  }

  raw(key: string): string {
    return (this.cells[key] ?? '').trim();
  }

  has(key: string): boolean {
    return this.raw(key) !== '';
  }

  private take<T>(key: string, p: Parsed<T>, required: boolean): T | null {
    const f = this.field(key);
    if (!p.ok) {
      this.errors.push(`${f.label}: ${p.error}.`);
      return null;
    }
    if (p.value === null && required) this.errors.push(`${f.label} is required.`);
    return p.value;
  }

  text(key: string, required = this.field(key).required === true): string | null {
    return this.take(key, parseTextCell(this.raw(key), this.field(key).max ?? 500), required);
  }
  money(key: string, required = this.field(key).required === true, allowNegative = false): number | null {
    return this.take(key, parseMoneyCell(this.raw(key), { allowNegative }), required);
  }
  date(key: string, required = this.field(key).required === true): string | null {
    return this.take(key, parseDateCell(this.raw(key)), required);
  }
  int(key: string, opts: { min?: number; max?: number } = {}, required = this.field(key).required === true): number | null {
    return this.take(key, parseIntCell(this.raw(key), opts), required);
  }
  hours(key: string, required = this.field(key).required === true): string | null {
    return this.take(key, parseHoursCell(this.raw(key)), required);
  }
  pct(key: string, required = this.field(key).required === true): number | null {
    return this.take(key, parsePctCell(this.raw(key)), required);
  }
  bool(key: string): boolean | null {
    return this.take(key, parseBoolCell(this.raw(key)), false);
  }
  enumOf<V extends string>(key: string, fallback: V | null = null, required = this.field(key).required === true): V | null {
    const f = this.field(key);
    const raw = this.raw(key);
    if (!raw) {
      if (fallback) return fallback;
      if (required) this.errors.push(`${f.label} is required.`);
      return null;
    }
    const v = matchEnum(raw, f.options ?? []);
    if (!v) {
      this.errors.push(`${f.label}: “${raw}” isn’t one of ${(f.options ?? []).map((o) => o.label).join(', ')}.`);
      return null;
    }
    return v as V;
  }
}

// ── per-kind row validators ───────────────────────────────────────────────────

function resolveVendor(r: RowReader, ctx: ImportContext): string | null {
  const make = r.text('make');
  if (!make) return null;
  const id = ctx.resolve?.vendorsByName[normKey(make)] ?? null;
  if (ctx.resolve && !id) r.warnings.push(`Make “${make}” isn’t a vendor in Books — the unit is saved without a make.`);
  return id;
}

function unitFields(r: RowReader, ctx: ImportContext, source: 'DMS' | 'OPENING') {
  const serialNumber = r.text('serialNumber', true);
  const modelYear = r.int('modelYear', { min: 1900, max: 2200 });
  const condition = r.enumOf<UnitCondition>('condition', ctx.defaultCondition ?? 'NEW');
  const status = r.enumOf<'ON_ORDER' | 'IN_TRANSIT' | 'IN_STOCK'>('status');
  return {
    serialNumber: serialNumber ?? '',
    stockNumber: r.text('stockNumber'),
    vinHin: r.text('vinHin'),
    makeVendorId: resolveVendor(r, ctx),
    model: r.text('model'),
    modelYear,
    description: r.text('description'),
    condition: condition ?? 'NEW',
    status: status ?? undefined,
    receivedDate: r.date('receivedDate'),
    listPriceCents: r.money('listPriceCents'),
    source,
    importBatchId: ctx.importBatchId,
  };
}

function validateUnitRow(r: RowReader, ctx: ImportContext, opening: boolean): RowCheck {
  const unit = unitFields(r, ctx, opening ? 'OPENING' : 'DMS');
  const principal = r.money('principalCents');
  const invoice = r.text('lenderInvoiceNumber');
  const flooredDate = r.date('flooredDate');
  const dmsCost = opening ? null : r.money('dmsInvoiceCostCents');
  const accruedThrough = opening ? r.date('interestAccruedThrough') : null;

  const wantsFloor = principal !== null && principal > 0;
  if (wantsFloor && !ctx.lineId) {
    r.errors.push('This row has a floored amount — choose the floor-plan line it is on (step 1).');
  }
  if (wantsFloor && ctx.lineId) {
    if (!invoice) r.errors.push('Lender invoice # is required to floor this unit.');
    const date = flooredDate ?? unit.receivedDate;
    if (!date) r.errors.push('Floored date (or received date) is required to floor this unit.');
    if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
    const body: FloorBody = {
      lineId: ctx.lineId,
      programId: ctx.programId ?? null,
      collateralType: 'WHOLE_GOOD',
      lenderInvoiceNumber: invoice!,
      flooredDate: date!,
      principalCents: principal!,
      unit: { ...unit, receivedDate: unit.receivedDate ?? date },
      importBatchId: ctx.importBatchId,
      ...(opening ? { opening: { interestAccruedThrough: accruedThrough } } : { viaImport: true, dmsInvoiceCostCents: dmsCost }),
    };
    return { ok: true, plan: { target: 'floor', body }, warnings: r.warnings };
  }
  if (!wantsFloor && (invoice || flooredDate) && opening) {
    r.warnings.push('No principal owed — the unit is loaded as owned (not floored).');
  }
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  return { ok: true, plan: { target: 'unit', body: unit }, warnings: r.warnings };
}

function validateDealRow(r: RowReader, ctx: ImportContext): RowCheck {
  const externalDealRef = r.text('externalDealRef');
  const saleDate = r.date('saleDate');
  const serial = r.text('serialNumber', true);
  const customer = r.text('customer');
  const salePriceCents = r.money('salePriceCents');
  const taxCents = r.money('taxCents');
  const retailRebateCents = r.money('retailRebateCents');
  const salesperson = r.text('salesperson');

  let unitId: string | null = null;
  if (serial) {
    if (!ctx.resolve) r.errors.push('Not checked against Books yet.');
    else {
      unitId = ctx.resolve.unitsBySerial[normKey(serial)] ?? null;
      if (!unitId) r.errors.push(`No unit with serial “${serial}” is in Books — import the unit first.`);
    }
  }
  let customerId: string | null = null;
  if (customer && ctx.resolve) {
    customerId = ctx.resolve.customersByName[normKey(customer)] ?? null;
    if (!customerId) r.errors.push(`No customer named “${customer}” is in Books — add the customer first.`);
  }
  if ((retailRebateCents ?? 0) > 0 && !ctx.retailRebateProgramId) {
    r.errors.push('This deal has a retail rebate — choose the manufacturer program it comes from (step 1).');
  }

  const tradeSerial = r.text('tradeSerial');
  const allowance = r.money('tradeAllowanceCents', false);
  const acv = r.money('tradeAcvCents', false);
  const lien = r.money('tradeLienPayoffCents', false);
  const tradeModel = r.text('tradeModel');
  const tradeYear = r.int('tradeYear', { min: 1900, max: 2200 });
  const hasTrade = !!tradeSerial || allowance !== null || acv !== null || (lien ?? 0) > 0;
  let trade: SaleBody['trade'] = null;
  if (hasTrade) {
    if (!tradeSerial) r.errors.push('Trade serial number is required when the deal has a trade-in.');
    if (allowance === null) r.errors.push('Trade allowance is required when the deal has a trade-in.');
    if (acv === null) r.errors.push('Trade ACV is required when the deal has a trade-in (a sales manager approves it).');
    if (tradeSerial && allowance !== null && acv !== null) {
      trade = { serialNumber: tradeSerial, model: tradeModel, modelYear: tradeYear, allowanceCents: allowance, acvCents: acv, ...(lien ? { lienPayoffCents: lien } : {}) };
      r.warnings.push('The trade ACV needs a sales manager’s approval before the deal posts.');
    }
  }
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  const body: SaleBody = {
    unitId: unitId!,
    customerId,
    saleDate: saleDate!,
    salePriceCents: salePriceCents!,
    ...(taxCents ? { taxCents } : {}),
    ...((retailRebateCents ?? 0) > 0 ? { retailRebateCents: retailRebateCents!, retailRebateProgramId: ctx.retailRebateProgramId } : {}),
    trade,
    salesperson,
    source: 'DMS',
    externalDealRef,
    importBatchId: ctx.importBatchId,
  };
  return { ok: true, plan: { target: 'sale', body }, warnings: r.warnings };
}

function validateWarrantyRow(r: RowReader, ctx: ImportContext): RowCheck {
  if (!ctx.oemVendorId) r.errors.push('Choose the manufacturer these claims are filed with (step 1).');
  const serial = r.text('serialNumber', false);
  const laborHours = r.hours('laborHours');
  const laborRateCents = r.money('laborRateCents');
  const partsCostCents = r.money('partsCostCents');
  const partsMarkupBps = r.pct('partsMarkupBps') ?? 0;
  const subletCents = r.money('subletCents') ?? 0;
  const freightCents = r.money('freightCents') ?? 0;
  const otherCents = r.money('otherCents') ?? 0;
  const checkTotal = r.money('claimedTotalCents', false);
  const oemClaimNumber = r.text('oemClaimNumber');
  const dealerClaimRef = r.text('dealerClaimRef');
  const repairOrderRef = r.text('repairOrderRef');
  if (!oemClaimNumber && !dealerClaimRef && !repairOrderRef) r.errors.push('Each claim needs a claim #, a dealer reference or a repair order #.');
  if (partsMarkupBps > 100_000) r.errors.push('Parts markup % is too large.');

  let unitId: string | null = null;
  if (serial && ctx.resolve) {
    unitId = ctx.resolve.unitsBySerial[normKey(serial)] ?? null;
    if (!unitId) r.warnings.push(`Serial “${serial}” isn’t a unit in Books — the claim keeps the serial only.`);
  }
  if (laborHours !== null && laborRateCents !== null && partsCostCents !== null) {
    const c = computeClaim({ laborHours, laborRateCents, partsCostCents, partsMarkupBps, subletCents, freightCents, otherCents });
    if (checkTotal !== null && checkTotal !== c.claimedCents) {
      r.errors.push(`The parts add up to ${centsLabel(c.claimedCents)} but the claim total says ${centsLabel(checkTotal)}.`);
    }
  }
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  const body: WarrantyBody = {
    oemVendorId: ctx.oemVendorId!,
    oemClaimNumber,
    dealerClaimRef,
    repairOrderRef,
    unitId,
    serialNumber: serial,
    failureDate: r.date('failureDate'),
    repairDate: r.date('repairDate'),
    filingDeadline: r.date('filingDeadline'),
    laborHours: laborHours!,
    laborRateCents: laborRateCents!,
    partsCostCents: partsCostCents!,
    partsMarkupBps,
    ...(subletCents ? { subletCents } : {}),
    ...(freightCents ? { freightCents } : {}),
    ...(otherCents ? { otherCents } : {}),
    importBatchId: ctx.importBatchId,
  };
  return { ok: true, plan: { target: 'warranty', body }, warnings: r.warnings };
}

function validateLenderLine(r: RowReader): RowCheck {
  const line: LenderLine = {
    lenderInvoiceNumber: r.text('lenderInvoiceNumber'),
    serialNumber: r.text('serialNumber'),
    model: r.text('model'),
    originalCents: r.money('originalCents'),
    currentCents: r.money('currentCents'),
    interestCents: r.money('interestCents'),
    feesCents: r.money('feesCents'),
    lenderCode: r.text('lenderCode'),
    dispositionDate: r.date('dispositionDate'),
    days: r.int('days', { min: 0, max: 100_000 }),
  };
  if (!line.lenderInvoiceNumber && !line.serialNumber) r.errors.push('Each line needs a lender invoice # or a serial number.');
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  return { ok: true, plan: { target: 'lenderLine', line }, warnings: r.warnings };
}

function validateOemLine(r: RowReader, ctx: ImportContext): RowCheck {
  const lineType = r.enumOf<OemLineType>('lineType', ctx.defaultOemLineType ?? null, true);
  let amount = r.money('amountCents', false, true);
  if (amount === null) {
    const credit = r.money('creditCents');
    const debit = r.money('debitCents');
    if (credit !== null || debit !== null) amount = (credit ?? 0) - (debit ?? 0);
  }
  if (amount === null) r.errors.push('Amount is required (or a credit / debit column).');
  const line = {
    lineType: lineType ?? 'OTHER',
    reference: r.text('reference'),
    serialNumber: r.text('serialNumber'),
    description: r.text('description'),
    amountCents: amount ?? 0,
  } satisfies OemLine;
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  return { ok: true, plan: { target: 'oemLine', line }, warnings: r.warnings };
}

function validateProgramRow(r: RowReader, ctx: ImportContext): RowCheck {
  if (!ctx.oemVendorId) r.errors.push('Choose the manufacturer that runs these programs (step 1).');
  const name = r.text('name');
  const programType = r.enumOf<ProgramBody['programType']>('programType');
  const treatment = r.enumOf<NonNullable<ProgramBody['treatment']>>('treatment');
  const startDate = r.date('startDate');
  const endDate = r.date('endDate');
  if (startDate && endDate && endDate < startDate) r.errors.push('End date is before the start date.');
  const amountCents = r.money('amountCents');
  const eligibleModels = r.text('eligibleModels');
  const notes = r.text('notes');
  const paidDirect = r.bool('paidDirect');
  const claimDeadlineDays = r.int('claimDeadlineDays', { min: 0, max: 3650 });
  if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
  const rules: Record<string, unknown> = {};
  if (amountCents !== null) rules.amountCents = amountCents;
  if (eligibleModels) rules.eligibleModels = eligibleModels;
  if (notes) rules.notes = notes;
  const body: ProgramBody = {
    oemVendorId: ctx.oemVendorId!,
    programCode: r.text('programCode'),
    name: name!,
    programType: programType!,
    ...(treatment ? { treatment } : {}),
    ...(paidDirect !== null ? { paidDirect } : {}),
    startDate,
    endDate,
    claimDeadlineDays,
    ...(Object.keys(rules).length ? { rules } : {}),
  };
  r.warnings.push('Programs are saved as drafts — someone with settings rights approves each one.');
  return { ok: true, plan: { target: 'program', body }, warnings: r.warnings };
}

function centsLabel(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Validate one mapped row for an import kind. */
export function validateRow(kind: ImportFileKind, cells: Cells, ctx: ImportContext): RowCheck {
  const r = new RowReader(cells, KIND_FIELDS[kind]);
  switch (kind) {
    case 'UNITS':
      return validateUnitRow(r, ctx, false);
    case 'OPENING':
      return validateUnitRow(r, ctx, true);
    case 'DEALS':
      return validateDealRow(r, ctx);
    case 'WARRANTY':
      return validateWarrantyRow(r, ctx);
    case 'LENDER_STATEMENT':
    case 'LENDER_AUDIT':
      return validateLenderLine(r);
    case 'OEM_STATEMENT':
      return validateOemLine(r, ctx);
    case 'PROGRAMS':
      return validateProgramRow(r, ctx);
  }
}

export interface RowsCheck {
  results: RowCheck[];
  accepted: number;
  rejected: number;
}

/** Duplicate key of a row within one file (second and later occurrences are rejected). */
function dupKey(kind: ImportFileKind, cells: Cells): string | null {
  switch (kind) {
    case 'UNITS':
    case 'OPENING':
      return cells.serialNumber ? `serial:${normKey(cells.serialNumber)}` : null;
    case 'DEALS':
      return cells.externalDealRef ? `deal:${normKey(cells.externalDealRef)}` : null;
    case 'WARRANTY':
      return cells.oemClaimNumber ? `claim:${normKey(cells.oemClaimNumber)}` : null;
    case 'PROGRAMS':
      return cells.programCode ? `code:${normKey(cells.programCode)}` : null;
    default:
      return null;
  }
}

/** Validate every row, rejecting in-file duplicates (unit serial, deal #, claim #, program code). */
export function validateRows(kind: ImportFileKind, rows: Cells[], ctx: ImportContext): RowsCheck {
  const seen = new Map<string, number>();
  const results = rows.map((cells, i) => {
    const res = validateRow(kind, cells, ctx);
    const k = dupKey(kind, cells);
    if (k) {
      const first = seen.get(k);
      if (first !== undefined) {
        const errors = [...(res.ok ? [] : res.errors), `Same ${k.split(':')[0] === 'serial' ? 'serial number' : k.startsWith('deal') ? 'deal number' : k.startsWith('claim') ? 'claim #' : 'program code'} as row ${first + 1} of this file.`];
        return { ok: false as const, errors, warnings: res.warnings };
      }
      seen.set(k, i);
    }
    return res;
  });
  const accepted = results.filter((r) => r.ok).length;
  return { results, accepted, rejected: results.length - accepted };
}

// ── statement header (footer totals) ──────────────────────────────────────────

export interface LenderHeaderInput {
  statementKind: StatementKind;
  statementDate: string;
  footerPrincipal: string;
  footerInterest: string;
  footerFees: string;
  footerLineCount: string;
}

export interface OemHeaderInput {
  statementDate: string;
  footerTotal: string;
}

export type HeaderCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function checkLenderHeader(h: LenderHeaderInput): HeaderCheck<{ kind: StatementKind; statementDate: string; footer: LenderStatementBody['footer'] }> {
  const errors: string[] = [];
  const d = parseDateCell(h.statementDate);
  const p = parseMoneyCell(h.footerPrincipal);
  const i = parseMoneyCell(h.footerInterest);
  const f = parseMoneyCell(h.footerFees);
  const n = parseIntCell(h.footerLineCount, { min: 0 });
  if (!d.ok) errors.push(`Statement date: ${d.error}.`);
  else if (!d.value) errors.push('Statement date is required.');
  if (!p.ok) errors.push(`Principal total: ${p.error}.`);
  else if (p.value === null) errors.push('The statement’s principal total is required — it is how we check the lines add up.');
  if (!i.ok) errors.push(`Interest total: ${i.error}.`);
  if (!f.ok) errors.push(`Fees total: ${f.error}.`);
  if (!n.ok) errors.push(`Line count: ${n.error}.`);
  if (errors.length || !d.ok || !p.ok || !i.ok || !f.ok || !n.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: h.statementKind,
      statementDate: d.value!,
      footer: { principalCents: p.value, interestCents: i.value, feesCents: f.value, lineCount: n.value },
    },
  };
}

export function checkOemHeader(h: OemHeaderInput): HeaderCheck<{ statementDate: string; footerTotalCents: number }> {
  const errors: string[] = [];
  const d = parseDateCell(h.statementDate);
  const t = parseMoneyCell(h.footerTotal, { allowNegative: true });
  if (!d.ok) errors.push(`Statement date: ${d.error}.`);
  else if (!d.value) errors.push('Statement date is required.');
  if (!t.ok) errors.push(`Statement total: ${t.error}.`);
  else if (t.value === null) errors.push('The statement total is required — it is how we check the lines add up.');
  if (errors.length || !d.ok || !t.ok) return { ok: false, errors };
  return { ok: true, value: { statementDate: d.value!, footerTotalCents: t.value! } };
}
