/**
 * K&B design-software import (RES-23): 2020 Design, Cabinet Vision and ProKitchen cabinet lists
 * (CSV or XML) → the lines pm.res_stage_kb_import maps to catalog SKUs. Quantities are summed per
 * SKU + finish + room, money is exact cents from text, unknown columns are ignored and every row
 * that cannot be read is reported (never silently dropped). Pure; unit-tested.
 */
import { dollarsToCentsText, headerIndex, numText, parseDelimited, xmlElements, xmlValue } from '@/lib/dealer/tabular';

export const KB_SOURCES = ['TWENTY_TWENTY', 'CABINET_VISION', 'PROKITCHEN', 'CSV'] as const;
export type KbSource = (typeof KB_SOURCES)[number];

export const KB_SOURCE_LABELS: Readonly<Record<KbSource, string>> = {
  TWENTY_TWENTY: '2020 Design',
  CABINET_VISION: 'Cabinet Vision',
  PROKITCHEN: 'ProKitchen',
  CSV: 'Other cabinet list (CSV)',
};

export interface KbLine {
  sku: string;
  description: string;
  qty: number;
  uom: string;
  width_in: number | null;
  height_in: number | null;
  depth_in: number | null;
  finish: string | null;
  room: string | null;
  list_price_cents: number | null;
  unit_cost_cents: number | null;
}

export interface KbParse {
  source: KbSource;
  lines: KbLine[];
  issues: Array<{ row: number; message: string }>;
  totals: { lines: number; units: number; listCents: number };
}

type Key = 'sku' | 'description' | 'qty' | 'uom' | 'width' | 'height' | 'depth' | 'finish' | 'room' | 'list' | 'net';

const ALIASES: Readonly<Record<Key, readonly string[]>> = {
  sku: ['sku', 'item #', 'item no', 'item number', 'item code', 'manufacturer code', 'mfg code', 'code', 'catalog code', 'part number', 'product code', 'nomenclature'],
  description: ['description', 'item description', 'name', 'product', 'product name', 'cabinet description'],
  qty: ['qty', 'quantity', 'count', 'units'],
  uom: ['uom', 'unit', 'units of measure'],
  width: ['width', 'w', 'width in', 'width (in)'],
  height: ['height', 'h', 'height in', 'height (in)'],
  depth: ['depth', 'd', 'depth in', 'depth (in)'],
  finish: ['finish', 'door style', 'style', 'color', 'species', 'material'],
  room: ['room', 'area', 'location', 'wall'],
  list: ['list', 'list price', 'price', 'retail', 'msrp', 'unit price', 'extended list'],
  net: ['net', 'net price', 'cost', 'unit cost', 'dealer net', 'net cost'],
};

