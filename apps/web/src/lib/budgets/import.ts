/**
 * DETERMINISTIC budget importer — CSV / XLSX → public.budgets rows.
 *
 * A firm exports its annual budget (from Excel, QuickBooks, Sage, a planning tool,
 * or a hand-built spreadsheet) as CSV or XLSX and loads it straight into the existing
 * budgets feature WITHOUT any model call. The columns are auto-mapped (then human-
 * confirmed in the preview), the amounts are folded to monthly period cells, and the
 * result is upserted into `public.budgets` — the SAME rows the Budget Entry grid and
 * Budget-vs-Actual already read (migration 013).
 *
 * Two shapes are supported, auto-detected from the header row:
 *   • MONTHLY — an Account column plus up to twelve month columns (Jan…Dec). Each
 *     month cell becomes one budget period (period_number 1–12).
 *   • ANNUAL  — an Account column plus a single annual/total amount column. The annual
 *     figure is spread evenly across the twelve months (remainder to January), exactly
 *     like the grid's "Spread" button, so it foots to the imported total to the cent.
 *
 * Everything in this module is PURE and DB/model-free (safe for the client bundle and
 * unit tests): the column auto-mapper (reuses `autoMap`), the amount parser (bigint
 * cents via `dollarsToCents`, never floats), the row extractor, and the monthly fold.
 * The XLSX byte-reader (`../payroll/xlsx-read.ts`) and the account-number resolution +
 * upsert live server-side in the route; nothing here touches Supabase.
 */

import { dollarsToCents } from '@meritbooks/shared';
import { autoMap, type ParsedCsv } from '@/lib/import/csv';
import type { ImportFieldDef } from '@/lib/import/definitions';

// ── Layout + field vocabulary ──────────────────────────────────────────────

export type BudgetLayout = 'monthly' | 'annual';

/** The 12 fiscal months, period_number 1–12. */
export const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const MONTH_ALIASES: string[][] = [
  ['jan', 'january', 'month 1', 'period 1', 'm1', 'p1'],
  ['feb', 'february', 'month 2', 'period 2', 'm2', 'p2'],
  ['mar', 'march', 'month 3', 'period 3', 'm3', 'p3'],
  ['apr', 'april', 'month 4', 'period 4', 'm4', 'p4'],
  ['may', 'month 5', 'period 5', 'm5', 'p5'],
  ['jun', 'june', 'month 6', 'period 6', 'm6', 'p6'],
  ['jul', 'july', 'month 7', 'period 7', 'm7', 'p7'],
  ['aug', 'august', 'month 8', 'period 8', 'm8', 'p8'],
  ['sep', 'sept', 'september', 'month 9', 'period 9', 'm9', 'p9'],
  ['oct', 'october', 'month 10', 'period 10', 'm10', 'p10'],
  ['nov', 'november', 'month 11', 'period 11', 'm11', 'p11'],
  ['dec', 'december', 'month 12', 'period 12', 'm12', 'p12'],
];

/** Account-identifier column (matched to the chart of accounts by number, then name). */
const ACCOUNT_FIELD: ImportFieldDef = {
  key: 'account',
  label: 'Account',
  type: 'text',
  required: true,
  aliases: ['account', 'account number', 'acct', 'account no', 'gl', 'gl account', 'gl code', 'number', 'code', 'account name', 'name'],
};

/** Single annual/total amount column (annual layout). */
const ANNUAL_FIELD: ImportFieldDef = {
  key: 'annual',
  label: 'Annual Amount',
  type: 'money',
  aliases: ['annual', 'annual budget', 'annual amount', 'total', 'total budget', 'budget', 'amount', 'full year', 'fy total', 'year total', 'yearly'],
};

/** Month field defs (key m1..m12), used only for header auto-mapping. */
const MONTH_FIELDS: ImportFieldDef[] = MONTH_ALIASES.map((aliases, i) => ({
  key: `m${i + 1}`,
  label: MONTH_LABELS[i],
  type: 'money',
  aliases,
}));

// ── Parsed-row + result shapes ─────────────────────────────────────────────

/**
 * One extracted amount for one account at one period. `period` is a month number
 * (1–12) in the monthly layout, or the string `'annual'` in the annual layout (the
 * route/fold spreads it across the twelve months).
 */
