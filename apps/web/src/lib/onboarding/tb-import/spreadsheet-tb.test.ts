/**
 * Spreadsheet trial-balance intake — fixtures mimic real QuickBooks exports:
 * title rows above the table, a BLANK first header (the account column), a
 * "TOTAL" row, a footer, "(1,234.56)" negatives, and Debit/Credit column pairs.
 */

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  findTbHeaderRow,
  normalizeTrialBalanceGrid,
  normalizeTrialBalanceSheets,
  looksLikeGeneralLedgerDetail,
  GL_DETAIL_NOT_TB_CODE,
  parseLooseDate,
  splitAccountLabel,
} from './spreadsheet-tb';
import { readXlsxSheets } from '@/lib/import/spreadsheet-xlsx';
import { readCsvGrid, parseAccountingAmount, centsToPlainDollars, gridToTable, spreadsheetKind } from '@/lib/import/spreadsheet';

/** QuickBooks Online "Trial Balance" export, as a grid (what readXlsxSheets yields). */
const QBO_GRID: string[][] = [
  ['Heritage Interiors LLC', '', ''],
  ['Trial Balance', '', ''],
  ['As of September 30, 2026', '', ''],
  [],
  ['', 'Debit', 'Credit'],
  ['1000 Checking', '12,345.67', ''],
  ['1200 Accounts Receivable (A/R)', '4,000.00', ''],
  ['Undeposited Funds', '0.00', ''],
  ['2000 Accounts Payable (A/P)', '', '2,100.00'],
  ['2100 Credit Card', '(150.00)', ''], // QBO shows a credit balance as a negative debit
  ['3000 Opening Balance Equity', '', '14,095.67'],
  ['TOTAL', '$16,345.67', '$16,345.67'],
  [],
  [],
  ['Accrual Basis Friday, October 16, 2026 09:15 AM GMT-07:00', '', ''],
];

describe('findTbHeaderRow', () => {
  it('skips QuickBooks title rows and finds the blank-first-cell header', () => {
    expect(findTbHeaderRow(QBO_GRID)).toBe(4);
  });

  it('finds a generic header on row 1', () => {
    expect(findTbHeaderRow([['Account Code', 'Account Name', 'Debit', 'Credit'], ['1000', 'Cash', '10', '']])).toBe(0);
  });

  it('accepts a single Balance column with an account column', () => {
    expect(findTbHeaderRow([['Report'], ['Account', 'Balance'], ['Cash', '5']])).toBe(1);
  });

  it('returns -1 when there are no amount columns', () => {
    expect(findTbHeaderRow([['Name', 'Email'], ['Ann', 'a@x.com']])).toBe(-1);
  });
});

describe('normalizeTrialBalanceGrid — QuickBooks Online export', () => {
  const res = normalizeTrialBalanceGrid(QBO_GRID, 'Sheet1');
  if (!res.ok) throw new Error(res.error);

  it('detects the header row (1-based) and the as-of date in the title rows', () => {
    expect(res.headerRow).toBe(5);
    expect(res.asOfDateHint).toBe('2026-09-30');
    expect(res.titleLines[0]).toBe('Heritage Interiors LLC');
    expect(res.columns.account).toBe('(no heading)');
    expect(res.columns.debit).toBe('Debit');
  });

  it('drops the TOTAL row and the footer, and reports both (never silent)', () => {
    expect(res.lines.some((l) => /total/i.test(l.accountName))).toBe(false);
    expect(res.dropped.some((d) => d.row === 12 && /total row/i.test(d.reason))).toBe(true);
    expect(res.dropped.some((d) => d.row === 15)).toBe(true);
  });

  it('splits "1000 Checking" into number + name and keeps number-less names', () => {
    const chk = res.lines.find((l) => l.accountName === 'Checking')!;
    expect(chk.accountNumber).toBe('1000');
    expect(chk.row).toBe(6);
    const undep = res.lines.find((l) => l.accountName === 'Undeposited Funds')!;
    expect(undep.accountNumber).toBeNull();
  });

  it('parses money into integer cents and folds "(150.00)" in the Debit column into a credit', () => {
    const chk = res.lines.find((l) => l.accountNumber === '1000')!;
    expect(chk.debitCents).toBe(1_234_567);
    const cc = res.lines.find((l) => l.accountNumber === '2100')!;
    expect(cc.debitCents).toBe(0);
    expect(cc.creditCents).toBe(15_000);
  });

  it('the remaining lines balance (debits == credits)', () => {
    const dr = res.lines.reduce((s, l) => s + l.debitCents, 0);
    const cr = res.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(dr).toBe(1_634_567);
    expect(cr).toBe(1_634_567);
  });
});

