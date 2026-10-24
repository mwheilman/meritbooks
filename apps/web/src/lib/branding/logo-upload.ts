/**
 * Brand logo upload checks (FPB-branding §4.4, AC-8). Pure, so the route stays thin and
 * the rules are unit-tested: the file's BYTES decide its type (PNG / JPEG only — SVG,
 * WebP, GIF, HTML refused), size 1 byte – 2 MB, and the storage path is pinned to the
 * org's folder in a shape isTenantLogoUrl accepts.
 *
 * Request hardening (security review): the route reads the target (slot, company) from the
 * QUERY STRING, checks the permission, then refuses an oversized request from its
 * Content-Length header and a byte-capped stream read — all BEFORE the multipart body is
 * parsed. A replaced logo's object is deleted afterwards (service.ts) unless another row
 * still points at it.
 */

import { BRANDING_BUCKET, MAX_LOGO_BYTES, isTenantLogoUrl, logoExtension, sniffLogoType, type LogoImageType } from '@/lib/invoices/templates/logo-url';
import type { LogoSlot } from './types';

/** The whole multipart request may carry the 2 MB file plus framing / small fields. */
export const MAX_LOGO_REQUEST_BYTES = MAX_LOGO_BYTES + 64 * 1024;

export type LengthCheck = { ok: true; declared: number | null } | { ok: false; code: 'TOO_LARGE' | 'BAD_LENGTH'; status: 413 | 400; error: string };

/** Refuse from the Content-Length header alone (absent = chunked; the stream cap applies). */
export function checkDeclaredLength(header: string | null | undefined, cap = MAX_LOGO_REQUEST_BYTES): LengthCheck {
  if (header == null || header === '') return { ok: true, declared: null };
  if (!/^\d{1,15}$/.test(header.trim())) return { ok: false, code: 'BAD_LENGTH', status: 400, error: 'Invalid Content-Length.' };
  const n = Number(header.trim());
  if (n > cap) return { ok: false, code: 'TOO_LARGE', status: 413, error: 'The logo must be under 2 MB.' };
  return { ok: true, declared: n };
}

export type CappedRead = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; code: 'TOO_LARGE' };

/**
 * Read a request body, aborting as soon as it passes `cap` bytes (a lying or absent
 * Content-Length can't make the server buffer more than the cap).
 */
export async function readCappedBody(body: ReadableStream<Uint8Array> | null, cap = MAX_LOGO_REQUEST_BYTES): Promise<CappedRead> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, code: 'TOO_LARGE' };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes: out };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?location_id=` → a company id, null (tenant), or undefined when malformed. */
export function parseLogoLocation(raw: string | null | undefined): string | null | undefined {
  if (raw == null || raw === '') return null;
  return UUID_RE.test(raw) ? raw.toLowerCase() : undefined;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  );
}

export type LogoCheck =
  | { ok: true; kind: LogoImageType }
  | { ok: false; code: 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE'; error: string };

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg');
}

export function validateLogoBytes(bytes: Uint8Array): LogoCheck {
  if (bytes.byteLength === 0) return { ok: false, code: 'EMPTY', error: 'That file is empty.' };
  if (bytes.byteLength > MAX_LOGO_BYTES) return { ok: false, code: 'TOO_LARGE', error: 'The logo must be under 2 MB.' };
  const kind = sniffLogoType(bytes);
  if (!kind) {
    return {
      ok: false,
      code: 'UNSUPPORTED_TYPE',
      error: looksLikeSvg(bytes)
        ? 'SVG logos aren’t supported yet (invoices print as PDF). Export a PNG at least 600 px wide.'
        : isWebp(bytes)
          ? 'WebP logos aren’t supported yet (invoices print as PDF). Export a PNG or JPG.'
          : 'Use a PNG or JPG image.',
    };
  }
  return { ok: true, kind };
}

const SLOT_STEM: Record<LogoSlot, string> = { logo: 'logo', logo_dark: 'dark', mark: 'mark' };

/** `${orgId}/brand-<org|locationId>-<slot>-<ts>.<ext>` — one flat file in the org folder. */
export function brandLogoPath(orgId: string, locationId: string | null, slot: LogoSlot, kind: LogoImageType, ts: number): string {
  return `${orgId}/brand-${locationId ?? 'org'}-${SLOT_STEM[slot]}-${ts}.${logoExtension(kind)}`;
}

// ── replaced-logo cleanup ──────────────────────────────────────────────────────

const PUBLIC_PREFIX = `/storage/v1/object/public/${BRANDING_BUCKET}/`;

/**
 * The storage object path behind one of THIS org's brand-logo URLs
 * (`${orgId}/brand-….png|jpg`), or null — anything not uploaded by the brand route (an
 * invoice-branding logo, another org's file, a foreign URL) is never a deletion candidate.
 */
export function brandLogoObjectPath(url: string | null | undefined, orgId: string, supabaseUrl?: string | null): string | null {
  if (!url || !isTenantLogoUrl(url, orgId, supabaseUrl === undefined ? process.env.NEXT_PUBLIC_SUPABASE_URL : supabaseUrl)) return null;
  const path = new URL(url).pathname.slice(PUBLIC_PREFIX.length);
  return path.startsWith(`${orgId}/brand-`) ? path : null;
}

/**
 * Object paths safe to delete after a save / reset: URLs the row held before and no longer
 * holds, that are brand uploads of this org, and that NO row (any brand profile, invoice
 * template or check stock in the org — including this row's other slots) still references.
 */
export function orphanedLogoPaths(
  before: ReadonlyArray<string | null | undefined>,
  after: ReadonlyArray<string | null | undefined>,
  stillReferenced: ReadonlyArray<string | null | undefined>,
  orgId: string,
  supabaseUrl?: string | null,
): string[] {
  // Compare by object path, not URL text, so a differently-written URL to the same file
  // still counts as a reference.
  const keep = new Set<string>();
  for (const u of [...after, ...stillReferenced]) {
    if (!u) continue;
    keep.add(u);
    try {
      const path = decodeURIComponent(new URL(u).pathname);
      const i = path.indexOf(PUBLIC_PREFIX);
      if (i >= 0) keep.add(path.slice(i + PUBLIC_PREFIX.length));
    } catch {
      /* not a URL — kept by its text */
    }
  }
  const out = new Set<string>();
  for (const u of before) {
    if (!u || keep.has(u)) continue;
    const p = brandLogoObjectPath(u, orgId, supabaseUrl);
    if (p && !keep.has(p)) out.add(p);
  }
  return [...out];
}
