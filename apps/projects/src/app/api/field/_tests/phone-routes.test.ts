import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Access, AccessRow } from '@/lib/access/types';
import { buildAccess } from '@/lib/access/derive';
import { memoryState, memoryStore, type MemoryState } from './memory-store';
import { memoryPhoneStore, phoneState, type PhoneState } from './memory-phone-store';

const L1 = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';
const REQ = '66666666-6666-4666-8666-666666666666';

vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_dana' })) }));
const tenant = {
  state: 'ready', clerkUserId: 'user_dana', orgId: 'org-1', orgName: 'Heartland', entitlements: { projects: true }, booksPresent: true,
  companies: [{ id: L1, name: 'Heartland', shortCode: null, industry: null, revRecMethod: null, isManagementCompany: false }], activeCompanyId: L1,
};
vi.mock('@/lib/tenant', () => ({ getDb: vi.fn(async () => ({})), requireReadyTenant: vi.fn(async () => tenant), getTenant: vi.fn(async () => tenant) }));
let current: Access;
vi.mock('@/lib/access/server', () => ({ getAccess: vi.fn(async () => current) }));
let s: MemoryState;
let p: PhoneState;
vi.mock('../_lib/store', () => ({ createFieldStore: () => memoryStore(s) }));
vi.mock('../_lib/phone-store', () => ({ createPhoneStore: () => memoryPhoneStore(p) }));
const reads = {
  loadPayWeek: vi.fn(async () => ({ installer: true, weekStart: '2026-10-19', weekEnd: '2026-10-25', tickets: [], chargebacks: [], totals: { grossCents: 64000, chargebackCents: 0, netCents: 64000, approvedNetCents: 0 } })),
  loadRo: vi.fn(async () => ({ serverTime: '', stores: [], ros: [], lines: [], open: null })),
  loadDrawings: vi.fn(async (_db: unknown, ids: string[]) => ({ sheets: [], serverTime: '', ids })),
  loadExtras: vi.fn(async () => ({ visits: {}, homes: {}, drawings: {}, features: {}, stations: [] })),
  loadSell: vi.fn(async () => null),
};
vi.mock('../_lib/phone-reads', () => reads);

const sync = await import('../sync/route');
const pay = await import('../pay/route');
const ro = await import('../ro/route');
const drawings = await import('../drawings/route');
const service = await import('../sell/route');

const grant = (capability: string, actions: string[]): AccessRow => ({ location_id: L1, capability, actions, role_key: 'x', role_name: null });
const get = (url: string) => new NextRequest(`http://x${url}`, { headers: { authorization: 'Bearer t' } });
const post = (url: string, body: unknown) => new NextRequest(`http://x${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: 'Bearer t' } });
let n = 0;
const cid = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  current = buildAccess([grant('projects.jobs', ['view']), grant('projects.time', ['view', 'create']), grant('projects.documents', ['view', 'create'])]);
  s = memoryState();
  p = phoneState();
  s.jobs.set(JOB, { jobId: JOB, companyId: L1, siteLat: null, siteLng: null });
});

describe('POST /api/field/sync with v2 phone commands', () => {
  it('a v1 clock and a v2 approval in one batch, each answered once, in order', async () => {
    p.approvals.set(REQ, { id: REQ, status: 'PENDING', round: 1, step: 1, canAct: true, title: 'Time for Andre', history: [] });
    const commands = [
      { id: cid(), kind: 'clock', event: 'IN', at: new Date(Date.now() - 60_000).toISOString(), jobId: JOB },
      { id: cid(), kind: 'approval.decide', at: new Date().toISOString(), requestId: REQ, decision: 'approve', round: 1, step: 1 },
    ];
    const res = await sync.POST(post('/api/field/sync', { commands }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ kind: string; outcome: string }> };
    expect(body.results.map((r) => [r.kind, r.outcome])).toEqual([['clock', 'applied'], ['approval.decide', 'applied']]);
    const again = (await (await sync.POST(post('/api/field/sync', { commands }))).json()) as { results: Array<{ outcome: string }> };
    expect(again.results[1]!.outcome).toBe('duplicate');
    expect(p.acted).toHaveLength(1);
  });
});

describe('phone-only reads: grants', () => {
  it('pay is open to any field seat (own rows only, enforced in the loader)', async () => {
    const r = await pay.GET(get('/api/field/pay?week=2026-10-22'));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { totals: { grossCents: number } }).totals.grossCents).toBe(64000);
    expect(reads.loadPayWeek).toHaveBeenCalledWith(expect.anything(), 'user_dana', '2026-10-22');
  });

  it('RO clock needs time:create; drawings need documents:view; ids are cleaned and capped', async () => {
    expect((await ro.GET(get('/api/field/ro'))).status).toBe(200);
    current = buildAccess([grant('projects.jobs', ['view'])]);
    expect((await ro.GET(get('/api/field/ro'))).status).toBe(403);
    expect((await drawings.GET(get(`/api/field/drawings?jobIds=${JOB}`))).status).toBe(403);
    current = buildAccess([grant('projects.documents', ['view'])]);
    const d = await drawings.GET(get(`/api/field/drawings?jobIds=${JOB},not-an-id,${JOB}`));
    expect(d.status).toBe(200);
    expect(reads.loadDrawings).toHaveBeenLastCalledWith(expect.anything(), [JOB]);
  });

  it('service answers 404 for a visit the caller cannot see', async () => {
    const r = await service.GET(get(`/api/field/sell?workOrderId=${cid()}`));
    expect(r.status).toBe(404);
  });
});
