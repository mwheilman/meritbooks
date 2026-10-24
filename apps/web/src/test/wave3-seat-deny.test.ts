/**
 * H1 guard (security review): every RLS table created by migrations 185–190 carries the 1110
 * Projects-only seat deny (RESTRICTIVE `projects_only_seat_deny`).
 *
 * 1110_pm_access.sql is NOT in the PGlite replay (only NNN_ files are), so the migrations
 * guard their call with to_regprocedure(...). This test replays through 184, installs the 1110
 * contract (core.apply_projects_only_seat_deny copied verbatim; core.is_projects_only_seat
 * stubbed on a test GUC), applies 185–190, and asserts the policy is on every table they create.
 * A static check also requires each file to name every table it creates in its seat-deny block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import { asClaims } from './wave3-db-helpers';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/supabase/migrations');
const WAVE3 = ['185', '186', '187', '188', '189', '190'];
const files = listMigrationFiles().filter((f) => WAVE3.includes(f.slice(0, 3)));

function createdTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.([a-z_][a-z0-9_]*)/gi)) out.add(m[1].toLowerCase());
  return Array.from(out).sort();
}

function seatDenyTables(sql: string): Set<string> {
  // the guarded blocks: foreach t in array array['a', 'b', ...] loop perform core.apply_projects_only_seat_deny(...)
  const out = new Set<string>();
  const re = /array\s*\[([^\]]*)\]\s*loop\s*perform\s+core\.apply_projects_only_seat_deny/gi;
  for (const m of sql.matchAll(re)) for (const t of m[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) out.add(t[1]);
  return out;
}

const ORG = '11111111-1111-1111-1111-1111111e3185';

// 1110's contract, verbatim apply function; the seat predicate is a test switch.
const INSTALL_1110_CONTRACT = `
  create or replace function core.is_projects_only_seat() returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as $$
    select coalesce(current_setting('test.projects_only_seat', true), '') = 'on'
  $$;
  grant execute on function core.is_projects_only_seat() to authenticated, service_role;
  create or replace function core.apply_projects_only_seat_deny(p_table regclass) returns void
  language plpgsql
  set search_path = core, public, pg_temp
  as $$
  begin
    execute format('drop policy if exists projects_only_seat_deny on %s', p_table);
    execute format('create policy projects_only_seat_deny on %s as restrictive for all to authenticated '
                   'using (not (select core.is_projects_only_seat())) with check (not (select core.is_projects_only_seat()))', p_table);
  end $$;
  revoke all on function core.apply_projects_only_seat_deny(regclass) from public, anon, authenticated;
  grant execute on function core.apply_projects_only_seat_deny(regclass) to service_role;
`;

describe('H1 static: every 185–190 table is named in its migration\'s seat-deny block', () => {
  for (const f of files) {
    it(f, () => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const tables = createdTables(sql);
      expect(tables.length).toBeGreaterThan(0);
      const covered = seatDenyTables(sql);
      expect(tables.filter((t) => !covered.has(t)), `${f} tables without apply_projects_only_seat_deny`).toEqual([]);
    });
  }
});

describe('H1 replay: projects_only_seat_deny is on every RLS table 185–190 create', () => {
  let db: PGlite;
  const all = files.flatMap((f) => createdTables(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')));

  beforeAll(async () => {
    ({ db } = await createTestDb({ supabaseDefaultGrants: true, through: '184' }));
    await db.exec(INSTALL_1110_CONTRACT);
    const rest = listMigrationFiles().filter((f) => f > '184_zzz');
    for (const f of rest) await applyMigrationFile(db, f);
    await db.exec(`insert into core.organizations (id, name, slug) values ('${ORG}', 'Seat Org', 'seat-org-e3')`);
    await db.exec(`insert into public.report_layouts (org_id, name, statement) values ('${ORG}', 'Seat layout', 'PNL')`);
  }, 300_000);

  afterAll(async () => {
    await db?.close();
  });

  it('every created table has RLS on and the restrictive deny for authenticated', async () => {
    const r = await db.query<{ t: string; rls: boolean; deny: boolean }>(
      `select c.relname t, c.relrowsecurity rls,
              exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                        and p.policyname = 'projects_only_seat_deny' and p.permissive = 'RESTRICTIVE'
                        and p.cmd = 'ALL' and p.roles::text like '%authenticated%') deny
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[]) order by 1`,
      [all],
    );
    expect(r.rows.map((x) => x.t).sort()).toEqual([...all].sort());
    expect(r.rows.filter((x) => !x.rls || !x.deny).map((x) => x.t)).toEqual([]);
  });

  it('re-running a migration keeps the deny (its policy-reset loop preserves it)', async () => {
    for (const f of files) await applyMigrationFile(db, f);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from pg_policies where schemaname = 'public' and policyname = 'projects_only_seat_deny' and tablename = any($1::text[])`,
      [all],
    );
    expect(r.rows[0].n).toBe(new Set(all).size);
  });

  it('a Projects-only seat reads nothing from a Wave 3 table; a Books member does', async () => {
    const read = () => asClaims(db, 'authenticated', { sub: 'user_seat', org_id: ORG }, async () =>
      (await db.query(`select id from public.report_layouts`)).rows.length);
    expect(await read()).toBe(1);
    await db.exec(`set test.projects_only_seat = 'on'`);
    try {
      expect(await read()).toBe(0);
    } finally {
      await db.exec(`reset test.projects_only_seat`);
    }
  });
});
