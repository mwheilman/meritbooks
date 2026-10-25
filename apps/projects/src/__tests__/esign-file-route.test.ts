import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const documentForToken = vi.fn();
const fetchSignerDocument = vi.fn();
vi.mock('@/lib/esign/public', () => ({ documentForToken: (t: string) => documentForToken(t) }));
vi.mock('@/lib/esign/file', () => ({ fetchSignerDocument: (p: string) => fetchSignerDocument(p) }));

import { GET } from '@/app/api/sign/public/[token]/file/route';
import { isSignerDocumentPath } from '../lib/esign/file-path';

const TOKEN = 'A'.repeat(43);
const call = (token = TOKEN) => GET(new Request(`https://x.test/api/sign/public/${token}/file`) as never, { params: { token } });

describe('GET /api/sign/public/<token>/file', () => {
  beforeEach(() => { documentForToken.mockReset(); fetchSignerDocument.mockReset(); });

  it('a valid token streams exactly its document, never cached', async () => {
    documentForToken.mockResolvedValue({ ok: true, path: 'a0000000-0000-4000-8000-000000000001/pm/docs/x-contract.pdf', fileName: 'contract.pdf', mimeType: 'application/pdf' });
    fetchSignerDocument.mockResolvedValue({ body: new Blob(['%PDF-1.7']).stream(), contentType: 'application/pdf', contentLength: '8' });
    const r = await call();
    expect(r.status).toBe(200);
    expect(fetchSignerDocument).toHaveBeenCalledWith('a0000000-0000-4000-8000-000000000001/pm/docs/x-contract.pdf');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(await r.text()).toBe('%PDF-1.7');
  });
  it.each(['revoked', 'used', 'expired', 'voided', 'declined', 'signed', 'waiting'])('%s link → 410, nothing fetched', async (reason) => {
    documentForToken.mockResolvedValue({ ok: false, reason });
    const r = await call();
    expect(r.status).toBe(410);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(fetchSignerDocument).not.toHaveBeenCalled();
  });
  it('malformed or unknown tokens → 404', async () => {
    expect((await call('short')).status).toBe(404);
    expect(documentForToken).not.toHaveBeenCalled();
    documentForToken.mockResolvedValue({ ok: false, reason: 'invalid' });
    expect((await call()).status).toBe(404);
  });
});

describe('the service role is used in exactly one place, for one object', () => {
  it('in documents / drawings / templates / e-sign, only lib/esign/file.ts touches the service role', () => {
    const src = join(__dirname, '..');
    const mine = /^(lib\/(documents|esign|templates)|components\/(documents|esign)|app\/api\/(documents|sign)|app\/sign|app\/\(app\)\/documents)\//;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []; });
    const users = walk(src).filter((f) => /createAdminSupabase|SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f)).filter((f) => mine.test(f)).sort();
    expect(users).toEqual(['lib/esign/file.ts']);
    const file = readFileSync(join(src, 'lib/esign/file.ts'), 'utf8');
    expect(file.match(/createAdminSupabase\(\)/g)).toHaveLength(1);
    expect(file).toMatch(/createSignedUrl\(path, 60\)/);
    expect(file).not.toMatch(/\.from\('(?!documents)|\.rpc\(|\.upload\(|\.remove\(|\.download\(/);
  });
  it('only <org>/pm/ document keys are ever streamed', () => {
    expect(isSignerDocumentPath('a0000000-0000-4000-8000-000000000001/pm/docs/1-x.pdf')).toBe(true);
    expect(isSignerDocumentPath('a0000000-0000-4000-8000-000000000001/bill/1-x.pdf')).toBe(false);
    expect(isSignerDocumentPath('a0000000-0000-4000-8000-000000000001/pm/docs/../../b/x.pdf')).toBe(false);
    expect(isSignerDocumentPath('other/pm/docs/x.pdf')).toBe(false);
  });
});
