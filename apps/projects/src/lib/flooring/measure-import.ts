/**
 * Measure file import (FLR make-or-break: the quote is built from the measure, not retyped).
 * MeasureSquare and RFMS Measure export room lists as CSV or XML; a generic spreadsheet works too.
 * Maps them onto the rooms pm.flr_import_measure takes:
 *   {room, area_kind FLOOR|STAIRS|BASE|TRANSITION|WALL|OTHER, category, sqft, linear_ft, each_count, waste_pct, notes}
 * Square yards are converted to square feet (× 9), waste "12%" or 0.12 both read as 0.12.
 * Pure; unit-tested.
 */
import { headerIndex, numText, parseDelimited, xmlElements, xmlValue } from '@/lib/dealer/tabular';

export const MEASURE_SOURCES = ['MEASURESQUARE', 'RFMS', 'GENERIC'] as const;
export type MeasureSource = (typeof MEASURE_SOURCES)[number];

export const MEASURE_SOURCE_LABELS: Readonly<Record<MeasureSource, string>> = {
  MEASURESQUARE: 'MeasureSquare',
  RFMS: 'RFMS Measure',
  GENERIC: 'Other room list (CSV)',
};

export const AREA_KINDS = ['FLOOR', 'STAIRS', 'BASE', 'TRANSITION', 'WALL', 'OTHER'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export const FLOOR_CATEGORIES = ['CARPET', 'LVP', 'HARDWOOD', 'LAMINATE', 'TILE', 'VINYL_SHEET', 'RUBBER', 'PAD', 'SUNDRY', 'TRANSITION', 'OTHER'] as const;
export type FloorCategory = (typeof FLOOR_CATEGORIES)[number];

export interface MeasureRoom {
  room: string;
  area_kind: AreaKind;
  category: FloorCategory | null;
  sqft: number;
  linear_ft: number | null;
  each_count: number | null;
  waste_pct: number | null;
  notes: string | null;
}

export interface MeasureParse {
  source: MeasureSource;
  rooms: MeasureRoom[];
  issues: Array<{ row: number; message: string }>;
  totals: { sqft: number; linearFt: number; steps: number };
}

type Key = 'room' | 'kind' | 'category' | 'sqft' | 'sqyd' | 'lf' | 'each' | 'waste' | 'notes' | 'product';

const ALIASES: Readonly<Record<Key, readonly string[]>> = {
  room: ['room', 'room name', 'area', 'area name', 'location', 'space'],
  kind: ['area type', 'type', 'kind', 'measure type'],
  category: ['category', 'material', 'material type', 'floor type', 'product type', 'flooring'],
  sqft: ['sq ft', 'sqft', 'square feet', 'sf', 'net sf', 'area sf', 'area (sf)', 'net area', 'floor area'],
  sqyd: ['sq yd', 'sqyd', 'square yards', 'sy', 'net sy'],
  lf: ['lf', 'linear ft', 'linear feet', 'perimeter', 'base lf', 'lin ft'],
  each: ['steps', 'stairs', 'step count', 'each', 'count', 'qty', 'quantity', 'transitions'],
  waste: ['waste', 'waste %', 'waste pct', 'waste factor', 'overage'],
  notes: ['notes', 'note', 'comments', 'memo'],
  product: ['product', 'product name', 'style'],
};

const CATEGORY_WORDS: ReadonlyArray<readonly [RegExp, FloorCategory]> = [
  [/carpet|broadloom|berber/i, 'CARPET'],
  [/\b(lvp|lvt|luxury vinyl|vinyl plank|spc|wpc)\b/i, 'LVP'],
  [/sheet vinyl|vinyl sheet|linoleum/i, 'VINYL_SHEET'],
  [/hardwood|engineered wood|solid wood|\bwood\b/i, 'HARDWOOD'],
  [/laminate/i, 'LAMINATE'],
  [/tile|porcelain|ceramic|stone|marble/i, 'TILE'],
  [/rubber/i, 'RUBBER'],
  [/\bpad\b|cushion|underlayment/i, 'PAD'],
  [/transition|reducer|t-mold|threshold/i, 'TRANSITION'],
];

export function categoryOf(raw: string | null | undefined): FloorCategory | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const up = s.toUpperCase().replace(/[\s-]+/g, '_');
  if ((FLOOR_CATEGORIES as readonly string[]).includes(up)) return up as FloorCategory;
  return CATEGORY_WORDS.find(([re]) => re.test(s))?.[1] ?? 'OTHER';
}

export function kindOf(raw: string | null | undefined, room: string, hasLf: boolean, hasSf: boolean): AreaKind {
  const s = `${raw ?? ''} ${room}`.toLowerCase();
  if (/stair|step/.test(s)) return 'STAIRS';
  if (/transition|threshold|reducer/.test(s)) return 'TRANSITION';
  if (/\bbase\b|baseboard|cove|quarter round|shoe/.test(s) || (hasLf && !hasSf)) return 'BASE';
  if (/wall|backsplash|shower wall/.test(s)) return 'WALL';
  const up = (raw ?? '').trim().toUpperCase();
  if ((AREA_KINDS as readonly string[]).includes(up)) return up as AreaKind;
  return 'FLOOR';
}

/** "12%" → 0.12, "12" → 0.12, "0.12" → 0.12, "1.12" (factor) → 0.12. */
export function wasteOf(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const v = numText(s);
  if (v == null || v < 0) return null;
  if (s.includes('%') || v > 1.5) return Math.round(v * 100) / 10000;
  if (v > 1) return Math.round((v - 1) * 10000) / 10000;
  return Math.round(v * 10000) / 10000;
}

