/**
 * .xlsx → grids (SERVER-SIDE ONLY — pulls in exceljs). The pure helpers (CSV grid,
 * amount parsing, header-row tools) live in ./spreadsheet.ts so client components
 * can import them without bundling exceljs.
 */

import ExcelJS from 'exceljs';
import type { Grid, SheetGrid } from './spreadsheet';

/** Display text for one exceljs cell value (formula results, rich text, links, dates). */
export function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('result' in o) return cellText(o.result); // formula / shared formula
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: unknown }>).map((r) => (typeof r.text === 'string' ? r.text : '')).join('').trim();
    }
    if (typeof o.text === 'string') return o.text.trim(); // hyperlink
    if ('error' in o) return ''; // #N/A, #REF! …
  }
  return '';
}

/** Max rows/cols read per sheet — a trial balance is never this big; guards memory. */
const MAX_SHEET_ROWS = 25_000;
const MAX_SHEET_COLS = 60;

/**
 * Read every worksheet of an .xlsx file into grids (grid index + 1 = sheet row
 * number; blank rows are kept as []; trailing blank rows are dropped). Throws a
 * plain-English error when the file is not a readable .xlsx.
 */
export async function readXlsxSheets(data: ArrayBuffer | Uint8Array): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  try {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    // exceljs accepts a Node Buffer / ArrayBuffer.
    await wb.xlsx.load(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) as unknown as ArrayBuffer);
  } catch {
    throw new Error('We could not open that Excel file. Save it as .xlsx (or export a CSV) and try again.');
  }

  const sheets: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const grid: Grid = [];
    const rowCount = Math.min(ws.rowCount, MAX_SHEET_ROWS);
    const colCount = Math.min(ws.columnCount, MAX_SHEET_COLS);
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= colCount; c++) cells.push(cellText(row.getCell(c).value));
      // Keep blank rows as [] so grid index + 1 === the sheet's row number.
      grid.push(cells.some((v) => v !== '') ? cells : []);
    }
    while (grid.length > 0 && grid[grid.length - 1].length === 0) grid.pop();
    sheets.push({ name: ws.name, grid });
  });
  return sheets;
}

