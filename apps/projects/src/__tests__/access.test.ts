import { describe, expect, it } from 'vitest';
import { PERSONAS, PERSONA_RANK, type AccessRow, type Grant, type PersonaKey } from '@/lib/access/types';
import {
  buildAccess, choosePersona, deriveJobScope, deriveMoneyLevel, emptyAccess, grantsByCompany, inferPersona, narrowToPersona,
} from '@/lib/access/derive';
import { can, companiesWith } from '@/lib/access/can';
import { CAPABILITY_ACTIONS, PERSONA_LABEL, PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { accessFromJson, accessToJson } from '@/lib/access/serialize';
import { packRoleTitle } from '@/lib/access/titles';
import { forbiddenMessage, requireCan } from '@/lib/access/guard';
import { HttpError } from '@/lib/api-errors';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

/** pm.my_access rows for a persona's full template at a company (what 1110 returns after backfill). */
function rowsFor(persona: PersonaKey, loc: string, roleName: string | null = null): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: persona, role_name: roleName }));
}

describe('grantsByCompany', () => {
  it('keys grants per company and drops unknown capabilities and actions (fail closed)', () => {
    const g = grantsByCompany([
      { location_id: L1, capability: 'projects.jobs', actions: ['view', 'edit', 'fly'], role_key: 'projects_pm', role_name: null },
      { location_id: L1, capability: 'books.gl', actions: ['view'], role_key: null, role_name: null },
      { location_id: L2, capability: 'projects.billing', actions: ['configure', 'post'], role_key: null, role_name: null },
    ]);
    expect([...g[L1]!].sort()).toEqual(['projects.jobs:edit', 'projects.jobs:view']);
    expect([...g[L2]!]).toEqual(['projects.billing:post']);
  });
});

describe('persona selection (PERSONA_RANK)', () => {
  it('highest rank wins across roles and companies', () => {
    const rows = [...rowsFor('projects_labor', L1), ...rowsFor('projects_pm', L2), ...rowsFor('projects_supervisor', L1)];
    expect(choosePersona(rows, new Set())).toBe('projects_pm');
  });

  it.each(PERSONAS.map((p) => [p]))('%s alone selects itself', (p) => {
    expect(buildAccess(rowsFor(p, L1)).persona).toBe(p);
  });

  it('rank order is total and owner is top', () => {
    const ranks = PERSONAS.map((p) => PERSONA_RANK[p]);
    expect(new Set(ranks).size).toBe(PERSONAS.length);
    expect(Math.max(...ranks)).toBe(PERSONA_RANK.projects_owner);
  });

  it('a custom role key is inferred from its grants', () => {
    const custom = (g: Grant[]) => inferPersona(new Set(g));
    expect(custom(['projects.settings:configure'])).toBe('projects_owner');
    expect(custom(['projects.jobs_all:view', 'projects.contract_value:view'])).toBe('projects_office_manager');
    expect(custom(['projects.jobs_all:view'])).toBe('projects_dispatcher');
    expect(custom(['projects.financials:view'])).toBe('projects_pm');
    expect(custom(['projects.time:approve'])).toBe('projects_supervisor');
    expect(custom([])).toBe('projects_labor');
    const rows: AccessRow[] = [{ location_id: L1, capability: 'projects.jobs', actions: ['view'], role_key: 'acme_custom_tech', role_name: 'Tech' }];
    expect(buildAccess(rows).persona).toBe('projects_labor');
  });

  it('no rows: labor persona with no grants', () => {
    const a = emptyAccess();
    expect(a.persona).toBe('projects_labor');
    expect(a.grants.size).toBe(0);
    expect(a.moneyLevel).toBe(1);
    expect(a.jobScope).toBe('own');
  });
});

