/**
 * Spreadsheet reading for imports — "accept files as they come" (FPB principle 4).
 *
 * Reads a file into a plain GRID (string[][], one inner array per sheet row, cells
 * as display text) so callers can find the REAL header row themselves instead of
 * assuming row 1 is headers. Accounting exports (QuickBooks, Xero, Sage) put title
 * rows above the table — company name, report name, "As of …" — and often leave the
 * first header cell blank.
 *
 *   • .xlsx → `readXlsxSheets` in ./spreadsheet-xlsx.ts (exceljs; server-side only,
 *     kept in its own module so client code can use these pure helpers safely).
 *   • .csv  → `readCsvGrid` (RFC-4180-ish; quoted fields, embedded commas/newlines).
 *
 * This module is ADDITIVE: `lib/import/csv.ts` (row-1-is-headers) is unchanged for
 * its existing callers. Everything here is PURE (safe in client components).
 */

export type Grid = string[][];

export interface SheetGrid {
  name: string;
  grid: Grid;
}

/** Kinds of upload this module can read. */
export type SpreadsheetKind = 'xlsx' | 'csv' | 'xls' | null;

/** Classify an upload by extension first (browsers often send a blank/odd MIME). */
export function spreadsheetKind(fileName: string, mimeType?: string | null): SpreadsheetKind {
  const name = (fileName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (name.endsWith('.csv') || name.endsWith('.txt') || mime === 'text/csv') return 'csv';
  if (name.endsWith('.xls') || mime === 'application/vnd.ms-excel') return 'xls';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV → grid
// ─────────────────────────────────────────────────────────────────────────────

/** Parse CSV text into a grid of trimmed cells (blank lines kept as empty rows). */
export function readCsvGrid(text: string): Grid {
  const clean = text.replace(/^﻿/, '');
  const out: Grid = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  // Blank lines are kept as [] so a grid row index maps back to the file's line
  // (users are told "row 14"); header detection skips them.
  const endRecord = () => {
    record.push(field);
    field = '';
    out.push(record.some((f) => f.trim() !== '') ? record.map((f) => f.trim()) : []);
    record = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) endRecord();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounting amounts → integer cents (never floating-point money)
// ─────────────────────────────────────────────────────────────────────────────

export type AmountParse = { ok: true; cents: number } | { ok: false };

/**
 * Parse an accounting-formatted amount into integer CENTS.
 *   "1,234.56"  → 123456      "(1,234.56)" → -123456     "-$1,234.56" → -123456
 *   "1234.56-"  → -123456     "1,234.56 CR" → -123456    "1,234.56 DR" → 123456
 *   ""/"-"/"—"  → 0           "12345.670000000002" (Excel float) → 1234567
 * Decimal digits are rounded half-up at the cent from the STRING, not via float math.
 */
export function parseAccountingAmount(raw: string | number | null | undefined): AmountParse {
  if (raw == null) return { ok: true, cents: 0 };
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === '–') return { ok: true, cents: 0 };

  let negative = false;
  s = s.replace(/^(USD|US\$|\$)\s*\(/i, '('); // "$(1,234.56)" → "(1,234.56)"
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  const crdr = s.match(/\s*(CR|DR|Cr|Dr|cr|dr)\.?$/);
  if (crdr) { if (crdr[1].toUpperCase() === 'CR') negative = !negative; s = s.slice(0, crdr.index).trim(); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1).trim(); }
  s = s.replace(/^(USD|US\$|\$)\s*/i, '').replace(/\s*(USD)$/i, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/^\$\s*/, '').replace(/[,\s]/g, '');
  if (s === '') return { ok: true, cents: 0 };

  let cents: number;
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false };
    cents = Math.round(Math.abs(n) * 100);
    if (n < 0) negative = !negative;
  } else {
    const m = s.match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false };
    const whole = m[1] === '' ? 0 : Number(m[1]);
    const frac = (m[2] ?? '').padEnd(3, '0');
    let c = Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) c += 1; // round half-up at the cent
    cents = whole * 100 + c;
  }
  if (!Number.isSafeInteger(cents)) return { ok: false };
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

/** Integer cents → plain dollar string ("-1234.56"), built without float math. */
export function centsToPlainDollars(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${whole}.${frac < 10 ? `0${frac}` : frac}`;
}

/** Normalize a header/label cell for keyword matching. */
export function normHeader(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

/** Spreadsheet column letter for a 0-based index (0 → "A", 26 → "AA"). */
export function columnLetter(idx: number): string {
  let n = idx + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/**
 * Turn a grid into header-keyed records using row `headerIdx` as the header. Blank
 * or duplicate header cells get unique names ("Column A", "Debit (2)") so no column
 * is lost. Rows above the header and blank rows are skipped. `rowNumbers` holds each
 * record's 1-based grid row (= file row) for user-facing messages.
 */
export function gridToTable(grid: Grid, headerIdx: number): { headers: string[]; rows: Record<string, string>[]; rowNumbers: number[] } {
  const headerCells = grid[headerIdx] ?? [];
  const width = grid.slice(headerIdx + 1).reduce((w, r) => Math.max(w, r.length), headerCells.length);
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    let h = (headerCells[c] ?? '').trim() || `Column ${columnLetter(c)}`;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    if (n > 1) h = `${h} (${n})`;
    headers.push(h);
  }
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.length === 0 || cells.every((v) => v === '')) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, c) => { obj[h] = (cells[c] ?? '').trim(); });
    rows.push(obj);
    rowNumbers.push(r + 1);
  }
  return { headers, rows, rowNumbers };
}
