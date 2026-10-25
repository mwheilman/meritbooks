/**
 * OEM price-file mapping (DLR price files + supersessions). Manufacturers send their parts price
 * files as delimited text with their own headings, or as fixed-width records; this maps any of
 * them onto the rows pm.dlr_stage_price_file stages:
 *   {part_number, description, list_price_cents, cost_cents, core_charge_cents, supersedes_to, uom, category}
 * Nothing is applied here: the database stages the file, shows new / changed / superseded /
 * below-floor lines, and only pm.dlr_apply_price_file changes the catalog. Pure; unit-tested.
 */
import { dateText, dollarsToCentsText, headerIndex, parseDelimited, sniffDelimiter } from './tabular';

export interface PriceFileRow {
  part_number: string;
  description: string | null;
  list_price_cents: number | null;
  cost_cents: number | null;
  core_charge_cents: number | null;
  supersedes_to: string | null;
  uom: string | null;
  category: string | null;
}

export interface PriceFileParse {
  format: PriceFileFormat;
  rows: PriceFileRow[];
  /** Row-level problems the person sees before staging (the database re-checks every row). */
  issues: Array<{ row: number; message: string }>;
  /** An effective date found in the file (header record or column), when there is one. */
  effectiveOn: string | null;
}

/** Fixed-width layouts: [key, start (0-based), length]. Prices carry implied decimals when `impliedDecimals`. */
interface FixedLayout {
  fields: ReadonlyArray<readonly [keyof PriceFileRow | 'effective_on', number, number]>;
  impliedDecimals: number;
  /** Records whose first character marks a header / trailer, skipped. */
  skipPrefix?: readonly string[];
}

export const PRICE_FILE_FORMATS = ['GENERIC', 'KUBOTA', 'STIHL', 'HUSQVARNA', 'TORO', 'BRIGGS', 'ECHO', 'FIXED_KUBOTA'] as const;
export type PriceFileFormat = (typeof PRICE_FILE_FORMATS)[number];

export const PRICE_FILE_FORMAT_LABELS: Readonly<Record<PriceFileFormat, string>> = {
  GENERIC: 'Any spreadsheet (CSV, tab or pipe)',
  KUBOTA: 'Kubota parts price list (delimited)',
  STIHL: 'STIHL dealer price file',
  HUSQVARNA: 'Husqvarna parts price file',
  TORO: 'Toro / Exmark price file',
  BRIGGS: 'Briggs & Stratton price file',
  ECHO: 'ECHO price file',
  FIXED_KUBOTA: 'Kubota fixed-width record file',
};

/** Header aliases across the delimited OEM files (lower-case, spaces). */
const ALIASES: Readonly<Record<keyof PriceFileRow | 'effective_on', readonly string[]>> = {
  part_number: ['part number', 'part no', 'part #', 'partno', 'part', 'item number', 'item', 'material number', 'material', 'sku', 'pn'],
  description: ['description', 'part description', 'desc', 'item description', 'material description', 'name'],
  list_price_cents: ['list price', 'list', 'retail', 'retail price', 'suggested retail', 'msrp', 'suggested list', 'srp', 'price'],
  cost_cents: ['dealer cost', 'dealer net', 'cost', 'net price', 'net', 'dealer price', 'your cost'],
  core_charge_cents: ['core charge', 'core', 'core price', 'core deposit'],
  supersedes_to: ['superseded by', 'supersedes to', 'replaced by', 'replacement', 'new part number', 'sub part', 'substitute', 'supersession'],
  uom: ['uom', 'unit', 'unit of measure', 'sell unit'],
  category: ['category', 'product group', 'price group', 'group', 'discount code', 'class', 'commodity code'],
  effective_on: ['effective date', 'effective', 'eff date', 'price effective date'],
};

const FIXED: Partial<Record<PriceFileFormat, FixedLayout>> = {
  // A Kubota-style record: part (15) · description (30) · list (9, 2 implied) · cost (9, 2 implied) · supersession (15) · group (4).
  FIXED_KUBOTA: {
    fields: [['part_number', 0, 15], ['description', 15, 30], ['list_price_cents', 45, 9], ['cost_cents', 54, 9], ['supersedes_to', 63, 15], ['category', 78, 4]],
    impliedDecimals: 2,
    skipPrefix: ['#', 'H', 'T'],
  },
};

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

function partNo(v: string | null | undefined): string | null {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/\s+/g, '') : null;
}

function impliedCents(raw: string, decimals: number): number | null {
  const s = raw.trim();
  if (!/^-?\d+$/.test(s)) return dollarsToCentsText(s);
  const n = Number(s);
  return decimals === 2 ? n : decimals === 3 ? Math.floor((n + 5) / 10) : n * 100;
}