describe('normalizeTrialBalanceGrid — other shapes', () => {
  it('QuickBooks Desktop: "1000 · Checking" with hierarchy across blank-header columns', () => {
    const grid = [
      ['Heritage Interiors', '', '', ''],
      ['Trial Balance', '', '', ''],
      ['As of 9/30/2026', '', '', ''],
      ['', '', 'Debit', 'Credit'],
      ['1000 · Checking', '', '500.00', ''],
      ['', '1010 · Petty Cash', '25.00', ''],
      ['3000 · Owner Equity', '', '', '525.00'],
      ['TOTAL', '', '525.00', '525.00'],
    ];
    const res = normalizeTrialBalanceGrid(grid);
    if (!res.ok) throw new Error(res.error);
    expect(res.asOfDateHint).toBe('2026-09-30');
    expect(res.lines.map((l) => l.accountNumber)).toEqual(['1000', '1010', '3000']);
    expect(res.lines[1].accountName).toBe('Petty Cash');
  });

  it('separate number + name columns', () => {
    const res = normalizeTrialBalanceGrid([
      ['Account Code', 'Account Name', 'Debit', 'Credit'],
      ['1000', 'Cash', '1,000.00', ''],
      ['3000', 'Capital', '', '1,000.00'],
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.lines[0]).toMatchObject({ accountNumber: '1000', accountName: 'Cash', debitCents: 100_000 });
    expect(res.lines[1]).toMatchObject({ accountNumber: '3000', accountName: 'Capital', creditCents: 100_000 });
  });

  it('single signed Balance column: positive = debit, (negative) = credit', () => {
    const res = normalizeTrialBalanceGrid([
      ['Account', 'Balance'],
      ['Cash', '$2,000.00'],
      ['Loan', '(2,000.00)'],
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.lines[0]).toMatchObject({ debitCents: 200_000, creditCents: 0 });
    expect(res.lines[1]).toMatchObject({ debitCents: 0, creditCents: 200_000 });
  });

  it('reports an unreadable amount instead of guessing', () => {
    const res = normalizeTrialBalanceGrid([
      ['', 'Debit', 'Credit'],
      ['Cash', 'abc', ''],
      ['Equity', '', '1.00'],
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.lines).toHaveLength(1);
    expect(res.dropped[0].reason).toMatch(/couldn’t read the amount/i);
  });

  it('fails with plain guidance when no Debit/Credit/Balance columns exist', () => {
    const res = normalizeTrialBalanceGrid([['Customer', 'Email'], ['Ann', 'a@x.com']]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Trial Balance/);
  });

  it('normalizeTrialBalanceSheets picks the first sheet that reads as a TB', () => {
    const res = normalizeTrialBalanceSheets([
      { name: 'Notes', grid: [['Read me'], ['nothing here']] },
      { name: 'TB', grid: QBO_GRID },
    ]);
    expect(res.ok && res.sheetName).toBe('TB');
  });
});

/** QuickBooks Online "General Ledger" (transaction detail) export — NOT a trial balance. */
const QBO_GL_GRID: string[][] = [
  ['Heritage Interiors LLC'],
  ['General Ledger'],
  ['January - September, 2026'],
  [],
  ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance'],
  ['1000 Checking'],
  ['', '01/03/2026', 'Deposit', '', 'Acme Co', 'Payment', 'Accounts Receivable', '1,200.00', '1,200.00'],
  ['', '01/05/2026', 'Expense', '1001', 'Office Depot', 'Supplies', 'Office Supplies', '-45.00', '1,155.00'],
  ['Total for 1000 Checking', '', '', '', '', '', '', '$1,155.00', ''],
];

describe('General Ledger detail exports (not a trial balance)', () => {
  it('recognizes the QuickBooks Online General Ledger export', () => {
    expect(looksLikeGeneralLedgerDetail(QBO_GL_GRID)).toBe(true);
  });

  it('recognizes a GL header even without the title rows', () => {
    expect(looksLikeGeneralLedgerDetail(QBO_GL_GRID.slice(4))).toBe(true);
  });

  it('does not flag a real trial balance (incl. an account named "General Ledger …")', () => {
    expect(looksLikeGeneralLedgerDetail(QBO_GRID)).toBe(false);
    const tbWithOddAccount = [...QBO_GRID.slice(0, 6), ['1999 General Ledger Suspense', '0.00', ''], ...QBO_GRID.slice(6)];
    expect(looksLikeGeneralLedgerDetail(tbWithOddAccount)).toBe(false);
    expect(normalizeTrialBalanceSheets([{ name: 'TB', grid: tbWithOddAccount }]).ok).toBe(true);
  });

  it('returns a plain "we need the Trial Balance" message with the QuickBooks export steps', () => {
    const res = normalizeTrialBalanceSheets([{ name: 'GL', grid: QBO_GL_GRID }]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(GL_DETAIL_NOT_TB_CODE);
      expect(res.error).toMatch(/General Ledger/);
      expect(res.error).toMatch(/Trial Balance/);
      expect(res.error).toMatch(/Export to Excel/);
    }
  });

  it('still uses a TB sheet when the workbook also has a GL sheet', () => {
    const res = normalizeTrialBalanceSheets([
      { name: 'GL', grid: QBO_GL_GRID },
      { name: 'TB', grid: QBO_GRID },
    ]);
    expect(res.ok && res.sheetName).toBe('TB');
  });
});

describe('helpers', () => {
  it('parseAccountingAmount handles accounting formats without float drift', () => {
    expect(parseAccountingAmount('1,234.56')).toEqual({ ok: true, cents: 123_456 });
    expect(parseAccountingAmount('(1,234.56)')).toEqual({ ok: true, cents: -123_456 });
    expect(parseAccountingAmount('$(1,234.56)')).toEqual({ ok: true, cents: -123_456 });
    expect(parseAccountingAmount('-$1,234.56')).toEqual({ ok: true, cents: -123_456 });
    expect(parseAccountingAmount('1234.56-')).toEqual({ ok: true, cents: -123_456 });
    expect(parseAccountingAmount('1,234.56 CR')).toEqual({ ok: true, cents: -123_456 });
    expect(parseAccountingAmount('12345.670000000002')).toEqual({ ok: true, cents: 1_234_567 });
    expect(parseAccountingAmount('0.125')).toEqual({ ok: true, cents: 13 });
    expect(parseAccountingAmount('')).toEqual({ ok: true, cents: 0 });
    expect(parseAccountingAmount('—')).toEqual({ ok: true, cents: 0 });
    expect(parseAccountingAmount('n/a').ok).toBe(false);
  });

  it('centsToPlainDollars round-trips', () => {
    expect(centsToPlainDollars(123_456)).toBe('1234.56');
    expect(centsToPlainDollars(-5)).toBe('-0.05');
    expect(centsToPlainDollars(100)).toBe('1.00');
  });

  it('splitAccountLabel', () => {
    expect(splitAccountLabel('1000 Checking')).toEqual({ accountNumber: '1000', accountName: 'Checking' });
    expect(splitAccountLabel('1000-10 - Petty Cash')).toEqual({ accountNumber: '1000-10', accountName: 'Petty Cash' });
    expect(splitAccountLabel('401k Payable')).toEqual({ accountNumber: null, accountName: '401k Payable' });
    expect(splitAccountLabel('Checking')).toEqual({ accountNumber: null, accountName: 'Checking' });
  });

  it('parseLooseDate', () => {
    expect(parseLooseDate('September 30, 2026')).toBe('2026-09-30');
    expect(parseLooseDate('Sep 30 2026')).toBe('2026-09-30');
    expect(parseLooseDate('Sept. 30, 2026')).toBe('2026-09-30');
    expect(parseLooseDate('9/30/2026')).toBe('2026-09-30');
    expect(parseLooseDate('February 30, 2026')).toBeNull();
  });

  it('readCsvGrid keeps quoted commas and blank-line row positions', () => {
    const grid = readCsvGrid('"Heritage, LLC"\n\n,Debit,Credit\n"1000 Checking","1,000.00",\n');
    expect(grid[0]).toEqual(['Heritage, LLC']);
    expect(grid[1]).toEqual([]);
    expect(grid[2]).toEqual(['', 'Debit', 'Credit']);
    expect(grid[3]).toEqual(['1000 Checking', '1,000.00', '']);
  });

  it('gridToTable names blank and duplicate headers', () => {
    const t = gridToTable([['', 'Amt', 'Amt'], ['x', '1', '2']], 0);
    expect(t.headers).toEqual(['Column A', 'Amt', 'Amt (2)']);
    expect(t.rowNumbers).toEqual([2]);
  });

  it('spreadsheetKind', () => {
    expect(spreadsheetKind('TB.xlsx')).toBe('xlsx');
    expect(spreadsheetKind('tb.CSV')).toBe('csv');
    expect(spreadsheetKind('old.xls')).toBe('xls');
    expect(spreadsheetKind('tb.pdf', 'application/pdf')).toBeNull();
  });
});

describe('end to end: a real .xlsx (QuickBooks Online layout) → lines', () => {
  it('reads numeric cells, merged title rows and a formula TOTAL', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Trial Balance');
    ws.addRow(['Heritage Interiors LLC']);
    ws.mergeCells('A1:C1');
    ws.addRow(['Trial Balance']);
    ws.addRow(['As of September 30, 2026']);
    ws.addRow([]);
    ws.addRow([null, 'Debit', 'Credit']);
    ws.addRow(['1000 Checking', 12345.67, null]);
    ws.addRow(['2000 Accounts Payable (A/P)', null, 2345.67]);
    ws.addRow(['3000 Opening Balance Equity', null, 10000]);
    ws.addRow(['TOTAL', { formula: 'SUM(B6:B8)', result: 12345.67 }, { formula: 'SUM(C6:C8)', result: 12345.67 }]);
    const buf = await wb.xlsx.writeBuffer();

    const sheets = await readXlsxSheets(new Uint8Array(buf as ArrayBuffer));
    const res = normalizeTrialBalanceSheets(sheets);
    if (!res.ok) throw new Error(res.error);
    expect(res.headerRow).toBe(5);
    expect(res.asOfDateHint).toBe('2026-09-30');
    expect(res.lines).toHaveLength(3);
    expect(res.lines[0]).toMatchObject({ row: 6, accountNumber: '1000', debitCents: 1_234_567 });
    expect(res.lines[2]).toMatchObject({ accountNumber: '3000', creditCents: 1_000_000 });
    expect(res.dropped.some((d) => d.row === 9)).toBe(true);
  });

  it('rejects a file that is not a real .xlsx with plain guidance', async () => {
    await expect(readXlsxSheets(new TextEncoder().encode('not a zip'))).rejects.toThrow(/Save it as \.xlsx/);
  });
});
