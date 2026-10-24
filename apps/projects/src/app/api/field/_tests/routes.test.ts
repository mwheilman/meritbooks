import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Access, AccessRow, PersonaKey } from '@/lib/access/types';
import { buildAccess } from '@/lib/access/derive';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { memoryState, memoryStore, type MemoryState } from './memory-store';

const L1 = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';

let user: string | null = 'user_andre';
vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: user })) }));
const tenant = {
  state: 'ready', clerkUserId: 'user_andre', orgId: 'org-1', orgName: 'Heartland', entitlements: { projects: true }, booksPresent: true,
  companies: [{ id: L1, name: 'Heartland', shortCode: null, industry: null, revRecMethod: null, isManagementCompany: false }],
  activeCompanyId: L1,
};
vi.mock('@/lib/tenant', () => ({ getDb: vi.fn(async () => ({})), requireReadyTenant: vi.fn(async () => tenant), getTenant: vi.fn(async () => tenant) }));
let current: Access;
vi.mock('@/lib/access/server', () => ({ getAccess: vi.fn(async () => current) }));
let s: MemoryState;
vi.mock('../_lib/store', () => ({ createFieldStore: () => memoryStore(s) }));

const sync = await import('../sync/route');
const clock = await import('../clock/route');
const photos = await import('../photos/route');
const approve = await import('../crew/approve/route');
const punch = await import('../punch/route');
const logs = await import('../logs/route');
const checklists = await import('../checklists/route');
const { CHECKLISTS } = await import('../_lib/checklists');

function rowsFor(persona: PersonaKey): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: L1, capability, actions, role_key: persona, role_name: null }));
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://x${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: 'Bearer test' } });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const recent = () => new Date(Date.now() - 60 * 60_000).toISOString();
let n = 0;
const cid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  user = 'user_andre';
  current = buildAccess(rowsFor('projects_labor'));
  s = memoryState();
  s.jobs.set(JOB, { jobId: JOB, companyId: L1, siteLat: null, siteLng: null });
});

