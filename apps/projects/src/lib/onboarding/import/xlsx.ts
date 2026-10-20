/**
 * Minimal, dependency-free .xlsx reader (ported from Books' payroll register importer,
 * apps/web/src/lib/payroll/xlsx-read.ts). An .xlsx is a ZIP of XML parts: we read the
 * central directory, inflate `xl/sharedStrings.xml` and the first worksheet, and build a
 * string grid. Inflate is INJECTED (node:zlib `inflateRawSync` on the server) so this
 * module stays pure and testable. Never throws: an unreadable file returns [].
 *
 * Supports shared/inline strings, numbers, booleans and cached formula values. Dates
 * arrive as Excel serials; ./dates.ts converts them.
 */
import type { Grid } from './grid';

export type InflateRaw = (data: Uint8Array) => Uint8Array;

interface ZipEntry { name: string; method: number; compressedSize: number; localHeaderOffset: number }

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf8 = new TextDecoder('utf-8');

function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
  if (buf.length < 22) return [];
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const cdOffset = u32(buf, eocd + 16);
  const total = u16(buf, eocd + 10);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (u32(buf, p) !== 0x02014b50) break;
    const nameLen = u16(buf, p + 28);
    entries.push({
      method: u16(buf, p + 10),
      compressedSize: u32(buf, p + 20),
      localHeaderOffset: u32(buf, p + 42),
      name: utf8.decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + u16(buf, p + 30) + u16(buf, p + 32);
  }
  return entries;
}

function readEntry(buf: Uint8Array, e: ZipEntry, inflate: InflateRaw): string | null {
  const off = e.localHeaderOffset;
  if (off + 30 > buf.length || u32(buf, off) !== 0x04034b50) return null;
  const start = off + 30 + u16(buf, off + 26) + u16(buf, off + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  try {
    if (e.method === 0) return utf8.decode(data);
    if (e.method === 8) return utf8.decode(inflate(data));
    return null;
  } catch {
    return null;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) text += tm[1];
    out.push(decodeXml(text));
  }
  return out;
}

function colToIndex(ref: string): number {
  let idx = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

const MAX_ROWS = 25_000;
const MAX_COLS = 80;

function parseSheet(xml: string, shared: string[]): Grid {
  const rows: Grid = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null && rows.length < MAX_ROWS) {
    const rAttr = /\br="(\d+)"/.exec(rm[1] ?? rm[3] ?? '');
    const rowIdx = rAttr ? parseInt(rAttr[1], 10) - 1 : rows.length;
    while (rows.length < rowIdx) rows.push([]);
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    const body = rm[2] ?? '';
    while ((cm = cellRe.exec(body)) !== null) {
      const attrs = cm[1] ?? cm[3] ?? '';
      const inner = cm[2] ?? '';
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const col = refM ? colToIndex(refM[1]) : cells.length;
      if (col >= MAX_COLS) continue;
      let value = '';
      if (type === 's') {
        const i = parseInt(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '', 10);
        value = Number.isInteger(i) ? shared[i] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = decodeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(inner) ? 'TRUE' : 'FALSE';
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      while (cells.length < col) cells.push('');
      cells[col] = value.trim();
    }
    rows.push(cells.some((c) => c !== '') ? cells : []);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** The first worksheet of an .xlsx as a grid (row index + 1 = sheet row). [] when unreadable. */
export function readXlsxGrid(data: Uint8Array, inflate: InflateRaw): Grid {
  try {
    const entries = readCentralDirectory(data);
    if (entries.length === 0) return [];
    const shared = parseSharedStrings((() => {
      const e = entries.find((x) => x.name === 'xl/sharedStrings.xml');
      return e ? readEntry(data, e, inflate) : null;
    })());
    const sheet = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
    if (!sheet) return [];
    const xml = readEntry(data, sheet, inflate);
    return xml ? parseSheet(xml, shared) : [];
  } catch {
    return [];
  }
}
