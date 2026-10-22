/**
 * 1110 security-review fixes (H1, H2, M1, M2, low a–d), against the full migration chain.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, as, q, errorOf, type Fixture, ORG_A, L1, J1, J2, J3 } from './fixture';

let f: Fixture;
const forbidden = /PM_FORBIDDEN/;

beforeAll(async () => {
  f = await buildFixture();
  await f.db.query(`update core.jobs set contract_amount_cents = 2500000, estimated_cost_cents = 1900000, billed_to_date_cents = 400000`);
  await f.db.query(`insert into core.customers (org_id, name, location_id, credit_limit_cents) values ($1, 'Acme', $2, 1000000)`, [ORG_A, L1]);
  await f.db.query(`update core.jobs set customer_id = (select id from core.customers where name = 'Acme') where id = $1`, [J2]);
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

const n = async (p: Parameters<typeof as>[1], sql: string, params: unknown[] = []): Promise<number> =>
  as(f, p, async () => (await q<{ n: number }>(f.db, `select count(*)::int as n from (${sql}) x`, params))[0].n);

describe('H1 core masters for Projects-only seats', () => {
  it('Labor / Supervisor / Dispatcher (Projects-only, no money) read no core.jobs / customers / events row', async () => {
    for (const p of ['labor', 'supervisor', 'dispatcher'] as const) {
      expect(await n(p, `select id from core.jobs`), `${p} jobs`).toBe(0);
      expect(await n(p, `select id from core.customers`), `${p} customers`).toBe(0);
      expect(await n(p, `select id from core.events`), `${p} events`).toBe(0);
    }
  });
  it('a flagged money holder sees core.jobs only for their money jobs; the (unflagged) owner everywhere', async () => {
    const pmRows = await as(f, 'pm', async () => q<{ id: string; contract_amount_cents: string }>(f.db, `select id, contract_amount_cents from core.jobs order by id`));
    expect(pmRows.map((r) => r.id)).toEqual([J1]); // never J2's contract_amount_cents
    expect(await n('gm', `select id from core.jobs`)).toBe(2);
    expect(await n('owner', `select id from core.jobs`)).toBe(3);
  });
  it('seats that are not Projects-only are unchanged (no assignments; Books + Projects)', async () => {
    const u = await q<{ id: string }>(f.db, `insert into core.users (clerk_user_id) values ('user_legacy0') returning id`);
    await f.db.query(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member')`, [u[0].id, ORG_A]);
    await f.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_legacy0', org_id: ORG_A, role: 'authenticated' })]);
    await f.db.exec('set role authenticated');
    try {
      expect((await q<{ n: number }>(f.db, `select count(*)::int n from core.jobs`))[0].n).toBe(3);
    } finally {
      await f.db.exec('reset role');
      await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
    }
    // the same Projects-role seat without the flag is unchanged; with the flag it is narrowed
    await f.db.query(`update core.memberships set projects_only = false where id = $1`, [f.membership.labor]);
    try {
      expect(await n('labor', `select id from core.jobs`)).toBe(3);
    } finally {
      await f.db.query(`update core.memberships set projects_only = true where id = $1`, [f.membership.labor]);
    }
    expect(await n('labor', `select id from core.jobs`)).toBe(0);
  });
  it('pm.v_core_jobs_masked: reachable jobs only, money null without the capability', async () => {
    const l = await as(f, 'labor', async () => q<{ id: string; job_number: string; contract_amount_cents: string | null; estimated_cost_cents: string | null }>(f.db,
      `select id, job_number, contract_amount_cents, estimated_cost_cents from pm.v_core_jobs_masked`));
    expect(l).toEqual([{ id: J2, job_number: 'J2', contract_amount_cents: null, estimated_cost_cents: null }]);
    // the PM works estimates / customers company-wide, so sees L1 job identities — money only on their own job
    const pmv = await as(f, 'pm', async () => q<{ id: string; contract_amount_cents: string | null }>(f.db, `select id, contract_amount_cents from pm.v_core_jobs_masked order by id`));
    expect(pmv.map((r) => [r.id, r.contract_amount_cents === null ? null : Number(r.contract_amount_cents)])).toEqual([[J1, 2500000], [J2, null]]);
    const d = await as(f, 'dispatcher', async () => q<{ id: string; contract_amount_cents: string | null }>(f.db, `select id, contract_amount_cents from pm.v_core_jobs_masked order by id`));
    expect(d.map((r) => r.id)).toEqual([J1, J2].sort());
    expect(d.every((r) => r.contract_amount_cents === null)).toBe(true);
  });
  it("pm.v_core_customers_masked: customers of the caller's jobs, no credit limit", async () => {
    const l = await as(f, 'labor', async () => q<{ name: string; credit_limit_cents: string | null }>(f.db, `select name, credit_limit_cents from pm.v_core_customers_masked`));
    expect(l).toEqual([{ name: 'Acme', credit_limit_cents: null }]);
    const o = await as(f, 'owner', async () => q<{ credit_limit_cents: string | null }>(f.db, `select credit_limit_cents from pm.v_core_customers_masked`));
    expect(Number(o[0].credit_limit_cents)).toBe(1000000);
  });
  it('pm views that joined core.jobs as the caller still work for Projects-only seats', async () => {
    const r = await as(f, 'labor', async () => q<{ job_id: string; job_number: string; customer_name: string }>(f.db, `select job_id, job_number, customer_name from pm.v_project_list`));
    expect(r).toEqual([{ job_id: J2, job_number: 'J2', customer_name: 'Acme' }]);
    expect(await n('labor', `select 1 from pm.v_billing_queue`)).toBe(0);
    // cost_code_usable (invoker, used by member-write triggers) no longer reads core.jobs as the caller
    expect(await as(f, 'labor', async () => errorOf(f.db,
      `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, cost_code_id) values ($1, $2, $3, current_date, 1, $4)`,
      [ORG_A, J2, f.employee.labor, f.ids[`costCode:${L1}`]]))).toBeNull();
  });
});

describe('H2 every member-executable definer RPC is guarded or allowlisted', () => {
  it('no unguarded, non-allowlisted definer function is executable by authenticated or anon', async () => {
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
  });
  it('anon can execute nothing in pm', async () => {
    const r = await q<{ sig: string }>(f.db, `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                               where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r).toEqual([]);
  });
  it('org-only RPCs now need the capability on a reachable job / company', async () => {
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.set_job_customer($1, null, 'X')`, [J2]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.transition_stage($1, 'done')`, [J2]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.create_customer('X', null, null, $1, null, null)`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.create_customer('Y', null, null, $1, null, null)`, [L1])) ?? '').not.toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.create_vendor('V', null, null, null, $1)`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'supervisor', async () => errorOf(f.db, `select pm.adopt_job($1, 'build')`, [J1]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.apply_pack_plan(jsonb_build_object('location_id', $1::text), 'primary')`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.release_to_shop($1)`, [f.ids[`wo:${J2}`]]))).toMatch(forbidden);
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.schedule_work_order($1, now(), now() + interval '1 hour', null, null, false, false)`, [f.ids[`wo:${J2}`]]))).toMatch(forbidden);
  });
  it('a technician may work the work order they are dispatched on, not another', async () => {
    const own = await as(f, 'labor', async () => errorOf(f.db, `select pm.start_work_order($1)`, [f.ids[`wo:${J2}`]]));
    expect(own ?? '').not.toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.start_work_order($1)`, [f.ids[`wo:${J1}`]]))).toMatch(forbidden);
  });
  it('money arguments need the money capability', async () => {
    const u = await q<{ id: string }>(f.db, `insert into pm.units (org_id, job_id, unit_number) values ($1, $2, 'U1') returning id`, [ORG_A, J1]);
    expect(await as(f, 'supervisor', async () => errorOf(f.db, `select pm.set_unit_status($1, 'UNDER_CONTRACT', current_date, null, 50000000)`, [u[0].id]))).toMatch(forbidden);
  });
});

describe('M1 definer views are read-only for members', () => {
  it('no INSERT / UPDATE / DELETE / TRUNCATE for authenticated, nothing for anon, on every definer pm view', async () => {
    const views = await q<{ name: string }>(f.db,
      `select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'pm' and c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ','), '') !~ 'security_invoker=(on|true)'`);
    expect(views.map((v) => v.name)).toEqual(expect.arrayContaining(['v_job_team', 'v_company_team', 'v_tasks_masked', 'v_core_jobs_masked']));
    for (const v of views) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await q<{ ok: boolean }>(f.db, `select has_table_privilege('authenticated', $1, $2) as ok`, [`pm.${v.name}`, priv]);
        expect(r[0].ok, `${v.name} ${priv}`).toBe(false);
      }
      const a = await q<{ ok: boolean }>(f.db, `select has_table_privilege('anon', $1, 'SELECT') as ok`, [`pm.${v.name}`]);
      expect(a[0].ok, `${v.name} anon`).toBe(false);
    }
  });
  it('writing through a masked view is refused', async () => {
    expect(await as(f, 'owner', async () => errorOf(f.db, `update pm.v_tasks_masked set title = 'x'`))).toMatch(/permission denied/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `insert into pm.v_job_team (job_id, membership_id, slot) values ($1, $2, 'crew')`, [J1, f.membership.labor]))).toMatch(/permission denied|cannot insert into view/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `delete from pm.v_core_jobs_masked`))).toMatch(/permission denied/);
  });
});

describe('M2 remaining money columns are masked', () => {
  it('base columns are revoked from members', async () => {
    for (const [t, c] of [['parts', 'cost_cents'], ['price_book_items', 'cost_cents'], ['assets', 'dealer_cost_cents'], ['assets', 'payoff_cents'],
                          ['selections', 'allowance_cents'], ['selections', 'variance_cents'], ['selection_options', 'unit_cost_cents'],
                          ['procurement_items', 'cost_total_cents'], ['dealer_deal_lines', 'cost_cents'], ['dealer_deals', 'finance_reserve_cents'],
                          ['parts_ticket_lines', 'unit_cost_cents'], ['dealer_trades', 'acv_cents']] as const) {
      const r = await q<{ ok: boolean }>(f.db, `select has_column_privilege('authenticated', $1, $2, 'SELECT') as ok`, [`pm.${t}`, c]);
      expect(r[0].ok, `${t}.${c}`).toBe(false);
    }
  });
  it('a dispatcher adding a price-book line gets the cost copied in, but never sees it', async () => {
    const pb = await q<{ id: string }>(f.db, `insert into pm.price_book_items (org_id, location_id, code, name, price_cents, cost_cents) values ($1, $2, 'TUNE', 'Tune-up', 15000, 6000) returning id`, [ORG_A, L1]);
    const err = await as(f, 'dispatcher', async () => errorOf(f.db,
      `insert into pm.work_order_lines (org_id, job_id, work_order_id, price_book_item_id, qty) values ($1, $2, $3, $4, 1)`, [ORG_A, J1, f.ids[`wo:${J1}`], pb[0].id]));
    expect(err).toBeNull();
    const stored = await q<{ unit_cost_cents: string; unit_price_cents: string }>(f.db, `select unit_cost_cents, unit_price_cents from pm.work_order_lines where price_book_item_id = $1`, [pb[0].id]);
    expect([Number(stored[0].unit_cost_cents), Number(stored[0].unit_price_cents)]).toEqual([6000, 15000]);
    const seen = await as(f, 'dispatcher', async () => q<{ cost_cents: string | null; price_cents: string }>(f.db, `select cost_cents, price_cents from pm.v_price_book_items_masked where id = $1`, [pb[0].id]));
    expect(seen).toEqual([{ cost_cents: null, price_cents: 15000 }]);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select * from pm.access_unmasked_price_book_item($1)`, [pb[0].id]))).toMatch(forbidden);
  });
  it('deal documents lose gross keys without financials', async () => {
    const r = await q<{ d: Record<string, unknown> }>(f.db,
      `select pm.access_strip_keys('{"sale_price_cents": 10, "front_gross_cents": 3, "lines": [{"cost_cents": 1, "qty": 2}]}'::jsonb, pm.access_deal_money_keys()) as d`);
    expect(r[0].d).toEqual({ sale_price_cents: 10, lines: [{ qty: 2 }] });
  });
});

/** Insert a row filling every NOT NULL column without a default (enum → first label, numbers → 0, …). */
async function insertRow(schema: string, table: string, values: Record<string, unknown>): Promise<void> {
  const cols = await q<{ column_name: string; udt_name: string }>(f.db,
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null and is_generated = 'NEVER'`, [schema, table]);
  const names = Object.keys(values);
  const params: unknown[] = names.map((k) => values[k]);
  const exprs = names.map((_, i) => `$${i + 1}`);
  for (const c of cols) {
    if (names.includes(c.column_name)) continue;
    const label = await q<{ enumlabel: string }>(f.db, `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`, [c.udt_name]);
    names.push(c.column_name);
    if (label[0]) { params.push(label[0].enumlabel); exprs.push(`$${params.length}::${c.udt_name}`); }
    else if (/int|numeric/.test(c.udt_name)) { params.push(0); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'bool') { params.push(false); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'date' || c.udt_name.startsWith('timestamp')) { params.push('2026-10-01'); exprs.push(`$${params.length}::${c.udt_name}`); }
    else if (c.udt_name === 'uuid') { params.push(crypto.randomUUID()); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'jsonb' || c.udt_name === 'json') { params.push('{}'); exprs.push(`$${params.length}::jsonb`); }
    else { params.push(`x-${crypto.randomUUID().slice(0, 8)}`); exprs.push(`$${params.length}`); }
  }
  await f.db.query(`insert into ${schema}.${table} (${names.join(', ')}) values (${exprs.join(', ')})`, params);
}

describe('Books data is closed to Projects-only seats', () => {
  const SAMPLE = ['invoices', 'gl_entries', 'bills', 'bank_transactions', 'payroll_runs'] as const;
  let booksOwner: string;
  beforeAll(async () => {
    await f.db.exec(`set session_replication_role = replica`); // seed sample rows without Books' posting / balance triggers
    try {
      for (const t of SAMPLE) await insertRow('public', t, { org_id: ORG_A, location_id: L1 });
    } finally {
      await f.db.exec(`set session_replication_role = origin`);
    }
    // an owner who also holds Books grants (Books tenant role "owner")
    await f.db.query(`select core.rbac_import_tenant_roles($1)`, [ORG_A]);
    const u = await q<{ id: string }>(f.db, `insert into core.users (clerk_user_id, email) values ('user_booksOwner', 'booksowner@example.test') returning id`);
    const m = await q<{ id: string }>(f.db, `insert into core.memberships (user_id, org_id, role) values ($1, $2, 'owner') returning id`, [u[0].id, ORG_A]);
    booksOwner = m[0].id;
    const r = await q<{ id: string }>(f.db, `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'owner'`, [ORG_A]);
    await f.db.query(`insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source) values ($1, $2, 'role', $3, 'all_clients', 'manual')`, [ORG_A, booksOwner, r[0].id]);
  });
  const asClerk = async <T>(clerk: string, fn: () => Promise<T>): Promise<T> => {
    await f.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: clerk, org_id: ORG_A, role: 'authenticated' })]);
    await f.db.exec('set role authenticated');
    try { return await fn(); } finally {
      await f.db.exec('reset role');
      await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
    }
  };

  it('every RLS-enabled public / core table carries projects_only_seat_deny or a justified exception', async () => {
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    const n = await q<{ n: number }>(f.db, `select count(*)::int n from pg_policies where policyname = 'projects_only_seat_deny' and schemaname in ('public', 'core')`);
    expect(n[0].n).toBeGreaterThan(150);
  });
  it('a new Books table without the policy is caught; core.apply_projects_only_seat_deny fixes it', async () => {
    await f.db.exec(`create table public.zz_books_new (id uuid primary key, org_id uuid); alter table public.zz_books_new enable row level security;`);
    try {
      expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([{ access_seat_unprotected_tables: 'public.zz_books_new' }]);
      await f.db.query(`select core.apply_projects_only_seat_deny('public.zz_books_new')`);
      expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    } finally {
      await f.db.exec(`drop table public.zz_books_new`);
    }
  });
  it('flagged Labor / Supervisor / Dispatcher / PM / GM seats read zero rows of Books money tables', async () => {
    for (const p of ['labor', 'supervisor', 'dispatcher', 'pm', 'gm'] as const) {
      for (const t of SAMPLE) expect(await n(p, `select 1 from public.${t}`), `${p} ${t}`).toBe(0);
      expect(await n(p, `select 1 from public.payroll_run_employees`), `${p} payroll_run_employees`).toBe(0);
    }
  });
  it('unflagged seats keep Books data: new owner, legacy owner / staff / PM, a member with no assignments, a Books owner', async () => {
    for (const t of SAMPLE) {
      const all = (await q<{ n: number }>(f.db, `select count(*)::int n from public.${t} where org_id = $1`, [ORG_A]))[0].n;
      expect(all, t).toBeGreaterThan(0);
      for (const p of ['owner', 'legacyOwner', 'legacyStaff', 'legacyPm'] as const) {
        expect(await n(p, `select 1 from public.${t}`), `${p} ${t}`).toBe(all);
      }
      expect(await asClerk('user_booksOwner', async () => (await q<{ n: number }>(f.db, `select count(*)::int n from public.${t}`))[0].n), `books owner ${t}`).toBe(all);
      expect(await asClerk('user_legacy0', async () => (await q<{ n: number }>(f.db, `select count(*)::int n from public.${t}`))[0].n), `legacy ${t}`).toBe(all);
    }
  });
  it('Projects-only seats cannot write Books tables', async () => {
    const err = await as(f, 'gm', async () => errorOf(f.db, `insert into public.documents (org_id, storage_path, file_name, entity_type) values ($1, 'x/bill.pdf', 'bill.pdf', 'bills')`, [ORG_A]));
    expect(err).toMatch(/row-level security/);
  });
  it('exceptions: identity / RBAC reads and Projects attachments / AI proposals keep working', async () => {
    expect(await n('labor', `select 1 from core.locations`)).toBeGreaterThan(0);
    expect(await n('labor', `select 1 from core.users`)).toBe(1); // self-read
    expect(await n('gm', `select 1 from core.role_definitions where key like 'projects\_%'`)).toBeGreaterThan(0);
    const doc = await as(f, 'gm', async () => errorOf(f.db,
      `insert into public.documents (org_id, storage_path, file_name, entity_type, uploaded_by_user) values ($1, 'x/photo.jpg', 'photo.jpg', 'pm.assets', 'user_gm')`, [ORG_A]));
    expect(doc).toBeNull();
    expect(await n('gm', `select 1 from public.documents`)).toBe(1);
    await f.db.query(`insert into public.documents (org_id, storage_path, file_name, entity_type) values ($1, 'x/w9.pdf', 'w9.pdf', 'vendors')`, [ORG_A]);
    expect(await n('gm', `select 1 from public.documents`)).toBe(1); // the Books W-9 stays hidden
    expect(await n('owner', `select 1 from public.documents`)).toBe(2); // unflagged owner sees both
    const ai = await as(f, 'gm', async () => errorOf(f.db,
      `insert into public.ai_decisions (org_id, location_id, feature, input_summary, proposed_output) values ($1, $2, 'PROJECTS_PACK_CONFIGURE', 'x', '{}')`, [ORG_A, L1]));
    expect(ai).toBeNull();
    const books = await as(f, 'gm', async () => errorOf(f.db,
      `insert into public.ai_decisions (org_id, location_id, feature, input_summary, proposed_output) values ($1, $2, 'CATEGORIZATION', 'x', '{}')`, [ORG_A, L1]));
    expect(books).toMatch(/row-level security/);
  });
});

describe('Projects-only is an explicit, guarded flag', () => {
  const flag = async (m: string): Promise<boolean> => (await q<{ p: boolean }>(f.db, `select projects_only as p from core.memberships where id = $1`, [m]))[0].p;
  it('the backfill flags nobody; only the explicitly flagged seats are Projects-only', async () => {
    for (const p of ['owner', 'legacyOwner', 'legacyStaff', 'legacyPm', 'bOwner'] as const) expect(await flag(f.membership[p]), p).toBe(false);
    for (const p of ['gm', 'pm', 'supervisor', 'labor', 'dispatcher', 'accountant'] as const) expect(await flag(f.membership[p]), p).toBe(true);
    expect(await as(f, 'legacyStaff', async () => (await q<{ s: boolean }>(f.db, `select core.is_projects_only_seat() as s`))[0].s)).toBe(false);
    expect(await as(f, 'labor', async () => (await q<{ s: boolean }>(f.db, `select core.is_projects_only_seat() as s`))[0].s)).toBe(true);
  });
  it('members cannot set the flag directly', async () => {
    expect(await as(f, 'owner', async () => errorOf(f.db, `update core.memberships set projects_only = true where id = $1`, [f.membership.legacyStaff]))).toMatch(/permission denied/);
  });
  it('pm.set_projects_only: team:edit at every company of the seat; never owner / admin; never self', async () => {
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.legacyStaff]))).toMatch(forbidden);
    // the PM has team:edit at L1 only; legacyStaff is assigned on every company
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.legacyStaff]))).toMatch(/every company/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.legacyOwner]))).toMatch(/owner \/ admin/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.owner]))).toMatch(/own seat/);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.legacyStaff]))).toMatch(forbidden);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.set_projects_only($1, true)`, [f.membership.legacyStaff]))).toBeNull();
    expect(await flag(f.membership.legacyStaff)).toBe(true);
    expect(await n('legacyStaff', `select 1 from public.invoices`)).toBe(0);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.set_projects_only($1, false)`, [f.membership.legacyStaff]))).toBeNull();
    expect(await n('legacyStaff', `select 1 from public.invoices`)).toBeGreaterThan(0);
  });
  it('promoting a flagged seat to owner / admin clears the flag', async () => {
    await f.db.query(`update core.memberships set projects_only = true where id = $1`, [f.membership.legacyPm]);
    await f.db.query(`update core.memberships set role = 'admin' where id = $1`, [f.membership.legacyPm]);
    expect(await flag(f.membership.legacyPm)).toBe(false);
    await f.db.query(`update core.memberships set role = 'member' where id = $1`, [f.membership.legacyPm]);
  });
  it('flagged seats see only their own memberships / assignments rows unless they hold projects.team:view', async () => {
    expect(await as(f, 'labor', async () => (await q<{ id: string }>(f.db, `select id from core.memberships`)).map((r) => r.id))).toEqual([f.membership.labor]);
    expect(await as(f, 'labor', async () => (await q<{ m: string }>(f.db, `select distinct membership_id as m from core.access_assignments`)).map((r) => r.m))).toEqual([f.membership.labor]);
    const all = (await q<{ n: number }>(f.db, `select count(*)::int n from core.memberships where org_id = $1`, [ORG_A]))[0].n;
    expect(await n('pm', `select 1 from core.memberships`)).toBe(all);
    expect(await n('legacyStaff', `select 1 from core.memberships`)).toBe(all);
  });
});

describe('low-severity fixes', () => {
  it('(c) v_company_team lists only members holding a Projects grant at the company', async () => {
    const emails = await as(f, 'owner', async () => q<{ email: string | null; location_id: string; role_key: string }>(f.db, `select email, location_id, role_key from pm.v_company_team`));
    expect(emails.every((r) => r.role_key.startsWith('projects_'))).toBe(true);
    expect(emails.some((r) => r.email === 'labor@example.test' && r.location_id === L1)).toBe(true);
    expect(emails.some((r) => r.email === 'labor@example.test' && r.location_id !== L1)).toBe(false);
    expect(emails.some((r) => r.email === null)).toBe(false);
  });
  it('(b) access_is_service: a member role is never trusted; the platform login without a JWT is', async () => {
    expect(await as(f, 'labor', async () => (await q<{ s: boolean }>(f.db, `select pm.access_is_service() as s`))[0].s)).toBe(false);
    expect((await q<{ s: boolean }>(f.db, `select pm.access_is_service() as s`))[0].s).toBe(true);
  });
  it('(a) demoting or deactivating an owner seat ends the automatic Projects owner; re-promoting restores it', async () => {
    const active = async (): Promise<number> => (await q<{ n: number }>(f.db,
      `select count(*)::int n from core.access_assignments where membership_id = $1 and backfill_key = 'projects:role:owner' and status = 'active'`, [f.membership.owner]))[0].n;
    expect(await active()).toBe(1);
    await f.db.query(`update core.memberships set role = 'member' where id = $1`, [f.membership.owner]);
    expect(await active()).toBe(0);
    expect(await n('owner', `select 1 from pm.my_access()`)).toBe(0);
    await f.db.query(`update core.memberships set role = 'owner' where id = $1`, [f.membership.owner]);
    expect(await active()).toBe(1);
    await f.db.query(`update core.memberships set status = 'suspended' where id = $1`, [f.membership.owner]);
    expect(await active()).toBe(0);
    await f.db.query(`update core.memberships set status = 'active' where id = $1`, [f.membership.owner]);
    expect(await active()).toBe(1);
    expect(await n('owner', `select id from core.jobs`)).toBe(3);
    expect([J1, J2, J3].length).toBe(3);
  });
});
