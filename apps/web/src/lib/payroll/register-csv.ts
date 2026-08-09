/**
 * DETERMINISTIC payroll-register importer — CSV / XLSX → balanced payroll JE.
 *
 * This is the NO-AI complement to the drop-and-parse AI path (`register-parse.ts`).
 * A tenant that ran payroll at an outside processor (ADP, Gusto, QuickBooks Payroll,
 * Paychex, or a spreadsheet) can export the payroll REGISTER as a CSV or XLSX and
 * import it here WITHOUT any model call: the columns are mapped (auto-detected, then
 * human-confirmed) to payroll fields, summed to period TOTALS, and normalized into
 * the SAME `NormalizedRegister` shape the AI path produces — which
 * `buildProposedPayrollJE` (in `register-parse.ts`) turns into a balanced entry.
 *
 * Everything in this module is PURE and DB/model-free (safe for the client bundle and
 * unit tests): the delimited-file parser, the header auto-mapper, and the row
 * aggregator. The XLSX byte-reader (`xlsx-read.ts`) and the role→account resolution
 * (the build route) live server-side. Money is bigint cents throughout; a blank or
 * unparseable cell is 0, never NaN — nothing is ever guessed.
 *
 * Canon §3 boundary is preserved: this proposes a BALANCED entry from the tenant's
 * own numbers; the deterministic engine (`postJournalEntry` / `check_journal_balance()`)
 * does the accounting only after a human confirms via the gated confirm route.
 */

import type { NormalizedRegister, RegisterLineItem } from './register-parse';

// ---------------------------------------------------------------------------
// Column → payroll-field mapping vocabulary
// ---------------------------------------------------------------------------

/**
 * The payroll field a source column maps to. `ignore` drops the column;
 * `employee` is used only to count paid employees (never summed into the JE);
 * `employer_tax` / `deduction` become their own credit lines, labelled by the
 * column header, so ANY provider's tax/deduction columns import without a schema
 * change.
 */
export type PayrollFieldTarget =
  | 'ignore'
  | 'employee'
  | 'gross'
  | 'fed_wh'
  | 'state_wh'
  | 'local_wh'
  | 'fica_ss'
  | 'fica_medicare'
  | 'fica'
  | 'net'
  | 'employer_tax'
  | 'deduction';

/** A single source column mapped to a payroll field. */
export interface ColumnMapping {
  /** The verbatim header text. */
  header: string;
  /** 0-based column index in the parsed grid. */
  index: number;
  target: PayrollFieldTarget;
  /** GL line label for `employer_tax` / `deduction` columns (defaults to the header). */
  label?: string;
}

/** Human-facing labels for each target (used in the mapping dropdown + preview). */
export const TARGET_LABELS: Record<PayrollFieldTarget, string> = {
  ignore: 'Ignore column',
  employee: 'Employee (name / id)',
  gross: 'Gross wages',
  fed_wh: 'Federal income tax withheld (employee)',
  state_wh: 'State income tax withheld (employee)',
  local_wh: 'Local / city tax withheld (employee)',
  fica_ss: 'Social Security withheld (employee)',
  fica_medicare: 'Medicare withheld (employee)',
  fica: 'FICA withheld — combined (employee)',
  net: 'Net pay (take-home)',
  employer_tax: 'Employer tax (FUTA / SUTA / employer FICA …)',
  deduction: 'Deduction (401k / health / garnishment …)',
};

/** Targets whose columns must be numeric money (everything except ignore/employee). */
export const MONEY_TARGETS: ReadonlySet<PayrollFieldTarget> = new Set<PayrollFieldTarget>([
  'gross', 'fed_wh', 'state_wh', 'local_wh', 'fica_ss', 'fica_medicare', 'fica', 'net',
  'employer_tax', 'deduction',
]);

/**
 * Targets that must appear AT MOST once (a register has one gross column, one net
 * column, etc.). `employer_tax` / `deduction` / `ignore` may repeat; `employee` too.
 */
const SINGLETON_TARGETS: ReadonlySet<PayrollFieldTarget> = new Set<PayrollFieldTarget>([
  'gross', 'fed_wh', 'state_wh', 'local_wh', 'fica_ss', 'fica_medicare', 'fica', 'net',
]);

