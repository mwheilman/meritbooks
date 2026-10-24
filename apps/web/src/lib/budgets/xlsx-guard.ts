/**
 * Zip-bomb guard for budget .xlsx uploads (security review, LOW) — SERVER-ONLY (`node:zlib`).
 *
 * The shared reader (lib/payroll/xlsx-read.ts) inflates parts with no output cap, so a tiny
 * archive could expand to gigabytes in memory. Before the budget import hands a file to it, this
 * checks the archive WITHOUT trusting its declared sizes:
 *
 *   - compressed size ≤ 10 MB (the route's upload cap, re-checked here), ≤ 2,000 entries, no ZIP64
 *   - declared uncompressed sizes: ≤ 20 MB in total, no entry over 100:1 (once past 1 MB)
 *   - every DEFLATE entry is actually inflated with `maxOutputLength` = what's left of the 20 MB
 *     budget, so a lying header can't get past it; the real output is held to the same 100:1 rule
 *   - only STORED / DEFLATE entries
 *
 * Returns null when the file is safe to read, else a short reason for the 422.
 */
import { inflateRawSync } from 'node:zlib';

export const XLSX_LIMITS = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 20 * 1024 * 1024,
  maxEntries: 2_000,
  maxRatio: 100,
  /** Below this an entry's ratio isn't judged (tiny XML parts legitimately compress very well). */
  ratioFloorBytes: 1024 * 1024,
} as const;

export type XlsxLimits = { [K in keyof typeof XLSX_LIMITS]: number };

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

export function xlsxBombReason(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): string | null {
  if (buf.length > limits.maxCompressedBytes) return 'The spreadsheet is larger than 10 MB.';
  if (buf.length < 22) return 'The spreadsheet is not a valid .xlsx file.';
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return 'The spreadsheet is not a valid .xlsx file.';
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === ZIP64_MARK) return 'ZIP64 spreadsheets are not supported — re-save it as a normal .xlsx.';
  if (total > limits.maxEntries) return `The spreadsheet has too many parts (over ${limits.maxEntries.toLocaleString('en-US')}).`;

  let declared = 0;
  let inflated = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) return 'The spreadsheet is not a valid .xlsx file.';
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;
    if (compressed === ZIP64_MARK || uncompressed === ZIP64_MARK || localOffset === ZIP64_MARK) {
      return 'ZIP64 spreadsheets are not supported — re-save it as a normal .xlsx.';
    }
    if (method !== 0 && method !== 8) return 'The spreadsheet uses an unsupported compression method.';
    declared += uncompressed;
    if (declared > limits.maxUncompressedBytes) return 'The spreadsheet expands to more than 20 MB — split it or export a CSV.';
    if (uncompressed > limits.ratioFloorBytes && uncompressed > compressed * limits.maxRatio) {
      return 'The spreadsheet is compressed suspiciously well (over 100:1) — re-save it or export a CSV.';
    }

    // Measure the real output, capped — never trust the declared size.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) return 'The spreadsheet is not a valid .xlsx file.';
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressed > buf.length) return 'The spreadsheet is not a valid .xlsx file.';
    let size = compressed;
    if (method === 8) {
      const budget = limits.maxUncompressedBytes - inflated;
      if (budget <= 0) return 'The spreadsheet expands to more than 20 MB — split it or export a CSV.';
      try {
        size = inflateRawSync(buf.subarray(start, start + compressed), { maxOutputLength: budget }).length;
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string } | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
          return 'The spreadsheet expands to more than 20 MB — split it or export a CSV.';
        }
        return 'The spreadsheet is damaged and could not be read.';
      }
    }
    inflated += size;
    if (inflated > limits.maxUncompressedBytes) return 'The spreadsheet expands to more than 20 MB — split it or export a CSV.';
    if (size > limits.ratioFloorBytes && size > Math.max(compressed, 1) * limits.maxRatio) {
      return 'The spreadsheet is compressed suspiciously well (over 100:1) — re-save it or export a CSV.';
    }
  }
  return null;
}
