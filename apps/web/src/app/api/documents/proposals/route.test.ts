/**
 * GET /api/documents/proposals — security review M / H4: the LIST is a summary projection
 * (no `payload`), the `?id=` detail carries the payload TIN-redacted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

let rows: Array<Record<string, unknown>> = [];
let selected: string[] = [];
function builder(table: string) {
  const q: Record<string, unknown> = {};
  q.select = (cols?: string) => {
    if (table === 'document_proposals') selected.push(cols ?? '*');
    return q;
  };
  for (const m of ['eq', 'in', 'neq', 'or', 'order', 'limit']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: table === 'document_proposals' ? rows[0] ?? null : { id: DOC, file_name: 'a.pdf' }, error: null });
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: table === 'document_proposals' ? rows : [{ id: DOC, file_name: 'a.pdf', mime_type: null, created_at: 'c' }], error: null }).then(res, rej);
  return q;
}
const supabase = { from: (t: string) => builder(t) };

vi.mock('@/lib/api-handler', () => ({
  apiQueryHandler: (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, handler: (q: unknown, ctx: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
      return handler(parsed.data, { userId: 'user_1', orgId: ORG, supabase });
    },
}));
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: async () => ({ ok: true, role: 'cfo', orgId: ORG }) }));
vi.mock('@/lib/db/scoped-writer', () => ({ assertWriteScope: async () => undefined, isWriteScopeError: () => false }));
vi.mock('@/lib/documents/intelligence/server', () => ({ intelDeps: () => ({ db: {}, anthropicApiKey: null, now: () => new Date(), loadBytes: async () => null }) }));
vi.mock('@/lib/documents/intelligence/service', () => ({ syncNative: async () => 0, IntelligenceError: class extends Error {} }));

const { GET } = await import('./route');

beforeEach(() => {
  selected = [];
  rows = [{ id: PID, document_id: DOC, target_kind: 'lease', mode: 'staged', status: 'pending', extract_state: 'done', payload: { lease: { lessor: 'Acme', lessor_tin: '12-3456789' } }, title: 't', summary: 'EIN 12-3456789', confidence: 0.8, created_at: 'c' }];
});

describe('GET /api/documents/proposals', () => {
  it('the list never selects or returns payload', async () => {
    const res = await GET(new Request('http://localhost/api/documents/proposals?target_kind=lease'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('payload');
    expect(body.data[0]).toMatchObject({ id: PID, summary: 'EIN *****6789', document: { id: DOC } });
    expect(selected.some((c) => c === '*' || c.includes('payload'))).toBe(false);
  });

  it('the detail returns the payload, redacted', async () => {
    const res = await GET(new Request(`http://localhost/api/documents/proposals?id=${PID}`));
    const body = (await res.json()) as { data: { payload: { lease: { lessor_tin: string } } } };
    expect(body.data.payload.lease.lessor_tin).toBe('**-***6789');
  });
});