/** Which program wrote the file, from its name and its first lines. */
export function detectKbSource(fileName: string, text: string): KbSource {
  const head = text.slice(0, 4000).toLowerCase();
  const name = fileName.toLowerCase();
  if (name.includes('2020') || head.includes('2020 design') || head.includes('<kitchendraw') || head.includes('<itemlist')) return 'TWENTY_TWENTY';
  if (name.includes('cabinet vision') || name.includes('cabinetvision') || head.includes('<cabinetvision') || head.includes('<cabinets') || head.includes('<cabinet ')) return 'CABINET_VISION';
  if (name.includes('prokitchen') || head.includes('prokitchen')) return 'PROKITCHEN';
  return 'CSV';
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function key(l: KbLine): string {
  return [l.sku.toUpperCase(), (l.finish ?? '').toUpperCase(), (l.room ?? '').toUpperCase(), l.list_price_cents ?? '', l.unit_cost_cents ?? ''].join('|');
}

function merge(lines: KbLine[]): KbLine[] {
  const by = new Map<string, KbLine>();
  for (const l of lines) {
    const k = key(l);
    const prev = by.get(k);
    if (prev) prev.qty = Math.round((prev.qty + l.qty) * 10000) / 10000;
    else by.set(k, { ...l });
  }
  return [...by.values()];
}

function totals(lines: KbLine[]): KbParse['totals'] {
  return {
    lines: lines.length,
    units: lines.reduce((s, l) => s + l.qty, 0),
    listCents: lines.reduce((s, l) => s + Math.round(l.qty * (l.list_price_cents ?? 0)), 0),
  };
}

/** Per-unit price: a column named "extended" is divided by the quantity. */
function unitFrom(raw: string | undefined, header: string | undefined, qty: number): number | null {
  const c = dollarsToCentsText(raw);
  if (c == null) return null;
  if (header && /extended|ext\b|total/i.test(header) && qty > 0) return Math.round(c / qty);
  return c;
}

function parseCsvList(text: string, source: KbSource): KbParse {
  const rows = parseDelimited(text).filter((r) => r.some((c) => c.trim() !== ''));
  const issues: KbParse['issues'] = [];
  // the header is the first row that names a SKU / code column
  let h = rows.findIndex((r) => {
    const ix = headerIndex(r, ALIASES);
    return ix.sku >= 0 && (ix.qty >= 0 || ix.description >= 0);
  });
  if (h < 0) return { source, lines: [], issues: [{ row: 1, message: 'No SKU / item code column was found in the file' }], totals: totals([]) };
  const header = rows[h]!;
  const ix = headerIndex(header, ALIASES);
  const lines: KbLine[] = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const sku = clean(r[ix.sku]);
    if (!sku) continue;
    if (/^(total|subtotal|grand total)\b/i.test(sku)) continue;
    const qty = ix.qty >= 0 ? numText(r[ix.qty]) : 1;
    if (qty == null || qty <= 0) { issues.push({ row: i + 1, message: `${sku}: quantity "${r[ix.qty] ?? ''}" is not a number` }); continue; }
    lines.push({
      sku: sku.slice(0, 80),
      description: clean(ix.description >= 0 ? r[ix.description] : '').slice(0, 500),
      qty,
      uom: clean(ix.uom >= 0 ? r[ix.uom] : '').toUpperCase().slice(0, 12) || 'EA',
      width_in: ix.width >= 0 ? numText(r[ix.width]) : null,
      height_in: ix.height >= 0 ? numText(r[ix.height]) : null,
      depth_in: ix.depth >= 0 ? numText(r[ix.depth]) : null,
      finish: clean(ix.finish >= 0 ? r[ix.finish] : '') || null,
      room: clean(ix.room >= 0 ? r[ix.room] : '') || null,
      list_price_cents: ix.list >= 0 ? unitFrom(r[ix.list], header[ix.list], qty) : null,
      unit_cost_cents: ix.net >= 0 ? unitFrom(r[ix.net], header[ix.net], qty) : null,
    });
  }
  const merged = merge(lines);
  return { source, lines: merged, issues, totals: totals(merged) };
}

function parseXmlList(text: string, source: KbSource): KbParse {
  const els = xmlElements(text, ['Cabinet', 'Item', 'Product', 'Part', 'LineItem']);
  const issues: KbParse['issues'] = [];
  const lines: KbLine[] = [];
  els.forEach((el, i) => {
    const sku = clean(xmlValue(el, ['SKU', 'Code', 'ItemCode', 'ManufacturerCode', 'Nomenclature', 'PartNumber', 'Name']));
    if (!sku) { issues.push({ row: i + 1, message: `<${el.name}> ${i + 1} has no code` }); return; }
    const qty = numText(xmlValue(el, ['Qty', 'Quantity', 'Count'])) ?? 1;
    if (qty <= 0) { issues.push({ row: i + 1, message: `${sku}: quantity is not positive` }); return; }
    lines.push({
      sku: sku.slice(0, 80),
      description: clean(xmlValue(el, ['Description', 'Desc', 'Title'])).slice(0, 500),
      qty,
      uom: clean(xmlValue(el, ['UOM', 'Unit'])).toUpperCase().slice(0, 12) || 'EA',
      width_in: numText(xmlValue(el, ['Width', 'W'])),
      height_in: numText(xmlValue(el, ['Height', 'H'])),
      depth_in: numText(xmlValue(el, ['Depth', 'D'])),
      finish: clean(xmlValue(el, ['Finish', 'DoorStyle', 'Material', 'Species', 'Color'])) || null,
      room: clean(xmlValue(el, ['Room', 'Area', 'Wall', 'Location'])) || null,
      list_price_cents: dollarsToCentsText(xmlValue(el, ['ListPrice', 'List', 'Price', 'Retail'])),
      unit_cost_cents: dollarsToCentsText(xmlValue(el, ['NetPrice', 'Net', 'Cost', 'DealerNet'])),
    });
  });
  const merged = merge(lines);
  return { source, lines: merged, issues, totals: totals(merged) };
}

/** Parse a cabinet list. `hint` overrides the detected program. */
export function parseKbFile(fileName: string, text: string, hint?: KbSource | null): KbParse {
  const body = text.replace(/^﻿/, '');
  const source = hint ?? detectKbSource(fileName, body);
  const isXml = /^\s*</.test(body);
  return isXml ? parseXmlList(body, source) : parseCsvList(body, source);
}
