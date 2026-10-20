/**
 * Files → grids. CSV is parsed here (RFC-4180-ish, BOM, quoted commas/newlines);
 * .xlsx goes through ./xlsx.ts. Ported from Books (apps/web/src/lib/import/spreadsheet.ts)
 * so Projects needs no spreadsheet dependency. Pure.
 */

export type Grid = string[][];

export type SpreadsheetKind = 'xlsx' | 'csv' | 'xls' | null;

export function spreadsheetKind(fileName: string, mimeType?: string | null): SpreadsheetKind {
  const name = (fileName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv') || mime === 'text/csv') return 'csv';
  if (name.endsWith('.xls') || mime === 'application/vnd.ms-excel') return 'xls';
  return null;
}

/** CSV (or tab-separated) text → grid. Blank lines kept as [] so row numbers match the file. */
export function readCsvGrid(text: string): Grid {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const out: Grid = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
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
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      endRecord();
    } else field += c;
  }
  if (field !== '' || record.length > 0) endRecord();
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
  return out;
}

export function columnLetter(idx: number): string {
  let n = idx + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/**
 * Header-keyed records using grid row `headerIdx`. Blank/duplicate header cells get
 * unique names so no column is lost; `rowNumbers` are 1-based file rows.
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
