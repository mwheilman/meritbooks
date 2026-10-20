/**
 * Dealer imports — PURE normalizers for the AI parsers' JSON (A1 lender statement /
 * floor check, A2 manufacturer statement / credit memo, A4 deal recap, DMS unit list,
 * A6 program bulletin).
 *
 * The model's loose JSON becomes the SAME field-keyed `Cells` a spreadsheet mapping
 * produces, so the review screen runs the identical validation (lib/dealer/imports/
 * targets.ts) and the identical footing check. Every value is re-validated here:
 * money becomes canonical dollars text parsed from the string (integer cents, never
 * float math), dates become ISO, enum words map to the allowed codes. Anything missing
 * or unreadable is left BLANK and the row is flagged low-confidence — never guessed.
 * Never throws: a malformed shape yields zero rows.
 */

import type { ImportFileKind, StatementKind } from '../types';
import { KIND_FIELDS, isLenderKind, type TargetField } from './fields';
import { matchEnum, type Cells } from './targets';
import { centsToCell, parseBoolCell, parseDateCell, parseHoursCell, parseIntCell, parseMoneyCell, parsePctCell } from './values';

export const LOW_CONFIDENCE = 0.6;

export interface ProposedRow {
  /** Stable local id for the review table. */
  id: string;
  cells: Cells;
  /** Model confidence 0..1. */
  confidence: number;
  /** Unsure, or a required value is missing / unreadable. */
  lowConfidence: boolean;
  /** Field keys the model left blank or gave an unreadable value for. */
  missing: string[];
  /** Field keys a human must always confirm (e.g. trade ACV). */
  alwaysReview: string[];
}

export interface AiProposal {
  kind: ImportFileKind;
  /** Statement header / footer as editable text (statementKind, statementDate, footer*). */
  header: Record<string, string>;
  rows: ProposedRow[];
  /** Mean row confidence (0..1). */
  confidence: number;
  documentNote: string | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return '';
}
function conf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Canonicalize one value for a field; '' when missing or unreadable (`bad` = unreadable). */
function canon(f: TargetField, v: unknown): { text: string; bad: boolean } {
  const s = str(v);
  if (s === '') return { text: '', bad: false };
  switch (f.type) {
    case 'money':
    case 'signedMoney': {
      const p = parseMoneyCell(s, { allowNegative: f.type === 'signedMoney' });
      return p.ok && p.value !== null ? { text: centsToCell(p.value), bad: false } : { text: '', bad: true };
    }
    case 'date': {
      const p = parseDateCell(s);
      return p.ok && p.value ? { text: p.value, bad: false } : { text: '', bad: true };
    }
    case 'int': {
      const p = parseIntCell(s);
      return p.ok && p.value !== null ? { text: String(p.value), bad: false } : { text: '', bad: true };
    }
    case 'hours': {
      const p = parseHoursCell(s);
      return p.ok && p.value ? { text: p.value, bad: false } : { text: '', bad: true };
    }
    case 'pct': {
      const p = parsePctCell(s);
      return p.ok && p.value !== null ? { text: `${Math.floor(p.value / 100)}.${String(p.value % 100).padStart(2, '0')}`, bad: false } : { text: '', bad: true };
    }
    case 'bool': {
      const p = parseBoolCell(s);
      return p.ok && p.value !== null ? { text: p.value ? 'yes' : 'no', bad: false } : { text: '', bad: true };
    }
    case 'enum': {
      const m = matchEnum(s, f.options ?? []);
      return m ? { text: m, bad: false } : { text: '', bad: true };
    }
    default:
      return { text: s.replace(/\s+/g, ' ').slice(0, f.max ?? 500), bad: false };
  }
}

