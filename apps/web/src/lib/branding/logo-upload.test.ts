/**
 * Brand logo upload hardening (security review): size refused from Content-Length and from
 * a byte-capped stream read before the multipart parse; type by magic bytes (WebP / SVG
 * refused); a replaced logo's object deleted only when nothing in the org references it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_LOGO_BYTES } from '@/lib/invoices/templates/logo-url';
import {
  MAX_LOGO_REQUEST_BYTES,
  brandLogoObjectPath,
  checkDeclaredLength,
  orphanedLogoPaths,
  parseLogoLocation,
  readCappedBody,
  validateLogoBytes,
} from './logo-upload';
import { deleteReplacedLogos } from './service';

const SB = 'https://proj.supabase.co';
const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const url = (org: string, file: string) => `${SB}/storage/v1/object/public/branding/${org}/${file}`;

function stream(chunks: number[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++]));
      else c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('request size before parsing', () => {
  it('checkDeclaredLength refuses an oversized / malformed Content-Length', () => {
    expect(checkDeclaredLength(null)).toEqual({ ok: true, declared: null });
    expect(checkDeclaredLength(String(MAX_LOGO_REQUEST_BYTES))).toEqual({ ok: true, declared: MAX_LOGO_REQUEST_BYTES });
    expect(checkDeclaredLength(String(MAX_LOGO_REQUEST_BYTES + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE', status: 413 });
    expect(checkDeclaredLength('-5')).toMatchObject({ ok: false, code: 'BAD_LENGTH' });
    expect(checkDeclaredLength('12abc')).toMatchObject({ ok: false, code: 'BAD_LENGTH' });
  });

  it('readCappedBody stops reading (and cancels) once past the cap — a lying header cannot bypass it', async () => {
    let cancelled = false;
    const r = await readCappedBody(stream([600, 600, 600, 600], () => (cancelled = true)), 1000);
    expect(r).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(cancelled).toBe(true);
    const ok = await readCappedBody(stream([400, 600]), 1000);
    expect(ok.ok && ok.bytes.byteLength).toBe(1000);
    expect(await readCappedBody(null)).toMatchObject({ ok: true });
  });

  it('parseLogoLocation: uuid, tenant (null) or malformed (undefined)', () => {
    expect(parseLogoLocation(null)).toBeNull();
    expect(parseLogoLocation('')).toBeNull();
    expect(parseLogoLocation(ORG.toUpperCase())).toBe(ORG);
    expect(parseLogoLocation('../../etc')).toBeUndefined();
  });
});

describe('type by magic bytes', () => {
  it('PNG / JPEG pass; WebP, SVG, HTML, oversized refused', () => {
    expect(validateLogoBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({ ok: true, kind: 'png' });
    expect(validateLogoBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, kind: 'jpeg' });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0]);
    expect(validateLogoBytes(webp)).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE', error: expect.stringMatching(/WebP/) });
    expect(validateLogoBytes(new TextEncoder().encode('<svg onload="x()"/>'))).toMatchObject({ ok: false, error: expect.stringMatching(/SVG/) });
    expect(validateLogoBytes(new TextEncoder().encode('<html>'))).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
    expect(validateLogoBytes(new Uint8Array(MAX_LOGO_BYTES + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });
});

describe('replaced-logo cleanup', () => {
  it('brandLogoObjectPath: only this org\'s brand uploads', () => {
    expect(brandLogoObjectPath(url(ORG, 'brand-org-logo-1.png'), ORG, SB)).toBe(`${ORG}/brand-org-logo-1.png`);
    expect(brandLogoObjectPath(url(ORG, 'invoice-logo-1.png'), ORG, SB)).toBeNull(); // invoice-branding upload
    expect(brandLogoObjectPath(url(OTHER, 'brand-org-logo-1.png'), ORG, SB)).toBeNull();
    expect(brandLogoObjectPath('https://evil.example/branding/x.png', ORG, SB)).toBeNull();
  });

  it('orphanedLogoPaths keeps anything still referenced (same row other slot, other rows)', () => {
    const a = url(ORG, 'brand-org-logo-1.png');
    const b = url(ORG, 'brand-org-dark-1.png');
    const c = url(ORG, 'brand-org-mark-1.png');
    const next = url(ORG, 'brand-org-logo-2.png');
    expect(orphanedLogoPaths([a, b, c], [next, b, c], [], ORG, SB)).toEqual([`${ORG}/brand-org-logo-1.png`]);
    expect(orphanedLogoPaths([a], [next], [a], ORG, SB)).toEqual([]); // another brand row / template uses it
    expect(orphanedLogoPaths([a], [next, a], [], ORG, SB)).toEqual([]); // moved to another slot
    expect(orphanedLogoPaths([null, a], [next], [`${a}`], ORG, SB)).toEqual([]);
  });

  describe('deleteReplacedLogos (service)', () => {
    afterEach(() => vi.unstubAllEnvs());
    const fake = (refs: Record<string, Array<Record<string, string | null>>>, opts: { refError?: boolean } = {}) => {
      const removed: string[][] = [];
      const w = {
        from: (t: string) => {
          const q = { select: () => q, eq: () => Promise.resolve(opts.refError && t === 'invoice_templates' ? { data: null, error: { message: 'boom' } } : { data: refs[t] ?? [], error: null }) };
          return q;
        },
        storage: { from: () => ({ remove: async (p: string[]) => { removed.push(p); return { data: [], error: null }; } }) },
      } as unknown as SupabaseClient;
      return { w, removed };
    };

    it('deletes the replaced object, but not one another brand profile / template still uses', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SB);
      const old = url(ORG, 'brand-org-logo-1.png');
      const shared = url(ORG, 'brand-org-dark-1.png');
      const { w, removed } = fake({
        brand_profiles: [{ logo_url: url(ORG, 'brand-org-logo-2.png'), logo_dark_url: null, mark_url: null }, { logo_url: null, logo_dark_url: null, mark_url: shared }],
        invoice_templates: [{ logo_url: null }],
      });
      const out = await deleteReplacedLogos(w, ORG, [old, shared], [url(ORG, 'brand-org-logo-2.png')]);
      expect(out).toEqual([`${ORG}/brand-org-logo-1.png`]);
      expect(removed).toEqual([[`${ORG}/brand-org-logo-1.png`]]);
    });

    it('a failed reference read deletes nothing (fail safe, never throws)', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SB);
      const { w, removed } = fake({}, { refError: true });
      expect(await deleteReplacedLogos(w, ORG, [url(ORG, 'brand-org-logo-1.png')], [])).toEqual([]);
      expect(removed).toEqual([]);
    });
  });
});
