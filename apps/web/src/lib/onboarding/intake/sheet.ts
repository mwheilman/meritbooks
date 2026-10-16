/**
 * Smart Intake — read a spreadsheet/CSV into a grid (SERVER-ONLY: the XLSX reader uses
 * node:zlib). Used two ways:
 *   - `sniffSheet` → the first rows as flat cells + a CSV-ish text sample, for the
 *     deterministic rules and (optionally) the AI classifier;
 *   - `readSheetRows` → header-keyed rows, so a receiver (A/R / A/P review) can be fed
 *     the file the user already dropped instead of asking for it again.
 *
 * QuickBooks-style exports put title rows above the real header ("Company", "A/R Aging
 * Summary", "As of …"); `detectHeaderRow` skips them by picking the first row that is
 * mostly non-empty text.
 */

import type { ParsedCsv } from '@/lib/import/csv';
import { readXlsx } from '@/lib/payroll/xlsx-read';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Split CSV/TSV text into a raw string grid — RFC-4180-ish (quotes, "" escapes, embedded newlines). */
export function textToGrid(text: string, delimiter: ',' | '\t' = ','): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some((f) => f.trim() !== '')) records.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (record.some((f) => f.trim() !== '')) records.push(record);
  }
  return records;
}

/** Read a buffer to a raw grid (all rows, header included). Never throws. */
export function readRawGrid(buffer: Buffer, mediaType: string, fileName: string): string[][] {
  try {
    if (mediaType === XLSX_TYPE || /\.xlsx$/i.test(fileName)) {
      const g = readXlsx(buffer);
      return g.headers.length === 0 ? [] : [g.headers, ...g.rows];
    }
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const tsv = /\.tsv$/i.test(fileName) || (!text.includes(',') && text.includes('\t'));
    return textToGrid(text, tsv ? '\t' : ',');
  } catch {
    return [];
  }
}

/** Index of the first row that looks like a header (≥2 non-empty, mostly non-numeric cells). */
export function detectHeaderRow(grid: string[][]): number {
  const limit = Math.min(grid.length, 15);
  for (let i = 0; i < limit; i++) {
    const cells = grid[i].map((c) => (c ?? '').trim()).filter((c) => c !== '');
    if (cells.length < 2) continue;
    const texty = cells.filter((c) => !/^[-$(),.\d\s%]+$/.test(c)).length;
    if (texty / cells.length >= 0.6) return i;
  }
  return 0;
}

export interface SheetSniff {
  /** Cells from the first ~12 rows (title rows + header + a few data rows). */
  cells: string[];
  /** CSV-ish text of the first rows, for the AI classifier when rules are unsure. */
  textSample: string;
  rowCount: number;
}

export function sniffSheet(buffer: Buffer, mediaType: string, fileName: string): SheetSniff {
  const grid = readRawGrid(buffer, mediaType, fileName);
  const head = grid.slice(0, 12);
  const cells = head.flat().map((c) => String(c ?? '').trim()).filter((c) => c !== '');
  const textSample = grid.slice(0, 40).map((r) => r.map((c) => String(c ?? '').replace(/,/g, ' ')).join(',')).join('\n');
  return { cells, textSample, rowCount: grid.length };
}

/** Header-keyed rows starting at the detected header row (title rows skipped). */
export function readSheetRows(buffer: Buffer, mediaType: string, fileName: string): ParsedCsv {
  const grid = readRawGrid(buffer, mediaType, fileName);
  if (grid.length === 0) return { headers: [], rows: [] };
  const h = detectHeaderRow(grid);
  const rawHeaders = grid[h].map((c) => String(c ?? '').trim());
  const headers: string[] = [];
  rawHeaders.forEach((name, idx) => {
    const base = name || `Column ${idx + 1}`;
    headers.push(headers.includes(base) ? `${base} (${idx + 1})` : base);
  });
  const rows = grid.slice(h + 1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((key, idx) => { obj[key] = String(r[idx] ?? '').trim(); });
      return obj;
    });
  return { headers, rows };
}