/** Build one proposed row from a { fieldKey: rawValue } source. */
function buildRow(kind: ImportFileKind, id: string, source: Record<string, unknown>, confidence: unknown, alwaysReview: string[] = []): ProposedRow {
  const fields = KIND_FIELDS[kind];
  const cells: Cells = {};
  const missing: string[] = [];
  let bad = false;
  for (const f of fields) {
    if (!(f.key in source)) continue;
    const c = canon(f, source[f.key]);
    cells[f.key] = c.text;
    if (c.bad) {
      bad = true;
      missing.push(f.key);
    }
  }
  for (const f of fields) if (f.required && !cells[f.key] && !missing.includes(f.key)) missing.push(f.key);
  if (isLenderKind(kind) && !cells.lenderInvoiceNumber && !cells.serialNumber) missing.push('lenderInvoiceNumber');
  if (kind === 'OEM_STATEMENT' && !cells.amountCents) missing.push('amountCents');
  const c = conf(confidence);
  return {
    id,
    cells,
    confidence: c,
    lowConfidence: c < LOW_CONFIDENCE || bad || missing.length > 0,
    missing,
    alwaysReview: alwaysReview.filter((k) => !!cells[k]),
  };
}

function mean(rows: ProposedRow[]): number {
  if (rows.length === 0) return 0;
  return Math.round((rows.reduce((s, r) => s + r.confidence, 0) / rows.length) * 1000) / 1000;
}

function moneyText(v: unknown, allowNegative = false): string {
  const p = parseMoneyCell(str(v), { allowNegative });
  return p.ok && p.value !== null ? centsToCell(p.value) : '';
}

function note(v: unknown): string | null {
  const s = str(v);
  return s ? s.slice(0, 1000) : null;
}

const STATEMENT_KINDS: readonly StatementKind[] = ['STATEMENT', 'AUDIT', 'PAYOFF_QUOTE'];

/** A1 — lender statement / floor check / payoff quote. */
export function normalizeLenderStatement(raw: unknown, kind: 'LENDER_STATEMENT' | 'LENDER_AUDIT'): AiProposal {
  const root = obj(raw);
  const st = obj(root.statement);
  const totals = obj(st.totals);
  const k = str(st.kind).toUpperCase().replace(/[\s-]+/g, '_');
  const statementKind: StatementKind = (STATEMENT_KINDS as readonly string[]).includes(k)
    ? (k as StatementKind)
    : kind === 'LENDER_AUDIT'
      ? 'AUDIT'
      : 'STATEMENT';
  const date = parseDateCell(str(st.statement_date));
  const lc = parseIntCell(str(totals.line_count), { min: 0 });
  const rows = arr(root.lines).flatMap((l, i) => {
    const x = obj(l);
    if (Object.keys(x).length === 0) return [];
    return [
      buildRow(kind, `l${i}`, {
        lenderInvoiceNumber: x.invoice_number,
        serialNumber: x.serial_number,
        model: x.model,
        originalCents: x.original_amount,
        currentCents: x.current_balance,
        interestCents: x.interest,
        feesCents: x.fees,
        lenderCode: x.status_code,
        dispositionDate: x.disposition_date,
        days: x.days,
      }, x.confidence),
    ];
  });
  return {
    kind,
    header: {
      statementKind,
      statementDate: date.ok && date.value ? date.value : '',
      footerPrincipal: moneyText(totals.principal),
      footerInterest: moneyText(totals.interest),
      footerFees: moneyText(totals.fees),
      footerLineCount: lc.ok && lc.value !== null ? String(lc.value) : '',
    },
    rows,
    confidence: mean(rows),
    documentNote: note(root.document_note),
  };
}

/** A2 — manufacturer statement or credit memo. Credits are positive, debits negative. */
export function normalizeOemStatement(raw: unknown): AiProposal {
  const root = obj(raw);
  const doc = obj(root.document);
  const date = parseDateCell(str(doc.statement_date));
  const rows = arr(root.lines).flatMap((l, i) => {
    const x = obj(l);
    if (Object.keys(x).length === 0) return [];
    return [
      buildRow('OEM_STATEMENT', `l${i}`, {
        lineType: x.line_type,
        reference: x.reference,
        serialNumber: x.serial_number,
        description: x.description,
        amountCents: x.amount,
      }, x.confidence),
    ];
  });
  const type = str(doc.type).toUpperCase();
  return {
    kind: 'OEM_STATEMENT',
    header: {
      documentType: type === 'CREDIT_MEMO' ? 'CREDIT_MEMO' : 'STATEMENT',
      statementDate: date.ok && date.value ? date.value : '',
      footerTotal: moneyText(doc.total, true),
    },
    rows,
    confidence: mean(rows),
    documentNote: note(root.document_note),
  };
}

