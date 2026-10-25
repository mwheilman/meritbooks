/** Test helpers: read a fixture through the real engine; build a minimal .xlsx in memory. */
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { buildPreview, isFailure, readUpload, type PreviewOptions, type UploadTable } from '../engine';
import type { PreviewResult } from '../types';

export const FIXTURES = path.resolve(__dirname, '../__fixtures__');
export const inflate = (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

export function table(fixture: string): UploadTable {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, fixture)));
  const t = readUpload(fixture, fixture.endsWith('.xlsx') ? null : 'text/csv', bytes, inflate);
  if (isFailure(t)) throw new Error(`${fixture}: ${t.message}`);
  return t;
}

export const JOB_TYPES = [
  { key: 'remodel', label: 'Remodel', archetype: 'project' },
  { key: 'kitchen_remodel', label: 'Kitchen Remodel', archetype: 'project' },
  { key: 'service_call', label: 'Service call', archetype: 'field_service' },
];

export function preview(fixture: string, opts: Partial<PreviewOptions> = {}): PreviewResult {
  return buildPreview(table(fixture), { fileHash: 'f'.repeat(64), jobTypes: JOB_TYPES, ...opts });
}

// --- a minimal xlsx writer (stored + deflated entries, shared strings) ---
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
export function makeXlsx(grid: string[][]): Uint8Array {
  const strings: string[] = [];
  const idx = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = grid.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => /^-?\d+(\.\d+)?$/.test(v) ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  const files: [string, string][] = [['xl/sharedStrings.xml', sst], ['xl/worksheets/sheet1.xml', sheet]];
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = enc.encode(text);
    const data = new Uint8Array(deflateRawSync(raw));
    const nm = enc.encode(name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(8, 8, true); h.setUint32(14, crc32(raw), true);
    h.setUint32(18, data.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, nm.length, true);
    const local = new Uint8Array([...new Uint8Array(h.buffer), ...nm, ...data]);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(10, 8, true); c.setUint32(16, crc32(raw), true);
    c.setUint32(20, data.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array([...new Uint8Array(c.buffer), ...nm]));
    parts.push(local);
    offset += local.length;
  }
  const cd = central.reduce((a, b) => new Uint8Array([...a, ...b]), new Uint8Array());
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cd.length, true); e.setUint32(16, offset, true);
  return new Uint8Array([...parts.reduce((a, b) => new Uint8Array([...a, ...b]), new Uint8Array()), ...cd, ...new Uint8Array(e.buffer)]);
}