describe('money levels (§2.3) and job scope', () => {
  const level = (p: PersonaKey) => deriveMoneyLevel(PERSONA_TEMPLATE_GRANTS[p]);
  it('labor 1 · supervisor 2 · pm 3 · owner 4', () => {
    expect(level('projects_labor')).toBe(1);
    expect(level('projects_supervisor')).toBe(2);
    expect(level('projects_dispatcher')).toBe(2);
    expect(level('projects_pm')).toBe(3);
    expect(level('projects_office_manager')).toBe(3);
    expect(level('projects_sales')).toBe(3);
    expect(level('projects_owner')).toBe(4);
    expect(level('projects_gm')).toBe(4);
  });
  it('PM has no individual rates; owner does', () => {
    expect(PERSONA_TEMPLATE_GRANTS.projects_pm.has('projects.labor_rates:view')).toBe(false);
    expect(PERSONA_TEMPLATE_GRANTS.projects_owner.has('projects.labor_rates:edit')).toBe(true);
    expect(PERSONA_TEMPLATE_GRANTS.projects_gm.has('projects.labor_rates:edit')).toBe(false);
  });
  it('jobScope: all only with jobs_all', () => {
    expect(deriveJobScope(PERSONA_TEMPLATE_GRANTS.projects_owner)).toBe('all');
    expect(deriveJobScope(PERSONA_TEMPLATE_GRANTS.projects_dispatcher)).toBe('all');
    expect(deriveJobScope(PERSONA_TEMPLATE_GRANTS.projects_pm)).toBe('own');
    expect(deriveJobScope(PERSONA_TEMPLATE_GRANTS.projects_labor)).toBe('own');
  });
  it('labor and supervisor templates carry no money capability at all', () => {
    for (const p of ['projects_labor', 'projects_supervisor', 'projects_dispatcher'] as const) {
      for (const g of PERSONA_TEMPLATE_GRANTS[p]) expect(g).not.toMatch(/financials|contract_value|labor_rates/);
    }
  });
});

describe('templates mirror §2.1/§2.2', () => {
  it('every template grant is a declared cap:action', () => {
    for (const p of PERSONAS) {
      for (const g of PERSONA_TEMPLATE_GRANTS[p]) {
        const [cap, action] = g.split(':') as [keyof typeof CAPABILITY_ACTIONS, string];
        expect((CAPABILITY_ACTIONS[cap] as ReadonlyArray<string>).includes(action)).toBe(true);
      }
    }
  });
  it('only the owner can configure settings (preview gate)', () => {
    for (const p of PERSONAS) expect(PERSONA_TEMPLATE_GRANTS[p].has('projects.settings:configure')).toBe(p === 'projects_owner');
  });
  it('every persona has a label', () => {
    for (const p of PERSONAS) expect(PERSONA_LABEL[p]).toMatch(/^[A-Z]/);
  });
});

describe('can()', () => {
  const a = buildAccess([...rowsFor('projects_pm', L1), ...rowsFor('projects_labor', L2)]);
  it('company given → only that company counts (location scope)', () => {
    expect(can(a, 'projects.financials', 'view', L1)).toBe(true);
    expect(can(a, 'projects.financials', 'view', L2)).toBe(false);
    expect(can(a, 'projects.jobs', 'view', L2)).toBe(true);
    expect(can(a, 'projects.jobs', 'view', '33333333-3333-4333-8333-333333333333')).toBe(false);
  });
  it('no company → any company', () => {
    expect(can(a, 'projects.financials', 'view')).toBe(true);
    expect(can(a, 'projects.settings', 'configure')).toBe(false);
  });
  it('companiesWith lists where a grant is held', () => {
    expect(companiesWith(a, 'projects.financials', 'view')).toEqual([L1]);
    expect(companiesWith(a, 'projects.jobs', 'view').sort()).toEqual([L1, L2].sort());
  });
  it('requireCan throws a 403 FORBIDDEN in plain words', () => {
    expect(() => requireCan(a, 'projects.billing', 'approve', L1, 'Heritage')).toThrow(HttpError);
    try {
      requireCan(a, 'projects.billing', 'approve', L1, 'Heritage');
    } catch (e) {
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).code).toBe('FORBIDDEN');
      expect((e as HttpError).message).toBe('Your role doesn’t let you approve billing at Heritage. Ask an owner if you need it.');
    }
    expect(forbiddenMessage('projects.billing', 'post')).toBe('Your role doesn’t let you send billing to Merit Books. Ask an owner if you need it.');
    expect(() => requireCan(a, 'projects.billing', 'create', L1)).not.toThrow();
  });
});

