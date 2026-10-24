/**
 * Budget grid helpers (Wave 4B, AC-B20) — pure, used by the grid editor and tested here.
 * Parsing accepts what people paste from Excel: tabs between cells, newlines between rows,
 * "$1,234.50", "(1,234)", "-1234", "1.2k", "—" / "-" / blank as zero.
 */
import { applyGrowthToRow } from './generators';

/** Dollars text → integer cents, or null when it isn't a number. Blank / dash = 0. */
export function parseCellToCents(raw: string): number | null {
  let s = raw.trim();
  if (s === '' || s === '-' || s === '—' || s === '–') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1).trim();
  }
  s = s.replace(/^\$/, '').replace(/,/g, '').replace(/\s/g, '');
  let mult = 1;
  const suffix = /([kKmM])$/.exec(s);
  if (suffix) {
    mult = suffix[1].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    s = s.slice(0, -1);
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const dollars = Number(s) * mult;
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return neg ? -cents : cents;
}

export interface PasteResult {
  /** rows × columns of cents (null = unparseable cell, left unchanged). */
  cells: Array<Array<number | null>>;
  invalid: number;
}

/** Split a clipboard block (Excel / Sheets / CSV-ish) into a grid of cents. */
export function parsePasteBlock(text: string): PasteResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  let invalid = 0;
  const cells = lines.map((line) => {
    const parts = line.includes('\t') ? line.split('\t') : splitCsvLine(line);
    return parts.map((p) => {
      const v = parseCellToCents(p);
      if (v === null) invalid++;
      return v;
    });
  });
  return { cells, invalid };
}

function splitCsvLine(line: string): string[] {
  // A single number with thousands commas ("1,234") is one cell, not three.
  if (/^\s*[($-]?\$?\d{1,3}(,\d{3})+(\.\d+)?\)?\s*$/.test(line)) return [line];
  return line.split(',');
}

export interface GridPos {
  row: number;
  col: number;
}

/**
 * Apply a pasted block at `at` over a rows × 12 matrix; returns the edits (row, col, cents)
 * clipped to the grid. Unparseable cells are skipped.
 */
export function pasteEdits(
  block: PasteResult,
  at: GridPos,
  rowCount: number,
  colCount = 12,
): Array<{ row: number; col: number; cents: number }> {
  const out: Array<{ row: number; col: number; cents: number }> = [];
  block.cells.forEach((r, i) => {
    const row = at.row + i;
    if (row >= rowCount) return;
    r.forEach((v, j) => {
      const col = at.col + j;
      if (col >= colCount || v === null) return;
      out.push({ row, col, cents: v });
    });
  });
  return out;
}

/** Fill-right: copy the month at `fromCol` into every later month of the row. */
export function fillRight(months: readonly number[], fromCol: number): number[] {
  const v = months[fromCol] ?? 0;
  return months.map((m, i) => (i > fromCol ? v : m));
}

/** "+x%" on a row (bps, ties to the grown total). */
export function growRow(months: readonly number[], growthBps: number): number[] {
  return applyGrowthToRow(months, growthBps);
}

/** Parse a percent typed by a person ("5", "5%", "-2.5") into basis points. */
export function parsePercentToBps(raw: string): number | null {
  const s = raw.trim().replace(/%$/, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Keyboard navigation inside the grid (arrow keys / Tab / Enter). */
export function moveCursor(pos: GridPos, key: string, rows: number, cols = 12, shift = false): GridPos {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  switch (key) {
    case 'ArrowUp': return { row: clamp(pos.row - 1, rows), col: pos.col };
    case 'ArrowDown':
    case 'Enter': return { row: clamp(pos.row + (shift ? -1 : 1), rows), col: pos.col };
    case 'ArrowLeft': return { row: pos.row, col: clamp(pos.col - 1, cols) };
    case 'ArrowRight': return { row: pos.row, col: clamp(pos.col + 1, cols) };
    case 'Tab': {
      if (shift) return pos.col > 0 ? { row: pos.row, col: pos.col - 1 } : { row: clamp(pos.row - 1, rows), col: cols - 1 };
      return pos.col < cols - 1 ? { row: pos.row, col: pos.col + 1 } : { row: clamp(pos.row + 1, rows), col: 0 };
    }
    case 'Home': return { row: pos.row, col: 0 };
    case 'End': return { row: pos.row, col: cols - 1 };
    default: return pos;
  }
}