export interface BudgetImportRow {
  /** Source row number (1-based over data rows, +1 for the header). */
  rowNum: number;
  /** The verbatim account identifier from the file (number or name). */
  accountRef: string;
  period: number | 'annual';
  amountCents: number;
}

export interface BudgetParseError {
  row: number;
  message: string;
}

export interface BudgetColumnMapping {
  /** Header text mapped to the account column, or '' if none. */
  account: string;
  /** Header text for the annual column (annual layout), or ''. */
  annual: string;
  /** Header text per month index 0–11 (monthly layout), '' where absent. */
  months: string[];
}

export interface BudgetParseResult {
  layout: BudgetLayout;
  mapping: BudgetColumnMapping;
  rows: BudgetImportRow[];
  errors: BudgetParseError[];
  /** Distinct account identifiers seen, in first-seen order. */
  accountRefs: string[];
  /** Footing: signed sum of every extracted amount, in cents. */
  totalCents: number;
  /** Count of source data rows that produced at least one amount. */
  rowCount: number;
}

// ── Amount parsing (bigint cents; never floats) ────────────────────────────

/**
 * Parse a spreadsheet money cell to signed integer cents. Tolerates `$`, thousands
 * separators, surrounding whitespace, a leading `-`, and accounting parentheses
 * `(1,200.00)` → -120000. Blank, `-`, and `—` read as 0. Returns `ok:false` (never
 * NaN, never a guess) for anything non-numeric so the caller can flag the row.
 */
export function parseAmountCents(raw: string): { cents: number; ok: boolean } {
  const t = (raw ?? '').trim();
  if (t === '' || t === '-' || t === '—' || t === '–') return { cents: 0, ok: true };
  let s = t;
  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) { negative = true; s = paren[1].trim(); }
  // Reject anything that isn't a number after stripping currency/thousands.
  const stripped = s.replace(/[,$\s]/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(stripped)) return { cents: 0, ok: false };
  const cents = dollarsToCents(s);
  if (!Number.isFinite(cents)) return { cents: 0, ok: false };
  return { cents: negative ? -cents : cents, ok: true };
}

// ── Column mapping + layout detection ──────────────────────────────────────

/**
 * Auto-map the header row to the account column, the twelve month columns, and the
 * single annual column, then decide the layout: MONTHLY when at least two month
 * columns are recognized, otherwise ANNUAL. Callers may override with an explicit
 * mapping (e.g. after the human adjusts the preview).
 */
export function mapBudgetColumns(headers: string[]): { mapping: BudgetColumnMapping; layout: BudgetLayout } {
  const accountMap = autoMap(headers, [ACCOUNT_FIELD]);
  const monthMap = autoMap(headers, MONTH_FIELDS);
  const annualMap = autoMap(headers, [ANNUAL_FIELD]);

  const account = accountMap.account ?? '';
  const months = MONTH_FIELDS.map((f) => monthMap[f.key] ?? '');
  let annual = annualMap.annual ?? '';

  // Never let the same header serve as both the account column and an amount column.
  const monthsClean = months.map((h) => (h && h === account ? '' : h));
  if (annual === account) annual = '';

  const monthCount = monthsClean.filter(Boolean).length;
  const layout: BudgetLayout = monthCount >= 2 ? 'monthly' : 'annual';

  return { mapping: { account, annual, months: monthsClean }, layout };
}

// ── Grid → budget rows ─────────────────────────────────────────────────────

export interface ParseBudgetOptions {
  /** Force a layout instead of auto-detecting. */
  layout?: BudgetLayout;
  /** Override the auto-detected column mapping. */
  mapping?: BudgetColumnMapping;
}

/**
 * Extract budget amounts from a parsed grid (headers + header-keyed rows). Pure:
 * no account resolution, no DB. Amounts are folded later by `foldToPeriods` once the
 * account is resolved server-side.
 */
