/**
 * Minimal, dependency-free XLSX reader (SERVER-ONLY — uses `node:zlib`).
 *
 * An .xlsx file is a ZIP archive of XML parts. Rather than add a spreadsheet
 * dependency, this reads the ZIP central directory, inflates the two parts we need
 * (`xl/sharedStrings.xml` and the first `xl/worksheets/sheet*.xml`), and extracts a
 * rectangular string grid — enough to feed the deterministic payroll-register
 * mapper. It intentionally supports only what a payroll-register export needs:
 * shared/inline strings and numeric cells on the first worksheet. Formulas resolve
 * to their cached `<v>` value; dates come through as their raw serial/string and are
 * mapped by the human, not interpreted here.
 *
 * Never throws for a malformed file — returns `{ headers: [], rows: [] }` so the
 * route degrades to a clear "couldn't read this spreadsheet" message.
 */

import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Locate the End Of Central Directory record and read the central directory. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  // Scan backwards for the EOCD signature (comment is usually empty; cap the scan).
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate a single ZIP entry to a UTF-8 string (stored or DEFLATE only). */
function readEntry(buf: Buffer, entry: ZipEntry): string | null {
  const LFH_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  try {
    if (entry.method === 0) return data.toString('utf8'); // stored
    if (entry.method === 8) return inflateRawSync(data).toString('utf8'); // deflate
    return null;
  } catch {
    return null;
  }
}

/** Decode XML entities that appear in cell/shared-string text. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Parse sharedStrings.xml into an ordered string table. */
function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    // Concatenate every <t> run inside the shared-string item.
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner)) !== null) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

/** Column reference letters ("A", "AB") → 0-based index. */
function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, '');
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/** Parse a worksheet XML into a rectangular grid of strings. */
function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let maxCols = 0;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowXml = rm[1];
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1] ?? cm[3] ?? '';
      const body = cm[2] ?? '';
      const refM = /r="([A-Z]+)\d+"/.exec(attrs);
      const typeM = /t="([^"]+)"/.exec(attrs);
      const type = typeM?.[1] ?? 'n';
      const colIdx = refM ? colToIndex(refM[1]) : cells.length;

      let value = '';
      if (type === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        const sIdx = vM ? parseInt(vM[1], 10) : NaN;
        value = Number.isInteger(sIdx) ? (shared[sIdx] ?? '') : '';
      } else if (type === 'inlineStr') {
        const tM = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = tM ? decodeXml(tM[1]) : '';
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? decodeXml(vM[1]) : '';
      }
      while (cells.length < colIdx) cells.push('');
      cells[colIdx] = value;
    }
    if (cells.some((c) => c.trim() !== '')) {
      rows.push(cells);
      maxCols = Math.max(maxCols, cells.length);
    }
  }
  // Rectangularize.
  for (const r of rows) while (r.length < maxCols) r.push('');
  return rows;
}

export interface XlsxGrid {
  headers: string[];
  rows: string[][];
}

/**
 * Read the first worksheet of an .xlsx buffer into a header row + data rows.
 * Returns empty on any failure (caller degrades to a friendly error).
 */
export function readXlsx(buf: Buffer): XlsxGrid {
  const entries = readCentralDirectory(buf);
  if (entries.length === 0) return { headers: [], rows: [] };

  const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedEntry ? readEntry(buf, sharedEntry) : null);

  // First worksheet by filename order (sheet1, sheet2, …).
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sheetEntries.length === 0) return { headers: [], rows: [] };

  const sheetXml = readEntry(buf, sheetEntries[0]);
  if (!sheetXml) return { headers: [], rows: [] };

  const grid = parseSheet(sheetXml, shared);
  if (grid.length === 0) return { headers: [], rows: [] };

  const headers = grid[0].map((h) => h.trim());
  const width = headers.length;
  const rows = grid.slice(1).map((r) => {
    const out = r.slice(0, width).map((c) => c.trim());
    while (out.length < width) out.push('');
    return out;
  });
  return { headers, rows };
}