describe('preview as (narrowing only)', () => {
  const ownerRows = [...rowsFor('projects_owner', L1), ...rowsFor('projects_owner', L2)];

  it('owner previewing labor gets exactly the labor template', () => {
    const a = buildAccess(ownerRows, { preview: 'projects_labor' });
    expect(a.preview).toBe('projects_labor');
    expect(a.persona).toBe('projects_labor');
    expect(a.group).toBe('labor');
    expect([...a.grants].sort()).toEqual([...PERSONA_TEMPLATE_GRANTS.projects_labor].sort());
    expect(a.moneyLevel).toBe(1);
    expect(a.jobScope).toBe('own');
    expect(a.title).toBe('Crew');
  });

  it('never widens: effective = real ∩ template, per company', () => {
    const real = [...rowsFor('projects_owner', L1), ...rowsFor('projects_labor', L2)];
    const a = buildAccess(real, { preview: 'projects_pm' });
    expect(can(a, 'projects.financials', 'view', L1)).toBe(true);
    expect(can(a, 'projects.financials', 'view', L2)).toBe(false); // PM template has it, real L2 grants don't
    const realAccess = buildAccess(real);
    for (const p of PERSONAS) {
      const v = buildAccess(real, { preview: p });
      for (const [loc, set] of Object.entries(v.byCompany)) {
        for (const g of set) expect(realAccess.byCompany[loc]!.has(g)).toBe(true);
      }
    }
  });

  it('ignored unless the REAL grants include settings:configure', () => {
    const pm = buildAccess(rowsFor('projects_pm', L1), { preview: 'projects_labor' });
    expect(pm.preview).toBeNull();
    expect(pm.persona).toBe('projects_pm');
    expect(pm.grants.has('projects.financials:view')).toBe(true);
  });

  it('ignores an unknown persona value', () => {
    const a = buildAccess(ownerRows, { preview: 'projects_god' });
    expect(a.preview).toBeNull();
    expect(a.persona).toBe('projects_owner');
  });

  it('narrowToPersona drops everything outside the template', () => {
    const n = narrowToPersona({ [L1]: new Set<Grant>(['projects.jobs:view', 'projects.financials:view']) }, 'projects_labor');
    expect([...n[L1]!]).toEqual(['projects.jobs:view']);
  });
});

describe('titles', () => {
  it('pack roles slot (array) → industry title', () => {
    const m = { roles: [{ title: 'Technician', template: 'projects_labor' }, { title: 'CSR', template: 'projects_dispatcher' }] };
    expect(packRoleTitle(m, 'projects_labor')).toBe('Technician');
    expect(packRoleTitle(m, 'projects_dispatcher')).toBe('CSR');
    expect(packRoleTitle(m, 'projects_pm')).toBeNull();
  });
  it('pack roles slot (maps in either direction)', () => {
    expect(packRoleTitle({ roles: { 'Comfort advisor': 'projects_sales' } }, 'projects_sales')).toBe('Comfort advisor');
    expect(packRoleTitle({ roles: { projects_labor: 'Installer' } }, 'projects_labor')).toBe('Installer');
    expect(packRoleTitle({ name: 'no roles slot' }, 'projects_labor')).toBeNull();
    expect(packRoleTitle(null, 'projects_labor')).toBeNull();
  });
  it('pack title → role name → persona label', () => {
    const rows = rowsFor('projects_labor', L1, 'Field tech');
    expect(buildAccess(rows, { titleFor: () => 'Technician' }).title).toBe('Technician');
    expect(buildAccess(rows, { titleFor: () => null }).title).toBe('Field tech');
    expect(buildAccess(rowsFor('projects_labor', L1)).title).toBe('Crew');
  });
});

describe('serialization round-trip', () => {
  it('accessFromJson(accessToJson(a)) answers can() the same', () => {
    const a = buildAccess([...rowsFor('projects_pm', L1), ...rowsFor('projects_labor', L2)], { membershipId: 'm1' });
    const b = accessFromJson(JSON.parse(JSON.stringify(accessToJson(a))));
    expect(b.membershipId).toBe('m1');
    expect(b.persona).toBe(a.persona);
    for (const loc of [L1, L2]) {
      for (const g of PERSONA_TEMPLATE_GRANTS.projects_owner) {
        const [cap, action] = g.split(':') as [Parameters<typeof can>[1], Parameters<typeof can>[2]];
        expect(can(b, cap, action, loc)).toBe(can(a, cap, action, loc));
      }
    }
  });
  it('drops forged grants', () => {
    const j = accessToJson(emptyAccess());
    const b = accessFromJson({ ...j, grants: ['projects.jobs:view', 'projects.root:everything' as Grant] });
    expect([...b.grants]).toEqual(['projects.jobs:view']);
  });
});
