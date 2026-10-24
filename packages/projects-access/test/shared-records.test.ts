/**
 * 1111 shared records (docs/suite/SHARED-RECORDS-CRM-PROJECTS-BOOKS.md §9): matching at the door,
 * the duplicate safety net + queue, merge, crm lead flow + convert, RLS per persona, relationship
 * stage, customer 360 and the Books tie-outs. Runs on the 1110 fixture with 1111 applied on top
 * (numeric order), plus two personas: Sales (projects_sales at L1, Projects-only seat) and a
 * Books-only staff seat (Books ar_clerk role, no Projects grant).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigration } from './pg';
import { buildFixture, applyAfter1110, as, q, errorOf, type Fixture, ORG_A, ORG_B, L1, L2, LB, J1, J2, J3, JB } from './fixture';

let f: Fixture;
let db: PGlite;
const extra: Record<'sales' | 'books', string> = { sales: '', books: '' };
const ids: Record<string, string> = {};

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

/** Run as any Clerk user of org A / B through PostgREST semantics (role authenticated + JWT). */
async function asUser<T>(clerk: string, org: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: clerk, org_id: org, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
    await db.query(`select set_config('pm.access_entry', '', false)`);
  }
}
const asSales = <T>(fn: () => Promise<T>) => asUser('user_sales', ORG_A, fn);
const asBooks = <T>(fn: () => Promise<T>) => asUser('user_booksStaff', ORG_A, fn);

async function addMember(clerk: string, org: string, role: string): Promise<string> {
  const u = await one<{ id: string }>(`insert into core.users (clerk_user_id, email, first_name, last_name) values ($1, $2, 'T', $1) returning id`, [clerk, `${clerk}@example.test`]);
  const m = await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`, [u.id, org, role]);
  return m.id;
}

async function assign(membership: string, roleKey: string, location: string | null): Promise<void> {
  const r = await one<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = $2`, [ORG_A, roleKey]);
  await db.query(
    `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, source)
     values ($1, $2, 'role', $3, $4, $5, 'manual')`,
    [ORG_A, membership, r.id, location ? 'client' : 'all_clients', location],
  );
}

