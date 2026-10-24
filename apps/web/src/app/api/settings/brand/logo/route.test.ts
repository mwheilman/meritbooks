/**
 * POST /api/settings/brand/logo — security review: the permission (on the query-string
 * company) and the request size are checked BEFORE the multipart body is read / parsed;
 * the form can't name a second, unchecked company; bytes decide the type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const LOC = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000b';

vi.mock('@/lib/api-handler', () => ({ requireAuthedContext: async () => ({ orgId: ORG, userId: 'user_1', supabase: {} }) }));
const requirePermission = vi.fn();
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/db/scoped-writer', () => ({ assertWriteScope: async () => undefined, isWriteScopeError: () => false }));
const upload = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...(a as [])), getPublicUrl: (p: string) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/branding/${p}` } }) }) },
  }),
}));

const { POST } = await import('./route');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function multipart(fields: Record<string, string | Blob>): Promise<{ bytes: Uint8Array; type: string }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = new Response(fd);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '' };
}

/** A request whose body records whether anyone read it. */
function tracked(qs: string, bytes: Uint8Array, type: string, headers: Record<string, string> = {}): { req: Request; read: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled = true;
      c.enqueue(bytes);
      c.close();
    },
  }, { highWaterMark: 0 }); // no eager pull: `pulled` means someone actually read the body
  const init = { method: 'POST', body, headers: { 'content-type': type, ...headers }, duplex: 'half' } as RequestInit;
  return { req: new Request(`http://localhost/api/settings/brand/logo${qs}`, init), read: () => pulled };
}

beforeEach(() => {
  requirePermission.mockReset();
  requirePermission.mockResolvedValue({ ok: true, role: 'cfo', orgId: ORG });
  upload.mockClear();
});

describe('POST /api/settings/brand/logo', () => {
  it('checks settings_system:edit on the QUERY company before reading the body; denial reads nothing', async () => {
    requirePermission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const m = await multipart({ file: new Blob([PNG], { type: 'image/png' }) });
    const t = tracked(`?slot=logo&location_id=${LOC}`, m.bytes, m.type);
    const res = await POST(t.req);
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('user_1', 'settings_system', 'edit', { locationId: LOC });
    expect(t.read()).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses an oversized Content-Length with 413 without reading the body', async () => {
    const m = await multipart({ file: new Blob([PNG], { type: 'image/png' }) });
    const t = tracked('?slot=logo', m.bytes, m.type, { 'content-length': String(3 * 1024 * 1024) });
    const res = await POST(t.req);
    expect(res.status).toBe(413);
    expect(t.read()).toBe(false);
  });

  it('refuses a body that streams past the cap (no / lying Content-Length) with 413', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 128 * 1024);
    big.set(PNG);
    const m = await multipart({ file: new Blob([big], { type: 'image/png' }) });
    const res = await POST(tracked('?slot=logo', m.bytes, m.type).req);
    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  it('a form location_id that differs from the checked query company is refused', async () => {
    const m = await multipart({ file: new Blob([PNG], { type: 'image/png' }), location_id: OTHER });
    const res = await POST(tracked(`?slot=logo&location_id=${LOC}`, m.bytes, m.type).req);
    expect(res.status).toBe(422);
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses non-multipart and non-image bytes', async () => {
    const json = await POST(tracked('?slot=logo', new TextEncoder().encode('{}'), 'application/json').req);
    expect(json.status).toBe(415);
    const m = await multipart({ file: new Blob(['<svg onload="x()"/>'], { type: 'image/png' }) });
    const svg = await POST(tracked('?slot=logo', m.bytes, m.type).req);
    expect(svg.status).toBe(422);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads a PNG to the org-pinned brand path', async () => {
    const m = await multipart({ file: new Blob([PNG], { type: 'image/png' }) });
    const res = await POST(tracked(`?slot=mark&location_id=${LOC}`, m.bytes, m.type).req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; slot: string };
    expect(body.slot).toBe('mark');
    expect(body.url).toMatch(new RegExp(`/branding/${ORG}/brand-${LOC}-mark-\\d+\\.png$`));
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
