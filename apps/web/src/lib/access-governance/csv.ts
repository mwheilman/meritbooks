/**
 * CSV for audit evidence (access log, access-review report). PURE.
 *
 * Formula-injection safe: a cell whose first non-blank character is = + - @ (or that starts
 * with a tab / carriage return) is prefixed with a single quote, so Excel / Sheets treat it
 * as text instead of evaluating it. Every cell is quoted; embedded quotes are doubled.
 */

const DANGEROUS_LEAD = /^[\s]*[=+\-@]/;

export function neutralizeCell(value: string): string {
  if (DANGEROUS_LEAD.test(value) || value.startsWith('\t') || value.startsWith('\r')) return `'${value}`;
  return value;
}

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '""';
  const raw = typeof value === 'string' ? neutralizeCell(value) : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  const lines = [header.map((h) => csvCell(h)).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
