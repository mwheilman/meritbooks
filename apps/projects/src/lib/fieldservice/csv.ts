/**
 * Price-book spreadsheet round trip (FS-46). Excel opens and saves CSV; the export carries a UTF-8
 * BOM and CRLF line ends so Excel keeps accents and the columns line up, and the import accepts
 * what Excel writes back (quoted fields, embedded commas / quotes / newlines, either line end).
 * Column headers are matched loosely so an old system's export maps without a mapping screen.
 * Pure; unit-tested.
 */

export const PRICEBOOK_COLUMNS = [
  'code', 'name', 'kind', 'category', 'business_unit', 'unit', 'task_hours', 'cost', 'price', 'member_price',
  'after_hours_price', 'price_locked', 'target_gm_pct', 'materials', 'customer_description', 'active',
] as const;
export type PricebookColumn = (typeof PRICEBOOK_COLUMNS)[number];

/** RFC 4180 parse. Returns rows of cells; a trailing empty line is dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function q(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  const line = (r: ReadonlyArray<string | number | boolean | null | undefined>) => r.map((v) => q(v == null ? '' : String(v))).join(',');
  return '﻿' + [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}

/** Header aliases from ServiceTitan / FieldEdge / simPRO / Housecall Pro exports. */
const ALIASES: Readonly<Record<PricebookColumn, readonly string[]>> = {
  code: ['code', 'sku', 'item code', 'task code', 'part number', 'part #', 'item #', 'number'],
  name: ['name', 'description', 'task name', 'item name', 'display name', 'title'],
  kind: ['kind', 'type', 'item type'],
  category: ['category', 'category code', 'group'],
  business_unit: ['business unit', 'bu', 'department'],
  unit: ['unit', 'uom', 'unit of measure'],
  task_hours: ['task hours', 'hours', 'labor hours', 'flat rate hours', 'duration hours'],
  cost: ['cost', 'unit cost', 'cost $', 'material cost'],
  price: ['price', 'sell', 'sell price', 'retail', 'standard price', 'non-member price'],
  member_price: ['member price', 'member'],
  after_hours_price: ['after hours price', 'after-hours price', 'overtime price'],
  price_locked: ['price locked', 'locked', 'manual price'],
  target_gm_pct: ['target gm', 'target margin', 'gm %', 'margin %', 'target gm pct'],
  materials: ['materials', 'bundled materials', 'parts'],
  customer_description: ['customer description', 'long description', 'marketing description'],
  active: ['active', 'is active', 'status'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/** Column index per known field (−1 when absent). */
export function mapHeader(header: ReadonlyArray<string>): Record<PricebookColumn, number> {
  const h = header.map(norm);
  const out = {} as Record<PricebookColumn, number>;
  for (const col of PRICEBOOK_COLUMNS) {
    const names = ALIASES[col].map(norm);
    out[col] = h.findIndex((x) => x === norm(col) || names.includes(x));
  }
  return out;
}

/** "$1,234.50" / "1234.5" / "(12.00)" → cents; '' → null; junk → NaN. */
export function dollarsToCentsText(v: string): number | null {
  const t = v.trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t);
  const s = t.replace(/[()]/g, '');
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return Number.NaN;
  const [w, f = ''] = s.replace('-', '').split('.');
  const cents = Number(w) * 100 + Number((f + '00').slice(0, 2)) + (Number((f + '000').slice(2, 3)) >= 5 ? 1 : 0);
  return (neg || s.startsWith('-')) ? -cents : cents;
}

/** "45%" / "0.45" / "45" → 0.45. */
export function pctText(v: string): number | null {
  const t = v.trim().replace('%', '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return Number.NaN;
  return n > 1 ? Math.round(n * 100) / 10000 : n;
}

const truthy = (v: string) => /^(y|yes|true|1|locked|manual|active)$/i.test(v.trim());

/** The row shape pm.fs_import_pricebook takes (strings / cents strings). */
export interface ImportRow {
  code: string;
  name: string;
  kind?: string;
  category?: string;
  business_unit?: string;
  unit?: string;
  task_hours?: string;
  cost_cents?: string;
  price_cents?: string;
  price_locked?: boolean;
  target_gm_pct?: string;
  materials?: string;
  customer_description?: string;
  active?: boolean;
}

export interface ParsedImport {
  rows: ImportRow[];
  /** Problems found before the database sees anything (row = spreadsheet line, header = 1). */
  problems: Array<{ line: number; error: string }>;
  mapped: Record<PricebookColumn, number>;
}

export function parsePricebookCsv(text: string, maxRows = 10_000): ParsedImport {
  const all = parseCsv(text);
  const header = all[0] ?? [];
  const mapped = mapHeader(header);
  const problems: ParsedImport['problems'] = [];
  if (mapped.code < 0 || mapped.name < 0) {
    problems.push({ line: 1, error: 'The sheet needs a code column and a name column.' });
    return { rows: [], problems, mapped };
  }
  const rows: ImportRow[] = [];
  const get = (r: string[], c: PricebookColumn) => (mapped[c] >= 0 ? (r[mapped[c]] ?? '').trim() : '');
  for (let i = 1; i < all.length && rows.length < maxRows; i++) {
    const r = all[i]!;
    if (r.every((c) => c.trim() === '')) continue;
    const line = i + 1;
    const cost = get(r, 'cost') ? dollarsToCentsText(get(r, 'cost')) : null;
    const price = get(r, 'price') ? dollarsToCentsText(get(r, 'price')) : null;
    const gm = get(r, 'target_gm_pct') ? pctText(get(r, 'target_gm_pct')) : null;
    const hours = get(r, 'task_hours');
    if (cost !== null && (Number.isNaN(cost) || cost < 0)) { problems.push({ line, error: `cost "${get(r, 'cost')}" is not an amount` }); continue; }
    if (price !== null && (Number.isNaN(price) || price < 0)) { problems.push({ line, error: `price "${get(r, 'price')}" is not an amount` }); continue; }
    if (gm !== null && (Number.isNaN(gm) || gm < 0 || gm >= 0.95)) { problems.push({ line, error: 'target margin must be below 95%' }); continue; }
    if (hours && !/^\d{1,3}(\.\d{1,2})?$/.test(hours)) { problems.push({ line, error: `task hours "${hours}" is not a number like 1.5` }); continue; }
    const kind = get(r, 'kind').toUpperCase();
    rows.push({
      code: get(r, 'code').toUpperCase(),
      name: get(r, 'name'),
      ...(kind ? { kind: kind === 'TASK' ? 'SERVICE' : kind === 'PART' ? 'MATERIAL' : kind } : {}),
      ...(get(r, 'category') ? { category: get(r, 'category').toUpperCase() } : {}),
      ...(get(r, 'business_unit') ? { business_unit: get(r, 'business_unit').toUpperCase() } : {}),
      ...(get(r, 'unit') ? { unit: get(r, 'unit').toUpperCase() } : {}),
      ...(hours ? { task_hours: hours } : {}),
      ...(cost !== null ? { cost_cents: String(cost) } : {}),
      ...(price !== null ? { price_cents: String(price) } : {}),
      ...(get(r, 'price_locked') ? { price_locked: truthy(get(r, 'price_locked')) } : {}),
      ...(gm !== null ? { target_gm_pct: String(gm) } : {}),
      ...(get(r, 'materials') ? { materials: get(r, 'materials') } : {}),
      ...(get(r, 'customer_description') ? { customer_description: get(r, 'customer_description') } : {}),
      ...(get(r, 'active') ? { active: truthy(get(r, 'active')) || /^a/i.test(get(r, 'active')) } : {}),
    });
  }
  if (all.length - 1 > maxRows) problems.push({ line: maxRows + 2, error: `Only the first ${maxRows} rows are read.` });
  return { rows, problems, mapped };
}

/** Cents → "1234.50" (Excel-friendly, no symbol, no thousands separator). */
export function centsCell(c: number | null | undefined): string {
  if (c == null) return '';
  const neg = c < 0;
  const a = Math.abs(Math.round(c));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
