/**
 * Upload → table + auto-map (rules). Pure: inflate is injected for .xlsx.
 */
import { detectHeaderRow, autoMapColumns, detectVendor, unmappedHeaders } from './automap';
import { gridToTable, readCsvGrid, spreadsheetKind, type Grid } from './grid';
import { readXlsxGrid, type InflateRaw } from './xlsx';
import type { ColumnMapping } from '../types';

export const MAX_IMPORT_ROWS = 2000;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type ParseFailure = { ok: false; message: string };
export interface ParsedUpload {
  ok: true;
  vendor: string | null;
  headers: string[];
  headerRow: number;
  records: Record<string, string>[];
  rowNumbers: number[];
  rowCount: number;
  truncated: boolean;
  mapping: ColumnMapping;
  unmapped: string[];
}

export function gridFromUpload(fileName: string, mime: string | null, bytes: Uint8Array, inflate: InflateRaw): Grid | ParseFailure {
  const kind = spreadsheetKind(fileName, mime);
  if (kind === 'xls') return { ok: false, message: 'That is an older .xls file. Save it as .xlsx or CSV and drop it again.' };
  if (kind === 'xlsx') {
    const g = readXlsxGrid(bytes, inflate);
    return g.length > 0 ? g : { ok: false, message: "We couldn't open that Excel file. Save it as .xlsx or CSV and try again." };
  }
  if (kind === 'csv' || kind === null) {
    const text = new TextDecoder('utf-8').decode(bytes);
    if (kind === null && /[\u0000-\u0008]/.test(text.slice(0, 2000))) {
      return { ok: false, message: 'We read CSV and Excel (.xlsx) files. Export your job list in one of those and drop it again.' };
    }
    const g = readCsvGrid(text);
    return g.length > 0 ? g : { ok: false, message: 'That file is empty. Export your job list again and drop it here.' };
  }
  return { ok: false, message: 'We read CSV and Excel (.xlsx) files.' };
}

export function tableFromGrid(grid: Grid, fileName: string): ParsedUpload | ParseFailure {
  const headerRow = detectHeaderRow(grid);
  const { headers, rows, rowNumbers } = gridToTable(grid, headerRow);
  if (headers.length === 0 || rows.length === 0) {
    return { ok: false, message: "We found headers but no jobs under them. Check the export includes the job rows." };
  }
  const truncated = rows.length > MAX_IMPORT_ROWS;
  const records = rows.slice(0, MAX_IMPORT_ROWS);
  const sample: Record<string, string[]> = {};
  for (const h of headers) sample[h] = records.slice(0, 25).map((r) => r[h] ?? '');
  const mapping = autoMapColumns(headers, sample);
  return {
    ok: true,
    vendor: detectVendor(headers, fileName),
    headers,
    headerRow: headerRow + 1,
    records,
    rowNumbers: rowNumbers.slice(0, MAX_IMPORT_ROWS),
    rowCount: rows.length,
    truncated,
    mapping,
    unmapped: unmappedHeaders(headers, mapping),
  };
}
