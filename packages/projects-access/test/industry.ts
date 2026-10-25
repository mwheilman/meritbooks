/**
 * Shared setup for the 1122 industry-depth suites (dealer, manufacturing, flooring, design,
 * development): the two-tenant fixture, every migration after 1110 (1122 must apply; another
 * Wave B file still in progress is skipped and reported), and small helpers.
 */

import { applyMigration, listMigrationFiles } from './pg';
import { as, buildFixture, errorOf, q, type Fixture, type Persona, ORG_A, L1 } from './fixture';

export const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;

export async function setupIndustry(label: string): Promise<Fixture> {
  const f = await buildFixture();
  const skipped: string[] = [];
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if ([1111, 1112, 1113, 1115, 1117, 1122].includes(n)) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[${label}] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
  // the fixture's job type uses machine 'm' with no stages: give it an initial stage so jobs can be created
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                    select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs
                     where not exists (select 1 from pm.stage_defs s where s.install_id = pack_installs.id and s.stage_key = 'active')`);
  return f;
}

export async function one<T = Record<string, unknown>>(f: Fixture, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

/** Call a SQL expression as a persona and return column `r`. */
export async function call<T = unknown>(f: Fixture, p: Persona, sql: string, params: unknown[] = []): Promise<T> {
  return as(f, p, async () => (await q<{ r: T }>(f.db, `select ${sql} as r`, params))[0]!.r);
}

/** The error text of a call as a persona (null when it succeeds). */
export async function callErr(f: Fixture, p: Persona, sql: string, params: unknown[] = []): Promise<string | null> {
  return as(f, p, async () => errorOf(f.db, `select ${sql}`, params));
}

export async function registryClean(f: Fixture): Promise<{ unclassified: unknown[]; unguarded: unknown[]; anon: unknown[]; seat: unknown[] }> {
  return {
    unclassified: await q(f.db, `select * from pm.access_unclassified_tables()`),
    unguarded: await q(f.db, `select * from pm.access_unguarded_rpcs()`),
    anon: await q(f.db, `select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`),
    seat: await q(f.db, `select * from pm.access_seat_unprotected_tables()`),
  };
}

/** Re-apply 1122: counts of its tables must not change. */
export async function reapply1122(f: Fixture): Promise<void> {
  await applyMigration(f.db, '1122_pm_industry_depth.sql');
}

export async function stockLocation(f: Fixture, code: string, kind = 'WAREHOUSE', loc = L1): Promise<string> {
  return (await one<{ id: string }>(f, `insert into pm.stock_locations (org_id, location_id, code, name, kind) values ($1, $2, $3, $3, $4) returning id`,
    [ORG_A, loc, code, kind])).id;
}

export async function vendor(f: Fixture, name: string): Promise<string> {
  return (await one<{ id: string }>(f, `insert into core.vendors (org_id, name) values ($1, $2) returning id`, [ORG_A, name])).id;
}

export async function customer(f: Fixture, name: string): Promise<string> {
  return (await one<{ id: string }>(f, `insert into core.customers (org_id, name) values ($1, $2) returning id`, [ORG_A, name])).id;
}

export async function costCode(f: Fixture, code: string, name: string, type = 'OTHER', loc = L1): Promise<string> {
  return (await one<{ id: string }>(f, `insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, $3, $4, $5) returning id`,
    [ORG_A, loc, code, name, type])).id;
}

export async function documentRow(f: Fixture, name = 'photo.jpg'): Promise<string> {
  const cols = (await q<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(f.db,
    `select column_name, is_nullable, column_default, data_type from information_schema.columns where table_schema = 'public' and table_name = 'documents'`));
  const vals: Record<string, unknown> = { org_id: ORG_A };
  for (const c of cols) {
    if (c.column_name in vals || c.is_nullable === 'YES' || c.column_default != null) continue;
    vals[c.column_name] = c.data_type.includes('uuid') ? '00000000-0000-4000-8000-000000000999'
      : c.data_type.includes('int') || c.data_type === 'numeric' || c.data_type === 'bigint' ? 1
      : c.data_type.includes('bool') ? false : c.data_type.includes('timestamp') || c.data_type === 'date' ? new Date().toISOString() : name;
  }
  const keys = Object.keys(vals);
  return (await one<{ id: string }>(f, `insert into public.documents (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    keys.map((k) => vals[k]))).id;
}
