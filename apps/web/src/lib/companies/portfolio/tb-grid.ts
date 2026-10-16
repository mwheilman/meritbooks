/**
 * Spreadsheet trial-balance reader for the multi-file TB drop — pure (no I/O).
 *
 * Takes the raw cell grid of a CSV / XLSX trial balance exactly as exported —
 * INCLUDING the QuickBooks-style title rows ("Heritage Interiors" / "Trial Balance"
 * / "As of September 30, 2026") and a blank account-column header — and returns:
 *
 *   - `titleLines`  the text above the header row (used to match the file to a company),
 *   - `detectedAsOf` the "as of" date printed in the title (to sanity-check the cutover),
 *   - `rows` + `mapping` PRE-SHAPED for the existing conversion API
 *     (`POST /api/onboarding/conversion` body `{ mapping, rows }`), using the same
 *     fixed header names the PDF TB route emits (Account / Account Name / Debit / Credit,
 *     dollar strings — the conversion route converts dollars → cents),
 *   - a cents tie-out preview, and every row set aside with its reason (never silent).
 *
 * The conversion route stays the authority: it re-derives the mapping-aware tie-out
 * and gates go-live. This module only finds the table inside the file.
 */

export const TB_HEADER = {
  account: 'Account',
  name: 'Account Name',
  debit: 'Debit',
  credit: 'Credit',
} as const;

/** conversion field key → header name in `rows` (matches CONVERSION_SOURCE_FIELDS keys). */
export const TB_CONVERSION_MAPPING: Record<string, string> = {
  source_account: TB_HEADER.account,
  source_name: TB_HEADER.name,
  debit_cents: TB_HEADER.debit,
  credit_cents: TB_HEADER.credit,
};

export interface TbGridParse {
  titleLines: string[];
  detectedAsOf: string | null;
  /** 0-based index of the detected header row in the grid; -1 when none was found. */
  headerRowIndex: number;
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  /** Rows set aside (1-based grid row numbers) with the reason. */
  excluded: { row: number; reason: string }[];
  /** Rows with an account and an explicit zero balance (nothing to carry forward). */
  zeroRows: number;
  /** Set when no usable trial-balance table was found. */
  error: string | null;
}

// ── CSV → grid ───────────────────────────────────────────────────────────────

/**
 * Parse delimited text into a raw grid (no header assumption). Handles quotes,
 * "" escapes, embedded newlines, CRLF, a BOM, and auto-detects tab vs comma.
 */
export function csvToGrid(text: string): string[][] {
  const clean = (text ?? '').replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const grid: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      record.push(field); field = '';
      grid.push(record); record = [];
    } else field += c;
  }
  if (field !== '' || record.length > 0) { record.push(field); grid.push(record); }
  return grid.map((r) => r.map((c) => c.trim()));
}

// ── Amounts ──────────────────────────────────────────────────────────────────

/**
 * Parse an exported money cell to integer CENTS. Accepts "1,234.56", "$1,234.56",
 * "(1,234.56)", "-1234", "1234-" and "1,234.56 CR". Returns null for blank/non-numeric.
 * Decimal handled on the string (whole + fraction) so no float rounding drift.
 */
export function parseMoneyCents(raw: string | null | undefined): number | null {
  let s = (raw ?? '').trim();
  if (!s || s === '-' || s === '—') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\s*cr$/i.test(s)) { negative = !negative; s = s.replace(/\s*cr$/i, ''); }
  else if (/\s*dr$/i.test(s)) s = s.replace(/\s*dr$/i, '');
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, '');
  if (!/^\d*(\.\d+)?$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  const fracCents = Number((frac + '00').slice(0, 2));
  // Round half-up on the third decimal, if any.
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  const cents = Number(whole || '0') * 100 + fracCents + roundUp;
  return negative ? -cents : cents;
}

