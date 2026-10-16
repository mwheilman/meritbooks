/**
 * Trial balance from a SPREADSHEET (.xlsx / .csv) — deterministic, no AI (FPB
 * principles 4 + 10: accept files as they come; works with AI off).
 *
 * Built for the exports owners actually have, QuickBooks first:
 *
 *   QuickBooks Online "Trial Balance" export
 *     row 1  Heritage Interiors LLC            ← title rows (skipped)
 *     row 2  Trial Balance
 *     row 3  As of September 30, 2026          ← captured as a date hint
 *     row 5  (blank) | Debit | Credit          ← REAL header; first cell blank
 *     row 6  1000 Checking | 12,345.67 |
 *     …
 *     row N  TOTAL | $X | $X                   ← dropped (reported, never silent)
 *     row N+3 Accrual Basis Friday, October …  ← footer, dropped (no amounts)
 *
 *   QuickBooks Desktop: "1000 · Checking", hierarchy spread over several blank-header
 *   columns. Xero/Sage/generic: "Account Code | Account Name | Debit | Credit" or a
 *   single signed "Balance" column.
 *
 * Output: one line per account with INTEGER CENTS (debit XOR credit after folding
 * negatives), plus every dropped row with a plain reason. Pure — no I/O.
 */

import { normHeader, parseAccountingAmount, type Grid, type SheetGrid } from '@/lib/import/spreadsheet';

export interface SpreadsheetTbLine {
  /** 1-based row in the file / sheet. */
  row: number;
  accountNumber: string | null;
  accountName: string;
  debitCents: number;
  creditCents: number;
}

export interface SpreadsheetTbColumns {
  /** Header label of each detected column (blank headers shown as "(no heading)"). */
  account: string;
  name: string | null;
  debit: string | null;
  credit: string | null;
  balance: string | null;
}

export type SpreadsheetTbResult =
  | {
      ok: true;
      sheetName: string | null;
      /** 1-based row of the detected header. */
      headerRow: number;
      columns: SpreadsheetTbColumns;
      lines: SpreadsheetTbLine[];
      dropped: { row: number; reason: string }[];
      /** "As of …" date found in the title rows (YYYY-MM-DD), when present. */
      asOfDateHint: string | null;
      /** Title text above the table (company / report name), for display. */
      titleLines: string[];
    }
  | { ok: false; error: string; code?: typeof GL_DETAIL_NOT_TB_CODE };

const HEADER_SCAN_ROWS = 40;

/** Failure code: the file is a General Ledger DETAIL export (transactions), not a TB. */
export const GL_DETAIL_NOT_TB_CODE = 'GL_DETAIL_NOT_TB' as const;

/** The plain message (with the exact QuickBooks Online export steps) for a GL detail file. */
export const GL_DETAIL_NOT_TB_MESSAGE =
  'This looks like a General Ledger report — a list of every transaction — not a trial balance. ' +
  'To bring your opening balances over we need the Trial Balance (one line per account, with its balance). ' +
  'In QuickBooks Online: go to Reports, search for “Trial Balance”, set the date to the day before MeritBooks ' +
  'takes over, click Run report, then the export icon → Export to Excel, and drop that file here. ' +
  'Keep the General Ledger file — it’s useful history, it just can’t set opening balances on its own.';

const GL_TITLE_RE = /\bgeneral\s+ledger\b|\btransaction\s+(detail|list)\b|\bjournal\s+report\b/i;
// Compared against normHeader() output ("Memo/Description" → "memo description", "No." → "no").
const TRANSACTION_COL_RE = /^(transaction type|type|num|no|split|memo description|memo|description|name|distribution account)$/;

/**
 * Does this grid look like a General Ledger / transaction DETAIL export rather than a
 * trial balance? QuickBooks Online's GL export has a "General Ledger" title row and a
 * header like  (blank) | Date | Transaction Type | Num | Name | Memo/Description | Split | Amount | Balance.
 * Signals: a GL title above the header, OR a header carrying a Date column plus at
 * least two other transaction-only columns (type / num / split / memo / name).
 */
export function looksLikeGeneralLedgerDetail(grid: Grid): boolean {
  // Only look at the report's title + header block — never at account rows (an account
  // named "General Ledger Suspense" must not trip the check).
  const tbHeader = findTbHeaderRow(grid);
  const end = tbHeader >= 0 ? tbHeader + 1 : Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < end; i++) {
    const raw = grid[i] ?? [];
    const cells = raw.map(normHeader);
    const nonEmpty = cells.filter((c) => c !== '');
    if (nonEmpty.length === 0) continue;
    // Title rows above the header (one or two filled cells): a GL / transaction-detail report name.
    const isTitleRow = (tbHeader < 0 || i < tbHeader) && nonEmpty.length <= 2;
    if (isTitleRow && raw.some((c) => GL_TITLE_RE.test(c)) && !raw.some((c) => /trial\s+balance/i.test(c))) {
      return true;
    }
    // Header row: a Date column plus at least two transaction-only columns.
    const hasDate = cells.some((c) => c === 'date' || c === 'transaction date');
    const txnCols = cells.filter((c) => TRANSACTION_COL_RE.test(c)).length;
    if (hasDate && txnCols >= 2) return true;
  }
  return false;
}