describe('/api/field/sync', () => {
  it('401 without a signed-in session (Bearer token missing or expired)', async () => {
    user = null;
    const res = await sync.POST(post('/api/field/sync', { commands: [{}] }));
    expect(res.status).toBe(401);
  });

  it('applies a batch in order with one result per command, and dedupes a re-sent batch', async () => {
    const inId = cid();
    const startAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const commands = [
      { id: inId, kind: 'clock', event: 'IN', at: startAt, jobId: JOB },
      { id: cid(), kind: 'clock', event: 'OUT', at: recent(), jobId: JOB, segment: { startId: inId, startAt } },
      { id: cid(), kind: 'log.submit', at: recent(), jobId: JOB, logDate: '2026-10-24', body: 'Trim set' },
    ];
    const res = await sync.POST(post('/api/field/sync', { commands }));
    expect(res.status).toBe(200);
    const body = (await json(res)) as { results: Array<{ outcome: string }>; serverTime: string };
    expect(body.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(s.time.size).toBe(1);
    const again = (await json(await sync.POST(post('/api/field/sync', { commands })))) as { results: Array<{ outcome: string }> };
    expect(again.results.map((r) => r.outcome)).toEqual(['applied', 'duplicate', 'duplicate']);
    expect(s.time.size).toBe(1);
    expect(s.logs.size).toBe(1);
  });

  it('rejections carry the reason the phone shows', async () => {
    const res = await sync.POST(post('/api/field/sync', { commands: [{ id: cid(), kind: 'crew.approve', at: recent(), entryIds: [cid()] }] }));
    const body = (await json(res)) as { results: Array<{ outcome: string; reason: string }> };
    expect(body.results[0]).toMatchObject({ outcome: 'rejected' });
    expect(body.results[0]!.reason).toMatch(/approve/i);
  });

  it('more than 50 commands is a validation error (the phone sends in pages)', async () => {
    const res = await sync.POST(post('/api/field/sync', { commands: Array.from({ length: 51 }, () => ({})) }));
    expect(res.status).toBe(422);
  });

  it('a role without Projects job access is refused before anything runs', async () => {
    current = buildAccess([]);
    const res = await sync.POST(post('/api/field/sync', { commands: [{ id: cid(), kind: 'log.submit' }] }));
    expect(res.status).toBe(403);
  });
});

describe('single-command routes', () => {
  it('POST /api/field/clock answers the CommandResult; a re-send is 200 duplicate', async () => {
    const cmd = { id: cid(), kind: 'clock', event: 'OUT', at: recent(), jobId: JOB, segment: { startId: cid(), startAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } };
    const a = await clock.POST(post('/api/field/clock', cmd));
    expect(a.status).toBe(200);
    expect(await json(a)).toMatchObject({ id: cmd.id, outcome: 'applied' });
    const b = await clock.POST(post('/api/field/clock', cmd));
    expect(await json(b)).toMatchObject({ outcome: 'duplicate' });
  });

  it('the wrong kind on a route is refused', async () => {
    const r = await clock.POST(post('/api/field/clock', { id: cid(), kind: 'log.submit' }));
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ code: 'WRONG_ROUTE' });
  });

  it('crew approval is 403 for a crew member and works for a supervisor', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    s.time.set(id, { id, job_id: JOB, employee_id: 'eeeeeeee-0000-4000-8000-000000000009', user_id: null, work_date: '2026-10-23', hours: 8, cost_code_id: null, notes: null, approval_state: 'SUBMITTED', source_ref: null });
    const cmd = { id: cid(), kind: 'crew.approve', at: recent(), entryIds: [id] };
    expect((await approve.POST(post('/api/field/crew/approve', cmd))).status).toBe(403);
    current = buildAccess(rowsFor('projects_supervisor'));
    const ok = await approve.POST(post('/api/field/crew/approve', cmd));
    expect(ok.status).toBe(200);
    expect(s.time.get(id)!.approval_state).toBe('APPROVED');
  });

  it('punch needs projects.jobs:create (the grant RLS checks): crew 403, PM 200', async () => {
    const cmd = { id: cid(), kind: 'punch.create', at: recent(), jobId: JOB, title: 'Touch up paint at door 3' };
    expect((await punch.POST(post('/api/field/punch', cmd))).status).toBe(403);
    current = buildAccess(rowsFor('projects_pm'));
    expect((await punch.POST(post('/api/field/punch', cmd))).status).toBe(200);
  });

  it('responses never carry money keys', async () => {
    const cmd = { id: cid(), kind: 'clock', event: 'OUT', at: recent(), jobId: JOB, segment: { startId: cid(), startAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } };
    const text = await (await clock.POST(post('/api/field/clock', cmd))).text();
    expect(text).not.toMatch(/cents|rate|cost_/i);
  });
});

