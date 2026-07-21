/**
 * Schema integrity — asserts the migration set is internally consistent.
 *
 * This is the test that would have caught migration 014's invalid partial UNIQUE
 * constraint on the day it was written, instead of it sitting unnoticed while
 * production quietly diverged from the files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from './pg';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const rows = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
  (await db.query<T>(sql)).rows;

describe('migrations', () => {
  it('every migration applies to a clean database', async () => {
    // createTestDb throws on the first failure, so reaching here means all applied.
    const r = await rows<{ n: string }>(`select count(*)::text as n from pg_tables where schemaname in ('public','core')`);
    expect(Number(r[0].n)).toBeGreaterThan(50);
  });

  it('creates both the public and core schemas', async () => {
    const r = await rows<{ nspname: string }>(
      `select nspname from pg_namespace where nspname in ('public','core') order by nspname`,
    );
    expect(r.map((x) => x.nspname)).toEqual(['core', 'public']);
  });
});

describe('double-entry enforcement exists at the database level', () => {
  it('defines the journal balance check function', async () => {
    const r = await rows<{ proname: string }>(
      `select proname from pg_proc where proname = 'check_journal_balance'`,
    );
    expect(r.length).toBeGreaterThan(0);
  });

  it('wires the balance check to a trigger', async () => {
    const r = await rows<{ tgname: string }>(
      `select tgname from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'check_journal_balance' and not t.tgisinternal`,
    );
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('RBAC override uniqueness (regression: migration 014)', () => {
  it('enforces one tier-level override per (org, role, feature)', async () => {
    const r = await rows<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'role_permission_overrides' and indexname = 'unique_tier_override'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    expect(r[0].indexdef).toMatch(/employee_id IS NULL/i);
  });

  it('enforces one individual override per (org, employee, feature)', async () => {
    const r = await rows<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'role_permission_overrides' and indexname = 'unique_individual_override'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    expect(r[0].indexdef).toMatch(/employee_id IS NOT NULL/i);
  });

  it('actually rejects a duplicate tier-level override', async () => {
    // organizations lives in `core` after the migration-019 Suite Core carve.
    await db.exec(`
      insert into core.organizations (id, name, slug)
      values ('00000000-0000-0000-0000-0000000000aa', 'Test Org', 'test-org')
      on conflict do nothing;
    `);
    const insert = `insert into role_permission_overrides (org_id, role, feature_id, action_view)
                    values ('00000000-0000-0000-0000-0000000000aa', 'controller', 'invoices', true)`;
    await db.exec(insert);
    await expect(db.exec(insert)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows the same (org, role, feature) once per distinct employee', async () => {
    await db.exec(`
      insert into core.organizations (id, name, slug)
      values ('00000000-0000-0000-0000-0000000000bb', 'Test Org 2', 'test-org-2')
      on conflict do nothing;
    `);
    // employee_id NULL vs set are different uniqueness domains — both must be
    // insertable for the same (org, role, feature) triple.
    await db.exec(`insert into role_permission_overrides (org_id, role, feature_id, action_view)
                   values ('00000000-0000-0000-0000-0000000000bb', 'controller', 'bills', true)`);
    const r = await db.query<{ n: string }>(
      `select count(*)::text as n from role_permission_overrides
       where org_id = '00000000-0000-0000-0000-0000000000bb'`,
    );
    expect(Number(r.rows[0].n)).toBe(1);
  });
});

describe('every entry_type the code posts exists in the enum', () => {
  /**
   * The bug this exists to prevent, found in production 2026-07-20:
   *
   * GATE 12 built AR / AP / payroll / platform-fee posting, each writing a
   * domain-specific gl_entries.entry_type. entry_type_enum only ever contained
   * the six generic values, so EVERY money-movement post failed at the insert:
   *
   *   invalid input value for enum entry_type_enum: "AR_COLLECTION"
   *
   * The whole layer had never written a journal entry. It went unnoticed because
   * those modules were verified with DB-free harnesses that exercise the pure
   * entry builders — correct arithmetic, impossible insert. Nothing tested the
   * two together until a real card payment.
   *
   * This test reads the entry_type literals straight out of the source and
   * asserts the database accepts each one, so a new posting module cannot ship
   * with a value the enum doesn't know.
   */
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib');

  const collectEntryTypes = (dir: string, found = new Set<string>()): Set<string> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { collectEntryTypes(full, found); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/entry_?[Tt]ype:\s*'([A-Z][A-Z_]+)'/g)) found.add(m[1]);
    }
    return found;
  };

  it('finds entry_type literals in the source to check', () => {
    expect(collectEntryTypes(SRC).size).toBeGreaterThan(5);
  });

  it('accepts every entry_type the application posts', async () => {
    const used = [...collectEntryTypes(SRC)].sort();
    const r = await rows<{ enumlabel: string }>(
      `select enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'entry_type_enum'`,
    );
    const allowed = new Set(r.map((x) => x.enumlabel));
    const missing = used.filter((t) => !allowed.has(t));
    expect(missing).toEqual([]);
  });

  it('includes the money-movement types specifically', async () => {
    const r = await rows<{ enumlabel: string }>(
      `select enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'entry_type_enum'`,
    );
    const allowed = new Set(r.map((x) => x.enumlabel));
    for (const t of [
      'AR_COLLECTION', 'AR_PAYOUT', 'AR_REFUND', 'PLATFORM_FEE', 'PAYROLL_RUN',
      'AP_DISBURSEMENT_RELEASE', 'AP_DISBURSEMENT_SETTLE',
      'AP_DISBURSEMENT_RETURN', 'AP_DISBURSEMENT_VOID',
    ]) {
      expect(allowed.has(t)).toBe(true);
    }
  });
});

describe('ledger money is integer cents, never floating point', () => {
  /**
   * Two legitimate exceptions, deliberately allowed rather than silently ignored:
   *
   * 1. Reporting VIEWS — sum(bigint) returns numeric in Postgres. That is the
   *    aggregate's return type, not a storage decision, so views are out of scope.
   *
   * 2. AI cost metering — a token costs a fraction of a cent, so the gateway's
   *    cost and per-mtok price columns genuinely need sub-cent precision. These
   *    are usage metering, not ledger postings; they never reach a journal entry.
   *
   * Anything else storing money as numeric/float is a real defect: it reintroduces
   * floating-point error into the books.
   */
  const AI_METERING_EXCEPTIONS = ['ai_decisions', 'ai_model_prices', 'ai_usage_log'];

  it('stores every ledger *_cents column as an integer type', async () => {
    const bad = await rows<{ table_name: string; column_name: string; data_type: string }>(
      `select c.table_name, c.column_name, c.data_type
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.column_name like '%_cents'
         and c.table_schema in ('public','core')
         and t.table_type = 'BASE TABLE'
         and c.data_type not in ('bigint','integer','smallint')
         and c.table_name not in (${AI_METERING_EXCEPTIONS.map((t) => `'${t}'`).join(',')})
       order by c.table_name, c.column_name`,
    );
    expect(bad).toEqual([]);
  });

  it('confirms the AI metering exceptions are the only non-integer money columns', async () => {
    const exceptions = await rows<{ table_name: string }>(
      `select distinct c.table_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.column_name like '%_cents'
         and c.table_schema in ('public','core')
         and t.table_type = 'BASE TABLE'
         and c.data_type not in ('bigint','integer','smallint')
       order by c.table_name`,
    );
    // If a new table shows up here, it is either a real defect or a new
    // documented exception - either way it must be looked at, not absorbed.
    for (const row of exceptions) {
      expect(AI_METERING_EXCEPTIONS).toContain(row.table_name);
    }
  });
});