const isDebitHeader = (h: string) => /\bdebits?\b/.test(h) || h === 'dr';
const isCreditHeader = (h: string) => /\bcredits?\b/.test(h) || h === 'cr';
const isBalanceHeader = (h: string) =>
  !isDebitHeader(h) && !isCreditHeader(h) && /\b(balance|amount|net|ending balance|total)\b/.test(h);
const isNumberHeader = (h: string) =>
  /\b(number|no|num|code|gl)\b/.test(h) || h.includes('#') || h === 'acct';
const isNameHeader = (h: string) => /\b(name|description|title)\b/.test(h);
const isAccountHeader = (h: string) => /\b(account|accounts|acct)\b/.test(h);

/** Index of the real header row, or -1. A header names Debit+Credit, or a Balance plus an account column. */
export function findTbHeaderRow(grid: Grid): number {
  const limit = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const cells = (grid[i] ?? []).map(normHeader);
    if (cells.length === 0) continue;
    const hasDebit = cells.some(isDebitHeader);
    const hasCredit = cells.some(isCreditHeader);
    if (hasDebit && hasCredit) return i;
    const hasBalance = cells.some(isBalanceHeader);
    const hasAccount = cells.some((c) => isAccountHeader(c) || isNumberHeader(c) || isNameHeader(c));
    if (hasBalance && hasAccount && !looksLikeDataRow(grid[i])) return i;
  }
  return -1;
}

function looksLikeDataRow(cells: string[] | undefined): boolean {
  if (!cells) return false;
  return cells.filter((c) => c !== '' && parseAccountingAmount(c).ok && /\d/.test(c)).length >= 1;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Loose date → YYYY-MM-DD ("September 30, 2026", "Sep 30 2026", "9/30/2026", "2026-09-30"). */
export function parseLooseDate(text: string): string | null {
  const s = text.trim();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const valid = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) { const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    const [d, y] = [Number(m[2]), Number(m[3])];
    if (mo && valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) { const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])]; return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  return null;
}

/** Split "1000 Checking" / "1000 · Checking" / "1000-10 - Petty Cash" into number + name. */
export function splitAccountLabel(label: string): { accountNumber: string | null; accountName: string } {
  const s = label.trim();
  const m = s.match(/^(\d+(?:[.-]\d+)*)(?:\s*[·•:|–—-]\s*|\s+)(.+)$/);
  if (m && m[2].trim()) return { accountNumber: m[1], accountName: m[2].trim() };
  if (/^\d+(?:[.-]\d+)*$/.test(s)) return { accountNumber: s, accountName: s };
  return { accountNumber: null, accountName: s };
}

const isTotalLabel = (s: string) => /^(grand\s+)?total\b/i.test(s.trim()) || /^total for\b/i.test(s.trim());