/** A4 — deal recap / buyer's order → draft sales (+ trades). Trade ACV is always reviewed. */
export function normalizeDealRecap(raw: unknown): AiProposal {
  const root = obj(raw);
  const rows = arr(root.deals).flatMap((dl, i) => {
    const x = obj(dl);
    if (Object.keys(x).length === 0) return [];
    const t = obj(x.trade);
    return [
      buildRow('DEALS', `d${i}`, {
        externalDealRef: x.deal_number,
        saleDate: x.sale_date,
        serialNumber: x.unit_serial,
        customer: x.customer_name,
        salePriceCents: x.sale_price,
        taxCents: x.sales_tax,
        retailRebateCents: x.retail_rebate,
        salesperson: x.salesperson,
        tradeSerial: t.serial_number,
        tradeModel: t.model,
        tradeYear: t.year,
        tradeAllowanceCents: t.allowance,
        tradeAcvCents: t.acv,
        tradeLienPayoffCents: t.lien_payoff,
      }, x.confidence, ['tradeAcvCents', 'tradeAllowanceCents']),
    ];
  });
  return { kind: 'DEALS', header: {}, rows, confidence: mean(rows), documentNote: note(root.document_note) };
}

/** Dealer-system unit / stock list → units. */
export function normalizeUnitList(raw: unknown, kind: 'UNITS' | 'OPENING'): AiProposal {
  const root = obj(raw);
  const rows = arr(root.units).flatMap((u, i) => {
    const x = obj(u);
    if (Object.keys(x).length === 0) return [];
    const src: Record<string, unknown> = {
      serialNumber: x.serial_number,
      stockNumber: x.stock_number,
      vinHin: x.vin_hin,
      make: x.make,
      model: x.model,
      modelYear: x.model_year,
      description: x.description,
      condition: x.condition,
      status: x.status,
      receivedDate: x.received_date,
      listPriceCents: x.list_price,
    };
    if (kind === 'UNITS') src.dmsInvoiceCostCents = x.dealer_cost;
    return [buildRow(kind, `u${i}`, src, x.confidence)];
  });
  return { kind, header: {}, rows, confidence: mean(rows), documentNote: note(root.document_note) };
}

/** A6 — program bulletin → DRAFT manufacturer programs (always approved by a person). */
export function normalizePrograms(raw: unknown): AiProposal {
  const root = obj(raw);
  const rows = arr(root.programs).flatMap((p, i) => {
    const x = obj(p);
    if (Object.keys(x).length === 0) return [];
    return [
      buildRow('PROGRAMS', `p${i}`, {
        programCode: x.program_code,
        name: x.name,
        programType: x.program_type,
        treatment: x.treatment,
        paidDirect: x.paid_direct,
        startDate: x.start_date,
        endDate: x.end_date,
        claimDeadlineDays: x.claim_deadline_days,
        amountCents: x.amount_per_unit,
        eligibleModels: x.eligible_models,
        notes: x.notes,
      }, x.confidence),
    ];
  });
  return { kind: 'PROGRAMS', header: {}, rows, confidence: mean(rows), documentNote: note(root.document_note) };
}

/** Dispatch by import kind. WARRANTY has no AI reader (registers come as CSV/XLSX). */
export function normalizeForKind(kind: ImportFileKind, raw: unknown): AiProposal | null {
  switch (kind) {
    case 'LENDER_STATEMENT':
    case 'LENDER_AUDIT':
      return normalizeLenderStatement(raw, kind);
    case 'OEM_STATEMENT':
      return normalizeOemStatement(raw);
    case 'DEALS':
      return normalizeDealRecap(raw);
    case 'UNITS':
    case 'OPENING':
      return normalizeUnitList(raw, kind);
    case 'PROGRAMS':
      return normalizePrograms(raw);
    case 'WARRANTY':
      return null;
  }
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences / prose). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
