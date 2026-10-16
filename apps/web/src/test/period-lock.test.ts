/**
 * Period lock on INSERT + posted-line immutability (migration 152).
 *
 * Replays every migration into a real Postgres (PGlite) and drives the GL
 * triggers directly, asserting:
 *   - a POSTED entry INSERTED into a HARD_CLOSE period is rejected (was only
 *     blocked on UPDATE before 152),
 *   - OPEN and SOFT_CLOSE periods still accept postings (canon Rule F),
 *   - a fiscal_period_id that points at an open period can't smuggle an entry
 *     dated into a hard-closed month,
 *   - lines of a POSTED entry can't be deleted or have amounts rewritten, while
 *     dimension tagging (memo/job) still works and header-delete cascades
 *     (rollback / sandbox reset / org teardown) still succeed.
 *
 * Self-contained harness: same replay as ./pg.ts plus a `storage.foldername`
 * stub (migration 112 needs it; ./pg.ts doesn't ship it yet).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/supabase/migrations',
);

const STUBS = `
  create extension if not exists pg_trgm;
  create extension if not exists pgcrypto;
  create extension if not exists "uuid-ossp";
  create schema if not exists auth;
  create schema if not exists vault;
  create schema if not exists extensions;
  create schema if not exists storage;
  create or replace function auth.jwt()  returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create or replace function auth.uid()  returns uuid  language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text  language sql stable as $$ select 'service_role'::text $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
  create table if not exists storage.objects (
    id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner text, metadata jsonb
  );
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
  $$;
`;

const ORG = '11111111-1111-1111-1111-111111111111';
const LOC = '22222222-2222-2222-2222-222222222222';
const CASH = '33333333-3333-3333-3333-333333333331';
const EQUITY = '33333333-3333-3333-3333-333333333332';
// 2025-01 HARD_CLOSE, 2025-02 SOFT_CLOSE, 2025-03 OPEN
const P_HARD = '44444444-4444-4444-4444-444444444401';
const P_SOFT = '44444444-4444-4444-4444-444444444402';
const P_OPEN = '44444444-4444-4444-4444-444444444403';

let db: PGlite;
let applied = 0;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm, pgcrypto, uuid_ossp } });
  await db.exec(STUBS);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
      .replace(/create\s+extension[^;]*supabase_vault[^;]*;/gi, '');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied++;
  }

  await db.exec(`
    insert into core.organizations (id, name, slug) values ('${ORG}', 'Lock Test Co', 'lock-test');
    insert into core.locations (id, org_id, name, short_code) values ('${LOC}', '${ORG}', 'HQ', 'HQ');

    with t as (
      insert into public.account_types (org_id, name, code, display_order, normal_balance)
      values ('${ORG}', 'Asset', 'ASSET', 1, 'DEBIT') returning id
    ), st as (
      insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
      select '${ORG}', t.id, 'Current Asset', 'CURRENT_ASSET', 1 from t returning id
    ), g as (
      insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
      select '${ORG}', st.id, 'Cash', 1 from st returning id
    )
    insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, approval_status)
    select v.id::uuid, '${ORG}', g.id, v.num, v.nm, v.ty::account_type_enum, v.sty::account_sub_type_enum, 'APPROVED'
      from g, (values ('${CASH}', '1000', 'Cash', 'ASSET', 'CURRENT_ASSET'),
                      ('${EQUITY}', '3000', 'Equity', 'EQUITY', 'EQUITY')) v(id, num, nm, ty, sty);

    insert into public.fiscal_periods (id, org_id, location_id, period_year, period_month, start_date, end_date, status) values
      ('${P_HARD}', '${ORG}', '${LOC}', 2025, 1, '2025-01-01', '2025-01-31', 'HARD_CLOSE'),
      ('${P_SOFT}', '${ORG}', '${LOC}', 2025, 2, '2025-02-01', '2025-02-28', 'SOFT_CLOSE'),
      ('${P_OPEN}', '${ORG}', '${LOC}', 2025, 3, '2025-03-01', '2025-03-31', 'OPEN');
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

let seq = 0;
/** Insert an entry header; returns its id. Throws (DB error) when a trigger rejects. */
async function insertEntry(opts: { periodId: string; date: string; status?: string }): Promise<string> {
  seq++;
  const res = await db.query<{ id: string }>(
    `insert into public.gl_entries
       (org_id, location_id, entry_number, entry_date, entry_type, fiscal_period_id, source_module, status, posted_at, created_by)
     values ($1, $2, $3, $4, 'STANDARD', $5, 'GL_HISTORY', $6::transaction_status_enum, now(), null)
     returning id`,
    [ORG, LOC, `T-${seq}`, opts.date, opts.periodId, opts.status ?? 'POSTED'],
  );
  return res.rows[0].id;
}