/** Normalize one grid (one sheet / CSV) into trial-balance lines. */
export function normalizeTrialBalanceGrid(grid: Grid, sheetName: string | null = null): SpreadsheetTbResult {
  const headerIdx = findTbHeaderRow(grid);
  if (headerIdx < 0) {
    return {
      ok: false,
      error:
        'We couldn’t find the Debit and Credit (or Balance) columns in this file. ' +
        'In QuickBooks, run Reports → Trial Balance and export it to Excel, then drop that file here.',
    };
  }

  const header = (grid[headerIdx] ?? []).map(normHeader);
  const rawHeader = grid[headerIdx] ?? [];
  const debitIdx = header.findIndex(isDebitHeader);
  const creditIdx = header.findIndex(isCreditHeader);
  const useDebitCredit = debitIdx >= 0 && creditIdx >= 0;
  const balanceIdx = useDebitCredit ? -1 : header.findIndex(isBalanceHeader);
  const amountIdxs = (useDebitCredit ? [debitIdx, creditIdx] : [balanceIdx]).filter((i) => i >= 0);
  const firstAmountIdx = Math.min(...amountIdxs);

  const notAmount = (i: number) => !amountIdxs.includes(i);
  const numberIdx = header.findIndex((h, i) => notAmount(i) && isNumberHeader(h));
  const nameIdx = header.findIndex((h, i) => notAmount(i) && i !== numberIdx && isNameHeader(h));
  const accountIdx = header.findIndex((h, i) => notAmount(i) && i !== numberIdx && i !== nameIdx && isAccountHeader(h));
  // Blank-header label columns left of the amounts (QuickBooks puts accounts here).
  const blankLabelIdxs = header
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => i < firstAmountIdx && h === '' && notAmount(i))
    .map(({ i }) => i);

  const primaryIdx = numberIdx >= 0 ? numberIdx : accountIdx >= 0 ? accountIdx : nameIdx >= 0 ? nameIdx : -1;
  if (primaryIdx < 0 && blankLabelIdxs.length === 0) {
    return { ok: false, error: 'We found the amount columns but not the account column. Make sure each row has an account name or number.' };
  }

  const label = (i: number) => ((rawHeader[i] ?? '').trim() || '(no heading)');
  const columns: SpreadsheetTbColumns = {
    account: primaryIdx >= 0 ? label(primaryIdx) : '(no heading)',
    name: nameIdx >= 0 && nameIdx !== primaryIdx ? label(nameIdx) : null,
    debit: useDebitCredit ? label(debitIdx) : null,
    credit: useDebitCredit ? label(creditIdx) : null,
    balance: balanceIdx >= 0 ? label(balanceIdx) : null,
  };

  // Title rows above the header: keep their text; capture an "As of" date.
  const titleLines: string[] = [];
  let asOfDateHint: string | null = null;
  for (let r = 0; r < headerIdx; r++) {
    const text = (grid[r] ?? []).filter((c) => c !== '').join(' ').trim();
    if (!text) continue;
    if (titleLines.length < 5) titleLines.push(text);
    if (!asOfDateHint) {
      const asOf = text.match(/\bas of\b\s*(.+)$/i);
      if (asOf) asOfDateHint = parseLooseDate(asOf[1]);
    }
  }

  const lines: SpreadsheetTbLine[] = [];
  const dropped: { row: number; reason: string }[] = [];

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    if (cells.length === 0 || cells.every((c) => c === '')) continue;
    const rowNum = r + 1;

    // Account label: the primary column, else the first non-empty blank-header column.
    let primary = primaryIdx >= 0 ? (cells[primaryIdx] ?? '').trim() : '';
    if (!primary) primary = blankLabelIdxs.map((i) => (cells[i] ?? '').trim()).find((v) => v !== '') ?? '';
    const nameText = nameIdx >= 0 && nameIdx !== primaryIdx ? (cells[nameIdx] ?? '').trim() : '';

    const amountCells = amountIdxs.map((i) => (cells[i] ?? '').trim());
    const hasAnyAmount = amountCells.some((c) => c !== '');
    const labelText = primary || nameText;

    if (labelText && isTotalLabel(labelText)) {
      dropped.push({ row: rowNum, reason: `“${labelText}” is a total row, not an account — skipped.` });
      continue;
    }
    if (!hasAnyAmount) {
      if (labelText) dropped.push({ row: rowNum, reason: `“${truncate(labelText)}” has no amounts — skipped as a heading or note.` });
      continue;
    }
    if (!labelText) {
      dropped.push({ row: rowNum, reason: 'Amounts with no account name — skipped.' });
      continue;
    }

    let debit = 0;
    let credit = 0;
    if (useDebitCredit) {
      const d = parseAccountingAmount(cells[debitIdx]);
      const c = parseAccountingAmount(cells[creditIdx]);
      if (!d.ok || !c.ok) {
        dropped.push({ row: rowNum, reason: `Couldn’t read the amount on “${truncate(labelText)}” — skipped. Check the number format.` });
        continue;
      }
      debit = d.cents;
      credit = c.cents;
    } else {
      const b = parseAccountingAmount(cells[balanceIdx]);
      if (!b.ok) {
        dropped.push({ row: rowNum, reason: `Couldn’t read the balance on “${truncate(labelText)}” — skipped. Check the number format.` });
        continue;
      }
      if (b.cents >= 0) debit = b.cents; else credit = -b.cents;
    }
    // Fold negatives: a negative debit is a credit (and vice versa).
    if (debit < 0) { credit += -debit; debit = 0; }
    if (credit < 0) { debit += -credit; credit = 0; }

    let accountNumber: string | null;
    let accountName: string;
    if (nameText) {
      const split = splitAccountLabel(primary || nameText);
      accountNumber = primary ? (split.accountNumber ?? primary) : null;
      accountName = nameText;
    } else {
      ({ accountNumber, accountName } = splitAccountLabel(primary));
    }

    lines.push({ row: rowNum, accountNumber, accountName, debitCents: debit, creditCents: credit });
  }

  if (lines.length === 0) {
    return { ok: false, error: 'We found the columns but no account rows with amounts under them.' };
  }

  return { ok: true, sheetName, headerRow: headerIdx + 1, columns, lines, dropped, asOfDateHint, titleLines };
}

/** Try each sheet in order; the first one that reads as a trial balance wins. */
export function normalizeTrialBalanceSheets(sheets: SheetGrid[]): SpreadsheetTbResult {
  let firstError: string | null = null;
  let sawGlDetail = false;
  for (const sh of sheets) {
    if (sh.grid.length === 0) continue;
    // A GL / transaction-detail sheet is never a trial balance, even though its
    // Amount/Balance columns would otherwise parse as one.
    if (looksLikeGeneralLedgerDetail(sh.grid)) { sawGlDetail = true; continue; }
    const res = normalizeTrialBalanceGrid(sh.grid, sh.name);
    if (res.ok) return res;
    firstError ??= res.error;
  }
  if (sawGlDetail) return { ok: false, error: GL_DETAIL_NOT_TB_MESSAGE, code: GL_DETAIL_NOT_TB_CODE };
  return { ok: false, error: firstError ?? 'That spreadsheet is empty.' };
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