function finish(r: PriceFileRow, row: number, issues: PriceFileParse['issues']): PriceFileRow | null {
  if (!r.part_number) {
    if (r.description || r.list_price_cents != null) issues.push({ row, message: 'No part number; the row is skipped.' });
    return null;
  }
  if (r.part_number.length > 40) issues.push({ row, message: `Part number ${r.part_number.slice(0, 12)}… is longer than 40 characters.` });
  if (r.supersedes_to === r.part_number) { r.supersedes_to = null; }
  if ((r.list_price_cents ?? 0) < 0 || (r.cost_cents ?? 0) < 0) issues.push({ row, message: `${r.part_number} has a negative price.` });
  return r;
}

export function parsePriceFile(text: string, format: PriceFileFormat = 'GENERIC'): PriceFileParse {
  const issues: PriceFileParse['issues'] = [];
  const fixed = FIXED[format];
  if (fixed) {
    const rows: PriceFileRow[] = [];
    let effectiveOn: string | null = null;
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      if (fixed.skipPrefix?.some((p) => line.startsWith(p))) {
        effectiveOn ??= dateText(/(\d{8}|\d{4}-\d{2}-\d{2})/.exec(line)?.[1]);
        return;
      }
      const get = (k: keyof PriceFileRow | 'effective_on') => {
        const f = fixed.fields.find((x) => x[0] === k);
        return f ? line.slice(f[1], f[1] + f[2]) : '';
      };
      const r = finish({
        part_number: partNo(get('part_number')) ?? '',
        description: clean(get('description')),
        list_price_cents: clean(get('list_price_cents')) ? impliedCents(get('list_price_cents'), fixed.impliedDecimals) : null,
        cost_cents: clean(get('cost_cents')) ? impliedCents(get('cost_cents'), fixed.impliedDecimals) : null,
        core_charge_cents: null,
        supersedes_to: partNo(get('supersedes_to')),
        uom: null,
        category: clean(get('category')),
      }, i + 1, issues);
      if (r) rows.push(r);
    });
    return { format, rows, issues, effectiveOn };
  }
  const cells = parseDelimited(text, sniffDelimiter(text));
  if (!cells.length) return { format, rows: [], issues: [{ row: 0, message: 'The file is empty.' }], effectiveOn: null };
  const idx = headerIndex(cells[0]!, ALIASES);
  if (idx.part_number < 0) {
    return { format, rows: [], issues: [{ row: 1, message: 'No part number column. Expected a heading such as “Part Number”.' }], effectiveOn: null };
  }
  if (idx.list_price_cents < 0 && idx.cost_cents < 0 && idx.supersedes_to < 0) {
    issues.push({ row: 1, message: 'No list price, cost or supersession column: only descriptions will change.' });
  }
  const rows: PriceFileRow[] = [];
  let effectiveOn: string | null = null;
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i]!;
    const at = (k: keyof typeof idx) => (idx[k] >= 0 ? c[idx[k]] ?? '' : '');
    if (!effectiveOn && idx.effective_on >= 0) effectiveOn = dateText(at('effective_on'));
    const money = (k: 'list_price_cents' | 'cost_cents' | 'core_charge_cents') => {
      const raw = at(k);
      if (!clean(raw)) return null;
      const v = dollarsToCentsText(raw);
      if (v == null) issues.push({ row: i + 1, message: `Could not read “${raw.trim()}” as a price.` });
      return v;
    };
    const r = finish({
      part_number: partNo(at('part_number')) ?? '',
      description: clean(at('description')),
      list_price_cents: money('list_price_cents'),
      cost_cents: money('cost_cents'),
      core_charge_cents: money('core_charge_cents'),
      supersedes_to: partNo(at('supersedes_to')),
      uom: clean(at('uom'))?.toUpperCase().slice(0, 12) ?? null,
      category: clean(at('category'))?.slice(0, 40) ?? null,
    }, i + 1, issues);
    if (r) rows.push(r);
  }
  return { format, rows, issues, effectiveOn };
}

/** Supersession chains in a parsed file that loop back on themselves (A → B → A), which the database would refuse. */
export function supersessionLoops(rows: ReadonlyArray<PriceFileRow>): string[][] {
  const next = new Map(rows.filter((r) => r.supersedes_to).map((r) => [r.part_number, r.supersedes_to!]));
  const loops: string[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur && !path.includes(cur) && path.length < 50) { path.push(cur); cur = next.get(cur); }
    path.forEach((p) => seen.add(p));
    if (cur && path.includes(cur)) loops.push(path.slice(path.indexOf(cur)));
  }
  return loops;
}
