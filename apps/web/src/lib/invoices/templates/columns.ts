/**
 * The line table a customer sees — which columns print and what each cell says.
 * Pure: the PDF, the hosted pay page and the design preview all call this, so the
 * three always agree with the template.
 *
 * Customer-facing rule: NO internal GL account numbers or names, ever. The line
 * input carries only what may print (item label, description, cost code label …).
 */

import { COLUMN_LABELS, INVOICE_COLUMNS, type InvoiceColumn, type InvoiceTemplate } from './types';

export interface DocLineInput {
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  /** Catalog item name (core.items), when the line has one. */
  item_label?: string | null;
  /** YYYY-MM-DD */
  service_date?: string | null;
  /** Job cost code, e.g. "03-100 Concrete" — a job-costing code, not a GL account. */
  cost_code_label?: string | null;
  /** Sales tax allocated to this line (cents); sums to the invoice tax. */
  tax_cents?: number;
  custom_fields?: Record<string, string>;
}

export interface TableColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
  /** Relative width weight (the renderer turns weights into percentages). */
  weight: number;
}

export interface TableRow {
  cells: Record<string, string>;
}

export interface LineTable {
  columns: TableColumn[];
  rows: TableRow[];
}

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const shortDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString('en-US', { maximumFractionDigits: 4 }));

const WEIGHT: Record<Exclude<InvoiceColumn, 'custom'>, number> = {
  item: 14, description: 34, service_date: 12, job: 14, cost_code: 13, quantity: 7, rate: 12, tax: 10, amount: 13,
};
const RIGHT = new Set<string>(['quantity', 'rate', 'tax', 'amount']);

/**
 * Allocate an invoice's tax total across its taxable lines in proportion to their
 * amounts (largest-remainder, so the column adds up to the total to the cent).
 */
export function allocateLineTax(
  lines: ReadonlyArray<{ amount_cents: number; taxable: boolean }>,
  taxCents: number,
): number[] {
  const out = lines.map(() => 0);
  const idx = lines.map((l, i) => ({ i, base: l.taxable && l.amount_cents > 0 ? l.amount_cents : 0 })).filter((x) => x.base > 0);
  const baseTotal = idx.reduce((s, x) => s + x.base, 0);
  if (taxCents <= 0 || baseTotal <= 0) return out;
  let assigned = 0;
  const rema = idx.map((x) => {
    const exact = (taxCents * x.base) / baseTotal;
    const floor = Math.floor(exact);
    out[x.i] = floor;
    assigned += floor;
    return { i: x.i, frac: exact - floor };
  });
  rema.sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < taxCents - assigned; k++) out[rema[k % rema.length].i] += 1;
  return out;
}

export interface BuildTableOptions {
  /** Invoice-level job label ("J-1042 · Smith remodel"), printed in the Job column. */
  jobLabel?: string | null;
  /** Drop optional columns that are empty on every line of THIS invoice (default true). */
  hideEmpty?: boolean;
}

/** Build the customer line table for a template. */
export function buildLineTable(
  lines: ReadonlyArray<DocLineInput>,
  template: Pick<InvoiceTemplate, 'visible_columns' | 'line_fields'>,
  opts: BuildTableOptions = {},
): LineTable {
  const hideEmpty = opts.hideEmpty !== false;
  const cols: TableColumn[] = [];
  const cellFns: Array<{ key: string; fn: (l: DocLineInput) => string }> = [];

  // Always print in the canonical order, whatever order the template lists them in.
  const visible = INVOICE_COLUMNS.filter((c) => template.visible_columns.includes(c));
  for (const c of visible) {
    if (c === 'custom') {
      for (const f of template.line_fields) {
        const key = `custom:${f.key}`;
        cols.push({ key, label: f.label, align: 'left', weight: 12 });
        cellFns.push({ key, fn: (l) => (l.custom_fields?.[f.key] ?? '').toString() });
      }
      continue;
    }
    cols.push({ key: c, label: COLUMN_LABELS[c], align: RIGHT.has(c) ? 'right' : 'left', weight: WEIGHT[c] });
    switch (c) {
      case 'item': cellFns.push({ key: c, fn: (l) => l.item_label ?? '' }); break;
      case 'description': cellFns.push({ key: c, fn: (l) => l.description }); break;
      case 'service_date': cellFns.push({ key: c, fn: (l) => (l.service_date ? shortDate(l.service_date) : '') }); break;
      case 'job': cellFns.push({ key: c, fn: () => opts.jobLabel ?? '' }); break;
      case 'cost_code': cellFns.push({ key: c, fn: (l) => l.cost_code_label ?? '' }); break;
      case 'quantity': cellFns.push({ key: c, fn: (l) => qty(l.quantity) }); break;
      case 'rate': cellFns.push({ key: c, fn: (l) => money(l.unit_price_cents) }); break;
      case 'tax': cellFns.push({ key: c, fn: (l) => ((l.tax_cents ?? 0) > 0 ? money(l.tax_cents ?? 0) : '') }); break;
      case 'amount': cellFns.push({ key: c, fn: (l) => money(l.amount_cents) }); break;
    }
  }

  const rows: TableRow[] = lines.map((l) => ({
    cells: Object.fromEntries(cellFns.map(({ key, fn }) => [key, fn(l)])),
  }));

  const keep = cols.filter((c) => {
    if (!hideEmpty || c.key === 'description' || c.key === 'amount') return true;
    return rows.some((r) => (r.cells[c.key] ?? '').trim() !== '');
  });
  return { columns: keep, rows: rows.map((r) => ({ cells: Object.fromEntries(keep.map((c) => [c.key, r.cells[c.key] ?? ''])) })) };
}

/** Column weights → percentage widths that add up to 100. */
export function columnWidths(columns: ReadonlyArray<TableColumn>): string[] {
  const total = columns.reduce((s, c) => s + c.weight, 0) || 1;
  return columns.map((c) => `${((c.weight / total) * 100).toFixed(2)}%`);
}
