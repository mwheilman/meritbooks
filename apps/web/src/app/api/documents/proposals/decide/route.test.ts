/**
 * POST /api/documents/proposals/decide — AC8: accepting a document proposal needs the
 * TARGET MODULE's own gate (lease → journal_entries:create, bill → bills:create …), the
 * proposal must be visible through the member's RLS client, and the record must exist in
 * the org. Collaborators are faked; the route's own decisions are under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';
const LOC = '44444444-4444-4444-8444-444444444444';

let visible: { id: string } | null = { id: PID };
const supabase = {
  from: (table: string) => {
    expect(table).toBe('document_proposals');
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: visible, error: null }) };
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
const assertWriteScope = vi.fn(async () => undefined);
vi.mock('@/lib/db/scoped-writer', () => ({ assertWriteScope: (...a: unknown[]) => assertWriteScope(...(a as [])), isWriteScopeError: () => false }));
vi.mock('@/lib/documents/intelligence/server', () => ({ intelDeps: () => ({ db: {}, anthropicApiKey: null, now: () => new Date(), loadBytes: async () => null }) }));

let proposal: Record<string, unknown> | null = { id: PID, target_kind: 'lease', location_id: LOC, status: 'pending' };
const acceptProposal = vi.fn(async () => ({ proposal: { ...proposal, status: 'accepted' }, label: 'Lease: Acme' }));
const dismissProposal = vi.fn(async () => ({ ...proposal, status: 'dismissed' }));
vi.mock('@/lib/documents/intelligence/service', () => ({
  loadProposal: async () => proposal,
  acceptProposal: (...a: unknown[]) => acceptProposal(...(a as [])),
  dismissProposal: (...a: unknown[]) => dismissProposal(...(a as [])),
  IntelligenceError: class extends Error { status = 400; code = 'X'; },
}));
let record: { id: string; label: string; locationId: string | null } | null = { id: LEASE, label: 'Lease: Acme', locationId: LOC };
vi.mock('@/lib/documents/intelligence/records', () => ({ resolveRecord: async () => record }));

const { POST } = await import('./route');
const call = (body: unknown) => POST(new Request('http://localhost/api/documents/proposals/decide', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  visible = { id: PID };
  proposal = { id: PID, target_kind: 'lease', location_id: LOC, status: 'pending' };
  record = { id: LEASE, label: 'Lease: Acme', locationId: LOC };
  requirePermission.mockReset();
  requirePermission.mockResolvedValue({ ok: true, role: 'cfo', orgId: ORG });
  acceptProposal.mockClear();
  dismissProposal.mockClear();
  assertWriteScope.mockClear();
});

describe('POST /api/documents/proposals/decide', () => {
  it('checks the target module gate (lease → journal_entries:create) and refuses without it', async () => {
    requirePermission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'lease', target_id: LEASE });
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('user_1', 'journal_entries', 'create', expect.anything());
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it('uses bills:create for a bill proposal', async () => {
    proposal = { ...proposal, target_kind: 'bill' };
    requirePermission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    await call({ action: 'dismiss', proposal_id: PID });
    expect(requirePermission).toHaveBeenCalledWith('user_1', 'bills', 'create', expect.anything());
    expect(dismissProposal).not.toHaveBeenCalled();
  });

  it('404 when the member cannot see the proposal (other tenant / out of client scope)', async () => {
    visible = null;
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'lease', target_id: LEASE });
    expect(res.status).toBe(404);
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it('404 when the record does not exist in the org', async () => {
    record = null;
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'lease', target_id: LEASE });
    expect(res.status).toBe(404);
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it('accepts: client scope asserted on the proposal and the record, then linked', async () => {
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'lease', target_id: LEASE });
    expect(res.status).toBe(200);
    expect(assertWriteScope).toHaveBeenCalledWith(supabase, ORG, [LOC]);
    expect(acceptProposal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: ORG, proposalId: PID, targetType: 'lease', targetId: LEASE, userId: 'user_1' }));
    expect(((await res.json()) as { message: string }).message).toBe('Linked to Lease: Acme.');
  });

  it('refuses a record type the proposal kind may not close onto (allowlist) — before any lookup', async () => {
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'bill', target_id: LEASE });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_TARGET');
    expect(acceptProposal).not.toHaveBeenCalled();
    proposal = { ...proposal, target_kind: 'vendor_w9' };
    expect((await call({ action: 'accept', proposal_id: PID, target_type: 'lease', target_id: LEASE })).status).toBe(400);
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it("also needs the TARGET RECORD's module gate (guardRecord)", async () => {
    proposal = { ...proposal, target_kind: 'customer_contract' };
    requirePermission
      .mockResolvedValueOnce({ ok: true, role: 'cfo', orgId: ORG }) // the proposal kind's gate
      .mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }); // the record's gate
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'invoice', target_id: LEASE });
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenNthCalledWith(2, 'user_1', 'invoices', 'create', expect.anything());
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it('accepts a customer contract onto an invoice (allowed alternate) with both gates', async () => {
    proposal = { ...proposal, target_kind: 'customer_contract' };
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'invoice', target_id: LEASE });
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledTimes(2);
    expect(acceptProposal).toHaveBeenCalledTimes(1);
    expect((await res.json()) as { proposal: Record<string, unknown> }).not.toHaveProperty('proposal.payload');
  });

  it('rejects a malformed record type', async () => {
    const res = await call({ action: 'accept', proposal_id: PID, target_type: 'Lease; drop', target_id: LEASE });
    expect(res.status).toBe(422);
  });
});
