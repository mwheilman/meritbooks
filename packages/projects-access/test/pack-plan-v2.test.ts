/**
 * 1116 — pm.apply_pack_plan accepts workspace plan schema v2 (pack manifest v2 `experience`
 * section) and still accepts v1; the 1110 capability guard survives the in-place patch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compilePlan } from '../../industry-packs/src/index';
import { applyAfter1110, buildFixture, as, q, errorOf, type Fixture, L1 } from './fixture';

let f: Fixture;

beforeAll(async () => {
  f = await buildFixture();
  await applyAfter1110(f.db);
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

describe('1116 pack plan v2', () => {
  it('the owner applies a v2 plan; the experience is stored on the install', async () => {
    const plan = compilePlan({ pack: 'field_service', locationId: L1 });
    expect(plan.schema_version).toBe(2);
    const id = await as(f, 'owner', async () =>
      (await q<{ id: string }>(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary') as id`, [JSON.stringify(plan)]))[0].id);
    expect(id).toBeTruthy();
    const rows = await q<{ default_tab: string; v: string }>(f.db,
      `select resolved #>> '{experience,job_tabs,*,default_tab}' as default_tab, resolved ->> 'schema_version' as v
         from pm.pack_installs where id = $1`, [id]);
    expect(rows[0]).toEqual({ default_tab: 'work_orders', v: '2' });
  });

  it('a v1 plan still applies; any other version is refused', async () => {
    const v1 = { ...compilePlan({ pack: 'general', locationId: L1 }), schema_version: 1 } as Record<string, unknown>;
    delete v1.experience;
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary')`, [JSON.stringify(v1)]))).toBeNull();
    const v3 = { ...v1, schema_version: 3 };
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary')`, [JSON.stringify(v3)])))
      .toMatch(/unsupported schema_version 3 \(expected 1 or 2\)/);
    const none = { ...v1 };
    delete none.schema_version;
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary')`, [JSON.stringify(none)])))
      .toMatch(/unsupported schema_version/);
  });

  it('the 1110 guard is still at the top of the patched function', async () => {
    const def = await q<{ d: string }>(f.db, `select pg_get_functiondef('pm.apply_pack_plan(jsonb,text)'::regprocedure) as d`);
    expect(def[0].d).toContain('pm_access_guard');
    const plan = compilePlan({ pack: 'general', locationId: L1 });
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary')`, [JSON.stringify(plan)]))).toMatch(/PM_FORBIDDEN/);
  });

  it('pm.pack_overrides refuses __proto__ / constructor / prototype in the pointer or the value', async () => {
    const plan = compilePlan({ pack: 'field_service', locationId: L1 });
    const install = await as(f, 'owner', async () =>
      (await q<{ id: string }>(f.db, `select pm.apply_pack_plan($1::jsonb, 'primary') as id`, [JSON.stringify(plan)]))[0].id);
    const ins = (pointer: string, value: unknown) => as(f, 'owner', async () => errorOf(f.db,
      `insert into pm.pack_overrides (install_id, json_pointer, op, value) values ($1, $2, 'add', $3::jsonb)`, [install, pointer, JSON.stringify(value)]));
    expect(await ins('/experience/nav/pm/0/label', 'Change requests')).toBeNull();
    for (const ptr of ['/experience/__proto__/mask', '/experience/constructor/prototype/mask', '/experience/job_tabs/prototype', '/__proto__']) {
      expect(await ins(ptr, false), ptr).toMatch(/pack_overrides_no_proto_chk/);
    }
    expect(await ins('/experience/kiosk', JSON.parse('{"__proto__":{"mask":false}}'))).toMatch(/pack_overrides_no_proto_chk/);
    expect(await ins('/experience/job_tabs/x', { tabs: [{ constructor: 1 }] })).toMatch(/pack_overrides_no_proto_chk/);
    // a word that merely contains one of the names is fine
    expect(await ins('/experience/checklists/0/label', 'Prototype review')).toBeNull();
  });
});
