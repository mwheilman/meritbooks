/**
 * The small tabular toolkit the 1122 importers share (OEM price files, CAD cut lists, measure
 * files): delimiter sniffing (comma, tab, pipe, semicolon), loose header matching by alias, exact
 * dollars → cents from text (string math, never a float), numbers and dates from vendor exports,
 * and a tolerant XML element / attribute reader for the CAD and measure XML formats.
 * Pure; unit-tested.
 */
import { parseCsv } from '@/lib/fieldservice/csv';

export type Delimiter = ',' | '\t' | '|' | ';';

export function sniffDelimiter(text: string): Delimiter {
  const first = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const counts: Array<[Delimiter, number]> = (['\t', '|', ';', ','] as Delimiter[]).map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/** Rows of cells for any of the four delimiters (quoted fields honoured). */
export function parseDelimited(text: string, delimiter: Delimiter = sniffDelimiter(text)): string[][] {
  if (delimiter === ',') return parseCsv(text);
  // Swap the delimiter for a comma outside quotes, then reuse the RFC 4180 parser.
  let out = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === delimiter) out += ',';
    else if (!quoted && ch === ',') out += '\u0001';
    else out += ch;
  }
  return parseCsv(out).map((r) => r.map((c) => c.replace(/\u0001/g, ',')));
}

export function normHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
}

/** Column index per key from header aliases (first alias that matches wins); -1 when absent. */
export function headerIndex<K extends string>(header: ReadonlyArray<string>, aliases: Readonly<Record<K, readonly string[]>>): Record<K, number> {
  const norm = header.map(normHeader);
  const out = {} as Record<K, number>;
  for (const k of Object.keys(aliases) as K[]) {
    out[k] = -1;
    for (const a of aliases[k]) {
      const i = norm.indexOf(a);
      if (i >= 0) { out[k] = i; break; }
    }
  }
  return out;
}

/**
 * "$1,234.5" → 123450; "(12.00)" → -1200; "12.345" rounds half up at the third decimal → 1235.
 * Null for blank or unreadable text. Exact: string digits, no floating point.
 */
export function dollarsToCentsText(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$\s,]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  const f = (frac + '000').slice(0, 3);
  let cents = Number(whole || '0') * 100 + Number(f.slice(0, 2));
  if (Number(f[2]) >= 5) cents += 1;
  return neg ? -cents : cents;
}

/** A plain number from vendor text ("1,250.5", "12 ft" → 12); null when unreadable. */
export function numText(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, '');
  const m = /^-?\d*\.?\d+(e-?\d+)?/i.exec(s);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** ISO date from "2026-10-25", "10/25/2026", "10/25/26", "20261025"; null otherwise. */
export function dateText(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  let y: number; let mo: number; let d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) {
    mo = +m[1]!; d = +m[2]!; y = +m[3]!; if (y < 100) y += 2000;
  } else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  /** Text of simple child elements (<Material>Maple</Material>), lower-cased keys. */
  children: Record<string, string>;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Every element named one of `names` (case-insensitive), with its attributes and the text of its
 * simple children. Enough for the flat part / room lists CAD and measure tools export; not a
 * general XML parser (no DTDs, no entities beyond the five, no namespaces kept).
 */
export function xmlElements(xml: string, names: ReadonlyArray<string>): XmlElement[] {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: XmlElement[] = [];
  const src = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  const re = /<([A-Za-z_][\w.:-]*)(\s[^<>]*?)?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = m[1]!;
    const local = tag.includes(':') ? tag.split(':').pop()! : tag;
    if (!want.has(local.toLowerCase())) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]!.toLowerCase()] = decodeXml(a[3] ?? a[4] ?? '');
    const children: Record<string, string> = {};
    if (m[3] !== '/') {
      const close = new RegExp(`</${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i');
      const rest = src.slice(re.lastIndex);
      const end = rest.search(close);
      const body = end >= 0 ? rest.slice(0, end) : '';
      for (const c of body.matchAll(/<([A-Za-z_][\w.:-]*)[^<>]*>([^<]*)<\/\1\s*>/g)) {
        const k = (c[1]!.includes(':') ? c[1]!.split(':').pop()! : c[1]!).toLowerCase();
        if (!(k in children)) children[k] = decodeXml(c[2]!.trim());
      }
    }
    out.push({ name: local, attrs, children });
  }
  return out;
}

/** An element's value by any of several names: attribute first, then a simple child. */
export function xmlValue(el: XmlElement, names: ReadonlyArray<string>): string | null {
  for (const n of names) {
    const k = n.toLowerCase();
    if (el.attrs[k] != null && el.attrs[k] !== '') return el.attrs[k]!;
    if (el.children[k] != null && el.children[k] !== '') return el.children[k]!;
  }
  return null;
}