function centsToDollarString(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

// ── Dates in title rows ──────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Find a date printed in a title line ("As of September 30, 2026", "As of 9/30/2026", "2026-09-30"). */
export function findTitleDate(line: string): string | null {
  const s = line.trim();
  const iso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (us) {
    let y = Number(us[3]);
    if (us[3].length === 2) y += y > 50 ? 1900 : 2000;
    return validYmd(y, Number(us[1]), Number(us[2]));
  }
  const named = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (named) {
    const m = MONTHS[named[1].toLowerCase()];
    if (m) return validYmd(Number(named[3]), m, Number(named[2]));
  }
  return null;
}

// ── Header detection ─────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function isDebitHeader(h: string): boolean { const n = norm(h); return n === 'dr' || /\bdebits?\b/.test(n); }
function isCreditHeader(h: string): boolean { const n = norm(h); return n === 'cr' || /\bcredits?\b/.test(n); }
function isBalanceHeader(h: string): boolean {
  const n = norm(h);
  return /\b(balance|amount|net|ending balance|total)\b/.test(n) && !isDebitHeader(h) && !isCreditHeader(h);
}
function isNameHeader(h: string): boolean { return /\b(name|description|title)\b/.test(norm(h)); }
function isAccountHeader(h: string): boolean {
  const n = norm(h);
  return /\b(account|acct|gl|code|number|no|num)\b/.test(n) && !isNameHeader(h);
}

interface Columns { account: number; name: number; debit: number; credit: number; balance: number }

function detectColumns(row: string[]): Columns | null {
  const find = (pred: (h: string) => boolean) => row.findIndex((c) => c !== '' && pred(c));
  const debit = find(isDebitHeader);
  const credit = find(isCreditHeader);
  const balance = debit < 0 || credit < 0 ? find(isBalanceHeader) : -1;
  if ((debit < 0 || credit < 0) && balance < 0) return null;
  const amountCols = new Set([debit, credit, balance].filter((i) => i >= 0));
  let account = find(isAccountHeader);
  let name = find(isNameHeader);
  if (account < 0 && name < 0) {
    // QuickBooks: the account column header is blank. Only trusted when BOTH a Debit and
    // a Credit header are present (a lone "Balance" cell is just as likely a title row
    // like "Trial Balance"). Use the first column left of the amounts.
    if (debit < 0 || credit < 0) return null;
    const firstAmount = Math.min(...Array.from(amountCols));
    if (firstAmount <= 0) return null;
    account = 0;
  }
  if (account < 0) account = name;
  if (name === account) name = -1;
  return { account, name, debit, credit, balance };
}

/** Split "10100 · Checking" / "10100 Checking" / "10100 - Checking" into number + name. */
export function splitAccountCell(text: string): { number: string | null; name: string } {
  const t = text.trim();
  const m = t.match(/^(\d[\d.\-]*)\s*[·:\-–]?\s+(.+)$/);
  if (m) return { number: m[1].replace(/[.\-]$/, ''), name: m[2].trim() };
  if (/^\d[\d.\-]*$/.test(t)) return { number: t, name: t };
  return { number: null, name: t };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const HEADER_SCAN_ROWS = 40;

export function parseTbGrid(grid: string[][]): TbGridParse {
  const empty: TbGridParse = {
    titleLines: [], detectedAsOf: null, headerRowIndex: -1, mapping: TB_CONVERSION_MAPPING, rows: [],
    totalDebitCents: 0, totalCreditCents: 0, balanced: true, excluded: [], zeroRows: 0, error: null,
  };
  const g = (grid ?? []).map((r) => (r ?? []).map((c) => String(c ?? '').trim()));

  let headerRowIndex = -1;
  let cols: Columns | null = null;
  for (let i = 0; i < Math.min(g.length, HEADER_SCAN_ROWS); i++) {
    const c = detectColumns(g[i]);
    if (c) { headerRowIndex = i; cols = c; break; }
  }

  const titleSource = headerRowIndex >= 0 ? g.slice(0, headerRowIndex) : g.slice(0, 5);
  const titleLines = titleSource
    .map((r) => r.filter(Boolean).join(' ').trim())
    .filter(Boolean);
  let detectedAsOf: string | null = null;
  for (const l of titleLines) { detectedAsOf = findTitleDate(l); if (detectedAsOf) break; }

  if (!cols || headerRowIndex < 0) {
    return {
      ...empty, titleLines, detectedAsOf,
      error: 'Could not find the Debit/Credit (or Balance) columns in this file. Export the Trial Balance report with Debit and Credit columns.',
    };
  }

  const rows: Record<string, string>[] = [];
  const excluded: { row: number; reason: string }[] = [];
  let zeroRows = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  for (let i = headerRowIndex + 1; i < g.length; i++) {
    const r = g[i];
    const rowNum = i + 1;
    const accountCell = r[cols.account] ?? '';
    const nameCell = cols.name >= 0 ? (r[cols.name] ?? '') : '';
    const rawDebit = cols.debit >= 0 ? parseMoneyCents(r[cols.debit]) : null;
    const rawCredit = cols.credit >= 0 ? parseMoneyCents(r[cols.credit]) : null;
    const rawBalance = cols.debit < 0 || cols.credit < 0
      ? (cols.balance >= 0 ? parseMoneyCents(r[cols.balance]) : null)
      : null;
    const hasAmountCell = rawDebit !== null || rawCredit !== null || rawBalance !== null;
    let debit = rawDebit ?? 0;
    let credit = rawCredit ?? 0;
    if (rawBalance !== null) {
      if (rawBalance > 0) debit = rawBalance; else if (rawBalance < 0) credit = -rawBalance;
    }
    // Fold accounting-style negatives onto the opposite side.
    if (debit < 0) { credit += -debit; debit = 0; }
    if (credit < 0) { debit += -credit; credit = 0; }

    const label = (accountCell || nameCell).trim();
    if (!label && debit === 0 && credit === 0) continue; // blank spacer row
    if (label && !hasAmountCell) {
      excluded.push({ row: rowNum, reason: `"${label.slice(0, 60)}" has no amount — skipped as heading/footer text.` });
      continue;
    }
    if (/^total\b/i.test(label) || /^(net income|grand total)\b/i.test(label)) {
      excluded.push({ row: rowNum, reason: `"${label}" is a total line — excluded.` });
      continue;
    }
    if (!label) {
      excluded.push({ row: rowNum, reason: 'Amount with no account — excluded.' });
      continue;
    }
    if (debit > 0 && credit > 0) {
      excluded.push({ row: rowNum, reason: `"${label}" has both a debit and a credit — excluded as a subtotal.` });
      continue;
    }
    if (debit === 0 && credit === 0) { zeroRows++; continue; }

    let number: string | null;
    let name: string;
    if (cols.name >= 0 && accountCell && nameCell) {
      number = accountCell; name = nameCell;
    } else {
      const split = splitAccountCell(label);
      number = split.number; name = split.name;
    }
    rows.push({
      [TB_HEADER.account]: number ?? name,
      [TB_HEADER.name]: name,
      [TB_HEADER.debit]: debit > 0 ? centsToDollarString(debit) : '',
      [TB_HEADER.credit]: credit > 0 ? centsToDollarString(credit) : '',
    });
    totalDebit += debit;
    totalCredit += credit;
  }

  return {
    titleLines,
    detectedAsOf,
    headerRowIndex,
    mapping: TB_CONVERSION_MAPPING,
    rows,
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
    balanced: totalDebit === totalCredit,
    excluded,
    zeroRows,
    error: rows.length === 0 ? 'No account balances found under the header row.' : null,
  };
}
