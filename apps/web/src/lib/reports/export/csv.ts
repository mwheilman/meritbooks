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

function esc(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function line(cells: (string | number)[]): string {
  return cells.map((c) => (typeof c === 'number' ? String(c) : esc(c))).join(',');
}

export function toCsv(model: StatementModel): string {
  const out: string[] = [];
  out.push(line([model.title]));
  if (model.entityLabel) out.push(line([model.entityLabel]));
  if (model.periodLabel) out.push(line([model.periodLabel]));
  if (model.basisLabel) out.push(line([model.basisLabel]));
  out.push(line([`Generated ${new Date(model.generatedAt).toLocaleString('en-US')}`]));
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
