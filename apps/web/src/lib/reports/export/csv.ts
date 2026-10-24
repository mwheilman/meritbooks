import { centsToDollars } from '@meritbooks/shared';
import type { StatementModel } from './statement-model';

/**
 * StatementModel → CSV. Real numeric cells (money emitted as unquoted decimal
 * dollars, e.g. 1500.99) so a controller can open it in Excel and pivot
 * immediately (FPB Dimension 7 — the XLSX slot; see NEEDS CENTRAL note: no
 * spreadsheet lib is installed, so CSV is the honest deliverable today).
 *
 * Layout: a short metadata banner (title / entity / period / basis / generated),
 * a blank line, then the header row and data rows. Two dedicated left columns
 * ("Account #" and "Description") keep codes and names separate for pivoting.
 */

/**
 * CSV / formula injection (CWE-1236): a TEXT cell starting with = + - @ (or tab / CR, or
 * their full-width forms) is executed by Excel / Sheets as a formula. Prefix it with a single
 * quote so it is shown as text. Only TEXT cells — money / numbers are emitted as numeric
 * cells (typeof number), so a negative figure (-1500.99) stays a real number.
 */
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
/** A plain signed number / percent ("-12.5%", "+3", "-1,500.25") can't be a formula. */
const PLAIN_NUMBER = /^[+-]?\d[\d,]*(\.\d+)?%?$/;

export function neutralizeFormula(v: string): string {
  if (!FORMULA_START.test(v) || PLAIN_NUMBER.test(v)) return v;
  return `'${v}`;
}

function esc(raw: string): string {
  const v = neutralizeFormula(raw);
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function line(cells: (string | number)[]): string {
  return cells.map((c) => (typeof c === 'number' ? (Number.isFinite(c) ? String(c) : '') : esc(c))).join(',');
}

export function toCsv(model: StatementModel): string {
  const out: string[] = [];
  out.push(line([model.title]));
  if (model.entityLabel) out.push(line([model.entityLabel]));
  if (model.periodLabel) out.push(line([model.periodLabel]));
  if (model.basisLabel) out.push(line([model.basisLabel]));
  out.push(line([`Generated ${new Date(model.generatedAt).toLocaleString('en-US')}`]));
  // Governance marks travel with the data (preview / preliminary, warnings, closed-through).
  if (model.watermark) out.push(line([model.watermark]));
  if (model.banner) out.push(line([model.banner]));
  out.push('');

  const header: (string | number)[] = ['Account #', 'Description', ...model.columns.map((c) => c.label)];
  out.push(line(header));

  for (const row of model.rows) {
    if (row.kind === 'spacer') { out.push(''); continue; }
    const indent = row.indent ? '  '.repeat(row.indent) : '';
    const cells: (string | number)[] = [row.code ?? '', `${indent}${row.label}`];
    model.columns.forEach((col, i) => {
      const v = row.values[i];
      if (v === null || v === undefined || v === '') { cells.push(''); return; }
      if (col.money && typeof v === 'number') cells.push(centsToDollars(v)); // numeric dollars
      else cells.push(typeof v === 'number' ? v : String(v));
    });
    out.push(line(cells));
  }
  if (model.footnote) {
    out.push('');
    out.push(line([model.footnote]));
  }
  return out.join('\r\n');
}

/** Trigger a browser download of arbitrary content. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has committed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