export function parseBudgetGrid(input: ParsedCsv, opts: ParseBudgetOptions = {}): BudgetParseResult {
  const auto = mapBudgetColumns(input.headers);
  const mapping = opts.mapping ?? auto.mapping;
  const layout = opts.layout ?? auto.layout;

  const rows: BudgetImportRow[] = [];
  const errors: BudgetParseError[] = [];
  const accountRefs: string[] = [];
  const seenRefs = new Set<string>();
  let totalCents = 0;
  let rowCount = 0;

  if (!mapping.account) {
    errors.push({ row: 0, message: 'No Account column was detected. The first column should hold the account number or name.' });
    return { layout, mapping, rows, errors, accountRefs, totalCents, rowCount };
  }
  if (layout === 'annual' && !mapping.annual) {
    errors.push({ row: 0, message: 'No amount column was detected. Provide monthly columns (Jan…Dec) or a single Annual/Total column.' });
    return { layout, mapping, rows, errors, accountRefs, totalCents, rowCount };
  }

  input.rows.forEach((raw, i) => {
    const rowNum = i + 2; // +1 header, +1 to 1-index
    const accountRef = (raw[mapping.account] ?? '').trim();
    if (accountRef === '') return; // blank/spacer/total row — skip silently

    if (!seenRefs.has(accountRef.toLowerCase())) {
      seenRefs.add(accountRef.toLowerCase());
      accountRefs.push(accountRef);
    }

    let produced = false;

    if (layout === 'monthly') {
      mapping.months.forEach((header, idx) => {
        if (!header) return;
        const cell = raw[header] ?? '';
        const { cents, ok } = parseAmountCents(cell);
        if (!ok) { errors.push({ row: rowNum, message: `${MONTH_LABELS[idx]} value "${cell}" for "${accountRef}" is not a number.` }); return; }
        if (cents === 0) return; // don't write empty cells
        rows.push({ rowNum, accountRef, period: idx + 1, amountCents: cents });
        totalCents += cents;
        produced = true;
      });
    } else {
      const cell = raw[mapping.annual] ?? '';
      const { cents, ok } = parseAmountCents(cell);
      if (!ok) { errors.push({ row: rowNum, message: `Annual value "${cell}" for "${accountRef}" is not a number.` }); return; }
      if (cents !== 0) {
        rows.push({ rowNum, accountRef, period: 'annual', amountCents: cents });
        totalCents += cents;
        produced = true;
      }
    }

    if (produced) rowCount += 1;
  });

  return { layout, mapping, rows, errors, accountRefs, totalCents, rowCount };
}

// ── Monthly fold (annual → 12 even cells) ──────────────────────────────────

/**
 * Spread an annual amount evenly across the twelve months, putting the rounding
 * remainder in January — identical to the Budget Entry grid's "Spread" so an
 * imported annual figure and a hand-spread one land on the same cents.
 */
export function spreadAnnualCents(annualCents: number): Record<number, number> {
  const base = Math.trunc(annualCents / 12);
  const remainder = annualCents - base * 12;
  const periods: Record<number, number> = {};
  for (let n = 1; n <= 12; n++) periods[n] = base + (n === 1 ? remainder : 0);
  return periods;
}

/**
 * Fold parsed rows into monthly period cells per account identifier. Monthly rows
 * map straight to their period (summed if repeated); annual rows are spread across
 * the twelve months. Returns `accountRef → { 1..12 → cents }` (zero cells omitted).
 * Pure and testable — the route resolves each `accountRef` to an account id.
 */
export function foldToPeriods(rows: BudgetImportRow[]): Map<string, Record<number, number>> {
  const out = new Map<string, Record<number, number>>();
  const add = (ref: string, period: number, cents: number) => {
    let periods = out.get(ref);
    if (!periods) { periods = {}; out.set(ref, periods); }
    periods[period] = (periods[period] ?? 0) + cents;
  };

  for (const r of rows) {
    if (r.period === 'annual') {
      const spread = spreadAnnualCents(r.amountCents);
      for (let n = 1; n <= 12; n++) if (spread[n] !== 0) add(r.accountRef, n, spread[n]);
    } else {
      add(r.accountRef, r.period, r.amountCents);
    }
  }
  return out;
}

// ── XLSX grid → ParsedCsv shape ────────────────────────────────────────────

/**
 * Convert the rectangular string grid returned by the dependency-free XLSX reader
 * (`{ headers, rows: string[][] }`) into the header-keyed `ParsedCsv` shape the pure
 * parser consumes. Duplicate headers are disambiguated so no column is lost.
 */
export function gridToParsedCsv(grid: { headers: string[]; rows: string[][] }): ParsedCsv {
  const headers = grid.headers.map((h) => h.trim());
  const rows = grid.rows.map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const key = h in obj ? `${h} (${idx + 1})` : h;
      obj[key] = (r[idx] ?? '').trim();
    });
    return obj;
  });
  return { headers, rows };
}
