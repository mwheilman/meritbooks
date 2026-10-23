/**
 * Pure helpers shared by every inbound provider adapter: address parsing, base64
 * cleanup, sha256, header lookup. No I/O, no provider knowledge.
 */

import { createHash } from 'node:crypto';
import type { InboundAddress, InboundEmailAttachment } from './inbound-types';

/** Lowercase + trim; strips a "Display Name <addr>" wrapper. '' for garbage. */
export function normalizeAddress(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const angle = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const addr = (angle ? angle[1] : s).trim().replace(/^mailto:/i, '').toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(addr) ? addr : '';
}

/** Parse one "Name <a@b>" / "a@b" token. */
export function parseAddress(raw: string, name?: string | null): InboundAddress | null {
  const address = normalizeAddress(raw);
  if (!address) return null;
  let display = name ?? null;
  if (display === null) {
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*</);
    display = m && m[1].trim() ? m[1].trim() : null;
  }
  return { address, name: display && display.trim() ? display.trim() : null };
}

/**
 * Split an RFC 5322 address list ("A <a@x>, "B, Jr" <b@x>, c@x") into addresses.
 * Commas inside quotes or angle brackets do not split.
 */
export function parseAddressList(raw: string | null | undefined): InboundAddress[] {
  if (!raw) return [];
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle++;
    else if (ch === '>' && !quoted && angle > 0) angle--;
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const out: InboundAddress[] = [];
  for (const p of parts) {
    const a = parseAddress(p);
    if (a) out.push(a);
  }
  return out;
}

/** The domain of an address ('' when none). */
export function domainOf(address: string): string {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

/** The local part of an address ('' when none). */
export function localPartOf(address: string): string {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf('@');
  return at > 0 ? a.slice(0, at) : '';
}

/** Unique, normalized, non-empty addresses in first-seen order. */
export function uniqueAddresses(list: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = normalizeAddress(raw ?? '');
    if (a && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** Strip whitespace / a data: prefix from base64; null when not valid base64. */
export function cleanBase64(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const comma = s.startsWith('data:') ? s.indexOf(',') : -1;
  if (comma >= 0) s = s.slice(comma + 1);
  s = s.replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  return s.replace(/-/g, '+').replace(/_/g, '/');
}

/** Lowercase hex sha256. */
export function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lowercase MIME type without parameters. */
export function normalizeContentType(raw: string | null | undefined): string {
  const s = (raw ?? '').split(';')[0].trim().toLowerCase();
  return s || 'application/octet-stream';
}

/** Correct a vague declared type from the file extension (Outlook sends PDFs as octet-stream). */
export function sniffContentType(declared: string, fileName: string, bytes: Uint8Array): string {
  const ct = normalizeContentType(declared);
  if (ct !== 'application/octet-stream' && ct !== 'binary/octet-stream' && ct !== 'application/x-download') return ct;
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const byExt: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic' };
  return byExt[ext] ?? ct;
}

/** Build a normalized attachment from bytes. */
export function makeAttachment(args: {
  fileName: string | null | undefined;
  contentType: string | null | undefined;
  bytes: Uint8Array;
  contentId?: string | null;
  inline?: boolean;
}): InboundEmailAttachment {
  const fileName = (args.fileName ?? '').trim().slice(0, 200) || 'attachment';
  const buf = Buffer.from(args.bytes);
  const contentId = args.contentId ? args.contentId.replace(/^<|>$/g, '').trim() || null : null;
  return {
    fileName,
    contentType: sniffContentType(args.contentType ?? '', fileName, buf),
    base64: buf.toString('base64'),
    sizeBytes: buf.length,
    sha256: sha256Hex(buf),
    contentId,
    inline: Boolean(args.inline ?? contentId),
  };
}

/** Parse a raw RFC 822 header block ("Name: value\r\n  folded") into lowercase-keyed values. */
export function parseHeaderBlock(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const unfolded = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (!key || key in out) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

/** EVERY value of one header in a raw block, top first (e.g. all Authentication-Results). */
export function headerValues(raw: string | null | undefined, name: string): string[] {
  if (!raw) return [];
  const want = name.toLowerCase();
  const unfolded = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  const out: string[] = [];
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === want) out.push(line.slice(idx + 1).trim());
  }
  return out;
}

/** ISO time from an RFC 2822 date, falling back to `fallback`. */
export function toIsoDate(raw: string | null | undefined, fallback: Date): string {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallback.toISOString();
}

/** Spam verdict from SpamAssassin-style headers (Postmark adds X-Spam-Status / X-Spam-Score). */
export function spamFromHeaders(headers: Record<string, string>, scoreOverride?: string | null): { score: number | null; flagged: boolean } | null {
  const status = headers['x-spam-status'];
  const rawScore = scoreOverride ?? headers['x-spam-score'] ?? null;
  const score = rawScore !== null && rawScore !== undefined && rawScore !== '' && Number.isFinite(Number(rawScore)) ? Number(rawScore) : null;
  if (status === undefined && score === null) return null;
  const flagged = typeof status === 'string' ? /^\s*yes\b/i.test(status) : false;
  return { score, flagged };
}

/** First non-empty trimmed string. */
export function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * A stable synthetic id when a provider gives none: sha256 over sender, subject,
 * date and the attachment hashes. Identical redeliveries collide (good); two genuinely
 * different emails don't.
 */
export function syntheticMessageId(parts: {
  from: string;
  subject: string | null;
  date: string | null;
  attachmentHashes: string[];
  textBody: string | null;
}): string {
  const basis = [parts.from, parts.subject ?? '', parts.date ?? '', parts.attachmentHashes.join(','), (parts.textBody ?? '').slice(0, 2000)].join('\n');
  return `synthetic:${sha256Hex(basis)}`;
}