function totals(rooms: MeasureRoom[]): MeasureParse['totals'] {
  return {
    sqft: Math.round(rooms.reduce((s, r) => s + r.sqft, 0) * 100) / 100,
    linearFt: Math.round(rooms.reduce((s, r) => s + (r.linear_ft ?? 0), 0) * 100) / 100,
    steps: rooms.filter((r) => r.area_kind === 'STAIRS').reduce((s, r) => s + (r.each_count ?? 0), 0),
  };
}

interface Raw {
  row: number;
  room: string | null;
  kind: string | null;
  category: string | null;
  sqft: string | null;
  sqyd: string | null;
  lf: string | null;
  each: string | null;
  waste: string | null;
  notes: string | null;
  product: string | null;
}

function build(source: MeasureSource, raws: Raw[], issues: MeasureParse['issues']): MeasureParse {
  const rooms: MeasureRoom[] = [];
  for (const r of raws) {
    const room = (r.room ?? '').trim();
    if (!room) { if (r.sqft || r.sqyd) issues.push({ row: r.row, message: 'An area with no room name is skipped.' }); continue; }
    const sy = numText(r.sqyd);
    const sf = numText(r.sqft) ?? (sy != null ? Math.round(sy * 9 * 100) / 100 : null);
    const lf = numText(r.lf);
    const each = numText(r.each);
    const kind = kindOf(r.kind, room, lf != null && lf > 0, sf != null && sf > 0);
    if ((sf ?? 0) <= 0 && (lf ?? 0) <= 0 && (each ?? 0) <= 0) { issues.push({ row: r.row, message: `${room}: no square feet, linear feet or count.` }); continue; }
    if (kind === 'STAIRS' && !(each && each > 0)) issues.push({ row: r.row, message: `${room}: stairs without a step count; the quote flags it.` });
    rooms.push({
      room: room.slice(0, 120),
      area_kind: kind,
      category: categoryOf(r.category ?? r.product),
      sqft: sf && sf > 0 ? sf : 0,
      linear_ft: lf && lf > 0 ? lf : null,
      each_count: each && each > 0 ? Math.round(each) : null,
      waste_pct: wasteOf(r.waste),
      notes: r.notes?.trim().slice(0, 500) || null,
    });
  }
  return { source, rooms, issues, totals: totals(rooms) };
}

export function parseMeasureCsv(text: string, source: MeasureSource = 'GENERIC'): MeasureParse {
  const cells = parseDelimited(text);
  if (cells.length < 2) return { source, rooms: [], issues: [{ row: 0, message: 'The file has no rooms.' }], totals: totals([]) };
  const idx = headerIndex(cells[0]!, ALIASES);
  if (idx.room < 0) return { source, rooms: [], issues: [{ row: 1, message: 'No room column. Expected a heading such as “Room”.' }], totals: totals([]) };
  if (idx.sqft < 0 && idx.sqyd < 0 && idx.lf < 0) return { source, rooms: [], issues: [{ row: 1, message: 'No square feet, square yards or linear feet column.' }], totals: totals([]) };
  const raws: Raw[] = cells.slice(1).map((c, i) => {
    const at = (k: Key) => (idx[k] >= 0 ? (c[idx[k]] ?? '').trim() || null : null);
    return { row: i + 2, room: at('room'), kind: at('kind'), category: at('category'), sqft: at('sqft'), sqyd: at('sqyd'), lf: at('lf'), each: at('each'), waste: at('waste'), notes: at('notes'), product: at('product') };
  });
  return build(source, raws, []);
}

/** MeasureSquare / RFMS project XML: <Room> / <Area> elements with attributes or simple children. */
export function parseMeasureXml(xml: string, source: MeasureSource): MeasureParse {
  const els = xmlElements(xml, ['Room', 'Area', 'MeasureArea', 'Stair', 'Stairs', 'Base', 'Transition']);
  const raws: Raw[] = els.map((e, i) => {
    const v = (ns: string[]) => xmlValue(e, ns);
    const tagKind = /stair/i.test(e.name) ? 'STAIRS' : /base/i.test(e.name) ? 'BASE' : /transition/i.test(e.name) ? 'TRANSITION' : null;
    return {
      row: i + 1, room: v(['name', 'roomname', 'room', 'label']), kind: v(['type', 'areatype', 'kind']) ?? tagKind,
      category: v(['category', 'material', 'materialtype', 'producttype']), sqft: v(['sqft', 'squarefeet', 'netsf', 'area', 'areasf']),
      sqyd: v(['sqyd', 'squareyards', 'netsy']), lf: v(['lf', 'linearfeet', 'perimeter', 'baself']), each: v(['steps', 'stepcount', 'count', 'qty']),
      waste: v(['waste', 'wastepct', 'wastefactor']), notes: v(['notes', 'note', 'comment']), product: v(['product', 'productname', 'style']),
    };
  });
  const issues: MeasureParse['issues'] = raws.length ? [] : [{ row: 0, message: 'No rooms found in the XML.' }];
  return build(source, raws, issues);
}

export function parseMeasureFile(text: string, source: MeasureSource): MeasureParse {
  return /^\s*</.test(text) ? parseMeasureXml(text, source) : parseMeasureCsv(text, source);
}
