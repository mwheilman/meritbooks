/**
 * /api/close/flux/explanations — security review (MEDIUM / LOW):
 *   • PATCH loads the explanation server-side FIRST and checks close_mgmt:manage against
 *     ITS company (never a client-sent location); a denial writes nothing;
 *   • PATCH forwards the hash of the text the reviewer saw (the service pins / refuses);
 *   • POST never forwards client-sent drafted_by_ai / ai_citations (server-side only).
 * Collaborators are faked; the route's own decisions are under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const ROW_LOC = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_LOC = 'bbbbbbbb-0000-4000-8000-00000000000b';
const EID = 'eeeeeeee-0000-4000-8000-00000000000e';
const HASH = 'a'.repeat(64);

const supabase = {};
vi.mock('@/lib/api-handler', () => ({
  apiHandler: (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, handler: (b: unknown, ctx: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const parsed = schema.safeParse(await req.json());
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
      return handler(parsed.data, { userId: 'user_rev', orgId: ORG, supabase });
    },
}));

const requirePermission = vi.fn();
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/trust/actor', () => ({ resolveActor: async () => ({ coreUserId: null }) }));
vi.mock('@/lib/trust/action-log', () => ({ logHumanAction: async () => undefined }));
vi.mock('@/lib/close/flux/route-support', () => ({
  fluxErrorResponse: (e: unknown) => {
    const x = e as { status?: number; code?: string; message?: string };
    return NextResponse.json({ error: x.message, code: x.code }, { status: x.status ?? 500 });
  },
  noOrg: () => NextResponse.json({ error: 'No organization' }, { status: 400 }),
}));

const explanation = { id: EID, locationId: ROW_LOC, periodKey: '2026-10', lineKey: 'acct-1', preparedBy: 'user_prep', category: 'TIMING', changeCents: 1, draftedByAi: false, carriedFromId: null };
const loadExplanation = vi.fn(async () => explanation);
const reviewExplanation = vi.fn(async () => ({ ...explanation, status: 'REVIEWED' }));
const saveExplanation = vi.fn(async () => ({ ...explanation, status: 'EXPLAINED' }));
vi.mock('@/lib/close/flux/service', () => ({
  loadExplanation: (...a: unknown[]) => loadExplanation(...(a as [])),
  reviewExplanation: (...a: unknown[]) => reviewExplanation(...(a as [])),
  saveExplanation: (...a: unknown[]) => saveExplanation(...(a as [])),
}));
vi.mock('@/lib/close/flux/types', () => ({ EXPLANATION_CATEGORIES: ['TIMING', 'ONE_TIME', 'VOLUME', 'PRICE', 'RECLASS', 'ERROR_CORRECTED', 'EXPECTED'] }));

const { POST, PATCH } = await import('./route');
const req = (method: string, body: unknown) => new Request('http://localhost/api/close/flux/explanations', { method, body: JSON.stringify(body) });

beforeEach(() => {
  requirePermission.mockReset();
  requirePermission.mockResolvedValue({ ok: true, role: 'controller', orgId: ORG });
  loadExplanation.mockClear();
  reviewExplanation.mockClear();
  saveExplanation.mockClear();
});

describe('PATCH (review)', () => {
  it("checks close_mgmt:manage against the explanation's OWN company, loaded server-side", async () => {
    const res = await PATCH(req('PATCH', { explanation_id: EID, action: 'approve', explanation_hash: HASH, location_id: OTHER_LOC }));
    expect(res.status).toBe(200);
    expect(loadExplanation).toHaveBeenCalledWith(supabase, ORG, EID);
    expect(requirePermission).toHaveBeenCalledWith('user_rev', 'close_mgmt', 'manage', { locationId: ROW_LOC });
    expect(requirePermission).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { locationId: OTHER_LOC });
  });

  it('a denial for that company writes nothing', async () => {
    requirePermission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const res = await PATCH(req('PATCH', { explanation_id: EID, action: 'approve', explanation_hash: HASH }));
    expect(res.status).toBe(403);
    expect(reviewExplanation).not.toHaveBeenCalled();
  });

  it('an explanation outside the caller\'s RLS view is a 404 before any permission check', async () => {
    loadExplanation.mockRejectedValueOnce(Object.assign(new Error('Explanation not found.'), { status: 404, code: 'NOT_FOUND' }));
    const res = await PATCH(req('PATCH', { explanation_id: EID, action: 'approve', explanation_hash: HASH }));
    expect(res.status).toBe(404);
    expect(requirePermission).not.toHaveBeenCalled();
    expect(reviewExplanation).not.toHaveBeenCalled();
  });

  it('forwards the hash the reviewer saw (and the preloaded row) to the service', async () => {
    await PATCH(req('PATCH', { explanation_id: EID, action: 'approve', explanation_hash: HASH }));
    expect(reviewExplanation).toHaveBeenCalledWith(supabase, expect.objectContaining({ explanationHash: HASH, explanation, action: 'approve' }));
  });

  it('a malformed hash is a validation error', async () => {
    const res = await PATCH(req('PATCH', { explanation_id: EID, action: 'approve', explanation_hash: 'not-a-hash' }));
    expect(res.status).toBe(422);
    expect(reviewExplanation).not.toHaveBeenCalled();
  });
});

describe('POST (prepare)', () => {
  it('never forwards client-sent drafted_by_ai / ai_citations', async () => {
    const res = await POST(req('POST', {
      location_id: ROW_LOC, year: 2026, month: 10, line_key: 'acct-1', explanation: 'Insurance renewal paid early.', category: 'TIMING', submit: true,
      drafted_by_ai: true, ai_citations: ['L1', 'L2'],
    }));
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('user_rev', 'close_mgmt', 'view', { locationId: ROW_LOC });
    const args = (saveExplanation.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(args).not.toHaveProperty('draftedByAi');
    expect(args).not.toHaveProperty('aiCitations');
    expect(args.aiDecisionId).toBeNull();
  });
});