describe('ext keys under the database rule (pm.validate_ext: non-underscore keys are refused)', () => {
  it('logs, checklists and punch items saved through the routes carry only "_" system keys', async () => {
    current = buildAccess(rowsFor('projects_supervisor'));
    const t = CHECKLISTS.find((c) => c.key === 'site_safety')!;
    const chkId = cid();
    const items = t.items.map((i) => ({ key: i.key, result: i.key === 'ladders' ? 'FAIL' : 'PASS', note: i.key === 'ladders' ? 'Not tied off' : null, photoIds: i.photo === 'required' || i.key === 'ladders' ? [cid()] : [] }));
    const geo = { lat: 41.6, lng: -93.6, accuracyM: 5 };
    expect((await logs.POST(post('/api/field/logs', { id: cid(), kind: 'log.submit', at: recent(), geo, offline: true, jobId: JOB, logDate: '2026-10-24', body: 'Set trusses', signature: { name: 'Kelly Brandt', signedAt: recent() } }))).status).toBe(200);
    expect((await checklists.POST(post('/api/field/checklists', { id: chkId, kind: 'checklist.submit', at: recent(), jobId: JOB, templateKey: 'site_safety', items }))).status).toBe(200);
    const p = await punch.POST(post('/api/field/punch', { id: cid(), kind: 'punch.create', at: recent(), jobId: JOB, title: 'Ladders inspected and tied off', fromChecklist: { commandId: chkId, itemKey: 'ladders' } }));
    expect(p.status).toBe(200); // supervisors hold projects.jobs:create
    const exts = [...[...s.logs.values()].map((l) => l.ext), ...[...s.punches.values()].map((x) => x.ext)];
    expect(exts).toHaveLength(3);
    for (const ext of exts) expect(Object.keys(ext).filter((k) => !k.startsWith('_'))).toEqual([]);
    expect(exts[0]).toMatchObject({ _signature: { name: 'Kelly Brandt' }, _geo: { lat: 41.6 }, _offline: true });
  });

  it('a non-underscore ext key is refused: 422 PM_EXT_UNKNOWN_FIELD, nothing stored', async () => {
    s.injectExt = { client_command_id: 'old-key' };
    const r = await logs.POST(post('/api/field/logs', { id: cid(), kind: 'log.submit', at: recent(), jobId: JOB, logDate: '2026-10-24', body: 'x' }));
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ outcome: 'rejected', code: 'PM_EXT_UNKNOWN_FIELD' });
    expect(s.logs.size).toBe(0);
  });
});

describe('/api/field/photos', () => {
  function form(meta: unknown, file?: Blob): NextRequest {
    const f = new FormData();
    f.set('meta', JSON.stringify(meta));
    if (file) f.set('file', file, 'IMG_0001.jpg');
    return new NextRequest('http://x/api/field/photos', { method: 'POST', body: f });
  }

  it('stores the photo once and answers duplicate on a re-send', async () => {
    const meta = { id: cid(), kind: 'photo.upload', at: recent(), jobId: JOB };
    const file = new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });
    const a = await photos.POST(form(meta, file));
    expect(a.status).toBe(200);
    expect(await json(a)).toMatchObject({ outcome: 'applied' });
    expect(await json(await photos.POST(form(meta, file)))).toMatchObject({ outcome: 'duplicate' });
    expect(s.documents.size).toBe(1);
  });

  it('a Content-Length over the cap is refused before the body is parsed (413, store untouched)', async () => {
    const big = new NextRequest('http://x/api/field/photos', {
      method: 'POST', body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(13 * 1024 * 1024) },
    });
    const r = await photos.POST(big);
    expect(r.status).toBe(413);
    expect(await json(r)).toMatchObject({ code: 'PHOTO_TOO_LARGE' });
    expect(s.calls).toEqual([]);
  });

  it('a body with no Content-Length is cut off at the cap while streaming (413)', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 20) c.close();
        else c.enqueue(chunk);
      },
    });
    const init = { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=b' }, duplex: 'half' } as unknown as ConstructorParameters<typeof NextRequest>[1];
    const r = await photos.POST(new NextRequest('http://x/api/field/photos', init));
    expect(r.status).toBe(413);
    expect(sent).toBeLessThan(20); // stopped reading early
    expect(s.calls).toEqual([]);
  });

  it('a non-photo labelled image/jpeg is refused by its bytes (422 PHOTO_TYPE)', async () => {
    const meta = { id: cid(), kind: 'photo.upload', at: recent(), jobId: JOB };
    const r = await photos.POST(form(meta, new Blob([new TextEncoder().encode('<html><script>alert(1)</script>')], { type: 'image/jpeg' })));
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ code: 'PHOTO_TYPE' });
    expect(s.objects.size).toBe(0);
  });

  it('missing file or meta is refused with a reason', async () => {
    const r = await photos.POST(form({ id: cid(), kind: 'photo.upload', at: recent(), jobId: JOB }));
    expect(r.status).toBe(422);
    expect((await photos.POST(form({ nope: true }, new Blob([new Uint8Array([1])], { type: 'image/jpeg' })))).status).toBe(422);
  });
});
