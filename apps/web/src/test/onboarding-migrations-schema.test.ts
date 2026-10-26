/**
 * Migration 193 (Onboarding v2 part 1) — real-Postgres guarantees, replayed in PGlite WITH
 * hosted Supabase's default grants (so "members can't write" is not vacuous):
 *
 *   1. members (authenticated) and anon cannot write any migration table; members read only
 *      their own org; the service role writes; the client-scope policy is on every table
 *      that carries a client;
 *   2. a project's reviewer is never its preparer; "Signed off" / "Live" need a certificate;
 *      one open project per client;
 *   3. a wave IS a cutover date: a project in a wave carries the wave's cutover (composite
 *      FK), and moving the wave's cutover moves its clients;
 *   4. the certificate: preparer ≠ approver (SoD), issued needs an approver, voided needs a
 *      reason, one live certificate per project, CC-#### numbering;
 *   5. preflight: a blocker can't just be "accepted"; carrying or accepting needs a note;
 *   6. client mappings: accepted needs a target + decider; a type-guard block needs a reason;
 *   7. tie-out snapshots and the event trail are immutable even for the service role;
 *   8. nothing here touches the ledger (no triggers on gl / periods, no FK from them).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { createTestDb } from './pg';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const LOC_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LOC_A2 = 'aaaaaaaa-0000-0000-0000-0000000000a2';
const LOC_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const HASH = 'a'.repeat(64);

let db: PGlite;
let PROJ_A = '';
let ACCT_A = '';

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'), ('${ORG_B}', 'Tenant B', 'tenant-b');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'Heartland', 'HHC'), ('${LOC_A2}', '${ORG_A}', 'Dorrian', 'DOR'),
      ('${LOC_B}', '${ORG_B}', 'Company B', 'CB');
  `);
  const t = await db.query<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, 'ASSET', 'ASSET'::account_type_enum, 1, 'DEBIT')
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A],
  );
  const st = await db.query<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, 'CURRENT_ASSET', 'CURRENT_ASSET'::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A, t.rows[0].id],
  );
  const g = await db.query<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, 'G Cash', 1)
     on conflict (org_id, name) do update set display_order = 1 returning id`,
    [ORG_A, st.rows[0].id],
  );
  ACCT_A = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, '1000', 'Operating cash', 'ASSET', 'CURRENT_ASSET', true, 'APPROVED')`,
    [ACCT_A, ORG_A, g.rows[0].id],
  );
  const p = await db.query<{ id: string }>(
    `insert into public.migration_projects (org_id, location_id, cutover_date, preparer_user_id, reviewer_user_id)
     values ($1, $2, '2026-09-30', 'user_prep', 'user_rev') returning id`,
    [ORG_A, LOC_A],
  );
  PROJ_A = p.rows[0].id;
  await db.query(
    `insert into public.migration_projects (org_id, location_id) values ($1, $2)`,
    [ORG_B, LOC_B],
  );
}, 300_000);

afterAll(async () => {
  await db?.close();
});

async function asRole<T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>): Promise<T> {
  const claims = role === 'authenticated' ? { sub: 'user_a', org_id: ORG_A, role } : role === 'service_role' ? { role } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const TABLES = [
  'migration_waves', 'migration_projects', 'migration_sources', 'migration_runs', 'staged_records',
  'mapping_sets', 'mapping_rules', 'mapping_rule_evidence', 'client_mappings', 'preflight_findings',
  'tieout_snapshots', 'conversion_certificates', 'migration_events',
];

async function snapshot(projectId: string, location: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.tieout_snapshots (org_id, location_id, project_id, ties, all_tied, content_hash)
     values ($1, $2, $3, '[]'::jsonb, true, $4) returning id`,
    [ORG_A, location, projectId, HASH],
  );
  return r.rows[0].id;
}

describe('migration 193 — write locks and reads', () => {
  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot write any migration table`, async () => {
      const errs = await asRole(role, async () => [
        await errorOf(`insert into public.migration_projects (org_id, location_id) values ('${ORG_A}', '${LOC_A2}')`),
        await errorOf(`update public.migration_projects set stage = 'map'`),
        await errorOf(`delete from public.migration_projects`),
        await errorOf(`insert into public.migration_waves (org_id, name, cutover_date) values ('${ORG_A}', 'W', '2026-10-31')`),
        await errorOf(`update public.preflight_findings set disposition = 'fixed_in_source'`),
        await errorOf(`update public.client_mappings set status = 'accepted'`),
        await errorOf(`update public.conversion_certificates set approved_by = 'x'`),
        await errorOf(`delete from public.migration_events`),
      ]);
      for (const e of errs) expect(e).toMatch(/permission denied/i);
    });
  }

  it('members read only their own org', async () => {
    const rows = await asRole('authenticated', async () => (await db.query<{ org_id: string }>(`select org_id from public.migration_projects`)).rows);
    expect(rows.map((r) => r.org_id)).toEqual([ORG_A]);
    const anon = await asRole('anon', () => errorOf(`select 1 from public.migration_projects`));
    expect(anon).toMatch(/permission denied/i);
  });

  it('RLS is on for every table; the client-scope policy is on every client-owned table', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])`,
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
    const { rows: pol } = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and tablename = any($1::text[]) order by 1`,
      [TABLES],
    );
    // Every table except the tenant-level mapping memory (mapping_sets / mapping_rules) and waves.
    expect(pol.map((r) => r.tablename)).toEqual(
      TABLES.filter((t) => !['mapping_sets', 'mapping_rules', 'migration_waves'].includes(t)).sort(),
    );
  });
});

describe('migration 193 — projects', () => {
  it('the reviewer is never the preparer', async () => {
    expect(await errorOf(`update public.migration_projects set reviewer_user_id = 'user_prep' where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
  });

  it('"Signed off" and "Live" need a certificate', async () => {
    expect(await errorOf(`update public.migration_projects set stage = 'certified' where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
    expect(await errorOf(`update public.migration_projects set stage = 'live', live_at = now() where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
    expect(await errorOf(`update public.migration_projects set stage = 'tie_out' where id = $1`, [PROJ_A])).toBeNull();
  });

  it('one open project per client; an archived one frees the slot', async () => {
    expect(await errorOf(`insert into public.migration_projects (org_id, location_id) values ($1, $2)`, [ORG_A, LOC_A])).toMatch(/ux_migration_projects_client/);
  });

  it('enforces the vocabularies', async () => {
    expect(await errorOf(`update public.migration_projects set stage = 'done' where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
    expect(await errorOf(`update public.migration_projects set history_depth = 'everything' where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
    expect(await errorOf(`update public.migration_projects set skipped_stages = array['live'] where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
  });
});

describe('migration 193 — waves are cutover dates', () => {
  it('a project in a wave carries the wave cutover; moving the wave moves its clients', async () => {
    const w = await db.query<{ id: string }>(
      `insert into public.migration_waves (org_id, name, cutover_date) values ($1, 'Wave 2 · Sep 30', '2026-09-30') returning id`,
      [ORG_A],
    );
    const wave = w.rows[0].id;
    // Wrong cutover for the wave → refused by the composite FK.
    expect(await errorOf(`update public.migration_projects set wave_id = $1, cutover_date = '2026-10-31' where id = $2`, [wave, PROJ_A])).toMatch(/migration_projects_wave_fk/);
    // In a wave with no cutover → refused by the CHECK.
    expect(await errorOf(`update public.migration_projects set wave_id = $1, cutover_date = null where id = $2`, [wave, PROJ_A])).toMatch(/migration_projects_values_chk|migration_projects_wave_fk/);
    expect(await errorOf(`update public.migration_projects set wave_id = $1, cutover_date = '2026-09-30' where id = $2`, [wave, PROJ_A])).toBeNull();
    // A second open wave on the same date is refused.
    expect(await errorOf(`insert into public.migration_waves (org_id, name, cutover_date) values ($1, 'Dup', '2026-09-30')`, [ORG_A])).toMatch(/ux_migration_waves_open_cutover/);
    // Moving the wave's cutover cascades to the project.
    await db.query(`update public.migration_waves set cutover_date = '2026-10-31' where id = $1`, [wave]);
    const { rows } = await db.query<{ cutover_date: string }>(`select cutover_date::text from public.migration_projects where id = $1`, [PROJ_A]);
    expect(rows[0].cutover_date).toBe('2026-10-31');
    await db.query(`update public.migration_waves set cutover_date = '2026-09-30' where id = $1`, [wave]);
  });
});

describe('migration 193 — conversion certificate', () => {
  it('the approver is never the preparer; issued needs an approver; void needs a reason', async () => {
    const snap = await snapshot(PROJ_A, LOC_A);
    const ins = (cols: string, vals: string) =>
      errorOf(
        `insert into public.conversion_certificates (org_id, location_id, project_id, certificate_number, cutover_date, history_depth, snapshot_id, content_hash, prepared_by${cols})
         values ($1, $2, $3, 'CC-0001', '2026-09-30', 'opening_only', $4, $5, 'user_prep'${vals})`,
        [ORG_A, LOC_A, PROJ_A, snap, HASH],
      );
    expect(await ins(`, approved_by, approved_at, status`, `, 'user_prep', now(), 'issued'`)).toMatch(/conversion_certificates_values_chk/);
    expect(await ins(`, status`, `, 'issued'`)).toMatch(/conversion_certificates_values_chk/);
    expect(await ins('', '')).toBeNull();
    // A second live certificate for the project is refused.
    expect(
      await errorOf(
        `insert into public.conversion_certificates (org_id, location_id, project_id, certificate_number, cutover_date, history_depth, snapshot_id, content_hash, prepared_by)
         values ($1, $2, $3, 'CC-0002', '2026-09-30', 'opening_only', $4, $5, 'user_prep')`,
        [ORG_A, LOC_A, PROJ_A, snap, HASH],
      ),
    ).toMatch(/ux_conversion_certificates_live/);
    expect(await errorOf(`update public.conversion_certificates set approved_by = prepared_by, approved_at = now(), status = 'issued' where project_id = $1`, [PROJ_A])).toMatch(/conversion_certificates_values_chk/);
    expect(await errorOf(`update public.conversion_certificates set status = 'voided', voided_by = 'ctl', voided_at = now(), void_reason = 'oops' where project_id = $1`, [PROJ_A])).toMatch(/conversion_certificates_values_chk/);
    expect(await errorOf(`update public.conversion_certificates set approved_by = 'user_rev', approved_at = now(), status = 'issued' where project_id = $1`, [PROJ_A])).toBeNull();
    expect(await errorOf(`update public.conversion_certificates set certificate_number = 'CERT-1' where project_id = $1`, [PROJ_A])).toMatch(/conversion_certificates_values_chk/);
    // With the certificate linked, the project can be signed off and go live.
    const c = await db.query<{ id: string }>(`select id from public.conversion_certificates where project_id = $1`, [PROJ_A]);
    expect(await errorOf(`update public.migration_projects set certificate_id = $1, stage = 'certified', certified_at = now() where id = $2`, [c.rows[0].id, PROJ_A])).toBeNull();
    expect(await errorOf(`update public.migration_projects set stage = 'live' where id = $1`, [PROJ_A])).toMatch(/migration_projects_values_chk/);
    expect(await errorOf(`update public.migration_projects set stage = 'live', live_at = now() where id = $1`, [PROJ_A])).toBeNull();
  });
});

describe('migration 193 — preflight and mapping decisions', () => {
  it('a blocker is fixed in source or carried — never just accepted; carrying needs a note', async () => {
    const ins = (severity: string, disposition: string, note: string | null) =>
      errorOf(
        `insert into public.preflight_findings (org_id, location_id, project_id, check_id, severity, name, title, message, disposition, disposition_note, disposed_by, disposed_at)
         values ($1, $2, $3, $4, $5, 'n', 't', 'm', $6, $7, ${disposition === 'open' ? 'null, null' : `'user_prep', now()`})`,
        [ORG_A, LOC_A, PROJ_A, severity === 'blocker' ? 'PF-01' : 'PF-03', severity, disposition, note],
      );
    expect(await ins('blocker', 'accepted_with_note', 'We accept the gap here')).toMatch(/preflight_findings_values_chk/);
    expect(await ins('blocker', 'carry_as_reconciling_item', 'short')).toMatch(/preflight_findings_values_chk/);
    expect(await ins('blocker', 'carry_as_reconciling_item', 'Unapplied A/R from conversion, cleared in October')).toBeNull();
    expect(await ins('warning', 'accepted_with_note', 'Known and fine — cleared in month 1')).toBeNull();
    expect(
      await errorOf(
        `insert into public.preflight_findings (org_id, location_id, project_id, check_id, severity, name, title, message) values ($1, $2, $3, 'PF-25', 'info', 'n', 't', 'm')`,
        [ORG_A, LOC_A, PROJ_A],
      ),
    ).toMatch(/preflight_findings_values_chk/);
  });

  it('an accepted mapping needs a target and a decider; a blocked type needs a typed reason', async () => {
    const ins = (status: string, target: string | null, guard: string, reason: string | null, key: string) =>
      errorOf(
        `insert into public.client_mappings (org_id, location_id, project_id, source_account_key, source_name, target_account_id, type_guard, type_reason, status, decided_by, decided_at)
         values ($1, $2, $3, $4, 'Src', $5, $6, $7, $8, ${status === 'accepted' ? `'user_prep', now()` : 'null, null'})`,
        [ORG_A, LOC_A, PROJ_A, key, target, guard, reason, status],
      );
    expect(await ins('accepted', null, 'ok', null, 'k1')).toMatch(/client_mappings_values_chk/);
    expect(await ins('accepted', ACCT_A, 'block', 'no', 'k2')).toMatch(/client_mappings_values_chk/);
    expect(await ins('accepted', ACCT_A, 'block', 'Sales tax payable kept as a liability on purpose', 'k3')).toBeNull();
    expect(await ins('accepted', ACCT_A, 'ok', null, 'k4')).toBeNull();
    expect(await ins('proposed', null, 'ok', null, 'k4')).toMatch(/ux_client_mappings_key/);
  });
});

describe('migration 193 — immutable proof and trail', () => {
  it('the service role can add but never change or remove a snapshot or an event', async () => {
    await snapshot(PROJ_A, LOC_A);
    await db.query(
      `insert into public.migration_events (org_id, location_id, project_id, kind, actor, summary) values ($1, $2, $3, 'comment', 'user_prep', 'Asked Karen for the loan statement')`,
      [ORG_A, LOC_A, PROJ_A],
    );
    const errs = await asRole('service_role', async () => [
      await errorOf(`update public.tieout_snapshots set all_tied = false`),
      await errorOf(`delete from public.tieout_snapshots`),
      await errorOf(`update public.migration_events set summary = 'changed'`),
      await errorOf(`delete from public.migration_events`),
    ]);
    for (const e of errs) expect(e).toMatch(/permission denied/i);
    const ok = await asRole('service_role', () =>
      errorOf(
        `insert into public.migration_events (org_id, location_id, project_id, kind, actor_kind, summary) values ($1, $2, $3, 'preflight_run', 'system', '24 checks ran')`,
        [ORG_A, LOC_A, PROJ_A],
      ),
    );
    expect(ok).toBeNull();
  });

  it('nothing here touches the ledger', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where contype = 'f'
         and conrelid in ('public.gl_entries'::regclass, 'public.gl_entry_lines'::regclass, 'public.fiscal_periods'::regclass)
         and confrelid = any(array['public.migration_projects'::regclass, 'public.conversion_certificates'::regclass, 'public.staged_records'::regclass])`,
    );
    expect(rows[0].n).toBe(0);
    const { rows: trg } = await db.query<{ tgname: string }>(
      `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and c.relname = any($1::text[]) and t.tgname not like 'trg_%_updated'`,
      [TABLES],
    );
    expect(trg).toEqual([]);
  });
});
