/**
 * CAD / CAM cut-list import (MFG make-or-break: the shop builds what was sold, and the estimate is
 * checked against what engineering drew). Cabinet Vision, Microvellum, Mozaik, KCD, CabBuilder and
 * imos all export a part list (CSV) or a project XML; this maps any of them onto the lines
 * pm.mfg_stage_cad_import stages:
 *   {line_kind ASSEMBLY|PART|SHEET|EDGEBAND|HARDWARE|BUYOUT|FINISH, assembly_ref, part_code, label_id,
 *    description, material, qty, uom, length_mm, width_mm, thickness_mm, grain, edgeband, machining, yield_pct}
 * The database diffs the material against the estimate and only pm.mfg_apply_cad_import writes the
 * BOM. Dimensions are converted to millimetres (inch exports are detected or declared).
 * Pure; unit-tested.
 */
import { headerIndex, numText, parseDelimited, xmlElements, xmlValue, type XmlElement } from '@/lib/dealer/tabular';

export const CAD_SOURCES = ['CABINET_VISION', 'MICROVELLUM', 'MOZAIK', 'KCD', 'CABBUILDER', 'IMOS', 'GENERIC'] as const;
export type CadSource = (typeof CAD_SOURCES)[number];

export const CAD_SOURCE_LABELS: Readonly<Record<CadSource, string>> = {
  CABINET_VISION: 'Cabinet Vision',
  MICROVELLUM: 'Microvellum',
  MOZAIK: 'Mozaik',
  KCD: 'KCD',
  CABBUILDER: 'CabBuilder',
  IMOS: 'imos',
  GENERIC: 'Other cut list (CSV)',
};

export const CAD_LINE_KINDS = ['ASSEMBLY', 'PART', 'SHEET', 'EDGEBAND', 'HARDWARE', 'BUYOUT', 'FINISH'] as const;
export type CadLineKind = (typeof CAD_LINE_KINDS)[number];

export interface CadLine {
  line_kind: CadLineKind;
  assembly_ref: string | null;
  part_code: string | null;
  label_id: string | null;
  description: string;
  material: string | null;
  qty: number;
  uom: string | null;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  grain: 'NONE' | 'LENGTH' | 'WIDTH' | null;
  edgeband: string | null;
  machining: boolean;
  yield_pct: number | null;
}

export interface CadParse {
  source: CadSource;
  units: 'mm' | 'in';
  lines: CadLine[];
  issues: Array<{ row: number; message: string }>;
  summary: { assemblies: number; parts: number; sheets: number; edgebandLf: number; hardware: number };
}

type Key = 'kind' | 'assembly' | 'part_code' | 'label' | 'description' | 'material' | 'qty' | 'uom' | 'length' | 'width' | 'thickness' | 'grain' | 'edgeband' | 'machining' | 'yield';

/** Header aliases across the six tools' part-list exports (lower-case, spaces). */
const ALIASES: Readonly<Record<Key, readonly string[]>> = {
  kind: ['type', 'line type', 'item type', 'record type', 'kind', 'category'],
  assembly: ['cabinet', 'cabinet number', 'cab #', 'cab no', 'assembly', 'product', 'product name', 'cabinet name', 'unit', 'item'],
  part_code: ['part code', 'code', 'part id', 'sku', 'hardware code', 'catalog number', 'part number'],
  label: ['label', 'label id', 'barcode', 'part label', 'bar code', 'unique id'],
  description: ['part name', 'description', 'name', 'part', 'component', 'part description'],
  material: ['material', 'material name', 'sheet material', 'board', 'core material', 'stock'],
  qty: ['qty', 'quantity', 'count', 'pieces', 'pcs'],
  uom: ['uom', 'unit of measure', 'units'],
  length: ['length', 'cut length', 'finished length', 'len', 'l'],
  width: ['width', 'cut width', 'finished width', 'wid', 'w'],
  thickness: ['thickness', 'thick', 'material thickness', 'thk', 't'],
  grain: ['grain', 'grain direction', 'grain dir'],
  edgeband: ['edgeband', 'edge band', 'banding', 'edging', 'eb'],
  machining: ['machining', 'cnc', 'has machining', 'drilling', 'boring'],
  yield: ['yield', 'yield %', 'sheet yield', 'utilization'],
};

const KIND_WORDS: ReadonlyArray<readonly [RegExp, CadLineKind]> = [
  [/^(cab|cabinet|assembly|product|unit)/i, 'ASSEMBLY'],
  [/^(sheet|panel stock|board|material sheet)/i, 'SHEET'],
  [/^(edge|band)/i, 'EDGEBAND'],
  [/^(hardware|hinge|slide|pull|knob|fastener)/i, 'HARDWARE'],
  [/^(buyout|buy out|purchased|outsourced)/i, 'BUYOUT'],
  [/^(finish|paint|stain|lacquer)/i, 'FINISH'],
  [/^(part|panel|component|door|drawer|shelf)/i, 'PART'],
];

