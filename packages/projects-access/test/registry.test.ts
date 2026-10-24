/**
 * Projects registry guard: packages/projects-access (code) == core.* mirrors (DB after replaying
 * every migration), == the shared app contract (apps/projects/src/lib/access/types.ts), and the
 * GENERATED blocks of 1110_pm_access.sql are up to date.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createReplayDb, MIGRATIONS_DIR } from './pg';
import { PROJECT_CAPABILITIES, PROJECT_CAPABILITY_KEYS, riskTier, isPlatformOnly, ACTIONS } from '../src/capabilities';
import { PROJECT_ROLE_TEMPLATES, PROJECT_PERMISSION_SET_TEMPLATES, PERSONA_KEYS } from '../src/roles';
import { renderCarriers } from '../scripts/generate-seed';
import { PROJECT_CAPABILITIES as APP_CAPS, PERSONAS as APP_PERSONAS, PERSONA_RANK as APP_RANK } from '../../../apps/projects/src/lib/access/types';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createReplayDb());
  await db.query(`insert into core.organizations (id, name, slug) values ('c0000000-0000-4000-8000-000000000001', 'T', 't')`);
  await db.query(`select pm.access_provision_tenant('c0000000-0000-4000-8000-000000000001')`);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

interface CapRow {
  key: string; module: string; domain: string; actions: string[]; label: string; description: string; tags: string[];
  risk_tier: string; platform_only: boolean; field_classes: string[]; supports_constraints: string[]; status: string;
}

describe('code == shared app contract (types.ts)', () => {
  it('capability keys match apps/projects/src/lib/access/types.ts', () => {
    expect([...PROJECT_CAPABILITY_KEYS]).toEqual([...APP_CAPS]);
    expect(PROJECT_CAPABILITIES.map((c) => c.key)).toEqual([...APP_CAPS]);
  });
  it('persona keys and ranks match', () => {
    expect([...PERSONA_KEYS]).toEqual([...APP_PERSONAS]);
    expect(PROJECT_ROLE_TEMPLATES.map((t) => t.key)).toEqual([...APP_PERSONAS]);
    for (const t of PROJECT_ROLE_TEMPLATES) expect(t.rank, t.key).toBe(APP_RANK[t.key]);
  });
  it('every grant names a known capability and only actions it supports', () => {
    for (const t of [...PROJECT_ROLE_TEMPLATES, ...PROJECT_PERMISSION_SET_TEMPLATES]) {
      for (const g of t.grants) {
        const c = PROJECT_CAPABILITIES.find((x) => x.key === g.capability);
        expect(c, `${t.key} ${g.capability}`).toBeTruthy();
        for (const a of g.actions) expect(c?.actions, `${t.key} ${g.capability}:${a}`).toContain(a);
        expect(g.actions).toEqual(ACTIONS.filter((a) => g.actions.includes(a)));
      }
    }
  });
});

describe('spec §2.2 persona shape', () => {
  const has = (key: string, cap: string, action: string): boolean =>
    !!PROJECT_ROLE_TEMPLATES.find((t) => t.key === key)?.grants.some((g) => g.capability === cap && g.actions.includes(action as never));
  it('jobs_all only for the all-jobs personas', () => {
    for (const k of ['projects_owner', 'projects_gm', 'projects_office_manager', 'projects_project_accountant', 'projects_dispatcher', 'projects_purchasing']) {
      expect(has(k, 'projects.jobs_all', 'view'), k).toBe(true);
    }
    for (const k of ['projects_pm', 'projects_supervisor', 'projects_labor', 'projects_sales']) expect(has(k, 'projects.jobs_all', 'view'), k).toBe(false);
  });
  it('money levels: no job dollars for labor / supervisor / dispatcher; pay rates only for owner / gm', () => {
    for (const k of ['projects_labor', 'projects_supervisor', 'projects_dispatcher']) {
      expect(has(k, 'projects.financials', 'view'), k).toBe(false);
      expect(has(k, 'projects.contract_value', 'view'), k).toBe(false);
    }
    expect(has('projects_office_manager', 'projects.financials', 'view')).toBe(false);
    expect(has('projects_office_manager', 'projects.contract_value', 'view')).toBe(true);
    for (const k of PERSONA_KEYS) expect(has(k, 'projects.labor_rates', 'view'), k).toBe(k === 'projects_owner' || k === 'projects_gm');
    expect(has('projects_gm', 'projects.labor_rates', 'edit')).toBe(false);
    expect(has('projects_owner', 'projects.settings', 'configure')).toBe(true);
    expect(has('projects_gm', 'projects.settings', 'configure')).toBe(false);
  });
});

describe('DB mirror == code', () => {
  it('core.capabilities holds exactly the projects registry (and nothing else under module projects)', async () => {
    const r = await db.query<CapRow>(`select * from core.capabilities where module = 'projects' order by key`);
    const byKey = new Map(r.rows.map((x) => [x.key, x]));
    expect([...byKey.keys()].sort()).toEqual(PROJECT_CAPABILITIES.map((c) => c.key).sort());
    for (const c of PROJECT_CAPABILITIES) {
      const row = byKey.get(c.key);
      expect(row, c.key).toBeTruthy();
      expect({
        domain: row?.domain, actions: row?.actions, label: row?.label, description: row?.description, tags: row?.tags,
        risk: row?.risk_tier, platform: row?.platform_only, fields: row?.field_classes, constraints: row?.supports_constraints, status: row?.status,
      }, c.key).toEqual({
        domain: c.domain, actions: [...c.actions], label: c.label, description: c.description, tags: [...c.tags],
        risk: riskTier(c), platform: isPlatformOnly(c), fields: [...c.fieldClasses], constraints: [...c.supportsConstraints], status: c.status,
      });
    }
  });

  it('every platform persona template publishes exactly its code grants and metadata', async () => {
    for (const t of PROJECT_ROLE_TEMPLATES) {
      const r = await db.query<{ grants: unknown; audience: string; default_scope: string; field_policy: unknown; auth_policy: unknown; assignable_band: string; name: string; current_version: number }>(
        `select core.rbac_role_current_grants(id) as grants, audience, default_scope, field_policy, auth_policy, assignable_band, name, current_version
           from core.role_definitions where owner_level = 'platform' and key = $1`, [t.key]);
      const row = r.rows[0];
      expect(row, t.key).toBeTruthy();
      expect(row.current_version, t.key).toBeGreaterThanOrEqual(1); // a later migration republishes a changed template (1111: supervisor)
      expect({ name: row.name, audience: row.audience, scope: row.default_scope, field: row.field_policy, auth: row.auth_policy, band: row.assignable_band }, t.key)
        .toEqual({ name: t.name, audience: t.audience, scope: t.defaultScope, field: t.fieldPolicy, auth: t.authPolicy, band: t.assignableBand });
      expect(row.grants, t.key).toEqual(t.grants.map((g) => ({ capability: g.capability, actions: g.actions, constraints: g.constraints })));
    }
  });

  it('every platform permission set publishes exactly its code grants', async () => {
    for (const s of PROJECT_PERMISSION_SET_TEMPLATES) {
      const r = await db.query<{ grants: unknown }>(`select core.rbac_set_current_grants(id) as grants from core.permission_sets where owner_level = 'platform' and key = $1`, [s.key]);
      expect(r.rows[0]?.grants, s.key).toEqual(s.grants.map((g) => ({ capability: g.capability, actions: g.actions, constraints: g.constraints })));
    }
  });

  it('tenants get a standard clone of every template (role_key resolves to the template key)', async () => {
    const r = await db.query<{ key: string; upstream: string; grants: unknown }>(
      `select d.key, u.key as upstream, core.rbac_role_current_grants(d.id) as grants
         from core.role_definitions d join core.role_definitions u on u.id = d.upstream_template_id
        where d.owner_level = 'tenant' and d.org_id = 'c0000000-0000-4000-8000-000000000001' and d.key like 'projects\\_%' order by d.key`);
    expect(r.rows.map((x) => x.key)).toEqual([...PERSONA_KEYS].sort());
    for (const row of r.rows) {
      expect(row.upstream).toBe(row.key);
      expect(row.grants).toEqual(PROJECT_ROLE_TEMPLATES.find((t) => t.key === row.key)?.grants);
    }
    const sets = await db.query<{ key: string }>(`select key from core.permission_sets where owner_level = 'tenant' and org_id = 'c0000000-0000-4000-8000-000000000001' and key like 'projects\\_%' order by key`);
    expect(sets.rows.map((x) => x.key)).toEqual(PROJECT_PERMISSION_SET_TEMPLATES.map((s) => s.key).sort());
  });

  it('pm.access_persona_rank mirrors the template ranks', async () => {
    for (const t of PROJECT_ROLE_TEMPLATES) {
      const r = await db.query<{ n: number }>(`select pm.access_persona_rank($1) as n`, [t.key]);
      expect(r.rows[0].n, t.key).toBe(t.rank);
    }
  });

  it('GENERATED blocks are up to date with the code (each block in its latest carrier; 1110 is frozen live history)', () => {
    const carriers = renderCarriers();
    expect(carriers.size).toBeGreaterThan(0);
    for (const [file, c] of carriers) expect(c.rendered === c.current, `${file}: ${c.blocks.join(', ')}`).toBe(true);
  });
});
