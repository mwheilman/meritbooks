import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Access, AccessRow, PersonaKey } from '@/lib/access/types';
import { buildAccess } from '@/lib/access/derive';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';

vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }));

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const tenant = {
  state: 'ready', clerkUserId: 'user_1', orgId: 'org_1', orgName: 'Acme', entitlements: { projects: true }, booksPresent: true,
  companies: [
    { id: L1, name: 'Heritage', shortCode: null, industry: null, revRecMethod: null, isManagementCompany: false },
    { id: L2, name: 'Clive', shortCode: null, industry: null, revRecMethod: null, isManagementCompany: false },
  ],
  activeCompanyId: L1,
};
vi.mock('@/lib/tenant', () => ({
  getDb: vi.fn(async () => ({})),
  requireReadyTenant: vi.fn(async () => tenant),
  getTenant: vi.fn(async () => tenant),
}));

let current: Access;
vi.mock('@/lib/access/server', () => ({ getAccess: vi.fn(async () => current) }));

const { route, assertCompany } = await import('@/lib/api');

function rowsFor(persona: PersonaKey, loc: string): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: persona, role_name: null }));
}

function req(method: string, body?: unknown, url = 'http://x/api/t'): NextRequest {
  return new NextRequest(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

async function call(h: ReturnType<typeof route>, r: NextRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h(r, { params: {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  current = buildAccess([...rowsFor('projects_pm', L1), ...rowsFor('projects_labor', L2)]);
});

describe('route() access guard', () => {
  it('omitting access is a compile error', () => {
    // @ts-expect-error — `access` is required on every route
    const h = route({}, async () => ({ ok: true }));
    expect(typeof h).toBe('function');
  });

  it('403 FORBIDDEN in plain words before the handler runs', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const h = route({ access: { cap: 'projects.settings', action: 'configure' } }, handler);
    const r = await call(h, req('POST'));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Your role doesn’t let you set up Projects settings. Ask an owner if you need it.', code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes and hands the handler ctx.access', async () => {
    const h = route({ access: { cap: 'projects.jobs', action: 'view' } }, async ({ access }) => ({ persona: access.persona }));
    const r = await call(h, req('GET'));
    expect(r).toEqual({ status: 200, body: { persona: 'projects_pm' } });
  });

  it("'none' lets any signed-in member through", async () => {
    current = buildAccess([]);
    const h = route({ access: 'none' }, async () => ({ ok: true }));
    expect((await call(h, req('GET'))).status).toBe(200);
  });

  it('body companyId is checked at that company (location scope)', async () => {
    const h = route({ access: { cap: 'projects.financials', action: 'view' }, body: z.object({ companyId: z.string() }) }, async () => ({ ok: true }));
    expect((await call(h, req('POST', { companyId: L1 }))).status).toBe(200);
    const r = await call(h, req('POST', { companyId: L2 }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Your role doesn’t let you see job costs, budgets and margin at Clive. Ask an owner if you need it.');
  });

  it('ops map adds the op-specific grant', async () => {
    const Op = z.discriminatedUnion('op', [z.object({ op: z.literal('update') }), z.object({ op: z.literal('approve') })]);
    const h = route({ access: { cap: 'projects.billing', action: 'edit' }, ops: { approve: { cap: 'projects.billing', action: 'approve' } }, body: Op }, async () => ({ ok: true }));
    expect((await call(h, req('POST', { op: 'update' }))).status).toBe(200);
    const r = await call(h, req('POST', { op: 'approve' }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });

  it('assertCompany enforces the route grant at the row\'s company', async () => {
    const h = route({ access: { cap: 'projects.financials', action: 'view' } }, async ({ tenant: t }) => {
      assertCompany(t, L2);
      return { ok: true };
    });
    const r = await call(h, req('GET'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    const ok = route({ access: { cap: 'projects.financials', action: 'view' } }, async ({ tenant: t }) => {
      assertCompany(t, L1);
      return { ok: true };
    });
    expect((await call(ok, req('GET'))).status).toBe(200);
  });

  it('a preview narrows the guard (owner previewing labor cannot configure)', async () => {
    current = buildAccess(rowsFor('projects_owner', L1), { preview: 'projects_labor' });
    const h = route({ access: { cap: 'projects.settings', action: 'configure' } }, async () => ({ ok: true }));
    expect((await call(h, req('POST'))).status).toBe(403);
  });
});

describe('route() response masking', () => {
  it('masks every JSON response by default (strict union), GET and POST', async () => {
    current = buildAccess(rowsFor('projects_labor', L1));
    const h = route({ access: { cap: 'projects.jobs', action: 'view' } }, async () => ({ job: { location_id: L1, name: 'K', original_contract_cents: 9 } }));
    expect((await call(h, req('GET'))).body).toEqual({ job: { location_id: L1, name: 'K', original_contract_cents: null } });
    expect((await call(h, req('POST'))).body).toEqual({ job: { location_id: L1, name: 'K', original_contract_cents: null } });
  });

  it('declared object types decide ambiguous keys', async () => {
    current = buildAccess(rowsFor('projects_office_manager', L1));
    const billing = route({ access: { cap: 'projects.billing', action: 'view' }, mask: 'billing' }, async () => ({ amount_cents: 5 }));
    const strict = route({ access: { cap: 'projects.billing', action: 'view' } }, async () => ({ amount_cents: 5 }));
    expect((await call(billing, req('GET'))).body).toEqual({ amount_cents: 5 });
    expect((await call(strict, req('GET'))).body).toEqual({ amount_cents: null });
  });

  it('masks a NextResponse JSON body too and keeps its cookies and status', async () => {
    current = buildAccess(rowsFor('projects_labor', L1));
    const h = route({ access: 'none' }, async () => {
      const res = NextResponse.json({ cost_cents: 3, label: 'x' }, { status: 201 });
      res.cookies.set('mp_test', '1');
      return res;
    });
    const res = await h(req('POST'), { params: {} });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('mp_test=1');
    expect(await res.json()).toEqual({ cost_cents: null, label: 'x' });
  });

  it('mask: false leaves the payload alone; owners are never masked', async () => {
    current = buildAccess(rowsFor('projects_labor', L1));
    const off = route({ access: 'none', mask: false }, async () => ({ amount_cents: 5 }));
    expect((await call(off, req('GET'))).body).toEqual({ amount_cents: 5 });
    current = buildAccess(rowsFor('projects_owner', L1));
    const on = route({ access: 'none' }, async () => ({ amount_cents: 5, cost_rate_cents: 2 }));
    expect((await call(on, req('GET'))).body).toEqual({ amount_cents: 5, cost_rate_cents: 2 });
  });
});