// ---------------------------------------------------------------------------
// Pure amount coercion (kept local so this module has no runtime dependency on
// the AI parser — importing a value from register-parse.ts would pull the Core AI
// gateway into the client bundle). Mirrors `parseAmountToCents` there.
// ---------------------------------------------------------------------------

/**
 * Parse a spreadsheet cell to bigint cents. Accepts numbers (dollars), strings with
 * $/commas/whitespace, and parenthesized negatives "(1,234.56)". Blank/unparseable
 * → 0 (never NaN). Rounds to the nearest cent.
 */
export function cellToCents(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : 0;
  if (typeof raw !== 'string') return 0;
  let s = raw.trim();
  if (s === '') return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

// ---------------------------------------------------------------------------
// Delimited (CSV / TSV) parser — RFC 4180-ish, with delimiter auto-detection
// ---------------------------------------------------------------------------

export interface ParsedGrid {
  headers: string[];
  /** Data rows (header row excluded). Each row is aligned to `headers.length`. */
  rows: string[][];
}

/** Pick the delimiter by counting candidates in the first non-empty line. */
function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const candidates: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['|', (firstLine.match(/\|/g) ?? []).length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

/**
 * Parse CSV/TSV text into a header row + data rows. Handles quoted fields with
 * embedded delimiters, quotes ("" escape), and newlines. Strips a UTF-8 BOM and
 * skips fully-blank lines. Rows are padded/truncated to the header width so the
 * grid is rectangular.
 */
export function parseDelimited(text: string, delimiterOverride?: string): ParsedGrid {
  const clean = text.replace(/^﻿/, '');
  const delimiter = delimiterOverride ?? detectDelimiter(clean);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    // Keep the record unless it is entirely empty (a blank line).
    if (record.some((c) => c.trim() !== '')) records.push(record);
    record = [];
  };

  while (i < clean.length) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\n') { pushRecord(); i++; continue; }
    if (ch === '\r') { if (clean[i + 1] === '\n') i++; pushRecord(); i++; continue; }
    field += ch; i++;
  }
  // Trailing field / record.
  if (field !== '' || record.length > 0) pushRecord();

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const width = headers.length;
  const rows = records.slice(1).map((r) => {
    const out = r.slice(0, width).map((c) => c.trim());
    while (out.length < width) out.push('');
    return out;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Header auto-mapping (deterministic keyword rules)
// ---------------------------------------------------------------------------

/** True when the header carries an EMPLOYER marker (so an ambiguous FICA/SS/Med column is the employer share). */
function isEmployerHeader(h: string): boolean {
  return /(\ber\b|employer|company|comp\b|\bco\b)/.test(h) && !/\bee\b|employee/.test(h);
}

/**
 * Guess a target for each header from documented keyword rules. Ambiguous or
 * unrecognized columns default to `ignore` (never guessed into the JE). EE/ER
 * markers disambiguate the FICA/SS/Medicare employee-vs-employer split.
 */
export function guessMapping(headers: string[]): ColumnMapping[] {
  const used = new Set<PayrollFieldTarget>();
  return headers.map((header, index) => {
    const h = header.toLowerCase().trim();
    let target: PayrollFieldTarget = 'ignore';

    const take = (t: PayrollFieldTarget): boolean => {
      if (SINGLETON_TARGETS.has(t) && used.has(t)) return false;
      target = t;
      if (SINGLETON_TARGETS.has(t)) used.add(t);
      return true;
    };

    // Employer taxes first (so "employer FICA", "FUTA", "SUTA" don't fall through to employee).
    if (/(futa|suta|sui\b|state unemployment|federal unemployment|\bui\b|\bett\b|employer|er tax)/.test(h)) {
      target = 'employer_tax';
    } else if (isEmployerHeader(h) && /(fica|social security|soc sec|oasdi|medicare)/.test(h)) {
      target = 'employer_tax';
    } else if (/(employee|worker|\bee name\b|emp(loyee)? id|\bname\b|person|associate)/.test(h)) {
      take('employee') || (target = 'ignore');
    } else if (/(gross|total earnings|gross pay|gross wage|total wages)/.test(h)) {
      take('gross') || (target = 'ignore');
    } else if (/(net pay|net check|take.?home|check amount|check amt|\bnet\b)/.test(h)) {
      take('net') || (target = 'ignore');
    } else if (/(fed(eral)?.*(income|tax|w\/?h|withh)|\bfit\b|fed w\/?h)/.test(h) && !/unempl|futa/.test(h)) {
      take('fed_wh') || (target = 'ignore');
    } else if (/(state.*(income|tax|w\/?h|withh)|\bsit\b)/.test(h) && !/unempl|suta|sui/.test(h)) {
      take('state_wh') || (target = 'ignore');
    } else if (/(local|city|municipal|county).*(tax|w\/?h|withh)?/.test(h)) {
      take('local_wh') || (target = 'ignore');
    } else if (/(social security|soc sec|oasdi|\bss\b(?!n))/.test(h)) {
      take('fica_ss') || (target = 'ignore');
    } else if (/(medicare|\bmed\b)/.test(h)) {
      take('fica_medicare') || (target = 'ignore');
    } else if (/\bfica\b/.test(h)) {
      take('fica') || (target = 'ignore');
    } else if (/(401|403b|457|retire|pension|roth|\bira\b|deferral)/.test(h)) {
      target = 'deduction';
    } else if (/(health|medical|dental|vision|hsa|fsa|insurance|premium)/.test(h)) {
      target = 'deduction';
    } else if (/(garnish|child support|levy|withholding order|wage assignment)/.test(h)) {
      target = 'deduction';
    } else if (/(deduction|union dues|loan repay)/.test(h)) {
      target = 'deduction';
    }

    return { header, index, target };
  });
}

// ---------------------------------------------------------------------------
// Aggregation: mapped rows → period totals
// ---------------------------------------------------------------------------

export interface AggregatedRegister {
  grossCents: number;
  netCents: number;
  federalWithholdingCents: number;
  stateWithholdingCents: number;
  localWithholdingCents: number;
  ficaEmployeeCents: number;
  employerTaxes: RegisterLineItem[];
  deductions: RegisterLineItem[];
  employeeCount: number;
  /** gross - net - employee withholdings - deductions (0 when the register foots). */
  footingDeltaCents: number;
  /** The register's own arithmetic foots AND gross > 0. */
  registerFoots: boolean;
}

/**
 * Sum each mapped column across every data row into payroll period totals.
 * `employer_tax` / `deduction` columns become one labelled line each (label =
 * mapping.label || header), so multiple such columns import cleanly. Employee
 * count is the number of rows with a non-empty employee cell, or the row count
 * when no employee column is mapped.
 */
export function aggregateRows(rows: string[][], mapping: ColumnMapping[]): AggregatedRegister {
  let grossCents = 0;
  let netCents = 0;
  let federalWithholdingCents = 0;
  let stateWithholdingCents = 0;
  let localWithholdingCents = 0;
  let ficaSsCents = 0;
  let ficaMedCents = 0;
  let ficaCombinedCents = 0;
  const employerTaxes: RegisterLineItem[] = [];
  const deductions: RegisterLineItem[] = [];

  const employeeCols = mapping.filter((m) => m.target === 'employee').map((m) => m.index);

  const colSum = (index: number): number =>
    rows.reduce((s, r) => s + cellToCents(r[index]), 0);

  for (const m of mapping) {
    switch (m.target) {
      case 'gross': grossCents += colSum(m.index); break;
      case 'net': netCents += colSum(m.index); break;
      case 'fed_wh': federalWithholdingCents += colSum(m.index); break;
      case 'state_wh': stateWithholdingCents += colSum(m.index); break;
      case 'local_wh': localWithholdingCents += colSum(m.index); break;
      case 'fica_ss': ficaSsCents += colSum(m.index); break;
      case 'fica_medicare': ficaMedCents += colSum(m.index); break;
      case 'fica': ficaCombinedCents += colSum(m.index); break;
      case 'employer_tax': {
        const cents = colSum(m.index);
        if (cents > 0) employerTaxes.push({ label: (m.label || m.header).trim() || 'Employer tax', cents });
        break;
      }
      case 'deduction': {
        const cents = colSum(m.index);
        if (cents > 0) deductions.push({ label: (m.label || m.header).trim() || 'Deduction', cents });
        break;
      }
      default: break;
    }
  }

  const ficaEmployeeCents = ficaSsCents + ficaMedCents + ficaCombinedCents;

  let employeeCount = rows.length;
  if (employeeCols.length > 0) {
    employeeCount = rows.filter((r) => employeeCols.some((c) => (r[c] ?? '').trim() !== '')).length;
  }

  const employeeWithholdingTotal =
    federalWithholdingCents + stateWithholdingCents + localWithholdingCents + ficaEmployeeCents;
  const deductionTotal = deductions.reduce((s, d) => s + d.cents, 0);
  const footingDeltaCents = grossCents - employeeWithholdingTotal - deductionTotal - netCents;

  return {
    grossCents,
    netCents,
    federalWithholdingCents,
    stateWithholdingCents,
    localWithholdingCents,
    ficaEmployeeCents,
    employerTaxes,
    deductions,
    employeeCount,
    footingDeltaCents,
    registerFoots: footingDeltaCents === 0 && grossCents > 0,
  };
}

/**
 * Turn an aggregation + period metadata into the SAME `NormalizedRegister` shape the
 * AI parser produces, so `buildProposedPayrollJE` can build the balanced entry. The
 * deterministic import has full confidence in its own sums (there is no model to be
 * unsure) — `confidence` is 1 and `lowConfidenceFields` reflects only structural
 * gaps (missing gross/net, or a register that doesn't foot).
 */
export function aggregatedToNormalized(
  agg: AggregatedRegister,
  meta: { payDate: string | null; periodStart: string | null; periodEnd: string | null },
): NormalizedRegister {
  const low: string[] = [];
  if (agg.grossCents <= 0) low.push('gross_wages');
  if (agg.netCents <= 0) low.push('net_pay');
  if (!agg.registerFoots && agg.grossCents > 0) low.push('footing');

  return {
    payDate: meta.payDate,
    periodStart: meta.periodStart,
    periodEnd: meta.periodEnd,
    employeeCount: agg.employeeCount > 0 ? agg.employeeCount : null,
    grossCents: agg.grossCents,
    netCents: agg.netCents,
    federalWithholdingCents: agg.federalWithholdingCents,
    stateWithholdingCents: agg.stateWithholdingCents,
    localWithholdingCents: agg.localWithholdingCents,
    ficaEmployeeCents: agg.ficaEmployeeCents,
    employerTaxes: agg.employerTaxes,
    deductions: agg.deductions,
    confidence: {
      pay_date: meta.payDate ? 1 : 0,
      gross_wages: agg.grossCents > 0 ? 1 : 0,
      net_pay: agg.netCents > 0 ? 1 : 0,
      employee_taxes: 1,
      employer_taxes: 1,
      deductions: 1,
    },
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

/** Serializable, minimal mapping row for saving/loading a per-provider template. */
export interface SavedMappingColumn {
  header: string;
  target: PayrollFieldTarget;
  label?: string;
}

/** A stable signature of a file's header set, used to auto-suggest a saved mapping. */
export function headerSignature(headers: string[]): string {
  return headers.map((h) => h.toLowerCase().trim()).filter(Boolean).sort().join('|');
}

/**
 * Re-apply a saved mapping template to a freshly parsed grid by matching on header
 * text (case-insensitive). Columns not present in the template fall back to the
 * deterministic guess so a slightly-changed export still imports.
 */
export function applySavedMapping(headers: string[], saved: SavedMappingColumn[]): ColumnMapping[] {
  const byHeader = new Map<string, SavedMappingColumn>();
  for (const s of saved) byHeader.set(s.header.toLowerCase().trim(), s);
  const guessed = guessMapping(headers);
  return headers.map((header, index) => {
    const hit = byHeader.get(header.toLowerCase().trim());
    if (hit) return { header, index, target: hit.target, label: hit.label };
    return guessed[index];
  });
}
