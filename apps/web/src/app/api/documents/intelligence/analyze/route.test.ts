/**
 * POST /api/documents/intelligence/analyze — security review M:
 *   - `{ all: true }` (org-wide backfill) only for a caller with all-clients scope;
 *   - module drafts are authorized per target module + the document's company scope
 *     (the route hands the service a draftAuthorizer that fails closed);
 *   - the response never reveals a `duplicate_of` the caller can't see, nor a payload.
 * Collaborators are faked; the route's own decisions are under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const TWIN = '33333333-3333-4333-8333-333333333333';
const LOC = '44444444-4444-4444-8444-444444444444';

let visibleDoc: { id: string } | null = { id: DOC };
let visibleTwins: Array<{ id: string }> = [];
const supabase = {
  from: (table: string) => {
    expect(table).toBe('documents');
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: visibleDoc, error: null }),
      in: async () => ({ data: visibleTwins, error: null }),
    };
    return q;
  },
};

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, handler: (b: unknown, ctx: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const parsed = schema.safeParse(await req.json());
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
      return handler(parsed.data, { userId: 'user_1', orgId: ORG, supabase });
    },
}));

const requirePermission = vi.fn();
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
const assertWriteScope = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/db/scoped-writer', () => ({ assertWriteScope: (...a: unknown[]) => assertWriteScope(...a), isWriteScopeError: () => false }));
let scope: { mode: string; membershipId: string | null; allClients: boolean; locationIds: Set<string> } = { mode: 'enforce', membershipId: 'm', allClients: false, locationIds: new Set<string>([LOC]) };
vi.mock('@/lib/rbac/client-scope', () => ({ loadClientScope: async () => scope }));
vi.mock('@/lib/ai/gateway', () => ({ aiUnavailablePayload: (m: string) => ({ message: m }) }));
vi.mock('@/lib/documents/intelligence/server', () => ({ intelDeps: () => ({ db: {}, anthropicApiKey: 'sk', now: () => new Date(), loadBytes: async () => null }) }));

type Authorizer = (kind: string, locationId: string | null) => Promise<boolean>;
let lastCanDraft: Authorizer | null = null;
const intelRow = {
  id: 'i1', document_id: DOC, location_id: LOC, location_source: 'rules', doc_class: 'lease', confidence: 0.9, class_source: 'rules', status: 'duplicate', ai_status: 'done', ai_attempts: 0,
  next_retry_at: null, counterparty: 'Acme 12-3456789', key_dates: {}, amount_cents: null, summary: null, reason: 'Same file', duplicate_of: TWIN, source: 'center', classified_at: null, updated_at: 'u',
  content_sha256: 'a'.repeat(64), ai_last_error: 'secret detail',
};
const analyzeDocument = vi.fn(async (_d: unknown, input: { canDraft?: Authorizer }) => {
  lastCanDraft = input.canDraft ?? null;
  return { intelligence: intelRow, proposals: [{ id: 'p1', document_id: DOC, target_kind: 'lease', mode: 'staged', status: 'pending', extract_state: 'done', payload: { lease: { lessor: 'x' } }, title: 't', summary: null, confidence: 0.9, created_at: 'c' }], message: 'ok' };
});
const backfillOrg = vi.fn(async (_d: unknown, input: { canDraft?: Authorizer }) => {
  lastCanDraft = input.canDraft ?? null;
  return { analyzed: 1, proposals: 0, needsReview: 0, duplicates: 0, linksCreated: 0, remaining: 0, errors: ['doc-x: internal detail'] };
});
vi.mock('@/lib/documents/intelligence/service', () => ({
  analyzeDocument: (...a: unknown[]) => analyzeDocument(...(a as [unknown, { canDraft?: Authorizer }])),
  backfillOrg: (...a: unknown[]) => backfillOrg(...(a as [unknown, { canDraft?: Authorizer }])),
  IntelligenceError: class extends Error { status = 400; code = 'X'; },
}));

const { POST } = await import('./route');
const call = (body: unknown) => POST(new Request('http://localhost/api/documents/intelligence/analyze', { method: 'POST', body: JSON.stringify(body) }));
const ok = { ok: true, role: 'bookkeeper', orgId: ORG };
const denied = () => ({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });

beforeEach(() => {
  visibleDoc = { id: DOC };
  visibleTwins = [];
  scope = { mode: 'enforce', membershipId: 'm', allClients: false, locationIds: new Set<string>([LOC]) };
  lastCanDraft = null;
  requirePermission.mockReset();
  requirePermission.mockResolvedValue(ok);
  assertWriteScope.mockReset();
  assertWriteScope.mockResolvedValue(undefined);
  analyzeDocument.mockClear();
  backfillOrg.mockClear();
});

describe('POST /api/documents/intelligence/analyze', () => {
  it('{ all: true } is refused for a caller without all-clients scope', async () => {
    const res = await call({ all: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ALL_CLIENTS_REQUIRED');
    expect(backfillOrg).not.toHaveBeenCalled();
  });

  it('{ all: true } runs for an all-clients caller (or with scope off), with a draft authorizer, and never echoes error detail', async () => {
    scope = { ...scope, allClients: true };
    const res = await call({ all: true, limit: 5 });
    expect(res.status).toBe(200);
    expect(backfillOrg).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: ORG, limit: 5, canDraft: expect.any(Function) }));
    expect(((await res.json()) as { result: { errors: unknown } }).result.errors).toBe(1);
    scope = { mode: 'off', membershipId: null, allClients: false, locationIds: new Set() };
    expect((await call({ all: true })).status).toBe(200);
  });

  it('one document: the draft authorizer needs the target module gate AND the company in scope (fails closed)', async () => {
    const res = await call({ document_id: DOC });
    expect(res.status).toBe(200);
    const canDraft = lastCanDraft as Authorizer;
    expect(canDraft).toBeTypeOf('function');

    requirePermission.mockResolvedValueOnce(denied());
    expect(await canDraft('bill', LOC)).toBe(false);
    expect(requirePermission).toHaveBeenLastCalledWith('user_1', 'bills', 'create', expect.anything());

    requirePermission.mockResolvedValue(ok);
    assertWriteScope.mockRejectedValueOnce(new Error('You do not have access to that company.'));
    expect(await canDraft('lease', '55555555-5555-4555-8555-555555555555')).toBe(false);
    expect(requirePermission).toHaveBeenLastCalledWith('user_1', 'journal_entries', 'create', expect.anything());

    expect(await canDraft('vendor_w9', LOC)).toBe(true);
    expect(requirePermission).toHaveBeenLastCalledWith('user_1', 'vendors', 'edit', expect.anything());
    expect(assertWriteScope).toHaveBeenLastCalledWith(supabase, ORG, [LOC]);
  });

  it('hides a duplicate_of the caller cannot see, strips internal columns and proposal payloads, redacts TINs', async () => {
    const res = await call({ document_id: DOC });
    const body = (await res.json()) as { intelligence: Record<string, unknown>; proposals: Array<Record<string, unknown>> };
    expect(body.intelligence.duplicate_of).toBeNull();
    expect(body.intelligence.counterparty).toBe('Acme **-***6789');
    expect(body.intelligence).not.toHaveProperty('ai_last_error');
    expect(body.intelligence).not.toHaveProperty('content_sha256');
    expect(body.proposals[0]).not.toHaveProperty('payload');

    visibleTwins = [{ id: TWIN }];
    const again = (await (await call({ document_id: DOC })).json()) as { intelligence: { duplicate_of: string | null } };
    expect(again.intelligence.duplicate_of).toBe(TWIN);
  });

  it('404 when the document is not visible to the caller', async () => {
    visibleDoc = null;
    expect((await call({ document_id: DOC })).status).toBe(404);
    expect(analyzeDocument).not.toHaveBeenCalled();
  });
});
