/**
 * GET /api/documents/intelligence — security review H4 / M: the list never carries a
 * proposal's payload, TIN-shaped strings are redacted, internal columns are dropped, and
 * `duplicate_of` survives only when the twin document is visible to the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const TWIN = '33333333-3333-4333-8333-333333333333';

let tables: Record<string, unknown[]> = {};
/** A chainable, awaitable PostgREST-ish fake: every filter returns itself; awaiting yields the table's rows. */
function builder(table: string) {
  const result = () => ({ data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length });
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'neq', 'not', 'or', 'order', 'limit', 'is']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
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
  tables = {
    document_intelligence: [
      { id: 'i1', document_id: DOC, doc_class: 'w9', confidence: '0.9', class_source: 'rules', status: 'duplicate', ai_status: 'skipped', ai_attempts: 0, counterparty: 'Bolt 12-3456789', key_dates: {}, summary: 'SSN 123-45-6789', reason: null, duplicate_of: TWIN, source: 'center', updated_at: 'u', ai_last_error: 'x', content_sha256: 'a'.repeat(64), company_hint: 'h' },
    ],
    document_proposals: [
      { id: 'p1', document_id: DOC, target_kind: 'lease', mode: 'staged', status: 'pending', extract_state: 'done', payload: { lease: { lessor: 'Acme' } }, title: 'Lease 12-3456789', summary: null, confidence: 0.9, created_at: 'c', decided_by: 'u', content_sha256: 'b'.repeat(64) },
    ],
    document_links: [],
    documents: [], // the twin is NOT visible to this caller
  };
});

describe('GET /api/documents/intelligence', () => {
  it('no payload, redacted, internal columns dropped, foreign duplicate hidden', async () => {
    const res = await GET(new Request(`http://localhost/api/documents/intelligence?document_ids=${DOC}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ summary: 'SSN *****6789', counterparty: 'Bolt **-***6789', duplicate_of: null, confidence: 0.9 });
    for (const k of ['ai_last_error', 'content_sha256', 'company_hint']) expect(body.data[0]).not.toHaveProperty(k);
    expect(body.proposals[0]).not.toHaveProperty('payload');
    expect(body.proposals[0]).not.toHaveProperty('decided_by');
    expect(body.proposals[0].title).toBe('Lease **-***6789');
  });

  it('keeps duplicate_of when the twin is visible', async () => {
    tables.documents = [{ id: TWIN }];
    const body = (await (await GET(new Request(`http://localhost/api/documents/intelligence?document_ids=${DOC}`))).json()) as { data: Array<{ duplicate_of: string | null }> };
    expect(body.data[0].duplicate_of).toBe(TWIN);
  });
});