/** Two balanced lines (DR cash / CR equity) in one statement. */
async function insertLines(entryId: string, cents = 10_000): Promise<void> {
  await db.query(
    `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id)
     values ($1, $2, 1, $3, $5, 0, $6), ($1, $2, 2, $4, 0, $5, $6)`,
    [ORG, entryId, CASH, EQUITY, cents, LOC],
  );
}

async function lineCount(entryId: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int n from public.gl_entry_lines where gl_entry_id = $1`, [entryId]);
  return r.rows[0].n;
}

describe('migration 152 — period lock on INSERT', () => {
  it('replays every migration including 152', () => {
    expect(applied).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '152_period_lock_on_insert.sql'))).toBe(true);
  });

  it('installs the lock as BEFORE INSERT OR UPDATE', async () => {
    const r = await db.query<{ def: string }>(
      `select pg_get_triggerdef(oid) def from pg_trigger where tgname = 'trg_enforce_period_lock'`,
    );
    expect(r.rows[0].def).toMatch(/BEFORE INSERT OR UPDATE ON public\.gl_entries/);
  });

  it('rejects a POSTED entry inserted into a HARD_CLOSE period', async () => {
    await expect(insertEntry({ periodId: P_HARD, date: '2025-01-15' })).rejects.toThrow(/hard-closed period/);
  });

  it('accepts a POSTED entry into an OPEN period', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-10' });
    await insertLines(id);
    expect(await lineCount(id)).toBe(2);
  });

  it('accepts a POSTED entry into a SOFT_CLOSE period', async () => {
    const id = await insertEntry({ periodId: P_SOFT, date: '2025-02-10' });
    await insertLines(id);
    expect(await lineCount(id)).toBe(2);
  });

  it('rejects an entry dated into a hard-closed month even if fiscal_period_id points at an open one', async () => {
    await expect(insertEntry({ periodId: P_OPEN, date: '2025-01-20' })).rejects.toThrow(/hard-closed period 2025-01/);
  });

  it('still allows a PENDING (unposted) entry in a hard-closed period, but not promoting it to POSTED', async () => {
    const id = await insertEntry({ periodId: P_HARD, date: '2025-01-15', status: 'PENDING' });
    await expect(
      db.query(`update public.gl_entries set status = 'POSTED' where id = $1`, [id]),
    ).rejects.toThrow(/hard-closed period/);
  });

  it('rejects re-dating a posted entry into, or out of, a hard-closed period', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-11' });
    await insertLines(id);
    await expect(
      db.query(`update public.gl_entries set entry_date = '2025-01-11', fiscal_period_id = $2 where id = $1`, [id, P_HARD]),
    ).rejects.toThrow(/hard-closed period/);

    // Out of: post in an open month, then hard-close it, then try to move it out.
    const id2 = await insertEntry({ periodId: P_SOFT, date: '2025-02-12' });
    await insertLines(id2);
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = $1`, [P_SOFT]);
    try {
      await expect(
        db.query(`update public.gl_entries set entry_date = '2025-03-12', fiscal_period_id = $2 where id = $1`, [id2, P_OPEN]),
      ).rejects.toThrow(/out of hard-closed period/);
    } finally {
      await db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where id = $1`, [P_SOFT]);
    }
  });

  it('allows voiding a posted entry and non-date header edits (unchanged behavior)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-13' });
    await insertLines(id);
    await db.query(`update public.gl_entries set memo = 'edited' where id = $1`, [id]);
    await db.query(`update public.gl_entries set status = 'VOIDED', voided_at = now(), void_reason = 'test' where id = $1`, [id]);
    const r = await db.query<{ status: string }>(`select status::text status from public.gl_entries where id = $1`, [id]);
    expect(r.rows[0].status).toBe('VOIDED');
  });
});

describe('migration 152 — posted lines are immutable', () => {
  it('rejects deleting a line of a POSTED entry', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-14' });
    await insertLines(id);
    await expect(
      db.query(`delete from public.gl_entry_lines where gl_entry_id = $1`, [id]),
    ).rejects.toThrow(/posted journal entry/);
    expect(await lineCount(id)).toBe(2);
  });

  it('rejects changing the amount or account of a posted line', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-15' });
    await insertLines(id);
    await expect(
      db.query(`update public.gl_entry_lines set debit_cents = 1 where gl_entry_id = $1 and line_number = 1`, [id]),
    ).rejects.toThrow(/posted journal entry/);
    await expect(
      db.query(`update public.gl_entry_lines set account_id = $2 where gl_entry_id = $1 and line_number = 1`, [id, EQUITY]),
    ).rejects.toThrow(/posted journal entry/);
  });

  it('still allows dimension tagging (memo / job) on a posted line', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-16' });
    await insertLines(id);
    await db.query(`update public.gl_entry_lines set memo = 'tagged' where gl_entry_id = $1 and line_number = 1`, [id]);
    const r = await db.query<{ memo: string }>(`select memo from public.gl_entry_lines where gl_entry_id = $1 and line_number = 1`, [id]);
    expect(r.rows[0].memo).toBe('tagged');
  });

  it('allows deleting / editing lines of an unposted (PENDING) entry', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-17', status: 'PENDING' });
    await insertLines(id);
    await db.query(`update public.gl_entry_lines set debit_cents = 5 where gl_entry_id = $1 and line_number = 1`, [id]);
    await db.query(`delete from public.gl_entry_lines where gl_entry_id = $1`, [id]);
    expect(await lineCount(id)).toBe(0);
  });

  it('allows the posting-rollback header delete (POSTED header whose line insert failed)', async () => {
    // postJournalEntry: header committed (txn 1), line insert fails + rolls back
    // (txn 2), header deleted (txn 3). A line-less POSTED header has no ledger
    // effect, so 153 still allows deleting it.
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-18' });
    await expect(
      db.query(
        `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id)
         values ($1, $2, 1, $3, 100, 0, $4)`,
        [ORG, id, CASH, LOC],
      ),
    ).rejects.toThrow(/unbalanced/);
    expect(await lineCount(id)).toBe(0);
    await db.query(`delete from public.gl_entries where id = $1`, [id]);
    const r = await db.query<{ n: number }>(`select count(*)::int n from public.gl_entries where id = $1`, [id]);
    expect(r.rows[0].n).toBe(0);
  });

  it('a header-delete cascade of a POSTED entry WITH lines needs the purge opt-in (153)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-18' });
    await insertLines(id);
    await expect(db.query(`delete from public.gl_entries where id = $1`, [id])).rejects.toThrow(/Cannot delete posted journal entry/);
    expect(await lineCount(id)).toBe(2);
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('meritbooks.allow_ledger_purge', 'on', true)`);
      await tx.query(`delete from public.gl_entries where id = $1`, [id]);
    });
    expect(await lineCount(id)).toBe(0);
  });

  it('allows a bulk purge inside a transaction that opts in via meritbooks.allow_ledger_purge', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-19' });
    await insertLines(id);
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('meritbooks.allow_ledger_purge', 'on', true)`);
      await tx.query(`delete from public.gl_entry_lines where gl_entry_id = $1`, [id]);
    });
    expect(await lineCount(id)).toBe(0);
    // The opt-out is transaction-local: it does not leak into the next statement.
    const id2 = await insertEntry({ periodId: P_OPEN, date: '2025-03-20' });
    await insertLines(id2);
    await expect(
      db.query(`delete from public.gl_entry_lines where gl_entry_id = $1`, [id2]),
    ).rejects.toThrow(/posted journal entry/);
  });

  it('tears down a whole tenant (org delete cascade) only with the purge opt-in (153)', async () => {
    const ORG2 = '55555555-5555-5555-5555-555555555555';
    const LOC2 = '66666666-6666-6666-6666-666666666666';
    await db.exec(`
      insert into core.organizations (id, name, slug) values ('${ORG2}', 'Teardown Co', 'teardown');
      insert into core.locations (id, org_id, name, short_code) values ('${LOC2}', '${ORG2}', 'HQ', 'HQ');
      insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
        values ('${ORG2}', '${LOC2}', 2025, 3, '2025-03-01', '2025-03-31', 'OPEN');
    `);
    const p = await db.query<{ id: string }>(`select id from public.fiscal_periods where org_id = $1`, [ORG2]);
    const e = await db.query<{ id: string }>(
      `insert into public.gl_entries (org_id, location_id, entry_number, entry_date, fiscal_period_id, source_module, status, created_by)
       values ($1, $2, 'TD-1', '2025-03-05', $3, 'GL_HISTORY', 'POSTED', null) returning id`,
      [ORG2, LOC2, p.rows[0].id],
    );
    // Lines may reference ORG's accounts here — only the cascade behavior is under test.
    await db.query(
      `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id)
       values ($1, $2, 1, $3, 100, 0, $5), ($1, $2, 2, $4, 0, 100, $5)`,
      [ORG2, e.rows[0].id, CASH, EQUITY, LOC2],
    );
    // Without the opt-in, the cascade hits the posted-header guard and the whole
    // org delete rolls back — a tenant's books can't be dropped by accident.
    await expect(db.query(`delete from core.organizations where id = $1`, [ORG2])).rejects.toThrow(/Cannot delete posted journal entry/);
    const before = await db.query<{ n: number }>(`select count(*)::int n from public.gl_entry_lines where org_id = $1`, [ORG2]);
    expect(before.rows[0].n).toBe(2);

    await db.transaction(async (tx) => {
      await tx.query(`select set_config('meritbooks.allow_ledger_purge', 'on', true)`);
      await tx.query(`delete from core.organizations where id = $1`, [ORG2]);
    });
    const r = await db.query<{ n: number }>(`select count(*)::int n from public.gl_entry_lines where org_id = $1`, [ORG2]);
    expect(r.rows[0].n).toBe(0);
  });
});

describe('migration 153 — posted GL immutability (direct PostgREST bypass)', () => {
  it('postJournalEntry-style posting still works: POSTED header (txn 1), all lines in one statement (txn 2)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-21' });
    await insertLines(id);
    expect(await lineCount(id)).toBe(2);
  });

  it('multiple line statements inside ONE transaction are still allowed (server-side SQL)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-21' });
    await db.transaction(async (tx) => {
      for (const [n, cents] of [[1, 100], [3, 200]] as const) {
        await tx.query(
          `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id)
           values ($1, $2, $6, $3, $5, 0, $7), ($1, $2, $6 + 1, $4, 0, $5, $7)`,
          [ORG, id, CASH, EQUITY, cents, n, LOC],
        );
      }
    });
    expect(await lineCount(id)).toBe(4);
  });

  it('void still works in an OPEN period (and SOFT_CLOSE)', async () => {
    for (const [p, d] of [[P_OPEN, '2025-03-22'], [P_SOFT, '2025-02-22']] as const) {
      const id = await insertEntry({ periodId: p, date: d });
      await insertLines(id);
      await db.query(`update public.gl_entries set status = 'VOIDED', voided_at = now(), void_reason = 'test' where id = $1`, [id]);
      const r = await db.query<{ status: string }>(`select status::text status from public.gl_entries where id = $1`, [id]);
      expect(r.rows[0].status).toBe('VOIDED');
    }
  });

  it('rejects deleting a POSTED header that has lines', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-23' });
    await insertLines(id);
    await expect(db.query(`delete from public.gl_entries where id = $1`, [id])).rejects.toThrow(/Cannot delete posted journal entry/);
    expect(await lineCount(id)).toBe(2);
  });

  it('still allows deleting an unposted (PENDING) header with lines', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-23', status: 'PENDING' });
    await insertLines(id);
    await db.query(`delete from public.gl_entries where id = $1`, [id]);
    expect(await lineCount(id)).toBe(0);
  });

  it('rejects un-posting (POSTED -> PENDING) even in an OPEN period', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-24' });
    await insertLines(id);
    await expect(db.query(`update public.gl_entries set status = 'PENDING' where id = $1`, [id])).rejects.toThrow(/Cannot un-post/);
  });

  it('rejects any status change out of POSTED inside a HARD_CLOSE period — including void', async () => {
    const id = await insertEntry({ periodId: P_SOFT, date: '2025-02-24' });
    await insertLines(id);
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = $1`, [P_SOFT]);
    try {
      await expect(db.query(`update public.gl_entries set status = 'PENDING' where id = $1`, [id])).rejects.toThrow(/Cannot un-post/);
      await expect(db.query(`update public.gl_entries set status = 'VOIDED' where id = $1`, [id])).rejects.toThrow(/hard-closed/);
      const r = await db.query<{ status: string }>(`select status::text status from public.gl_entries where id = $1`, [id]);
      expect(r.rows[0].status).toBe('POSTED');
    } finally {
      await db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where id = $1`, [P_SOFT]);
    }
  });

  it('rejects un-voiding (VOIDED is terminal)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-25' });
    await insertLines(id);
    await db.query(`update public.gl_entries set status = 'VOIDED' where id = $1`, [id]);
    await expect(db.query(`update public.gl_entries set status = 'POSTED' where id = $1`, [id])).rejects.toThrow(/voided journal entry/);
  });

  it('rejects a late line insert into an already-posted entry (lines committed by an earlier transaction)', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-26' });
    await insertLines(id);
    // A balanced pair — the balance trigger alone would let this through.
    await expect(insertLines(id, 5_000)).rejects.toThrow(/Cannot add a line to posted journal entry/);
    expect(await lineCount(id)).toBe(2);
  });

  it('rejects a line insert into a posted entry whose period has since been hard-closed', async () => {
    const id = await insertEntry({ periodId: P_SOFT, date: '2025-02-26' });
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = $1`, [P_SOFT]);
    try {
      await expect(insertLines(id)).rejects.toThrow(/hard-closed/);
    } finally {
      await db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where id = $1`, [P_SOFT]);
    }
  });

  it('rejects filling a stale line-less POSTED header', async () => {
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-27' });
    await db.query(`update public.gl_entries set created_at = now() - interval '1 hour' where id = $1`, [id]);
    await expect(insertLines(id)).rejects.toThrow(/stale posted journal entry/);
  });

  it('purge_org_ledger() clears an org ledger (service_role path) and the opt-out does not leak', async () => {
    const ORG3 = '77777777-7777-7777-7777-777777777777';
    const LOC3 = '88888888-8888-8888-8888-888888888888';
    await db.exec(`
      insert into core.organizations (id, name, slug) values ('${ORG3}', 'Purge Co', 'purge-co');
      insert into core.locations (id, org_id, name, short_code) values ('${LOC3}', '${ORG3}', 'HQ', 'HQ');
      insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
        values ('${ORG3}', '${LOC3}', 2025, 3, '2025-03-01', '2025-03-31', 'OPEN');
    `);
    const p = await db.query<{ id: string }>(`select id from public.fiscal_periods where org_id = $1`, [ORG3]);
    const e = await db.query<{ id: string }>(
      `insert into public.gl_entries (org_id, location_id, entry_number, entry_date, fiscal_period_id, source_module, status, created_by)
       values ($1, $2, 'PG-1', '2025-03-05', $3, 'GL_HISTORY', 'POSTED', null) returning id`,
      [ORG3, LOC3, p.rows[0].id],
    );
    await db.query(
      `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id)
       values ($1, $2, 1, $3, 100, 0, $5), ($1, $2, 2, $4, 0, 100, $5)`,
      [ORG3, e.rows[0].id, CASH, EQUITY, LOC3],
    );
    const res = await db.query<{ n: number }>(`select public.purge_org_ledger($1) n`, [ORG3]);
    expect(res.rows[0].n).toBe(1);
    const r = await db.query<{ n: number }>(`select count(*)::int n from public.gl_entry_lines where org_id = $1`, [ORG3]);
    expect(r.rows[0].n).toBe(0);
    // The ORG ledger (posted, with lines) is still protected afterwards.
    const id = await insertEntry({ periodId: P_OPEN, date: '2025-03-28' });
    await insertLines(id);
    await expect(db.query(`delete from public.gl_entries where id = $1`, [id])).rejects.toThrow(/Cannot delete posted journal entry/);
  });

  it('revokes EXECUTE on the guard functions + purge RPC from anon / authenticated', async () => {
    for (const fn of [
      'public.guard_posted_gl_header_delete()',
      'public.enforce_period_lock()',
      'public.guard_posted_gl_lines()',
      'public.purge_org_ledger(uuid)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} on ${fn}`).toBe(false);
      }
    }
    const s = await db.query<{ ok: boolean }>(`select has_function_privilege('service_role', 'public.purge_org_ledger(uuid)', 'execute') ok`);
    expect(s.rows[0].ok).toBe(true);
  });
});