async function customer(name: string, extraCols: Record<string, unknown> = {}, org = ORG_A): Promise<string> {
  const cols = ['org_id', 'name', ...Object.keys(extraCols)];
  const vals = [org, name, ...Object.values(extraCols)];
  const r = await one<{ id: string }>(
    `insert into core.customers (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals);
  return r.id;
}

let invSeq = 0;
async function invoice(cust: string, opts: { job?: string | null; subtotal?: number; status?: string; date?: string; sourceRef?: string; subtype?: string; loc?: string } = {}): Promise<string> {
  invSeq++;
  const sub = opts.subtotal ?? 100_000;
  const r = await one<{ id: string }>(
    `insert into public.invoices (org_id, location_id, customer_id, job_id, invoice_number, invoice_date, due_date,
                                  subtotal_cents, total_cents, status, source_ref, billing_subtype)
     values ($1, $2, $3, $4, $5, $6::date, $6::date + 30, $7, $7, $8, $9, $10) returning id`,
    [ORG_A, opts.loc ?? L1, cust, opts.job ?? null, `INV-T-${invSeq}`, opts.date ?? new Date().toISOString().slice(0, 10), sub,
     opts.status ?? 'SENT', opts.sourceRef ?? null, opts.subtype ?? null],
  );
  return r.id;
}

beforeAll(async () => {
  f = await buildFixture();
  db = f.db;
  await applyAfter1110(db);

  extra.sales = await addMember('user_sales', ORG_A, 'member');
  await assign(extra.sales, 'projects_sales', L1);
  await db.query(`select core.rbac_import_tenant_roles($1)`, [ORG_A]);
  extra.books = await addMember('user_booksStaff', ORG_A, 'member');
  await assign(extra.books, 'ar_clerk', null);
  await as(f, 'owner', async () => {
    await db.query(`select pm.set_projects_only($1, true)`, [extra.sales]);
  });

  // an initial stage for the fixture's job type at L1 / L2 (pm.create_project needs one)
  for (const loc of [L1, L2]) {
    const inst = await one<{ id: string }>(`select id from pm.pack_installs where location_id = $1 and role = 'primary'`, [loc]);
    await db.query(
      `insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, sort, core_status, is_terminal, is_initial, is_active)
       values ($1, $2, $3, 'm', 'lead', 'Lead', 0, 'BID', false, true, true)`, [ORG_A, loc, inst.id]);
  }
}, 600_000);

afterAll(async () => {
  await db?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('guards: every crm table classified, every definer RPC registered, new core tables protected', () => {
  it('no unclassified crm table, no policy gap, no unregistered definer RPC, no unprotected core table', async () => {
    expect(await q(db, `select * from crm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(db, `select * from crm.access_policy_gaps()`)).toEqual([]);
    expect(await q(db, `select * from crm.access_unregistered_rpcs()`)).toEqual([]);
    expect(await q(db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    expect(await q(db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
  });

  it('a new unclassified crm table is reported (and an unregistered definer RPC too)', async () => {
    await db.exec(`create table crm.zz_probe (id int primary key)`);
    await db.exec(`create function crm.zz_probe_fn() returns int language sql security definer as $$ select 1 $$`);
    await db.exec(`grant execute on function crm.zz_probe_fn() to authenticated`);
    try {
      expect((await q<{ t: string }>(db, `select t from crm.access_unclassified_tables() t`)).map((r) => r.t)).toEqual(['zz_probe']);
      expect((await q<{ f: string }>(db, `select f from crm.access_unregistered_rpcs() f`)).map((r) => r.f)).toEqual([expect.stringMatching(/zz_probe_fn\(\)$/)]);
    } finally {
      await db.exec(`drop table crm.zz_probe; drop function crm.zz_probe_fn()`);
    }
  });

  it('anon executes nothing in crm; definer views are select-only for members', async () => {
    const anon = await q(db, `select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'crm' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anon).toEqual([]);
    for (const v of ['core.v_customer_relationship', 'pm.v_customer_360', 'pm.v_job_tieout', 'pm.v_company_tieout']) {
      const r = await one<{ s: boolean; i: boolean; u: boolean; d: boolean; a: boolean }>(
        `select has_table_privilege('authenticated', $1, 'select') s, has_table_privilege('authenticated', $1, 'insert') i,
                has_table_privilege('authenticated', $1, 'update') u, has_table_privilege('authenticated', $1, 'delete') d,
                has_table_privilege('anon', $1, 'select') a`, [v]);
      expect(r).toEqual({ s: true, i: false, u: false, d: false, a: false });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pipelines per company from the primary pack', () => {
  it('every existing company got a default pipeline (general fallback without a known pack)', async () => {
    const r = await q<{ location_id: string; key: string }>(db, `select location_id, key from crm.pipelines where is_default order by location_id`);
    expect(r.map((x) => x.location_id).sort()).toEqual([L1, L2, LB].sort());
    expect(new Set(r.map((x) => x.key))).toEqual(new Set(['sales']));
  });

  it('installing a pack adds its pipelines (field service: replacement sales default + agreement renewals)', async () => {
    await db.query(`update pm.pack_installs set pack_key = 'field_service' where location_id = $1 and role = 'primary'`, [L2]);
    const p = await q<{ key: string; is_default: boolean }>(db, `select key, is_default from crm.pipelines where location_id = $1 order by sort, key`, [L2]);
    expect(p).toEqual(expect.arrayContaining([
      { key: 'replacement_sales', is_default: true }, { key: 'agreement_renewals', is_default: false }, { key: 'sales', is_default: false }]));
    const st = await q<{ key: string; kind: string }>(db,
      `select s.key, s.kind from crm.pipeline_stages s join crm.pipelines p on p.id = s.pipeline_id
        where p.location_id = $1 and p.key = 'agreement_renewals' order by s.sort`, [L2]);
    expect(st.map((s) => s.key)).toEqual(['due_90', 'due_60', 'due_30', 'renewed', 'lapsed']);
    expect(st.slice(-2).map((s) => s.kind)).toEqual(['won', 'lost']);
    expect((await one<{ n: number }>(`select crm.ensure_pipelines($1) n`, [L2])).n).toBe(0);
  });

  it('the catalog carries every pack the doc names, in board order', async () => {
    const r = await q<{ pack_key: string; keys: string[] }>(db,
      `select pack_key, array(select s ->> 'name' from jsonb_array_elements(stages) s) keys from crm.pipeline_templates where is_default order by pack_key`);
    const by = Object.fromEntries(r.map((x) => [x.pack_key, x.keys]));
    expect(by.residential_remodel).toEqual(['New', 'Contacted', 'Consult scheduled', 'Consult done', 'Design agreement', 'Proposal sent', 'Negotiating', 'Won', 'Lost']);
    expect(by.home_builder).toEqual(['Inquiry', 'Lot and plan fit', 'Preconstruction agreement', 'Pricing', 'Contract signed', 'Lost']);
    expect(by.commercial_gc).toEqual(['ITB', 'Bid/no-bid', 'Estimating', 'Bid submitted', 'Shortlisted', 'Awarded', 'Lost']);
    expect(by.specialty_trade).toEqual(by.commercial_gc);
    expect(by.manufacturing_eto).toEqual(['RFQ', 'Qualified', 'Drawings and takeoff', 'Quote sent', 'Revision', 'PO received', 'Lost']);
    expect(by.flooring).toEqual(['Lead', 'Measure scheduled', 'Measured', 'Quote sent', 'Sold', 'Lost']);
    expect(by.interior_design).toEqual(['Inquiry', 'Discovery call', 'Design agreement', 'Retainer paid', 'Declined']);
    expect(by.equipment_dealer).toEqual(['Lead', 'Contacted', 'Demo/quote', 'Trade appraisal', 'Financing', 'Deal desk', 'Delivered', 'Lost']);
    expect(by.real_estate_development).toEqual(['Site identified', 'LOI', 'Due diligence', 'Entitlement', 'Financing committed', 'Closed', 'Dead']);
    expect(by.professional_services).toEqual(['Inquiry', 'Discovery', 'Proposal', 'SOW signed', 'Lost']);
    expect(by.field_service).toEqual(['Lead set', 'Appointment booked', 'Options presented', 'Follow-up', 'Sold', 'Lost']);
    expect(by.general).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('core.match_parties (exact / likely / none)', () => {
  beforeAll(async () => {
    ids.harbor = await customer('Harbor Holdings LLC', {
      email: 'ops@harbor.test', phone: '(515) 555-0100', address_line1: '12 Oak St', zip: '50010', city: 'Ames', tax_id: '12-3456789', location_id: L1,
    });
    await invoice(ids.harbor, { date: '2026-03-02', subtotal: 5_000 });
  });

  type Cand = { id: string; name: string; score: string; matched: string[]; detail: Record<string, unknown> };
  const match = (args: unknown[]) => as(f, 'owner', () =>
    q<Cand>(db, `select * from core.match_parties($1, $2, $3, $4, $5, $6)`, args));

  it('exact: shared email + strong name → 0.93, level exact, Books since the first invoice', async () => {
    const r = await match(['customer', 'Harbor Holdings', ' OPS@Harbor.test ', null, null, null]);
    expect(r[0].id).toBe(ids.harbor);
    expect(Number(r[0].score)).toBeCloseTo(0.93, 4);
    expect(r[0].matched).toEqual(['name', 'email']);
    expect(r[0].detail).toMatchObject({ level: 'exact', email: 'ops@harbor.test', city: 'Ames', books_since: '2026-03-02', source: 'books' });
  });

  it('exact: tax id alone → 0.96; phone digits + related name → 0.86; name + address → exact', async () => {
    const tax = await match(['customer', 'HH Corp', null, null, null, '123456789']);
    expect(tax[0]).toMatchObject({ id: ids.harbor, matched: ['tax_id'] });
    expect(Number(tax[0].score)).toBeCloseTo(0.96, 4);
    const phone = await match(['customer', 'Holdings Harbor', null, '515.555.0100', null, null]);
    expect(phone[0]).toMatchObject({ id: ids.harbor, matched: ['phone', 'name'] });
    expect(Number(phone[0].score)).toBeCloseTo(0.86, 4);
    const addr = await match(['customer', 'Harbor Holdings', null, null, '12 Oak Street, Ames, IA 50010', null]);
    expect(addr[0].matched).toEqual(['name']); // 'Oak Street' ≠ 'Oak St' after normalization: no address match (name only)
    const addr2 = await match(['customer', 'Harbor Holdings', null, null, '12 OAK ST., Ames, IA 50010', null]);
    expect(addr2[0]).toMatchObject({ id: ids.harbor, matched: ['name', 'address'] });
    expect(addr2[0].detail.level).toBe('exact');
  });

  it('likely: a near-identical name alone → 0.82, level likely', async () => {
    const r = await match(['customer', 'harbor holdings', null, null, null, null]);
    expect(r[0]).toMatchObject({ id: ids.harbor, matched: ['name'] });
    expect(Number(r[0].score)).toBeCloseTo(0.82, 4);
    expect(r[0].detail.level).toBe('likely');
  });

  it('none: unrelated names, or a shared email with an unrelated name, are not surfaced', async () => {
    expect(await match(['customer', 'Zephyr Plumbing', null, null, null, null])).toEqual([]);
    expect(await match(['customer', 'Zephyr Plumbing', 'ops@harbor.test', null, null, null])).toEqual([]);
  });

  it('org-guarded and capability-checked: other tenants see nothing; a Projects-only seat without customer grants is refused; Books staff may match', async () => {
    const b = await as(f, 'bOwner', () => q(db, `select * from core.match_parties('customer', 'Harbor Holdings', 'ops@harbor.test')`));
    expect(b).toEqual([]);
    expect(await as(f, 'labor', () => errorOf(db, `select * from core.match_parties('customer', 'Harbor Holdings')`))).toMatch(/CORE_FORBIDDEN/);
    const books = await asBooks(() => q<Cand>(db, `select * from core.match_parties('customer', 'Harbor Holdings', 'ops@harbor.test')`));
    expect(books[0].id).toBe(ids.harbor);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('safety net + duplicate queue + not-duplicate memory', () => {
  it('an insert that strongly matches files an open review (survivor = the record used in Books); a weak one does not', async () => {
    ids.harbor2 = await customer('Harbor Holdings', { email: 'ops@harbor.test', location_id: L1 });
    const r = await q<{ kind: string; score: string; matched: string[]; suggested_survivor_id: string; status: string; source: string }>(db,
      `select kind, score, matched, suggested_survivor_id, status, source from core.duplicate_reviews
        where kind = 'customer' and $1 in (a_id, b_id) and $2 in (a_id, b_id)`, [ids.harbor, ids.harbor2]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'customer', matched: ['name', 'email'], suggested_survivor_id: ids.harbor, status: 'open', source: 'insert_trigger' });
    ids.harborName = await customer('Harbor Holdings Co', { location_id: L1 }); // name-only (0.82) → below the 0.86 net
    const weak = await q(db, `select 1 from core.duplicate_reviews where $1 in (a_id, b_id)`, [ids.harborName]);
    expect(weak).toEqual([]);
  });

  it('vendors and contacts are covered too', async () => {
    const v1 = await one<{ id: string }>(`insert into core.vendors (org_id, name, email) values ($1, 'Acme Lumber', 'ap@acme.test') returning id`, [ORG_A]);
    const v2 = await one<{ id: string }>(`insert into core.vendors (org_id, name, email) values ($1, 'ACME Lumber Inc', 'AP@acme.test') returning id`, [ORG_A]);
    expect(await q(db, `select 1 from core.duplicate_reviews where kind = 'vendor' and a_id = least($1::uuid, $2::uuid) and b_id = greatest($1::uuid, $2::uuid)`, [v1.id, v2.id])).toHaveLength(1);
    ids.vendorA = v1.id;
    const c1 = await as(f, 'owner', () => one<{ id: string }>(`select core.create_contact(p_customer => $1, p_first_name => 'Dana', p_last_name => 'Reyes', p_email => 'dana@harbor.test') id`, [ids.harbor]));
    const c2 = await as(f, 'owner', () => one<{ id: string }>(`select core.create_contact(p_customer => $1, p_first_name => 'Dana', p_last_name => 'Reyes', p_email => 'dana@harbor.test') id`, [ids.harbor2]));
    expect(c2.id).not.toBe(c1.id); // different customer → a new contact…
    expect(await q(db, `select 1 from core.duplicate_reviews where kind = 'contact' and $1 in (a_id, b_id) and $2 in (a_id, b_id)`, [c1.id, c2.id])).toHaveLength(1); // …queued
    const again = await as(f, 'owner', () => one<{ id: string }>(`select core.create_contact(p_customer => $1, p_first_name => 'Dana', p_last_name => 'Reyes', p_email => 'DANA@harbor.test') id`, [ids.harbor]));
    expect(again.id).toBe(c1.id); // same person on the same customer → existing returned
    ids.contactDana = c1.id;
    ids.contactDana2 = c2.id;
  });

  it('the net never blocks or fails an insert', async () => {
    await db.exec(`create or replace function core.party_file_reviews(p_kind text, p_id uuid, p_source text) returns integer
                   language plpgsql as $$ begin raise exception 'boom'; end $$`);
    try {
      const id = await customer('Harbor Holdings', { email: 'ops@harbor.test' });
      expect(id).toBeTruthy();
      await db.query(`delete from core.customers where id = $1`, [id]);
    } finally {
      await applyMigration(db, '1111_shared_records.sql');
    }
  });

  it('dismiss_duplicate remembers the pair (never re-filed); refused without edit rights or across tenants', async () => {
    const rv = await one<{ id: string }>(`select id from core.duplicate_reviews where kind = 'customer' and $1 in (a_id, b_id) and $2 in (a_id, b_id)`, [ids.harbor, ids.harbor2]);
    expect(await as(f, 'labor', () => errorOf(db, `select core.dismiss_duplicate($1)`, [rv.id]))).toMatch(/CORE_FORBIDDEN/);
    expect(await as(f, 'bOwner', () => errorOf(db, `select core.dismiss_duplicate($1)`, [rv.id]))).toMatch(/CORE_FORBIDDEN/);
    await as(f, 'owner', () => db.query(`select core.dismiss_duplicate($1)`, [rv.id]));
    expect((await one<{ status: string }>(`select status from core.duplicate_reviews where id = $1`, [rv.id])).status).toBe('not_duplicate');
    expect((await one<{ n: number }>(`select core.party_file_reviews('customer', $1, 'rescan') n`, [ids.harbor2])).n).toBe(0);
    expect((await one<{ status: string }>(`select status from core.duplicate_reviews where id = $1`, [rv.id])).status).toBe('not_duplicate');
    expect(await q(db, `select 1 from core.action_log where action = 'parties.not_duplicate' and subject_id = $1`, [rv.id])).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('core.merge_parties', () => {
  let survivor: string;
  let victim: string;
  let victimInvoice: string;
  let leadId: string;

  beforeAll(async () => {
    survivor = await customer('Lakeside Builders', { email: 'office@lakeside.test', location_id: L1 });
    victim = await customer('Lakeside Builders Inc', { email: 'office@lakeside.test', phone: '515-555-0199', location_id: L1 });
    // references in core, pm, public (Books) and crm
    await db.query(`update core.jobs set customer_id = $1, customer_name = 'Lakeside Builders Inc' where id = $2`, [victim, J2]);
    await db.query(`update pm.contracts set customer_id = $1 where job_id = $2`, [victim, J2]);
    victimInvoice = await invoice(victim, { job: J2, subtotal: 123_456, status: 'PAID', date: '2026-02-14' });
    await db.query(`insert into public.customer_invoice_settings (org_id, customer_id) values ($1, $2), ($1, $3)`, [ORG_A, survivor, victim]);
    await as(f, 'owner', async () => {
      await db.query(`select core.create_contact(p_customer => $1, p_first_name => 'Pat', p_last_name => 'Lake', p_is_primary => true)`, [survivor]);
      await db.query(`select core.create_contact(p_customer => $1, p_first_name => 'Kim', p_last_name => 'Lake', p_is_primary => true)`, [victim]);
      await db.query(`select core.create_site(p_customer => $1, p_address_line1 => '9 Dock Rd', p_zip => '50011')`, [victim]);
      leadId = (await one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Lakeside addition', p_customer => $2) id`, [L1, victim])).id;
      await db.query(`select crm.log_activity(p_kind => 'call', p_lead => $1, p_direction => 'outbound', p_subject => 'Intro')`, [leadId]);
    });
  });

  it('refuses cross-tenant pairs, archived records, callers without edit rights', async () => {
    const other = await customer('Lakeside Builders', {}, ORG_B);
    expect(await as(f, 'owner', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{}')`, [survivor, other]))).toMatch(/CORE_MERGE_CROSS_TENANT/);
    expect(await as(f, 'labor', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{}')`, [survivor, victim]))).toMatch(/CORE_FORBIDDEN/);
    expect(await as(f, 'bOwner', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{}')`, [survivor, victim]))).toMatch(/CORE_FORBIDDEN/);
  });

  it('refuses a Books money conflict unless Books picks it (owner / Books customer-edit, not a Projects-only seat)', async () => {
    await db.query(`update core.customers set payment_terms_days = 15, credit_limit_cents = 500000 where id = $1`, [victim]);
    expect(await as(f, 'owner', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{}')`, [survivor, victim])))
      .toMatch(/CORE_MERGE_BOOKS_CONFLICT.*payment_terms_days, credit_limit_cents/);
    const choices = JSON.stringify({ payment_terms_days: 'victim', credit_limit_cents: 'victim' });
    expect(await asSales(() => errorOf(db, `select core.merge_parties('customer', $1, $2, $3::jsonb)`, [survivor, victim, choices])))
      .toMatch(/CORE_MERGE_BOOKS_AUTHORITY/);
    expect(await as(f, 'owner', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{"tax_exempt": "maybe"}')`, [survivor, victim])))
      .toMatch(/CORE_INVALID/);
  });

  it('repoints every reference across core / pm / public / crm, keeps chosen values, archives the victim, audits', async () => {
    const before = await one<{ total_cents: string; invoice_date: string; subtotal_cents: string }>(
      `select total_cents, invoice_date::text, subtotal_cents from public.invoices where id = $1`, [victimInvoice]);
    const choices = JSON.stringify({ payment_terms_days: 'victim', credit_limit_cents: 'victim', name: 'survivor' });
    const out = await asBooks(() => one<{ s: Record<string, unknown> }>(`select core.merge_parties('customer', $1, $2, $3::jsonb) s`, [survivor, victim, choices]));
    const s = out.s as { repointed: { table: string; column: string; rows: number }[]; kept_on_victim: { table: string }[]; fields_changed: string[]; audit_id: string };
    const tables = s.repointed.map((r) => `${r.table}.${r.column}`);
    expect(tables).toEqual(expect.arrayContaining([
      'core.jobs.customer_id', 'core.contacts.customer_id', 'core.sites.customer_id', 'crm.leads.customer_id',
      'crm.activities.customer_id', 'pm.contracts.customer_id', 'public.invoices.customer_id']));
    expect(s.kept_on_victim.map((k) => k.table)).toEqual(['public.customer_invoice_settings']);
    expect(s.fields_changed).toEqual(expect.arrayContaining(['payment_terms_days', 'credit_limit_cents', 'phone']));

    // Books invoice: repointed; amount and date untouched
    const after = await one<{ customer_id: string; total_cents: string; invoice_date: string; subtotal_cents: string }>(
      `select customer_id, total_cents, invoice_date::text, subtotal_cents from public.invoices where id = $1`, [victimInvoice]);
    expect(after).toEqual({ ...before, customer_id: survivor });
    expect((await one<{ customer_id: string; customer_name: string }>(`select customer_id, customer_name from core.jobs where id = $1`, [J2])))
      .toEqual({ customer_id: survivor, customer_name: 'Lakeside Builders' });
    expect((await one<{ customer_id: string }>(`select customer_id from crm.leads where id = $1`, [leadId])).customer_id).toBe(survivor);
    // survivor keeps its primary contact; the victim's contact arrives non-primary
    const contacts = await q<{ first_name: string; is_primary: boolean }>(db, `select first_name, is_primary from core.contacts where customer_id = $1 order by first_name`, [survivor]);
    expect(contacts).toEqual([{ first_name: 'Kim', is_primary: false }, { first_name: 'Pat', is_primary: true }]);
    const sv = await one<{ payment_terms_days: number; credit_limit_cents: string; phone: string; name: string }>(
      `select payment_terms_days, credit_limit_cents, phone, name from core.customers where id = $1`, [survivor]);
    expect({ ...sv, credit_limit_cents: Number(sv.credit_limit_cents) }).toEqual({ payment_terms_days: 15, credit_limit_cents: 500000, phone: '515-555-0199', name: 'Lakeside Builders' });
    const vv = await one<{ merged_into: string; is_active: boolean; deleted: boolean }>(
      `select merged_into, is_active, deleted_at is not null deleted from core.customers where id = $1`, [victim]);
    expect(vv).toEqual({ merged_into: survivor, is_active: false, deleted: true });
    const audit = await one<{ action: string; actor_type: string; metadata: { before: { victim: { name: string } }; after: { payment_terms_days: number } } }>(
      `select action, actor_type::text, metadata from core.action_log where id = $1`, [s.audit_id]);
    expect(audit.action).toBe('parties.merge');
    expect(audit.actor_type).toBe('HUMAN');
    expect(audit.metadata.before.victim.name).toBe('Lakeside Builders Inc');
    expect(audit.metadata.after.payment_terms_days).toBe(15);
    // the pair's review is closed as merged
    expect((await one<{ status: string }>(`select status from core.duplicate_reviews where kind = 'customer' and a_id = least($1::uuid, $2::uuid) and b_id = greatest($1::uuid, $2::uuid)`, [survivor, victim])).status).toBe('merged');
    // a merged record cannot be merged again
    expect(await as(f, 'owner', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{}')`, [survivor, victim]))).toMatch(/CORE_MERGE_ARCHIVED/);
  });

  it('contacts merge: leads / activities repointed, roles unioned, victim marked merged', async () => {
    await db.query(`update core.contacts set roles = '{billing}' where id = $1`, [ids.contactDana2]);
    const lead = await as(f, 'owner', () => one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Dana remodel', p_contact => $2) id`, [L1, ids.contactDana2]));
    const out = await as(f, 'owner', () => one<{ s: { repointed: { table: string }[] } }>(`select core.merge_parties('contact', $1, $2) s`, [ids.contactDana, ids.contactDana2]));
    expect(out.s.repointed.map((r) => r.table)).toContain('crm.leads');
    expect((await one<{ contact_id: string }>(`select contact_id from crm.leads where id = $1`, [lead.id])).contact_id).toBe(ids.contactDana);
    expect(await one(`select roles, identity_status from core.contacts where id = $1`, [ids.contactDana])).toEqual({ roles: ['billing'], identity_status: 'active' });
    expect(await one(`select identity_status, merged_into from core.contacts where id = $1`, [ids.contactDana2])).toEqual({ identity_status: 'merged', merged_into: ids.contactDana });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RLS per persona', () => {
  let leadL1: string;
  let leadL2: string;
  let custL2: string;

  beforeAll(async () => {
    custL2 = await customer('Prairie Dental', { location_id: L2 });
    await as(f, 'owner', async () => {
      leadL1 = (await one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Basement finish', p_estimated_value_cents => 4500000, p_next_step => 'Call back', p_next_step_on => current_date + 2) id`, [L1])).id;
      leadL2 = (await one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Office HVAC') id`, [L2])).id;
      await db.query(`select core.create_contact(p_customer => $1, p_first_name => 'Lee', p_last_name => 'Prairie')`, [custL2]);
      await db.query(`select core.create_site(p_customer => $1, p_address_line1 => '1 Main', p_zip => '50012')`, [custL2]);
    });
  });

  const count = (sql: string) => one<{ n: number }>(`select count(*)::int n from (${sql}) x`).then((r) => r.n);

  it('Labor sees no leads, activities, follow-ups or duplicate reviews; contacts / sites only of their own job\'s customer', async () => {
    const j2cust = (await one<{ c: string }>(`select customer_id c from core.jobs where id = $1`, [J2])).c;
    await as(f, 'labor', async () => {
      for (const t of ['crm.leads', 'crm.activities', 'crm.followups', 'crm.lead_stage_events', 'core.duplicate_reviews']) {
        expect(await count(`select 1 from ${t}`), t).toBe(0);
      }
      const seen = await q<{ customer_id: string | null }>(db, `select customer_id from core.contacts union all select customer_id from core.sites`);
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((r) => r.customer_id))).toEqual(new Set([j2cust]));
      expect(await errorOf(db, `select crm.create_lead($1, 'x')`, [L1])).toMatch(/CRM_FORBIDDEN/);
    });
  });

  it('Sales sees and works the leads of their company only', async () => {
    await asSales(async () => {
      const leads = await q<{ id: string }>(db, `select id from crm.leads`);
      expect(leads.map((l) => l.id)).toContain(leadL1);
      expect(leads.map((l) => l.id)).not.toContain(leadL2);
      expect(await count(`select 1 from crm.followups where lead_id = '${leadL1}'`)).toBe(1);
      expect((await db.query(`update crm.leads set next_step = 'Send plans' where id = $1`, [leadL1])).affectedRows).toBe(1);
      expect((await db.query(`update crm.leads set next_step = 'nope' where id = $1`, [leadL2])).affectedRows).toBe(0);
      expect(await errorOf(db, `update crm.leads set won_at = now() where id = $1`, [leadL1])).toMatch(/permission denied/);
      await db.query(`insert into crm.followups (lead_id, due_on, kind) values ($1, current_date + 7, 'call')`, [leadL1]);
      expect(await errorOf(db, `insert into crm.followups (lead_id, due_on, kind) values ($1, current_date + 7, 'call')`, [leadL2])).toMatch(/row-level security/);
      expect(await errorOf(db, `select crm.create_lead($1, 'x')`, [L2])).toMatch(/CRM_FORBIDDEN/);
      // contacts / sites: L1 customers yes, the L2 customer no (Projects-only narrowing)
      expect(await count(`select 1 from core.contacts c join core.customers k on k.id = c.customer_id where k.location_id = '${L2}'`)).toBe(0);
      expect(await count(`select 1 from core.contacts where customer_id = '${ids.harbor}'`)).toBeGreaterThan(0);
      expect(await count(`select 1 from core.sites where customer_id = '${custL2}'`)).toBe(0);
      expect(await count(`select 1 from core.duplicate_reviews`)).toBeGreaterThan(0);
      // update a contact through RLS (projects.customers:edit at L1)
      expect((await db.query(`update core.contacts set title = 'Owner' where id = $1`, [ids.contactDana])).affectedRows).toBe(1);
      expect(await errorOf(db, `insert into core.contacts (first_name) values ('Sneaky')`)).toMatch(/permission denied/);
    });
  });

  it('PM (projects_pm has no projects.leads) sees no company leads; a backfilled member (legacy all-jobs set) sees every company', async () => {
    expect(await as(f, 'pm', () => count(`select 1 from crm.leads`))).toBe(0);
    const legacy = await as(f, 'legacyPm', () => q<{ id: string }>(db, `select id from crm.leads`));
    expect(legacy.map((l) => l.id)).toEqual(expect.arrayContaining([leadL1, leadL2]));
  });

  it('Dispatcher (Projects-only, dispatch at L1) reads L1 customer contacts, not L2', async () => {
    await as(f, 'dispatcher', async () => {
      expect(await count(`select 1 from core.contacts where customer_id = '${ids.harbor}'`)).toBeGreaterThan(0);
      expect(await count(`select 1 from core.contacts where customer_id = '${custL2}'`)).toBe(0);
      expect(await count(`select 1 from crm.leads where id = '${leadL1}'`)).toBe(1); // dispatcher holds projects.leads
    });
  });

  it('Books-only staff are unaffected: full org read of contacts / sites / reviews, Books tables as before; no crm rows without a Projects grant', async () => {
    const all = await count(`select 1 from core.contacts where org_id = '${ORG_A}'`);
    const sites = await count(`select 1 from core.sites where org_id = '${ORG_A}'`);
    const invoices = await count(`select 1 from public.invoices where org_id = '${ORG_A}'`);
    await asBooks(async () => {
      expect(await count(`select 1 from core.contacts`)).toBe(all);
      expect(await count(`select 1 from core.sites`)).toBe(sites);
      expect(await count(`select 1 from public.invoices`)).toBe(invoices);
      expect(await count(`select 1 from core.duplicate_reviews`)).toBeGreaterThan(0);
      expect(await count(`select 1 from crm.leads`)).toBe(0);
    });
  });

  it('other tenants see none of it', async () => {
    await as(f, 'bOwner', async () => {
      for (const t of ['crm.leads', 'crm.activities', 'crm.followups', 'core.contacts', 'core.sites', 'core.duplicate_reviews']) {
        expect(await count(`select 1 from ${t} where org_id = '${ORG_A}'`), t).toBe(0);
      }
      expect(await errorOf(db, `select crm.move_lead($1, (select stage_id from crm.leads limit 1))`, [leadL1])).toMatch(/CRM_FORBIDDEN/);
    });
  });

  it('move_lead: lost needs a reason; the stage history is kept; follow-ups close', async () => {
    const lost = await one<{ id: string }>(`select s.id from crm.pipeline_stages s join crm.leads l on l.pipeline_id = s.pipeline_id where l.id = $1 and s.kind = 'lost'`, [leadL1]);
    await asSales(async () => {
      expect(await errorOf(db, `select crm.move_lead($1, $2)`, [leadL1, lost.id])).toMatch(/CRM_LOST_REASON_REQUIRED/);
      await db.query(`select crm.move_lead($1, $2, 'Went with a competitor')`, [leadL1, lost.id]);
      expect(await count(`select 1 from crm.lead_stage_events where lead_id = '${leadL1}'`)).toBe(2);
      expect(await count(`select 1 from crm.followups where lead_id = '${leadL1}' and done_at is null`)).toBe(0);
      const fu = await one<{ id: string }>(`select id from crm.followups where lead_id = $1 limit 1`, [leadL1]);
      await db.query(`select crm.complete_followup($1)`, [fu.id]);
    });
    expect(await one(`select lost_reason, won_at from crm.leads where id = $1`, [leadL1])).toEqual({ lost_reason: 'Went with a competitor', won_at: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('crm.convert_lead end to end', () => {
  it('Sales converts a prospect lead to an estimate: customer created via the matcher, job + DRAFT estimate, lead won', async () => {
    const out = await asSales(async () => {
      const contact = (await one<{ id: string }>(`select core.create_contact(p_first_name => 'Robin', p_last_name => 'Quill', p_email => 'robin@quill.test', p_phone => '515 555 0142') id`)).id;
      const lead = (await one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Quill kitchen', p_contact => $2, p_source => 'web', p_estimated_value_cents => 3500000) id`, [L1, contact])).id;
      await db.query(`select crm.log_activity('site_visit', $1, p_subject => 'Measure')`, [lead]);
      expect(await errorOf(db, `select crm.convert_lead($1, 'job', 'build')`, [lead])).toMatch(/CRM_FORBIDDEN.*jobs:create/);
      const r = await one<{ r: { customer_id: string; job_id: string; estimate_id: string; customer_created: boolean } }>(`select crm.convert_lead($1, 'estimate', 'build') r`, [lead]);
      return { ...r.r, lead, contact };
    });
    expect(out.customer_created).toBe(true);
    const cust = await one<{ name: string; email: string; location_id: string }>(`select name, email, location_id from core.customers where id = $1`, [out.customer_id]);
    expect(cust).toEqual({ name: 'Robin Quill', email: 'robin@quill.test', location_id: L1 });
    expect(await one(`select customer_id, location_id from core.jobs where id = $1`, [out.job_id])).toEqual({ customer_id: out.customer_id, location_id: L1 });
    expect(await one(`select job_id, customer_id, status from pm.estimates where id = $1`, [out.estimate_id])).toEqual({ job_id: out.job_id, customer_id: out.customer_id, status: 'DRAFT' });
    const lead = await one<{ kind: string; converted_job_id: string; converted_estimate_id: string; won: boolean; customer_id: string }>(
      `select s.kind, l.converted_job_id, l.converted_estimate_id, l.won_at is not null won, l.customer_id from crm.leads l join crm.pipeline_stages s on s.id = l.stage_id where l.id = $1`, [out.lead]);
    expect(lead).toEqual({ kind: 'won', converted_job_id: out.job_id, converted_estimate_id: out.estimate_id, won: true, customer_id: out.customer_id });
    expect((await one<{ customer_id: string }>(`select customer_id from core.contacts where id = $1`, [out.contact])).customer_id).toBe(out.customer_id);
    expect((await one<{ job_id: string }>(`select job_id from crm.activities where lead_id = $1`, [out.lead])).job_id).toBe(out.job_id);
    expect((await one<{ source_ref: string }>(`select source_ref from pm.projects where job_id = $1`, [out.job_id])).source_ref).toBe(`crm:lead:${out.lead}`);
    expect(await asSales(() => errorOf(db, `select crm.convert_lead($1, 'estimate', 'build')`, [out.lead]))).toMatch(/CRM_LEAD_CONVERTED/);
    ids.quill = out.customer_id;
  });

  it('Owner converts straight to a job, reusing an exact customer match (no duplicate created)', async () => {
    const out = await as(f, 'owner', async () => {
      const contact = (await one<{ id: string }>(`select core.create_contact(p_first_name => 'Ops', p_last_name => 'Desk', p_email => 'ops@harbor.test') id`)).id;
      const lead = (await one<{ id: string }>(`select crm.create_lead(p_location => $1, p_title => 'Harbor Holdings', p_contact => $2) id`, [L1, contact])).id;
      return (await one<{ r: { customer_id: string; job_id: string; estimate_id: string | null; customer_created: boolean } }>(`select crm.convert_lead($1, 'job', 'build') r`, [lead])).r;
    });
    expect(out.customer_created).toBe(false);
    expect([ids.harbor, ids.harbor2, ids.harborName]).toContain(out.customer_id);
    expect(out.estimate_id).toBeNull();
    expect((await one<{ customer_id: string }>(`select customer_id from core.jobs where id = $1`, [out.job_id])).customer_id).toBe(out.customer_id);
  });

  it('relationship stage: prospect → customer (issued invoice / signed contract) → former after 24 months', async () => {
    const stage = (id: string) => one<{ stage: string; since: string }>(`select stage, since::text from core.v_customer_relationship where customer_id = $1`, [id]);
    expect((await stage(ids.quill)).stage).toBe('prospect');
    await invoice(ids.quill, { date: new Date().toISOString().slice(0, 10) });
    expect((await stage(ids.quill)).stage).toBe('customer');
    const old = await customer('Old Mill Farms', { location_id: L1 });
    await invoice(old, { date: '2023-01-15' });
    expect(await stage(old)).toEqual({ stage: 'former', since: '2025-01-15' });
    const signed = await customer('Signed Only LLC', { location_id: L1 });
    await db.query(`update core.jobs set customer_id = $1 where id = $2`, [signed, J3]);
    await db.query(`update pm.contracts set status = 'ACTIVE', executed_on = current_date where job_id = $1`, [J3]);
    expect((await stage(signed)).stage).toBe('customer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pm.v_customer_360 money masking (job-scoped, security review M2)', () => {
  it('AR shows for the customer of a job where the caller holds contract_value, or with Books AR; never company-wide', async () => {
    await db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.harbor, J1]); // harbor becomes J1's customer
    const sigma = await customer('Sigma LLC', { location_id: L1 });
    await invoice(sigma, { subtotal: 777_700 });
    const pick = (rows: Record<string, unknown>[], id = ids.harbor) => rows.find((r) => r.customer_id === id) as Record<string, unknown> | undefined;
    // PM: money on J1's customer (own job), none on another L1 customer although they hold contract_value at L1
    const pm = await as(f, 'pm', () => q(db, `select * from pm.v_customer_360`));
    expect(Number(pick(pm)!.open_ar_cents)).toBe(5000);
    expect((pick(pm)!.invoices as unknown[]).length).toBe(1);
    expect(pick(pm, sigma)?.open_ar_cents ?? null).toBeNull();
    // Sales: contract_value at L1 but no job of harbor's → masked
    const sales = await asSales(() => q(db, `select * from pm.v_customer_360`));
    expect(pick(sales)).toMatchObject({ open_ar_cents: null, invoices: null });
    expect(pick(sales, sigma)).toMatchObject({ open_ar_cents: null });
    // Books AR staff see it all
    const books = await asBooks(() => q(db, `select * from pm.v_customer_360`));
    expect(Number(pick(books)!.open_ar_cents)).toBe(5000);
    expect(Number(pick(books, sigma)!.open_ar_cents)).toBe(777_700);
    const disp = await as(f, 'dispatcher', () => q(db, `select * from pm.v_customer_360`));
    expect(pick(disp)).toMatchObject({ relationship_stage: 'customer', open_ar_cents: null, invoices: null, payments: null, deposits: null });
    expect(disp.find((r) => r.name === 'Prairie Dental')).toBeUndefined();
    expect(await as(f, 'labor', () => q(db, `select * from pm.v_customer_360 where customer_id = $1`, [ids.harbor]))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('security review regressions (H1 H2 M1 M3 L1 L4)', () => {
  it('H1: a job team never reads lead money or notes from crm.leads / crm.activities; pm.v_leads_masked masks them', async () => {
    const pipe = await one<{ id: string }>(`select id from crm.pipelines where location_id = $1 and is_default`, [L1]);
    const st = await one<{ id: string }>(`select id from crm.pipeline_stages where pipeline_id = $1 order by sort limit 1`, [pipe.id]);
    const lead = await one<{ id: string }>(`insert into crm.leads (org_id, location_id, pipeline_id, stage_id, title, estimated_value_cents, converted_job_id, next_step)
                                            values ($1, $2, $3, $4, 'Big lead', 98765400, $5, 'Quote them $95k') returning id`, [ORG_A, L1, pipe.id, st.id, J2]);
    await db.query(`insert into crm.activities (org_id, location_id, lead_id, job_id, kind, subject, body) values ($1, $2, $3, $4, 'note', 'Budget', 'Client budget is $1.2M, margin target 30%')`,
      [ORG_A, L1, lead.id, J2]);
    await as(f, 'labor', async () => { // dispatched on J2
      expect(await q(db, `select 1 from crm.leads where id = $1`, [lead.id])).toEqual([]);
      expect(await q(db, `select 1 from crm.activities where lead_id = $1`, [lead.id])).toEqual([]);
      expect(await q(db, `select 1 from crm.lead_stage_events where lead_id = $1`, [lead.id])).toEqual([]);
      const v = await q<{ title: string; estimated_value_cents: unknown; next_step: string | null; activities: { body: string | null; subject: string | null; kind: string }[] }>(db,
        `select title, estimated_value_cents, next_step, activities from pm.v_leads_masked where id = $1`, [lead.id]);
      expect(v).toHaveLength(1);
      expect(v[0].estimated_value_cents).toBeNull();
      expect(v[0].next_step).toBeNull();
      expect(v[0].activities).toEqual([expect.objectContaining({ kind: 'note', body: null, subject: null })]);
    });
    const owner = await as(f, 'owner', () => one<{ estimated_value_cents: unknown; next_step: string; activities: { body: string }[] }>(`select estimated_value_cents, next_step, activities from pm.v_leads_masked where id = $1`, [lead.id]));
    expect(Number(owner.estimated_value_cents)).toBe(98765400);
    expect(owner.next_step).toBe('Quote them $95k');
    expect(owner.activities[0].body).toMatch(/margin target/);
    expect(await as(f, 'pm', () => q(db, `select 1 from pm.v_leads_masked where id = $1`, [lead.id]))).toEqual([]); // not on J2
  });

  it('H2: attaching a customer / contact / site the caller cannot see is refused (create_lead, lead update, log_activity)', async () => {
    const zeta = await customer('Zeta Holdings LLC', { email: 'ceo@zeta.test', phone: '515-555-0198', location_id: L2, tax_id: '987654321' });
    const zk = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, email) values ($1, $2, 'Zed', 'zed@zeta.test') returning id`, [ORG_A, zeta])).id;
    const zs = (await one<{ id: string }>(`insert into core.sites (org_id, customer_id, location_id, address_line1, access_notes) values ($1, $2, $3, '1 Zeta Way', 'gate code 4471') returning id`, [ORG_A, zeta, L2])).id;
    ids.zeta = zeta;
    await asSales(async () => {
      for (const args of [[L1, zeta, null, null], [L1, null, zk, null], [L1, null, null, zs]]) {
        expect(await errorOf(db, `select crm.create_lead($1, 'attach', null, null, $2, $3, $4)`, args)).toMatch(/CRM_FORBIDDEN/);
      }
      const mine = (await one<{ id: string }>(`select crm.create_lead($1, 'mine') id`, [L1])).id;
      expect(await errorOf(db, `update crm.leads set customer_id = $2 where id = $1`, [mine, zeta])).toMatch(/CRM_FORBIDDEN/);
      expect(await errorOf(db, `update crm.leads set contact_id = $2 where id = $1`, [mine, zk])).toMatch(/CRM_FORBIDDEN/);
      expect(await errorOf(db, `select crm.log_activity('call', $1, $2)`, [mine, zeta])).toMatch(/CRM_FORBIDDEN/);
      expect(await errorOf(db, `select crm.log_activity('call', $1, null, $2)`, [mine, zk])).toMatch(/CRM_FORBIDDEN/);
      // nothing became reachable
      expect(await q(db, `select 1 from core.contacts where customer_id = $1`, [zeta])).toEqual([]);
      expect(await q(db, `select 1 from core.sites where customer_id = $1`, [zeta])).toEqual([]);
      expect(await q(db, `select 1 from pm.v_customer_360 where customer_id = $1`, [zeta])).toEqual([]);
      // a reachable customer still attaches
      expect(await errorOf(db, `update crm.leads set customer_id = $2 where id = $1`, [mine, ids.harbor])).toBeNull();
    });
  });

  it('M1: matching is scoped to companies the caller works customers at, masks unseen contact details, never trusts a lone tax id', async () => {
    expect(await as(f, 'supervisor', () => errorOf(db, `select * from core.match_parties('customer', 'zeta')`))).toMatch(/CORE_FORBIDDEN/); // dispatch:view no longer opens the matcher
    expect(await as(f, 'supervisor', () => errorOf(db, `select * from core.match_parties('vendor', 'acme')`))).toMatch(/CORE_FORBIDDEN/);
    await asSales(async () => {
      // Zeta (L2) is outside Sales' companies: not offered by name, email or tax id
      expect(await q(db, `select * from core.match_parties('customer', 'Zeta Holdings LLC', 'ceo@zeta.test')`)).toEqual([]);
      expect(await q(db, `select * from core.match_parties('customer', 'x', null, null, null, '987654321')`)).toEqual([]);
      // an L1 customer: a lone tax id is no match for a Projects-only seat; with the name the tax id is not echoed
      await db.query(`select 1`);
    });
    await db.query(`update core.customers set tax_id = '55-1234567' where id = $1`, [ids.harbor]);
    await asSales(async () => {
      expect(await q(db, `select * from core.match_parties('customer', 'x', null, null, null, '551234567')`)).toEqual([]);
      const r = await q<{ matched: string[]; score: string }>(db, `select * from core.match_parties('customer', 'Harbor Holdings LLC', null, null, null, '551234567')`);
      expect(r.length).toBeGreaterThan(0);
      for (const x of r) expect(x.matched).not.toContain('tax_id');
      expect(await q(db, `select * from core.match_parties('customer', 'Harbor Holdings LLC', null, null, null, '000000000')`)).toEqual(r); // no oracle
    });
    // a tax id counts only with a Books field policy that reveals taxpayer ids (or an owner seat):
    // ar_clerk (tin masked) matches org-wide by name but gets nothing from a tax id; the owner does
    const books = await asBooks(() => q<{ id: string; matched: string[] }>(db, `select * from core.match_parties('customer', 'Zeta Holdings LLC')`));
    expect(books.map((r) => r.id)).toContain(ids.zeta);
    expect(await asBooks(() => q(db, `select * from core.match_parties('customer', 'x', null, null, null, '987654321')`))).toEqual([]);
    const owner = await as(f, 'owner', () => q<{ id: string; matched: string[] }>(db, `select * from core.match_parties('customer', 'x', null, null, null, '98-7654321')`));
    expect(owner[0]).toMatchObject({ id: ids.zeta, matched: ['tax_id'] });
    // PM (projects.financials on own jobs) cannot confirm an org-level customer's tax id: right and wrong ids answer alike
    const orgLevel = await customer('Zeta Org Level', { email: 'org@zeta.test', tax_id: '123456789' });
    const right = await as(f, 'pm', () => q(db, `select id, score, matched from core.match_parties('customer', 'Zeta Org Level', null, null, null, '123456789')`));
    const wrong = await as(f, 'pm', () => q(db, `select id, score, matched from core.match_parties('customer', 'Zeta Org Level', null, null, null, '999999999')`));
    expect(right).toEqual(wrong);
    for (const r of right as { matched: string[] }[]) expect(r.matched).not.toContain('tax_id');
    expect(await as(f, 'pm', () => q(db, `select id from core.match_parties('customer', 'x', null, null, null, '123456789')`))).toEqual([]);
    await db.query(`update core.customers set deleted_at = now() where id = $1`, [orgLevel]);
  });

  it('M3: a customer with Books money records, or with no company, is merged only with Books customer edit or an owner seat', async () => {
    const a = await customer('Kappa Co', { location_id: L1 });
    const b = await customer('Kappa Company', { location_id: L1 });
    const inv = await invoice(b, { subtotal: 500_000 });
    const orgA = await customer('Kappa Org', {});           // org-level (no company)
    const orgB = await customer('Kappa Org Inc', {});
    for (const p of ['dispatcher', 'gm'] as const) {        // projects.customers:edit at L1, not Books
      expect(await as(f, p, () => errorOf(db, `select core.merge_parties('customer', $1, $2)`, [a, b]))).toMatch(/CORE_MERGE_BOOKS_AUTHORITY/);
      expect(await as(f, p, () => errorOf(db, `select core.merge_parties('customer', $1, $2)`, [orgA, orgB]))).toMatch(/CORE_FORBIDDEN|CORE_MERGE_BOOKS_AUTHORITY/);
    }
    expect((await one<{ customer_id: string }>(`select customer_id from public.invoices where id = $1`, [inv])).customer_id).toBe(b);
    // Books customer edit (ar_clerk: mdm.customers:edit) may
    await asBooks(() => db.query(`select core.merge_parties('customer', $1, $2)`, [a, b]));
    expect((await one<{ customer_id: string }>(`select customer_id from public.invoices where id = $1`, [inv])).customer_id).toBe(a);
    // a Projects edit right at every company still cannot merge org-level customers without Books / owner
    expect(await as(f, 'legacyStaff', () => errorOf(db, `select core.merge_parties('customer', $1, $2)`, [orgA, orgB]))).toMatch(/CORE_FORBIDDEN|CORE_MERGE_BOOKS_AUTHORITY/);
    await as(f, 'owner', () => db.query(`select core.merge_parties('customer', $1, $2)`, [orgA, orgB]));
  });

  it('M3 (survivor side): a Books customer kept as survivor cannot take the victim\'s name or email without Books edit', async () => {
    const booksCust = await customer('Kappa Holdings', { email: 'ar@kappa.test', location_id: L1 });
    const other = await customer('Kappa Holdings Group', { email: 'attacker@evil.test', location_id: L1 });
    await invoice(booksCust, { subtotal: 500_000 });
    // keeping the invoiced customer as the victim is refused (victim side) …
    expect(await as(f, 'dispatcher', () => errorOf(db, `select core.merge_parties('customer', $1, $2)`, [other, booksCust]))).toMatch(/CORE_MERGE_BOOKS_AUTHORITY/);
    // … and keeping it as the survivor while choosing the victim's fields is refused too (survivor side)
    expect(await as(f, 'dispatcher', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{"email":"victim","name":"victim"}')`, [booksCust, other])))
      .toMatch(/CORE_MERGE_BOOKS_AUTHORITY.*surviving/);
    expect(await one(`select name, email, merged_into from core.customers where id = $1`, [booksCust])).toEqual({ name: 'Kappa Holdings', email: 'ar@kappa.test', merged_into: null });
    expect((await one<{ merged_into: string | null }>(`select merged_into from core.customers where id = $1`, [other])).merged_into).toBeNull();
    // a survivor blank filled from the victim counts as a change as well
    const blank = await customer('Kappa Supply', { location_id: L1 });
    await invoice(blank, { subtotal: 1_000 });
    const filler = await customer('Kappa Supply Co', { phone: '515-555-0177', location_id: L1 });
    expect(await as(f, 'dispatcher', () => errorOf(db, `select core.merge_parties('customer', $1, $2)`, [blank, filler]))).toMatch(/CORE_MERGE_BOOKS_AUTHORITY.*phone/);
    // explicit "keep the survivor's values" with nothing to fill merges (references move onto the Books customer)
    expect(await as(f, 'dispatcher', () => errorOf(db, `select core.merge_parties('customer', $1, $2, '{"email":"survivor","name":"survivor"}')`, [booksCust, other]))).toBeNull();
    expect(await one(`select name, email from core.customers where id = $1`, [booksCust])).toEqual({ name: 'Kappa Holdings', email: 'ar@kappa.test' });
    // Books customer edit may take the victim's values
    const c2 = await customer('Kappa Holdings Two', { email: 'new@kappa.test', location_id: L1 });
    await asBooks(() => db.query(`select core.merge_parties('customer', $1, $2, '{"email":"victim"}')`, [booksCust, c2]));
    expect((await one<{ email: string }>(`select email from core.customers where id = $1`, [booksCust])).email).toBe('new@kappa.test');
  });

  it('L1: a Projects-only seat sees a duplicate pair only when it reaches both records', async () => {
    const o1 = await customer('Omega Builders', { email: 'o@omega.test', location_id: L2 });
    const o2 = await customer('Omega Builders Inc', { email: 'o@omega.test', location_id: L2 });
    const pair = (await one<{ id: string }>(`select id from core.duplicate_reviews where kind = 'customer' and $1 in (a_id, b_id) and $2 in (a_id, b_id)`, [o1, o2])).id;
    for (const p of ['pm', 'dispatcher', 'gm'] as const) { // L1 seats
      expect(await as(f, p, () => q(db, `select 1 from core.duplicate_reviews where id = $1`, [pair])), p).toEqual([]);
    }
    expect(await as(f, 'owner', () => q(db, `select 1 from core.duplicate_reviews where id = $1`, [pair]))).toHaveLength(1);
    expect(await asBooks(() => q(db, `select 1 from core.duplicate_reviews where id = $1`, [pair]))).toHaveLength(1);
    const all = await as(f, 'dispatcher', () => q<{ kind: string; a_id: string; b_id: string }>(db, `select kind, a_id, b_id from core.duplicate_reviews where kind = 'customer'`));
    const reach = new Set((await as(f, 'dispatcher', () => q<{ id: string }>(db, `select crm.my_customer_ids() id`))).map((r) => r.id));
    for (const r of all) expect(reach.has(r.a_id) && reach.has(r.b_id)).toBe(true);
  });

  it('L4: the safety net and the matcher look candidates up through indexes, not a scan of every record', async () => {
    const idx = (await q<{ indexname: string }>(db, `select indexname from pg_indexes where schemaname = 'core' and indexname like 'core\\_%party%'`)).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['core_customers_party_email_idx', 'core_customers_party_phone_idx', 'core_customers_party_tax_idx',
      'core_customers_party_addr_idx', 'core_customers_party_name_gin', 'core_vendors_party_email_idx', 'core_contacts_party_email_idx', 'core_contacts_party_name_gin']));
    await db.query(`insert into core.customers (org_id, name, email, phone) select $1, 'Bulk ' || g, 'bulk' || g || '@x.test', '515' || lpad(g::text, 7, '0') from generate_series(1, 3000) g`, [ORG_A]);
    await db.exec(`analyze core.customers`);
    const plans: string[] = [];
    for (const sql of [
      `select c.id from core.customers c where c.org_id = '${ORG_A}' and core.party_norm_email(c.email) = 'ops@harbor.test'`,
      `select c.id from core.customers c where c.org_id = '${ORG_A}' and core.party_norm_phone(c.phone) = '5155550100'`,
      `select c.id from core.customers c where c.org_id = '${ORG_A}' and core.party_norm_tax(c.tax_id) = '551234567'`,
      `select c.id from core.customers c where c.org_id = '${ORG_A}' and btrim(c.zip) = '50010' and core.party_norm_text(c.address_line1) = '12 oak st'`,
      `select c.id from core.customers c where c.org_id = '${ORG_A}' and core.party_tokens(c.name) && array['harbor']`,
    ]) {
      const plan = (await q<{ 'QUERY PLAN': string }>(db, `explain ${sql}`)).map((r) => r['QUERY PLAN']).join('\n');
      plans.push(plan);
      expect(plan, sql).toMatch(/Index|Bitmap/);
      expect(plan, sql).not.toMatch(/Seq Scan on customers/);
    }
    // a new bulk row still files nothing, and the net still files a strong match
    const dup = await customer('Bulk 7', { email: 'BULK7@x.test' });
    expect(await q(db, `select 1 from core.duplicate_reviews where $1 in (a_id, b_id)`, [dup])).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tie-outs (pm.v_job_tieout / pm.v_company_tieout)', () => {
  beforeAll(async () => {
    // a tiny chart of accounts + an open period for L1
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() + 1;
    await db.exec(`
      with t as (insert into public.account_types (org_id, name, code, display_order, normal_balance) values ('${ORG_A}', 'COGS', 'COGS', 5, 'DEBIT') returning id),
           st as (insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) select '${ORG_A}', t.id, 'Cost of goods sold', 'COST_OF_GOODS_SOLD', 1 from t returning id),
           g as (insert into public.account_groups (org_id, account_sub_type_id, name, display_order) select '${ORG_A}', st.id, 'Job cost', 1 from st returning id)
      insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, approval_status)
      select v.id::uuid, '${ORG_A}', g.id, v.num, v.nm, v.ty::account_type_enum, v.sty::account_sub_type_enum, 'APPROVED'
        from g, (values ('a0000000-0000-4000-8000-00000000c051', '5000', 'Job materials', 'COGS', 'COST_OF_GOODS_SOLD'),
                        ('a0000000-0000-4000-8000-00000000e001', '3000', 'Equity', 'EQUITY', 'EQUITY')) v(id, num, nm, ty, sty);
      insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
      values ('${ORG_A}', '${L1}', ${y}, ${m}, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date, 'OPEN');
    `);
    let seq = 0;
    const gl = async (job: string, cents: number) => {
      seq++;
      await db.query(
        `with e as (
           insert into public.gl_entries (org_id, location_id, entry_number, entry_date, entry_type, fiscal_period_id, source_module, status, posted_at)
           values ($1, $2, $3, current_date, 'STANDARD', (select id from public.fiscal_periods where location_id = $2 and current_date between start_date and end_date), 'GL_HISTORY', 'POSTED', now())
           returning id)
         insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id, job_id)
         select $1, e.id, v.n, v.acct::uuid, v.dr, v.cr, $2, v.job::uuid
           from e, (values (1, 'a0000000-0000-4000-8000-00000000c051', $4::bigint, 0::bigint, $5::text),
                           (2, 'a0000000-0000-4000-8000-00000000e001', 0::bigint, $4::bigint, null::text)) v(n, acct, dr, cr, job)`,
        [ORG_A, L1, `TIE-${seq}`, cents, job]);
    };
    const jobCost = (job: string, ref: string, cents: number) => db.query(
      `insert into pm.job_costs (org_id, job_id, location_id, source_ref, amount_cents, lifecycle, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
       values ($1, $2, $3, $4, $5, 'CLEARED', gen_random_uuid(), now(), 2, now())`, [ORG_A, job, L1, ref, cents]);
    const event = async (job: string, status: string, ageMinutes: number) => (await one<{ id: string }>(
      `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status, created_at)
       values ($1, gen_random_uuid(), 'JOB_BILLING', 'PROJECTS', jsonb_build_object('job_id', $2::text), current_date, $3, now() - make_interval(mins => $4)) returning id`,
      [ORG_A, job, status, ageMinutes])).id;

    // J1 ties: cost 2,500.00 both sides; billing 1,000.00 request ↔ invoice
    await jobCost(J1, 'tie:j1:1', 250_000);
    await gl(J1, 250_000);
    const ev1 = await event(J1, 'processed', 120);
    await db.query(`update pm.billing_requests set status = 'EMITTED', event_id = $2, net_cents = 100000, emitted_at = now() where job_id = $1`, [J1, ev1]);
    const br1 = await one<{ source_ref: string; customer: string }>(`select r.source_ref, (select customer_id from core.jobs where id = r.job_id) customer from pm.billing_requests r where r.job_id = $1`, [J1]);
    const cust = br1.customer ?? ids.harbor;
    await invoice(cust, { job: J1, subtotal: 100_000, sourceRef: br1.source_ref });
    // J2 does not: cost 3,000.00 vs 2,000.00 in the GL; a request emitted 10 days ago with no invoice;
    // a deposit held in Books that Projects never requested; a rejected message
    await jobCost(J2, 'tie:j2:1', 300_000);
    await gl(J2, 200_000);
    const ev2 = await event(J2, 'rejected', 5);
    await db.query(`update pm.billing_requests set status = 'EMITTED', event_id = $2, net_cents = 50000, emitted_at = now() - interval '10 days' where job_id = $1`, [J2, ev2]);
    const ev3 = await event(J2, 'processed', 300);
    await db.query(`insert into pm.deposit_requests (org_id, location_id, job_id, amount_cents, status, source_ref, event_id) values ($1, $2, $3, 20000, 'ISSUED', 'dep:j2', $4)`, [ORG_A, L1, J2, ev3]);
    const j2cust = (await one<{ c: string }>(`select customer_id c from core.jobs where id = $1`, [J2])).c;
    await db.query(`insert into public.customer_deposits (org_id, location_id, customer_id, job_id, amount_cents, applied_cents, status, source_ref)
                    values ($1, $2, $3, $4, 20000, 5000, 'PARTIALLY_APPLIED', 'dep:j2'), ($1, $2, $3, $4, 7000, 0, 'HELD', null)`, [ORG_A, L1, j2cust, J2]);
    await db.query(`update pm.time_entries set approval_state = 'APPROVED', approved_at = now(), approved_by = 'x' where job_id = $1`, [J2]);
  });

  type Row = { job_id: string; check_key: string; projects_cents: number | null; books_cents: number | null; diff_cents: number | null; status: string; cause: string | null; action: string | null };
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const byKey = (rows: Row[], job: string): Record<string, Row> => Object.fromEntries(rows.filter((r) => r.job_id === job)
    .map((r) => [r.check_key, { ...r, projects_cents: num(r.projects_cents), books_cents: num(r.books_cents), diff_cents: num(r.diff_cents) }]));

  it('a job whose Books data matches ties out; commitments and time are pending (Books does not record them)', async () => {
    const r = byKey(await as(f, 'owner', () => q<Row>(db, `select * from pm.v_job_tieout`)), J1);
    expect(Object.keys(r).sort()).toEqual(['billing', 'commitments', 'deposits', 'events', 'job_cost', 'time']);
    expect(r.job_cost).toMatchObject({ projects_cents: 250000, books_cents: 250000, diff_cents: 0, status: 'ok' });
    expect(r.billing).toMatchObject({ projects_cents: 100000, books_cents: 100000, status: 'ok' });
    expect(r.deposits.status).toBe('ok');
    expect(r.events.status).toBe('ok');
    expect(r.commitments).toMatchObject({ status: 'pending', cause: 'Books does not record this yet', books_cents: null });
    expect(r.time).toMatchObject({ status: 'pending', cause: 'Books does not record this yet' });
  });

  it('a job whose Books data does not match shows dollar-ranked exceptions with a cause and an action', async () => {
    const r = byKey(await as(f, 'owner', () => q<Row>(db, `select * from pm.v_job_tieout`)), J2);
    expect(r.job_cost).toMatchObject({ projects_cents: 300000, books_cents: 200000, diff_cents: 100000, status: 'exception', action: 'Open the job cost detail' });
    // Books also holds an invoice for J2 Projects never requested (the merged customer's PAID invoice)
    expect(r.billing).toMatchObject({ projects_cents: 50000, books_cents: 123456, status: 'exception', action: 'Resend the billing request' });
    expect(r.billing.cause).toMatch(/no invoice after 2 business days/);
    expect(r.deposits).toMatchObject({ projects_cents: 15000, books_cents: 22000, diff_cents: -7000, status: 'exception' });
    expect(r.events).toMatchObject({ status: 'exception', action: 'Resend the rejected message' });
    expect(r.time).toMatchObject({ projects_cents: 800, status: 'pending' }); // 8 h × 100
  });

  it('masking per persona: Labor sees their job\'s statuses with no dollars; PM sees dollars on own jobs only; Books staff see all', async () => {
    const labor = await as(f, 'labor', () => q<Row>(db, `select * from pm.v_job_tieout`));
    expect(new Set(labor.map((x) => x.job_id))).toEqual(new Set([J2]));
    const lj = byKey(labor, J2);
    expect(lj.job_cost).toMatchObject({ projects_cents: null, books_cents: null, diff_cents: null, status: 'exception' });
    expect(lj.time.projects_cents).toBe(800); // hours are not money
    const pm = await as(f, 'pm', () => q<Row>(db, `select * from pm.v_job_tieout`));
    expect(new Set(pm.map((x) => x.job_id))).toEqual(new Set([J1]));
    expect(byKey(pm, J1).job_cost.projects_cents).toBe(250000);
    const books = await asBooks(() => q<Row>(db, `select * from pm.v_job_tieout`));
    expect(byKey(books, J2).job_cost.diff_cents).toBe(100000);
    expect(await as(f, 'bOwner', () => q(db, `select * from pm.v_job_tieout where job_id = any ($1)`, [[J1, J2, J3]]))).toEqual([]);
  });

  it('company summary: exceptions, exception dollars, pending checks and open duplicate reviews', async () => {
    const r = await as(f, 'owner', () => q<{ location_id: string; jobs_with_exceptions: number; exception_count: number; exception_cents: string; open_duplicate_reviews: number; status: string; jobs_tied: number }>(
      db, `select * from pm.v_company_tieout where location_id = $1`, [L1]));
    expect(r[0].status).toBe('exception');
    expect(r[0].jobs_with_exceptions).toBe(1);
    expect(r[0].exception_count).toBe(4);
    expect(Number(r[0].exception_cents)).toBe(100_000 + 73_456 + 7_000);
    expect(r[0].open_duplicate_reviews).toBeGreaterThanOrEqual(0);
    const labor = await as(f, 'labor', () => q<{ exception_cents: string | null }>(db, `select * from pm.v_company_tieout where location_id = $1`, [L1]));
    expect(labor[0].exception_cents).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('1111 follow-ups: masked views, supervisor jobs:create, phone idempotency keys', () => {
  it('pm.v_core_customers_masked / v_core_vendors_masked expose merged_into and merged_at', async () => {
    for (const v of ['v_core_customers_masked', 'v_core_vendors_masked']) {
      const cols = (await q<{ c: string }>(db, `select column_name c from information_schema.columns where table_schema = 'pm' and table_name = $1`, [v])).map((r) => r.c);
      expect(cols, v).toEqual(expect.arrayContaining(['merged_into', 'merged_at']));
    }
    const victim = (await one<{ id: string }>(`select id from core.customers where merged_into is not null limit 1`)).id;
    const r = await as(f, 'owner', () => q<{ merged_into: string | null }>(db, `select merged_into from pm.v_core_customers_masked where id = $1`, [victim]));
    expect(r[0]?.merged_into).toBeTruthy();
  });

  it('projects_supervisor (template and the tenant clone) holds projects.jobs:create; projects_labor does not', async () => {
    const has = async (level: string, key: string) => (await q(db,
      `select 1 from core.role_definitions rd join core.role_versions v on v.role_id = rd.id and v.state = 'published'
         join core.role_grants g on g.role_version_id = v.id
        where rd.owner_level = $1 and rd.key = $2 and ($1 = 'platform' or rd.org_id = $3) and g.capability = 'projects.jobs' and 'create' = any (g.actions)`,
      [level, key, ORG_A])).length > 0;
    expect(await has('platform', 'projects_supervisor')).toBe(true);
    expect(await has('tenant', 'projects_supervisor')).toBe(true);
    expect(await has('platform', 'projects_labor')).toBe(false);
    expect(await has('tenant', 'projects_labor')).toBe(false);
    const clone = await one<{ upstream_version: number; current_version: number }>(
      `select c.upstream_version, t.current_version from core.role_definitions c join core.role_definitions t on t.id = c.upstream_template_id
        where c.owner_level = 'tenant' and c.org_id = $1 and c.key = 'projects_supervisor'`, [ORG_A]);
    expect(clone.upstream_version).toBe(clone.current_version);
    // the supervisor files a punch item on their job from the phone; the crew still cannot
    const ok = await as(f, 'supervisor', () => errorOf(db, `insert into pm.punch_items (org_id, job_id, kind, title) values ($1, $2, 'PUNCH', 'Rail loose')`, [ORG_A, J1]));
    expect(ok).toBeNull();
    const no = await as(f, 'labor', () => errorOf(db, `insert into pm.punch_items (org_id, job_id, kind, title) values ($1, $2, 'PUNCH', 'Rail loose')`, [ORG_A, J2]));
    expect(no).toMatch(/row-level security/);
    expect((await one<{ n: number }>(`select pm.access_sync_role_templates('[]'::jsonb) n`)).n).toBe(0);
  });

  it('a re-sent phone command cannot create a second daily log or punch item (unique per org on ext._client_command_id; the real ext rule applies)', async () => {
    const cmd = '9b1d8a4e-2f0c-4c55-9c1e-7d3b2a1f0e01';
    await db.query(`insert into pm.field_logs (org_id, job_id, kind, log_date, ext) values ($1, $2, 'DAILY', current_date, jsonb_build_object('_client_command_id', $3::text, '_source', 'merit_workforce'))`, [ORG_A, J1, cmd]);
    expect(await errorOf(db, `insert into pm.field_logs (org_id, job_id, kind, log_date, ext) values ($1, $2, 'DAILY', current_date, jsonb_build_object('_client_command_id', $3::text, '_source', 'merit_workforce'))`, [ORG_A, J1, cmd]))
      .toMatch(/duplicate key/);
    await db.query(`insert into pm.punch_items (org_id, job_id, kind, title, ext) values ($1, $2, 'PUNCH', 'A', jsonb_build_object('_client_command_id', $3::text, '_source', 'merit_workforce'))`, [ORG_A, J1, cmd]);
    expect(await errorOf(db, `insert into pm.punch_items (org_id, job_id, kind, title, ext) values ($1, $2, 'PUNCH', 'B', jsonb_build_object('_client_command_id', $3::text, '_source', 'merit_workforce'))`, [ORG_A, J1, cmd]))
      .toMatch(/duplicate key/);
    // the same command id in another tenant, and rows without a command id, are unaffected
    await db.query(`insert into pm.punch_items (org_id, job_id, kind, title, ext) values ($1, $2, 'PUNCH', 'C', jsonb_build_object('_client_command_id', $3::text, '_source', 'merit_workforce'))`, [ORG_B, JB, cmd]);
    await db.query(`insert into pm.punch_items (org_id, job_id, kind, title) values ($1, $2, 'PUNCH', 'D'), ($1, $2, 'PUNCH', 'E')`, [ORG_A, J1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Last: re-applying 1110 runs its deploy backfill again (it would give later test seats a Projects grant).
describe('idempotency', () => {
  it('1111 is idempotent and survives a later 1110 re-apply', async () => {
    const before = await q(db, `select count(*)::int n from crm.pipelines`);
    await applyMigration(db, '1111_shared_records.sql');
    await applyMigration(db, '1110_pm_access.sql');
    expect(await q(db, `select count(*)::int n from crm.pipelines`)).toEqual(before);
    expect(await q(db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    expect(await q(db, `select * from crm.access_policy_gaps()`)).toEqual([]);
  });
});
