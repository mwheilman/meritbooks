/**
 * What the deterministic classifier can read from a file without AI: the PDF text layer,
 * spreadsheet header cells (Smart Intake's sniffer), or plain text. Server-only (Buffer).
 */

import { createHash } from 'node:crypto';
import { sniffSheet } from '@/lib/onboarding/intake/sheet';
import { extractPdfText, isPdf, readability } from './pdf-text';

export interface TextSample {
  /** Up to ~6000 chars of readable text ('' when none). */
  text: string;
  /** Spreadsheet cells from the first rows (empty for non-sheets). */
  cells: string[];
  /** For sheets: first rows as CSV for the AI. */
  sheetSample: string | null;
  kind: 'pdf' | 'image' | 'sheet' | 'text' | 'other';
}

const SHEET_MIME = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/tab-separated-values',
]);

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Lower-case hex SHA-256 of the bytes (the dedupe key). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The media type we trust for the bytes: magic first, then the stored mime, then the extension. */
export function effectiveMediaType(bytes: Uint8Array, mime: string | null, fileName: string): string {
  if (isPdf(bytes)) return 'application/pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return 'image/webp';
  const e = ext(fileName);
  if (e === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (e === 'csv') return 'text/csv';
  if (e === 'tsv') return 'text/tab-separated-values';
  if (e === 'txt') return 'text/plain';
  return mime || 'application/octet-stream';
}

export function readTextSample(bytes: Uint8Array, mediaType: string, fileName: string): TextSample {
  try {
    if (mediaType === 'application/pdf') {
      const t = extractPdfText(bytes);
      return { text: readability(t) >= 0.6 ? t : '', cells: [], sheetSample: null, kind: 'pdf' };
    }
    if (mediaType.startsWith('image/')) return { text: '', cells: [], sheetSample: null, kind: 'image' };
    if (SHEET_MIME.has(mediaType) || ['csv', 'tsv', 'xlsx'].includes(ext(fileName))) {
      const sn = sniffSheet(Buffer.from(bytes), mediaType, fileName);
      return { text: sn.cells.join(' ').slice(0, 6000), cells: sn.cells, sheetSample: sn.textSample, kind: 'sheet' };
    }
    if (mediaType.startsWith('text/')) {
      const t = Buffer.from(bytes).toString('utf8').slice(0, 6000);
      return { text: readability(t) >= 0.6 ? t : '', cells: [], sheetSample: null, kind: 'text' };
    }
  } catch {
    // unreadable → nothing; the name rules and the AI still run
  }
  return { text: '', cells: [], sheetSample: null, kind: 'other' };
}

/**
 * Everything readable for the taxpayer-ID screen (security review H4): a deeper PDF pass
 * than the classifier's sample (more streams, no readability filter — a garbled text
 * layer that still says "Request for Taxpayer Identification Number" must be caught),
 * else the sample's text + sheet rows. '' for a photo / scan.
 */
export function readScreenText(bytes: Uint8Array, mediaType: string, sample: TextSample): string {
  try {
    if (mediaType === 'application/pdf') {
      const deep = extractPdfText(bytes, { maxChars: 60_000, maxStreams: 400, maxInflatedBytes: 12 * 1024 * 1024 });
      return `${deep}\n${sample.text}`;
    }
  } catch {
    // fall through to the sample
  }
  return [sample.text, sample.sheetSample ?? ''].filter(Boolean).join('\n');
}
