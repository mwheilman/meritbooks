/**
 * Migration 169 (Dealer Pack, FPB-dealer-pack.md) — replayed into a real Postgres.
 *
 * Proves: every dealer table exists with RLS on, member read-only (writes revoked —
 * approval/posting state is control data) + the mig 163 client-scope policy; the new
 * entry types and account roles are registered; the enable gate refuses an unmapped
 * client; role resolution follows the FPB fallbacks; the tie-out view ties subledger
 * to GL; and the DB backstops (preparer ≠ approver, proposer ≠ releaser, trade policy,
 * claim footing, posted-row immutability, unit cost maintained from posted rows).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG_A = '00000000-0000-0000-0000-00000000d1a1';
const ORG_B = '00000000-0000-0000-0000-00000000d1b1';
const C1 = '00000000-0000-0000-0000-00000000d1c1';
const C2 = '00000000-0000-0000-0000-00000000d1c2';
const LB = '00000000-0000-0000-0000-00000000d1b2';

const DEALER_TABLES = [
  'dealer_pack_settings', 'dealer_department_map', 'floor_plan_lines', 'floor_plan_programs', 'dealer_import_batches',
  'dealer_units', 'dealer_unit_costs', 'floor_plan_notes', 'floor_plan_transactions', 'floor_plan_curtailments',
  'lender_statements', 'lender_statement_lines', 'trade_ins', 'dealer_unit_sales', 'warranty_claims', 'oem_programs',
  'oem_incentive_claims', 'oem_statements', 'oem_statement_lines', 'dealer_claim_events',
];

let db: PGlite;
const acct: Record<string, string> = {};
const dept: Record<string, string> = {};
let lender = '';
let oem = '';

async function insertRow(qualified: string, values: Record<string, unknown>): Promise<void> {
  const [schema, table] = qualified.split('.');
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null and is_generated = 'NEVER'`,
    [schema, table],
  );
  const names = Object.keys(values);
  const params: unknown[] = names.map((n) => values[n]);
  const exprs = names.map((_, i) => `$${i + 1}`);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    names.push(c.column_name);
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    if (label.rows[0]) {
      params.push(label.rows[0].enumlabel);
      exprs.push(`$${params.length}::${c.udt_name}`);
    } else if (c.udt_name === 'uuid') exprs.push('gen_random_uuid()');
    else if (c.udt_name === 'date') exprs.push('current_date');
    else if (c.udt_name.startsWith('timestamp')) exprs.push('now()');
    else if (c.udt_name === 'jsonb' || c.udt_name === 'json') exprs.push(`'{}'::${c.udt_name}`);
    else if (c.udt_name.startsWith('_')) exprs.push(`'{}'::${c.udt_name}`);
    else if (/int|numeric|float/.test(c.udt_name)) exprs.push('1');
    else if (c.udt_name === 'bool') exprs.push('false');
    else {
      params.push(`x-${crypto.randomUUID().slice(0, 8)}`);
      exprs.push(`$${params.length}`);
    }
  }
  await db.query(`insert into ${qualified} (${names.join(', ')}) values (${exprs.join(', ')})`, params);
}

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.query<T>(sql, params)).rows[0];

async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type Who = 'member_a' | 'member_b' | 'bk_c1';

async function as<T>(who: Who | 'service', fn: () => Promise<T>): Promise<T> {
  const claims = who === 'service' ? { role: 'service_role' } : { sub: `user_${who}`, org_id: who === 'member_b' ? ORG_B : ORG_A, role: 'authenticated' };
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${who === 'service' ? 'service_role' : 'authenticated'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

let groupSchema = 'public';
async function accountGroup(type: string, subType: string): Promise<string> {
  const t = await one<{ id: string }>(
    `insert into ${groupSchema}.account_types (org_id, name, code, display_order, normal_balance)
     values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A, type, ['ASSET', 'COGS', 'OPEX', 'OTHER'].includes(type) ? 'DEBIT' : 'CREDIT'],
  );
  const st = await one<{ id: string }>(
    `insert into ${groupSchema}.account_sub_types (org_id, account_type_id, name, code, display_order)
     values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG_A, t.id, subType],
  );
  const g = await one<{ id: string }>(
    `insert into ${groupSchema}.account_groups (org_id, account_sub_type_id, name, display_order)
     values ($1, $2, $3, 1) on conflict (org_id, name) do update set display_order = 1 returning id`,
    [ORG_A, st.id, `G ${subType}`],
  );
  return g.id;
}

async function addAccount(key: string, number: string, type: string, subType: string, location: string | null = null): Promise<void> {
  const id = crypto.randomUUID();
  await insertRow('public.accounts', {
    id, org_id: ORG_A, account_group_id: await accountGroup(type, subType),
    account_number: number, name: key, account_type: type, account_sub_type: subType, is_active: true,
    is_company_specific: location !== null, company_location_id: location,
  });
  acct[key] = id;
}

async function mapRole(role: string, key: string, location: string | null = C1): Promise<void> {
  await db.query(`insert into public.account_roles (org_id, role_key, account_id, location_id) values ($1, $2, $3, $4)`, [ORG_A, role, acct[key], location]);
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG_A}', 'Firm A', 'dealer-firm-a', 'firm'), ('${ORG_B}', 'Firm B', 'dealer-firm-b', 'firm');
  `);
  await insertRow('core.locations', { id: C1, org_id: ORG_A, name: 'Dealer One', short_code: 'D1' });
  await insertRow('core.locations', { id: C2, org_id: ORG_A, name: 'Dealer Two', short_code: 'D2' });
  await insertRow('core.locations', { id: LB, org_id: ORG_B, name: 'B Main', short_code: 'BM' });

  groupSchema = (await one<{ s: string }>(`select table_schema as s from information_schema.tables where table_name = 'account_groups' order by table_schema = 'public' desc limit 1`)).s;
  // Accounts used by the dealer roles (numbers are arbitrary — roles map by id).
  await addAccount('WG_INV', '1400', 'ASSET', 'CURRENT_ASSET');
  await addAccount('FPP', '2150', 'LIABILITY', 'CURRENT_LIABILITY', C1);
  await addAccount('FPP_ACCR', '2155', 'LIABILITY', 'CURRENT_LIABILITY');
  await addAccount('INT_EXP', '8000', 'OTHER', 'OTHER_EXPENSE'); // INTEREST_EXPENSE default number
  await addAccount('WG_SALES', '4100', 'REVENUE', 'REVENUE');
  await addAccount('WG_COGS', '5200', 'COGS', 'COST_OF_GOODS_SOLD');
  await addAccount('OVER_ALLOW', '4190', 'REVENUE', 'REVENUE');
  await addAccount('LIEN', '2160', 'LIABILITY', 'CURRENT_LIABILITY');
  await addAccount('WTY_AR', '1170', 'ASSET', 'CURRENT_ASSET');
  await addAccount('WTY_LAB', '4300', 'REVENUE', 'REVENUE');
  await addAccount('WTY_POL', '6900', 'OPEX', 'OPERATING_EXPENSE');
  await addAccount('OEM_AR', '1175', 'ASSET', 'CURRENT_ASSET');
  // pre-existing roles resolve by their standard default numbers
  await addAccount('AR', '1100', 'ASSET', 'CURRENT_ASSET');
  await addAccount('AP', '2000', 'LIABILITY', 'CURRENT_LIABILITY');
  await addAccount('BANK', '1000', 'ASSET', 'CURRENT_ASSET');
  await addAccount('DEPOSITS', '2420', 'LIABILITY', 'CURRENT_LIABILITY');
  await addAccount('PARTS', '1200', 'ASSET', 'CURRENT_ASSET');
  await addAccount('PARTS_COGS', '5100', 'COGS', 'COST_OF_GOODS_SOLD');
  await addAccount('TAX', '2300', 'LIABILITY', 'CURRENT_LIABILITY');

  for (const r of ['WG_NEW', 'WG_USED', 'PARTS', 'SERVICE', 'RENTAL', 'ADMIN']) {
    const id = crypto.randomUUID();
    await insertRow('core.departments', { id, org_id: ORG_A, name: `Dept ${r}`, code: r, location_id: null });
    dept[r] = id;
  }
  lender = crypto.randomUUID();
  oem = crypto.randomUUID();
  await insertRow('core.vendors', { id: lender, org_id: ORG_A, name: 'Lender X' });
  await insertRow('core.vendors', { id: oem, org_id: ORG_A, name: 'Maker Y' });

  // A tenant-A member (bookkeeper) and a tenant-B member, for the RLS checks.
  for (const [who, org] of [['member_a', ORG_A], ['member_b', ORG_B], ['bk_c1', ORG_A]] as const) {
    const u = await one<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_${who}`]);
    await db.query(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'accounting_specialist')`, [u.id, org]);
  }
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('schema: tables, RLS, vocabulary', () => {
  it('creates every dealer table with RLS enabled', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1)`,
      [DEALER_TABLES],
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...DEALER_TABLES].sort());
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });

  it('every dealer table has member_read, service_all and the client-scope policy (mig 163)', async () => {
    const r = await db.query<{ tablename: string; policies: string[] }>(
      `select tablename, array_agg(policyname order by policyname) as policies from pg_policies
        where schemaname = 'public' and tablename = any($1) group by tablename`,
      [DEALER_TABLES],
    );
    expect(r.rows).toHaveLength(DEALER_TABLES.length);
    for (const row of r.rows) expect(row.policies).toEqual(['client_scope_rls', 'member_read', 'service_all']);
  });

  it('registers the seven entry types and 21 role keys with no default account number', async () => {
    const e = await db.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'entry_type_enum'`,
    );
    const labels = new Set(e.rows.map((x) => x.enumlabel));
    for (const t of ['FLOOR_PLAN', 'FLOOR_PLAN_INTEREST', 'UNIT_SALE', 'TRADE_IN', 'WARRANTY_CLAIM', 'OEM_INCENTIVE', 'UNIT_COST']) {
      expect(labels.has(t)).toBe(true);
    }
    const k = await db.query<{ role_key: string; default_account_number: string | null }>(
      `select role_key, default_account_number from core.account_role_keys where role_key = any($1)`,
      [['WHOLE_GOODS_INVENTORY', 'FLOOR_PLAN_PAYABLE', 'TRADE_IN_OVER_ALLOWANCE', 'WARRANTY_RECEIVABLE', 'OEM_INCENTIVE_RECEIVABLE', 'CO_OP_ADVERTISING_RECOVERY']],
    );
    expect(k.rows).toHaveLength(6);
    expect(k.rows.every((x) => x.default_account_number === null)).toBe(true);
  });

  it('no member write grants on dealer tables (control data)', async () => {
    const r = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee in ('authenticated', 'anon') and table_schema = 'public' and table_name = any($1)
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
      [DEALER_TABLES],
    );
    expect(r.rows).toEqual([]);
  });
});

describe('enable gate + role resolution', () => {
  it('refuses to enable a client with unmapped roles / departments, naming what is missing', async () => {
    const missing = await one<{ m: string[] }>(`select public.dealer_pack_missing_requirements($1, $2) as m`, [ORG_A, C1]);
    expect(missing.m).toContain('ROLE:FLOOR_PLAN_PAYABLE');
    expect(missing.m).toContain('DEPT:WG_NEW');
    expect(missing.m).not.toContain('ROLE:AR_CONTROL'); // resolves via its default number 1100
    const err = await errorOf(() =>
      db.query(`insert into public.dealer_pack_settings (org_id, location_id, enabled) values ($1, $2, true)`, [ORG_A, C1]),
    );
    expect(err).toMatch(/cannot be enabled/);
  });

  it('follows the FPB fallbacks (used → whole goods, interest → INTEREST_EXPENSE default number)', async () => {
    await mapRole('WHOLE_GOODS_INVENTORY', 'WG_INV');
    const used = await one<{ a: string }>(`select public.dealer_role_account($1, $2, 'USED_WHOLE_GOODS_INVENTORY') as a`, [ORG_A, C1]);
    expect(used.a).toBe(acct.WG_INV);
    const interest = await one<{ a: string }>(`select public.dealer_role_account($1, $2, 'FLOOR_PLAN_INTEREST') as a`, [ORG_A, C1]);
    expect(interest.a).toBe(acct.INT_EXP);
    const fees = await one<{ a: string }>(`select public.dealer_role_account($1, $2, 'FLOOR_PLAN_FEES') as a`, [ORG_A, C1]);
    expect(fees.a).toBe(acct.INT_EXP);
    // nothing resolves for the other client → refuse to guess
    const other = await one<{ a: string | null }>(`select public.dealer_role_account($1, $2, 'WHOLE_GOODS_INVENTORY') as a`, [ORG_A, C2]);
    expect(other.a).toBeNull();
  });

  it('enables once every required role and department role resolves', async () => {
    for (const [role, key] of [
      ['FLOOR_PLAN_PAYABLE', 'FPP'], ['FLOOR_PLAN_INTEREST_ACCRUED', 'FPP_ACCR'], ['WHOLE_GOODS_SALES', 'WG_SALES'],
      ['WHOLE_GOODS_COGS', 'WG_COGS'], ['TRADE_IN_OVER_ALLOWANCE', 'OVER_ALLOW'], ['TRADE_LIEN_PAYOFF', 'LIEN'],
      ['WARRANTY_RECEIVABLE', 'WTY_AR'], ['WARRANTY_LABOR_SALES', 'WTY_LAB'], ['WARRANTY_POLICY_EXPENSE', 'WTY_POL'],
      ['OEM_INCENTIVE_RECEIVABLE', 'OEM_AR'],
    ] as const) {
      await mapRole(role, key);
    }
    for (const r of Object.keys(dept)) {
      await db.query(`insert into public.dealer_department_map (org_id, location_id, dept_role, department_id) values ($1, $2, $3, $4)`, [ORG_A, C1, r, dept[r]]);
    }
    const m = await one<{ m: string[] }>(`select public.dealer_pack_missing_requirements($1, $2) as m`, [ORG_A, C1]);
    expect(m.m).toEqual([]);
    await db.query(`insert into public.dealer_pack_settings (org_id, location_id, enabled) values ($1, $2, true)`, [ORG_A, C1]);
    const s = await one<{ enabled: boolean }>(`select enabled from public.dealer_pack_settings where location_id = $1`, [C1]);
    expect(s.enabled).toBe(true);
    const roleMap = await db.query<{ role_key: string; account_id: string | null }>(`select * from public.dealer_role_map($1, $2)`, [ORG_A, C1]);
    expect(roleMap.rows.find((r) => r.role_key === 'FLOOR_PLAN_PAYABLE')?.account_id).toBe(acct.FPP);
  });

  it('a department from another tenant is refused (same-tenant guard)', async () => {
    const foreign = crypto.randomUUID();
    await insertRow('core.departments', { id: foreign, org_id: ORG_B, name: 'B dept', code: 'BD', location_id: null });
    const err = await errorOf(() =>
      db.query(`insert into public.dealer_department_map (org_id, location_id, dept_role, department_id) values ($1, $2, 'WG_NEW', $3)`, [ORG_A, C2, foreign]),
    );
    expect(err).toMatch(/not in this organization/);
  });
});

describe('subledger rows, DB backstops, tie-out', () => {
  let lineId = '';
  let unitId = '';
  let noteId = '';

  it('floors a unit; unit cost is maintained from POSTED cost rows only', async () => {
    lineId = (await one<{ id: string }>(
      `insert into public.floor_plan_lines (org_id, location_id, lender_vendor_id, name, credit_limit_cents) values ($1, $2, $3, 'Line 1', 50000000) returning id`,
      [ORG_A, C1, lender],
    )).id;
    unitId = (await one<{ id: string }>(
      `insert into public.dealer_units (org_id, location_id, serial_number, condition, make_vendor_id) values ($1, $2, 'SN-1', 'NEW', $3) returning id`,
      [ORG_A, C1, oem],
    )).id;
    noteId = (await one<{ id: string }>(
      `insert into public.floor_plan_notes (org_id, location_id, line_id, unit_id, lender_invoice_number, floored_date, original_principal_cents, principal_balance_cents, idempotency_key)
       values ($1, $2, $3, $4, 'INV-1', '2026-01-01', 1000000, 1000000, 'k-note-1') returning id`,
      [ORG_A, C1, lineId, unitId],
    )).id;
    await db.query(
      `insert into public.dealer_unit_costs (org_id, location_id, unit_id, cost_type, amount_cents, source_type, status, idempotency_key)
       values ($1, $2, $3, 'BASE_INVOICE', 1000000, 'FLOOR_PLAN_NOTE', 'POSTED', 'k-c1'),
              ($1, $2, $3, 'FREIGHT', 25000, 'BILL_LINE', 'POSTED', 'k-c2'),
              ($1, $2, $3, 'SETUP_PDI', 15000, 'INTERNAL_RO', 'PROPOSED', 'k-c3')`,
      [ORG_A, C1, unitId],
    );
    expect((await one<{ c: string }>(`select cost_cents::text as c from public.dealer_units where id = $1`, [unitId])).c).toBe('1025000');
    await db.query(`update public.dealer_unit_costs set status = 'POSTED' where idempotency_key = 'k-c3'`);
    expect((await one<{ c: string }>(`select cost_cents::text as c from public.dealer_units where id = $1`, [unitId])).c).toBe('1040000');
  });

  it('rejects a second live note on the same unit and a duplicate serial', async () => {
    expect(await errorOf(() =>
      db.query(
        `insert into public.floor_plan_notes (org_id, location_id, line_id, unit_id, lender_invoice_number, floored_date, original_principal_cents, principal_balance_cents, idempotency_key)
         values ($1, $2, $3, $4, 'INV-2', '2026-01-01', 10, 10, 'k-note-2')`,
        [ORG_A, C1, lineId, unitId],
      ),
    )).toMatch(/duplicate key/);
    expect(await errorOf(() =>
      db.query(`insert into public.dealer_units (org_id, location_id, serial_number, condition, make_vendor_id) values ($1, $2, ' sn-1 ', 'NEW', $3)`, [ORG_A, C1, oem]),
    )).toMatch(/duplicate key/);
  });

  it('posted floor-plan transactions and cost rows are immutable', async () => {
    const t = await one<{ id: string }>(
      `insert into public.floor_plan_transactions (org_id, location_id, line_id, note_id, txn_type, txn_date, principal_cents, status, idempotency_key)
       values ($1, $2, $3, $4, 'FLOOR', '2026-01-01', 1000000, 'POSTED', 'k-t1') returning id`,
      [ORG_A, C1, lineId, noteId],
    );
    expect(await errorOf(() => db.query(`update public.floor_plan_transactions set principal_cents = 1 where id = $1`, [t.id]))).toMatch(/immutable/);
    expect(await errorOf(() => db.query(`delete from public.floor_plan_transactions where id = $1`, [t.id]))).toMatch(/immutable/);
    expect(await errorOf(() => db.query(`update public.dealer_unit_costs set amount_cents = 1 where idempotency_key = 'k-c1'`))).toMatch(/immutable/);
  });

  it('a payoff cannot be released by its proposer (DB CHECK)', async () => {
    expect(await errorOf(() =>
      db.query(
        `insert into public.floor_plan_transactions (org_id, location_id, line_id, note_id, txn_type, txn_date, principal_cents, status, proposed_by, released_by, idempotency_key)
         values ($1, $2, $3, $4, 'PAYOFF', '2026-08-15', 900000, 'POSTED', 'user_a', 'user_a', 'k-pay')`,
        [ORG_A, C1, lineId, noteId],
      ),
    )).toMatch(/check constraint/);
  });

  it('a lender reconciliation cannot be approved by its preparer (DB CHECK)', async () => {
    expect(await errorOf(() =>
      db.query(
        `insert into public.lender_statements (org_id, location_id, line_id, kind, statement_date, status, prepared_by, approved_by)
         values ($1, $2, $3, 'STATEMENT', '2026-09-30', 'APPROVED', 'user_a', 'user_a')`,
        [ORG_A, C1, lineId],
      ),
    )).toMatch(/check constraint/);
    await db.query(
      `insert into public.lender_statements (org_id, location_id, line_id, kind, statement_date, status, prepared_by, approved_by)
       values ($1, $2, $3, 'STATEMENT', '2026-09-30', 'APPROVED', 'user_a', 'user_b')`,
      [ORG_A, C1, lineId],
    );
  });

  it('trade-in recorded value follows the policy snapshot; over-allowance is generated', async () => {
    expect(await errorOf(() =>
      db.query(
        `insert into public.trade_ins (org_id, location_id, allowance_cents, acv_cents, valuation_policy, recorded_value_cents)
         values ($1, $2, 300000, 250000, 'LOWER_OF_ACV_AND_ALLOWANCE', 300000)`,
        [ORG_A, C1],
      ),
    )).toMatch(/check constraint/);
    const t = await one<{ over: string }>(
      `insert into public.trade_ins (org_id, location_id, allowance_cents, acv_cents, valuation_policy, recorded_value_cents)
       values ($1, $2, 300000, 250000, 'LOWER_OF_ACV_AND_ALLOWANCE', 250000) returning over_allowance_cents::text as over`,
      [ORG_A, C1],
    );
    expect(t.over).toBe('50000');
  });

  it('a warranty claim must foot: claimed = labor + parts + sublet + freight + other', async () => {
    const sql = `insert into public.warranty_claims (org_id, location_id, oem_vendor_id, labor_cents, parts_cents, claimed_cents) values ($1, $2, $3, 19000, 10400, $4)`;
    expect(await errorOf(() => db.query(sql, [ORG_A, C1, oem, 29000]))).toMatch(/check constraint/);
    await db.query(sql, [ORG_A, C1, oem, 29400]);
  });

  it('tie-out view: notes = floor plan payable, carried units = inventory, to the cent', async () => {
    // Post the flooring + freight + setup to the GL (fixture load: triggers off).
    await db.exec(`set session_replication_role = replica`);
    const je = crypto.randomUUID();
    await insertRow('public.gl_entries', { id: je, org_id: ORG_A, location_id: C1, status: 'POSTED', entry_date: '2026-01-01' });
    const lines: [string, number, number][] = [
      [acct.WG_INV, 1_040_000, 0],
      [acct.FPP, 0, 1_000_000],
      [acct.AP, 0, 40_000],
    ];
    let n = 1;
    for (const [a, dr, cr] of lines) {
      await insertRow('public.gl_entry_lines', { org_id: ORG_A, gl_entry_id: je, line_number: n++, account_id: a, location_id: C1, debit_cents: dr, credit_cents: cr });
    }
    await db.exec(`set session_replication_role = origin`);
    const r = await db.query<{ bucket: string; subledger_cents: string; gl_cents: string; difference_cents: string }>(
      `select bucket, subledger_cents::text, gl_cents::text, difference_cents::text from public.v_dealer_subledger_tieout
        where org_id = $1 and location_id = $2 and bucket in ('FLOOR_PLAN_PAYABLE', 'UNIT_INVENTORY') order by bucket`,
      [ORG_A, C1],
    );
    expect(r.rows).toEqual([
      { bucket: 'FLOOR_PLAN_PAYABLE', subledger_cents: '1000000', gl_cents: '1000000', difference_cents: '0' },
      { bucket: 'UNIT_INVENTORY', subledger_cents: '1040000', gl_cents: '1040000', difference_cents: '0' },
    ]);
    // a curtailment recorded in the subledger but not the GL shows as a difference
    await db.query(`update public.floor_plan_notes set principal_balance_cents = 900000 where id = $1`, [noteId]);
    const d = await one<{ diff: string }>(
      `select difference_cents::text as diff from public.v_dealer_subledger_tieout where location_id = $1 and bucket = 'FLOOR_PLAN_PAYABLE'`,
      [C1],
    );
    expect(d.diff).toBe('-100000');
  });
});

describe('tenant isolation + member write lock', () => {
  it('a tenant-A member reads tenant-A dealer rows; tenant B sees none of them', async () => {
    const a = await as('member_a', async () => (await db.query<{ n: string }>(`select count(*)::text as n from public.dealer_units`)).rows[0].n);
    const b = await as('member_b', async () => (await db.query<{ n: string }>(`select count(*)::text as n from public.dealer_units`)).rows[0].n);
    expect(Number(a)).toBeGreaterThan(0);
    expect(b).toBe('0');
  });

  it('a member cannot insert dealer rows — not into another tenant, not even into their own', async () => {
    const cross = await as('member_b', () =>
      errorOf(() => db.query(`insert into public.dealer_units (org_id, location_id, serial_number, condition) values ($1, $2, 'X1', 'NEW')`, [ORG_A, C1])),
    );
    expect(cross).toMatch(/permission denied/);
    const own = await as('member_a', () =>
      errorOf(() => db.query(`insert into public.dealer_units (org_id, location_id, serial_number, condition) values ($1, $2, 'X2', 'NEW')`, [ORG_A, C1])),
    );
    expect(own).toMatch(/permission denied/);
    const sign = await as('member_a', () =>
      errorOf(() => db.query(`update public.lender_statements set approved_by = 'me'`)),
    );
    expect(sign).toMatch(/permission denied/);
  });

  it('the service role writes (the app path, after requirePermission)', async () => {
    await as('service', () =>
      db.query(`insert into public.dealer_units (org_id, location_id, serial_number, condition) values ($1, $2, 'SVC-1', 'USED')`, [ORG_A, C2]),
    );
    const n = await one<{ n: string }>(`select count(*)::text as n from public.dealer_units where serial_number = 'SVC-1'`);
    expect(n.n).toBe('1');
  });

  it('client scope (mig 163, enforce): a member with no client assignment sees no dealer rows', async () => {
    await db.query(`update core.organizations set client_scope_rls_mode = 'enforce' where id = $1`, [ORG_A]);
    try {
      const n = await as('bk_c1', async () => (await db.query<{ n: string }>(`select count(*)::text as n from public.dealer_units`)).rows[0].n);
      expect(n).toBe('0');
    } finally {
      await db.query(`update core.organizations set client_scope_rls_mode = 'off' where id = $1`, [ORG_A]);
    }
  });
});
