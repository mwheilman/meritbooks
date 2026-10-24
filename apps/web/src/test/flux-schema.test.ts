/**
 * Migration 187 (flux review) — real-Postgres guarantees, replayed in PGlite WITH hosted
 * Supabase's default grants (so "members can't write" is not vacuous):
 *
 *   1. members (authenticated) and anon cannot INSERT / UPDATE / DELETE the three tables;
 *   2. members read ONLY their own org; the service role writes;
 *   3. a submitted explanation needs text ≥ 10, a category, a preparer and a time;
 *   4. REVIEWED needs a reviewer who is NOT the preparer (segregation of duties);
 *   5. one explanation per (company, month, line); a waiver needs a reason ≥ 10 and an actor;
 *   6. the vocabularies hold; the client-scope policy is present;
 *   7. flux writes leave the ledger and the period lock alone (no trigger on gl / periods).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { createTestDb } from './pg';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const LOC_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LOC_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
let ACCT_A = '';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'), ('${ORG_B}', 'Tenant B', 'tenant-b');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'Company A', 'CA'), ('${LOC_B}', '${ORG_B}', 'Company B', 'CB');
  `);
  // An account to hang explanations on (the automation-close.test.ts seeding pattern).
  const t = await db.query<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, 'OPEX', 'OPEX'::account_type_enum, 1, 'DEBIT')
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A],
  );
  const st = await db.query<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, 'OPERATING_EXPENSE', 'OPERATING_EXPENSE'::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A, t.rows[0].id],
  );
  const g = await db.query<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, 'G OPEX', 1)
     on conflict (org_id, name) do update set display_order = 1 returning id`,
    [ORG_A, st.rows[0].id],
  );
  ACCT_A = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, '6300', 'Repairs', 'OPEX', 'OPERATING_EXPENSE', true, 'APPROVED')`,
    [ACCT_A, ORG_A, g.rows[0].id],
  );
  await db.exec(`
    insert into public.flux_materiality_policies (org_id, location_id) values ('${ORG_A}', null), ('${ORG_B}', null);
  `);
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

async function errorOf(sql: string): Promise<string | null> {
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const insertExpl = (over: string, period = '2026-10', line = 'line-1') =>
  `insert into public.flux_explanations (org_id, location_id, period_key, line_key, account_id, comparison_basis${over ? `, ${over.split('=')[0]}` : ''})
   values ('${ORG_A}', '${LOC_A}', '${period}', '${line}', '${ACCT_A}', 'PRIOR_MONTH'${over ? `, ${over.split('=').slice(1).join('=')}` : ''})`;

describe('migration 187 — write locks', () => {
  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot write the flux tables`, async () => {
      const errs = await asRole(role, async () => [
        await errorOf(`insert into public.flux_materiality_policies (org_id, location_id) values ('${ORG_A}', '${LOC_A}')`),
        await errorOf(`update public.flux_materiality_policies set abs_threshold_cents = 1`),
        await errorOf(`delete from public.flux_materiality_policies`),
        await errorOf(insertExpl('')),
        await errorOf(`update public.flux_explanations set status = 'REVIEWED'`),
        await errorOf(`insert into public.flux_reviews (org_id, location_id, period_key) values ('${ORG_A}', '${LOC_A}', '2026-10')`),
        await errorOf(`delete from public.flux_reviews`),
      ]);
      for (const e of errs) expect(e).toMatch(/permission denied/i);
    });
  }

  it('members read only their own org; the service role writes', async () => {
    const rows = await asRole('authenticated', async () => (await db.query<{ org_id: string }>(`select org_id from public.flux_materiality_policies`)).rows);
    expect(rows.map((r) => r.org_id)).toEqual([ORG_A]);
    expect(await asRole('service_role', () => errorOf(`update public.flux_materiality_policies set abs_threshold_cents = 250000 where org_id = '${ORG_A}'`))).toBeNull();
  });

  it('the client-scope policy is applied to every flux table', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and tablename like 'flux_%' order by 1`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(['flux_explanations', 'flux_materiality_policies', 'flux_reviews']);
  });
});

describe('migration 187 — explanation rules', () => {
  it('a DRAFT needs nothing; a submitted explanation needs text, category, preparer, time', async () => {
    expect(await errorOf(insertExpl('', '2026-01'))).toBeNull();
    expect(await errorOf(insertExpl(`status, explanation='EXPLAINED', 'short'`, '2026-02'))).toMatch(/flux_explanations_chk/);
    expect(await errorOf(insertExpl(`status, explanation, category, prepared_by, prepared_at='EXPLAINED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now()`, '2026-02'))).toBeNull();
  });

  it('REVIEWED by the preparer is refused (SoD); by someone else it is accepted', async () => {
    const cols = `status, explanation, category, prepared_by, prepared_at, reviewed_by, reviewed_at`;
    expect(await errorOf(insertExpl(`${cols}='REVIEWED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now(), 'user_p', now()`, '2026-03'))).toMatch(/flux_explanations_chk/);
    expect(await errorOf(insertExpl(`${cols}='REVIEWED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now(), null, null`, '2026-03'))).toMatch(/flux_explanations_chk/);
    // A review must pin the reviewed text (hash of category + LF + explanation) — no hash, wrong hash: refused.
    expect(await errorOf(insertExpl(`${cols}='REVIEWED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now(), 'user_r', now()`, '2026-03'))).toMatch(/flux_explanations_review_hash_chk/);
    const hash = crypto.createHash('sha256').update('TIMING\nInsurance renewal paid in October', 'utf8').digest('hex');
    expect(await errorOf(insertExpl(`${cols}, reviewed_explanation_hash='REVIEWED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now(), 'user_r', now(), '${'0'.repeat(64)}'`, '2026-03'))).toMatch(/flux_explanations_review_hash_chk/);
    expect(await errorOf(insertExpl(`${cols}, reviewed_explanation_hash='REVIEWED', 'Insurance renewal paid in October', 'TIMING', 'user_p', now(), 'user_r', now(), '${hash}'`, '2026-03'))).toBeNull();
    // The reviewed text can't be swapped while the row stays REVIEWED.
    expect(await errorOf(`update public.flux_explanations set explanation = 'Something else entirely here' where period_key = '2026-03'`)).toMatch(/flux_explanations_review_hash_chk/);
    expect(await errorOf(`update public.flux_explanations set category = 'ONE_TIME' where period_key = '2026-03'`)).toMatch(/flux_explanations_review_hash_chk/);
    // An update cannot sneak the preparer in as reviewer either.
    expect(await errorOf(`update public.flux_explanations set reviewed_by = prepared_by where period_key = '2026-03'`)).toMatch(/flux_explanations_chk/);
  });

  it('one explanation per company, month and line', async () => {
    expect(await errorOf(insertExpl('', '2026-04', 'dup'))).toBeNull();
    expect(await errorOf(insertExpl('', '2026-04', 'dup'))).toMatch(/uq_flux_explanations_line/);
  });

  it('enforces the vocabularies', async () => {
    expect(await errorOf(insertExpl(`category='GUESS'`, '2026-05'))).toMatch(/flux_explanations_chk/);
    expect(await errorOf(insertExpl(`status='APPROVED'`, '2026-05'))).toMatch(/flux_explanations_chk/);
    expect(await errorOf(insertExpl('', '2026-13'))).toMatch(/flux_explanations_chk/);
    expect(await errorOf(`update public.flux_materiality_policies set threshold_mode = 'SOMETIMES' where org_id = '${ORG_A}'`)).toMatch(/flux_materiality_policies_chk/);
    expect(await errorOf(`update public.flux_materiality_policies set comparison_basis = 'QOQ' where org_id = '${ORG_A}'`)).toMatch(/flux_materiality_policies_chk/);
    expect(await errorOf(`update public.flux_materiality_policies set include_pnl = false, include_balance_sheet = false where org_id = '${ORG_A}'`)).toMatch(/flux_materiality_policies_chk/);
  });

  it('one policy per tenant default (NULL company) and per company', async () => {
    expect(await errorOf(`insert into public.flux_materiality_policies (org_id, location_id) values ('${ORG_A}', null)`)).toMatch(/uq_flux_materiality_policies_scope/);
    expect(await errorOf(`insert into public.flux_materiality_policies (org_id, location_id) values ('${ORG_A}', '${LOC_A}')`)).toBeNull();
    expect(await errorOf(`insert into public.flux_materiality_policies (org_id, location_id) values ('${ORG_A}', '${LOC_A}')`)).toMatch(/uq_flux_materiality_policies_scope/);
  });
});

describe('migration 187 — waiver', () => {
  it('a waiver needs a reason ≥ 10 chars and an actor', async () => {
    expect(await errorOf(`insert into public.flux_reviews (org_id, location_id, period_key, status) values ('${ORG_A}', '${LOC_A}', '2026-10', 'WAIVED')`)).toMatch(/flux_reviews_chk/);
    expect(await errorOf(`insert into public.flux_reviews (org_id, location_id, period_key, status, waived_reason, waived_by, waived_at) values ('${ORG_A}', '${LOC_A}', '2026-10', 'WAIVED', 'too short', 'ctl', now())`)).toMatch(/flux_reviews_chk/);
    expect(await errorOf(`insert into public.flux_reviews (org_id, location_id, period_key, status, waived_reason, waived_by, waived_at) values ('${ORG_A}', '${LOC_A}', '2026-10', 'WAIVED', 'Interim close for the lender', 'ctl', now())`)).toBeNull();
    expect(await errorOf(`insert into public.flux_reviews (org_id, location_id, period_key) values ('${ORG_A}', '${LOC_A}', '2026-10')`)).toMatch(/uq_flux_reviews_period/);
  });
});

describe('migration 187 — no ledger / period-lock effect', () => {
  it('no trigger on the flux tables, and none of them is referenced by a gl / period trigger', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and c.relname like 'flux_%'`,
    );
    expect(rows[0].n).toBe(0);
    const { rows: fk } = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where contype = 'f'
         and conrelid in ('public.gl_entries'::regclass, 'public.gl_entry_lines'::regclass, 'public.fiscal_periods'::regclass)
         and confrelid in ('public.flux_explanations'::regclass, 'public.flux_reviews'::regclass, 'public.flux_materiality_policies'::regclass)`,
    );
    expect(fk[0].n).toBe(0);
  });
});
