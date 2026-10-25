/**
 * Security review: a settings:configure holder must never reach Object.prototype through
 * pm.pack_overrides (e.g. /experience/__proto__/mask = false), and even a polluted prototype
 * must never switch route masking off, open a read-only view or unmask a figure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { maskMoney } from '@/lib/access/mask';
import { buildAccess } from '@/lib/access/derive';
import { experienceFor } from '@/lib/packs/experience';
import type { AccessRow } from '@/lib/access/types';

const proto = Object.prototype as unknown as Record<string, unknown>;
const planted: string[] = [];
function plant(k: string, v: unknown) {
  proto[k] = v;
  planted.push(k);
}
afterEach(() => {
  for (const k of planted.splice(0)) delete proto[k];
});

const L1 = '00000000-0000-4000-8000-0000000000a1';
const labor = buildAccess([{ location_id: L1, capability: 'projects.jobs', actions: ['view'], role_key: 'projects_labor', role_name: 'Crew' } satisfies AccessRow]);

vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(async () => ({ userId: 'user_1' })) }));
const tenant = {
  state: 'ready', clerkUserId: 'user_1', orgId: 'org_1', orgName: 'Acme', entitlements: { projects: true }, booksPresent: true,
  companies: [{ id: L1, name: 'Heritage', shortCode: null, industry: null, revRecMethod: null, isManagementCompany: false }],
  activeCompanyId: L1,
};
vi.mock('@/lib/tenant', () => ({ getDb: vi.fn(async () => ({})), requireReadyTenant: vi.fn(async () => tenant), getTenant: vi.fn(async () => tenant) }));
vi.mock('@/lib/access/server', () => ({ getAccess: vi.fn(async () => labor) }));
const { route, resolveRouteOptions } = await import('@/lib/api');

describe('route options are read as own properties only', () => {
  it('a polluted mask / allowReadOnly never applies', () => {
    plant('mask', false);
    plant('allowReadOnly', true);
    const r = resolveRouteOptions({ access: { cap: 'projects.jobs', action: 'view' } });
    expect(r.mask).toBeUndefined(); // strict union: masking on
    expect(r.allowReadOnly).toBe(false);
  });

  it('a polluted access never stands in for a missing one', () => {
    plant('access', 'none');
    expect(resolveRouteOptions({}).access).toBeNull();
  });

  it('declared options still work', () => {
    expect(resolveRouteOptions({ access: 'none', mask: false, allowReadOnly: true })).toMatchObject({ access: 'none', mask: false, allowReadOnly: true });
    expect(resolveRouteOptions({ access: 'none', mask: 'billing' }).mask).toBe('billing');
  });
});

describe('route() keeps masking on under a polluted prototype', () => {
  it('Object.prototype.mask = false does not unmask a route that declared no mask', async () => {
    plant('mask', false);
    const GET = route({ access: { cap: 'projects.jobs', action: 'view' } }, async () => ({ contract_value_cents: 500, actual_cost_cents: 300, name: 'J1' }));
    const res = await GET(new NextRequest('http://x/api/t'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.contract_value_cents).toBeNull();
    expect(body.actual_cost_cents).toBeNull();
    expect(body.name).toBe('J1');
  });
});

describe('money masking ignores a polluted prototype', () => {
  it('a planted public list or company id never unmasks', () => {
    plant('public', ['contract_value_cents', 'actual_cost_cents']);
    plant('location_id', L1);
    const out = maskMoney({ contract_value_cents: 100, actual_cost_cents: 50, name: 'x' }, labor);
    expect(out.contract_value_cents).toBeNull();
    expect(out.actual_cost_cents).toBeNull();
    expect(out.name).toBe('x');
  });
});

describe('pack overrides cannot pollute', () => {
  it('attack pointers and values are skipped; nothing global changes', () => {
    const e = experienceFor({
      primary: { pack_key: 'general', pack_version: '1.1.0' },
      overrides: [
        { json_pointer: '/experience/__proto__/mask', op: 'add', value: false },
        { json_pointer: '/experience/constructor/prototype/mask', op: 'add', value: false },
        { json_pointer: '/experience/kiosk', op: 'replace', value: JSON.parse('{"__proto__":{"mask":false}}') },
      ],
    })!;
    expect(e.skippedOverrides).toBe(3);
    expect(({} as Record<string, unknown>).mask).toBeUndefined();
    expect(resolveRouteOptions({ access: 'none' }).mask).toBeUndefined();
  });
});