export function kindOf(raw: string | null | undefined, fallback: CadLineKind = 'PART'): CadLineKind {
  const s = (raw ?? '').trim();
  if (!s) return fallback;
  const up = s.toUpperCase();
  if ((CAD_LINE_KINDS as readonly string[]).includes(up)) return up as CadLineKind;
  return KIND_WORDS.find(([re]) => re.test(s))?.[1] ?? fallback;
}

function grainOf(raw: string | null | undefined): CadLine['grain'] {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(none|no|n|0|false)$/.test(s)) return 'NONE';
  if (/^(w|width|cross|horizontal)/.test(s)) return 'WIDTH';
  if (/^(l|length|long|vertical|yes|y|1|true)/.test(s)) return 'LENGTH';
  return null;
}

function boolOf(raw: string | null | undefined): boolean {
  return /^(y|yes|true|1|x)$/i.test((raw ?? '').trim());
}

/** "3/4", "0.75", "19", "23 1/2" → a number; null otherwise. */
export function fractionText(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim().replace(/["”]|in\b|mm\b/gi, '').trim();
  if (!s) return null;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  return numText(s);
}

/** To millimetres at 0.1 mm, half up (the epsilon keeps 0.75 in = 19.05 mm from flooring to 19.0). */
const MM = (v: number | null, units: 'mm' | 'in'): number | null => (v == null || v <= 0 ? null : Math.round((units === 'in' ? v * 254 : v * 10) + 1e-6) / 10);

/** Inch exports: thicknesses under 2.5 or lengths under 150 across the file. */
export function guessUnits(values: { thickness: Array<number | null>; length: Array<number | null> }): 'mm' | 'in' {
  const t = values.thickness.filter((v): v is number => v != null && v > 0);
  const l = values.length.filter((v): v is number => v != null && v > 0);
  if (t.length && t.filter((v) => v < 2.5).length / t.length > 0.6) return 'in';
  if (!t.length && l.length && l.filter((v) => v < 150).length / l.length > 0.8) return 'in';
  return 'mm';
}

function summarize(lines: CadLine[]): CadParse['summary'] {
  const sum = (k: CadLineKind) => lines.filter((l) => l.line_kind === k).reduce((s, l) => s + l.qty, 0);
  return { assemblies: lines.filter((l) => l.line_kind === 'ASSEMBLY').length, parts: lines.filter((l) => l.line_kind === 'PART').length, sheets: sum('SHEET'), edgebandLf: sum('EDGEBAND'), hardware: sum('HARDWARE') };
}

interface RawLine {
  row: number;
  kind: string | null;
  assembly: string | null;
  part_code: string | null;
  label: string | null;
  description: string | null;
  material: string | null;
  qty: string | null;
  uom: string | null;
  length: string | null;
  width: string | null;
  thickness: string | null;
  grain: string | null;
  edgeband: string | null;
  machining: string | null;
  yield: string | null;
}

function finish(source: CadSource, raws: RawLine[], declared: 'mm' | 'in' | 'auto', issues: CadParse['issues']): CadParse {
  const units = declared === 'auto'
    ? guessUnits({ thickness: raws.map((r) => fractionText(r.thickness)), length: raws.map((r) => fractionText(r.length)) })
    : declared;
  const lines: CadLine[] = [];
  for (const r of raws) {
    const qty = numText(r.qty) ?? (r.qty == null ? 1 : null);
    const description = (r.description ?? r.part_code ?? '').trim();
    if (!description) { if (r.qty || r.material) issues.push({ row: r.row, message: 'No part name; the line is skipped.' }); continue; }
    if (qty == null || qty <= 0) { issues.push({ row: r.row, message: `${description}: quantity “${r.qty ?? ''}” is not a positive number.` }); continue; }
    const kind = kindOf(r.kind, r.edgeband && !r.length ? 'EDGEBAND' : 'PART');
    const y = numText(r.yield);
    lines.push({
      line_kind: kind,
      assembly_ref: r.assembly?.trim().slice(0, 60) || null,
      part_code: r.part_code?.trim().slice(0, 60) || null,
      label_id: r.label?.trim().slice(0, 60) || null,
      description: description.slice(0, 300),
      material: r.material?.trim().slice(0, 120) || null,
      qty,
      uom: r.uom?.trim().toUpperCase().slice(0, 12) || null,
      length_mm: MM(fractionText(r.length), units),
      width_mm: MM(fractionText(r.width), units),
      thickness_mm: MM(fractionText(r.thickness), units),
      grain: grainOf(r.grain),
      edgeband: r.edgeband?.trim().slice(0, 60) || null,
      machining: boolOf(r.machining),
      yield_pct: y == null ? null : y > 1 ? Math.round(y * 100) / 10000 : y,
    });
  }
  return { source, units, lines, issues, summary: summarize(lines) };
}

/** A delimited part list from any of the six tools. */
export function parseCadCsv(text: string, source: CadSource, units: 'mm' | 'in' | 'auto' = 'auto'): CadParse {
  const issues: CadParse['issues'] = [];
  const cells = parseDelimited(text);
  if (cells.length < 2) return { source, units: 'mm', lines: [], issues: [{ row: 0, message: 'The file has no part rows.' }], summary: summarize([]) };
  const idx = headerIndex(cells[0]!, ALIASES);
  if (idx.description < 0 && idx.part_code < 0) {
    return { source, units: 'mm', lines: [], issues: [{ row: 1, message: 'No part name column. Expected a heading such as “Part Name” or “Description”.' }], summary: summarize([]) };
  }
  const raws: RawLine[] = cells.slice(1).map((c, i) => {
    const at = (k: Key) => (idx[k] >= 0 ? (c[idx[k]] ?? '').trim() || null : null);
    return { row: i + 2, kind: at('kind'), assembly: at('assembly'), part_code: at('part_code'), label: at('label'), description: at('description'), material: at('material'), qty: at('qty'), uom: at('uom'), length: at('length'), width: at('width'), thickness: at('thickness'), grain: at('grain'), edgeband: at('edgeband'), machining: at('machining'), yield: at('yield') };
  });
  return finish(source, raws, units, issues);
}

const XML_PART = ['Part', 'Panel', 'PartItem', 'Component'];
const XML_ASSEMBLY = ['Cabinet', 'Product', 'Assembly'];
const XML_HARDWARE = ['Hardware', 'HardwareItem', 'Accessory'];
const XML_SHEET = ['Sheet', 'SheetStock', 'Material', 'Board'];
const XML_BAND = ['EdgeBand', 'Edgeband', 'Banding'];

function fromEl(e: XmlElement, row: number, kind: CadLineKind): RawLine {
  const v = (ns: string[]) => xmlValue(e, ns);
  return {
    row, kind, assembly: v(['cabinet', 'cabinetnumber', 'product', 'assembly', 'parent']), part_code: v(['code', 'partcode', 'sku', 'catalognumber']),
    label: v(['label', 'labelid', 'barcode', 'uniqueid', 'id']), description: v(['name', 'description', 'partname', 'desc']) ?? (kind === 'SHEET' ? v(['material']) : null),
    material: v(['material', 'materialname', 'board']), qty: v(['qty', 'quantity', 'count']), uom: v(['uom', 'unit']),
    length: v(['length', 'cutlength', 'l']), width: v(['width', 'cutwidth', 'w']), thickness: v(['thickness', 'thick', 't']),
    grain: v(['grain', 'graindirection']), edgeband: v(['edgeband', 'banding', 'edging']), machining: v(['machining', 'cnc', 'hasmachining']), yield: v(['yield', 'utilization']),
  };
}

/** A project XML (Cabinet Vision / Microvellum / imos / Mozaik / KCD shapes: element lists with attributes or simple children). */
export function parseCadXml(xml: string, source: CadSource, units: 'mm' | 'in' | 'auto' = 'auto'): CadParse {
  const issues: CadParse['issues'] = [];
  const declaredInXml = /units\s*=\s*["'](inch|inches|in|imperial)["']/i.test(xml) ? 'in' : /units\s*=\s*["'](mm|metric|millimet)/i.test(xml) ? 'mm' : null;
  const raws: RawLine[] = [];
  let row = 0;
  const take = (names: string[], kind: CadLineKind) => { for (const e of xmlElements(xml, names)) raws.push(fromEl(e, ++row, kind)); };
  take(XML_ASSEMBLY, 'ASSEMBLY');
  take(XML_PART, 'PART');
  take(XML_SHEET, 'SHEET');
  take(XML_BAND, 'EDGEBAND');
  take(XML_HARDWARE, 'HARDWARE');
  if (!raws.length) issues.push({ row: 0, message: 'No parts, cabinets, sheets or hardware found in the XML.' });
  return finish(source, raws, units === 'auto' && declaredInXml ? declaredInXml : units, issues);
}

/** CSV or XML by content. */
export function parseCadFile(text: string, source: CadSource, units: 'mm' | 'in' | 'auto' = 'auto'): CadParse {
  return /^\s*(<\?xml|<)/.test(text) ? parseCadXml(text, source, units) : parseCadCsv(text, source, units);
}
