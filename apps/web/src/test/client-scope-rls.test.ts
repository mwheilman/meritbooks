/**
 * Wave 2B exit gate — client-scoped (location) RLS (migration 163, IA M-4 v2, 05 §5.2.1).
 *
 * Replays every migration into PGlite with hosted Supabase's default grants, seeds:
 *   tenant A: clients C1, C2 (+ own books OWN)
 *     bk1  — Bookkeeper, `client` assignment on C1
 *     bk2  — Bookkeeper, `client` assignment on C2
 *     grp  — `client_set` assignment on a static set {C1, C2}
 *     ctl  — Controller, `all_clients`
 *     exp  — `client` C2 assignment that EXPIRED yesterday
 *     susp — `client` C1 assignment on a SUSPENDED membership
 *   tenant B: one all-clients admin
 * and one row per client in gl_entries / gl_entry_lines / bills / bill_lines / invoices /
 * bank_transactions / core.locations, then proves, per staging mode:
 *   enforce → bk1 sees only C1, bk2 only C2, grp both, ctl all, B nothing of A, expired /
 *             suspended nothing; writes are scope-checked; org-level rows stay visible;
 *   off / shadow → behaviour is exactly the org policy (unchanged);
 *   the contract functions (2A calls them) answer truthfully in every mode;
 *   the shadow logger records only genuine out-of-scope clients, bounded per day.
 * Plus the GUARD: every table with an owning `location_id` (and every stage-(a) child of
 * a client-owned table) carries the restrictive `client_scope_rls` policy, so a future
 * table can't skip it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const OWN = 'aaaaaaaa-2222-0000-0000-000000000000';
const C1 = 'aaaaaaaa-2222-0000-0000-000000000001';
const C2 = 'aaaaaaaa-2222-0000-0000-000000000002';
const LB = 'bbbbbbbb-2222-0000-0000-000000000001';

type Mode = 'off' | 'shadow' | 'enforce';
type Who = 'bk1' | 'bk2' | 'grp' | 'ctl' | 'exp' | 'susp' | 'b_admin' | 'nobody';

/** Tables the migration deliberately leaves out (must match 163's EXCLUDED list). */
const EXCLUDED = new Set([
  'core.membership_locations', 'core.client_scope_shadow_log',
  // access-governance rows: their own RLS limits them to admins / requester / reviewer;
  // client scope would hide a requester's own request for a client they don't have yet.
  'core.access_requests', 'core.access_reviews', 'core.sod_exceptions',
]);

/**
 * Stage-(b) children of client-owned tables that are NOT yet scoped by their parent.
 * RATCHET: this list may only shrink. A new child table of a client-owned table must be
 * added to core.apply_client_scope_rls()'s child list (or carry its own location_id).
 */
const DEFERRED_CHILDREN = new Set<string>([
  // governance children whose parents are EXCLUDED above (own admin/reviewer RLS)
  'core.access_review_items', 'core.template_updates',
  // reference / config rows keyed to a client-owned dimension, not client books
  'core.employees', // HR master data (department FK); the seat itself, not client books
  'core.vendors', // shared vendor master (default_department_id is a hint, not ownership)
  'public.customer_invoice_settings', // per-CUSTOMER invoice defaults (176): customers are org-level; template_id is a presentation reference, not ownership
  'core.memberships', // identity spine (role_definition_id FK)
  'core.role_versions', // grant definitions (role FK) — the role row itself is scoped
  'core.permission_set_versions',
  // Projects-owned tables (other session's zone) — scoped when PM adopts M-4
  'core.change_orders', 'core.job_phases', 'public.change_orders', 'public.job_phases',
  // multi-parent / policy rows — need a design decision (lead)
  'public.bill_po_links', 'public.vendor_compliance_events', 'public.vendor_payment_holds',
  'public.ap_approval_policies', 'public.expense_policies', 'public.book_tax_account_tags',
  'public.book_tax_line_overrides',
]);

let db: PGlite;
const ids = {
  membership: new Map<Who, string>(),
};

// ── fixture helpers ───────────────────────────────────────────────────────────────

/** Insert a row, filling every NOT NULL column without a default with a type-correct dummy. */
async function insertRow(qualified: string, values: Record<string, unknown>): Promise<void> {
  const [schema, table] = qualified.split('.');
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null
        and is_generated = 'NEVER'`,
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

async function tenantRole(orgId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `select id from core.role_definitions
      where owner_level = 'tenant' and org_id = $1 and max_assignment_days is null
        and audience = 'internal_staff' and status = 'active'
      order by key limit 1`,
    [orgId],
  );
  if (!r.rows[0]) throw new Error(`no tenant role in ${orgId}`);
  return r.rows[0].id;
}

async function addMember(who: Who, orgId: string, role = 'accounting_specialist'): Promise<string> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_${who}`]);
  const m = await db.query<{ id: string }>(
    `insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`,
    [u.rows[0].id, orgId, role],
  );
  ids.membership.set(who, m.rows[0].id);
  return m.rows[0].id;
}

async function assign(
  who: Who,
  orgId: string,
  scope: { all: true } | { location: string } | { set: string },
  extra: { from?: string; to?: string } = {},
): Promise<void> {
  const roleId = await tenantRole(orgId);
  const scopeType = 'all' in scope ? 'all_clients' : 'location' in scope ? 'client' : 'client_set';
  await db.query(
    `insert into core.access_assignments
       (org_id, membership_id, grant_type, role_id, scope_type, location_id, client_set_id, effective_from, effective_to)
     values ($1, $2, 'role', $3, $4, $5, $6, coalesce($7::timestamptz, now() - interval '30 days'), $8::timestamptz)`,
    [
      orgId,
      ids.membership.get(who),
      roleId,
      scopeType,
      'location' in scope ? scope.location : null,
      'set' in scope ? scope.set : null,
      extra.from ?? null,
      extra.to ?? null,
    ],
  );
}

async function setMode(orgId: string, mode: Mode): Promise<void> {
  await db.query(`update core.organizations set client_scope_rls_mode = $2 where id = $1`, [orgId, mode]);
}

/** Run fn as a PostgREST caller (SET ROLE + verified JWT claims), always resetting. */
async function as<T>(who: Who | 'service' | 'anon', fn: () => Promise<T>): Promise<T> {
  const orgId = who === 'b_admin' ? ORG_B : ORG_A;
  const claims =
    who === 'anon' ? {} : who === 'service' ? { role: 'service_role' } : { sub: `user_${who}`, org_id: orgId, role: 'authenticated' };
  const role = who === 'anon' ? 'anon' : who === 'service' ? 'service_role' : 'authenticated';
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

/** Distinct client ids visible to the caller in one table (via its client column). */
async function visibleClients(who: Who | 'service' | 'anon', table: string, col = 'location_id'): Promise<string[]> {
  return as(who, async () => {
    const r = await db.query<{ v: string }>(`select distinct ${col}::text as v from ${table} where ${col} is not null order by 1`);
    return r.rows.map((x) => x.v);
  });
}

/** Child rows visible, mapped to their parent's client. */
async function visibleChildClients(who: Who, child: string, fk: string, parent: string): Promise<string[]> {
  // the parent read runs as superuser (after the as() block) so it only maps ids
  const childIds = await as(who, async () =>
    (await db.query<{ v: string }>(`select distinct ${fk}::text as v from ${child}`)).rows.map((x) => x.v),
  );
  if (childIds.length === 0) return [];
  const r = await db.query<{ v: string }>(
    `select distinct location_id::text as v from ${parent} where id = any($1::uuid[]) order by 1`,
    [childIds],
  );
  return r.rows.map((x) => x.v);
}

async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── fixture ───────────────────────────────────────────────────────────────────────

const REPRESENTATIVE: ReadonlyArray<{ table: string; col?: string }> = [
  { table: 'core.locations', col: 'id' },
  { table: 'public.gl_entries' },
  { table: 'public.gl_entry_lines' },
  { table: 'public.bills' },
  { table: 'public.invoices' },
  { table: 'public.bank_transactions' },
];

const billIds = new Map<string, string>();

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));

  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG_A}', 'Firm A', 'firm-a-2b', 'firm'),
      ('${ORG_B}', 'Company B', 'company-b-2b', 'company');
  `);
  await insertRow('core.locations', { id: OWN, org_id: ORG_A, name: 'Firm A LLC', short_code: 'OWN', is_management_company: true });
  await insertRow('core.locations', { id: C1, org_id: ORG_A, name: 'Client One', short_code: 'C1' });
  await insertRow('core.locations', { id: C2, org_id: ORG_A, name: 'Client Two', short_code: 'C2' });
  await insertRow('core.locations', { id: LB, org_id: ORG_B, name: 'B Main', short_code: 'BM' });
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_A]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);

  await addMember('bk1', ORG_A);
  await addMember('bk2', ORG_A);
  await addMember('grp', ORG_A);
  await addMember('ctl', ORG_A, 'owner');
  await addMember('exp', ORG_A);
  await addMember('susp', ORG_A);
  await addMember('b_admin', ORG_B, 'owner');

  const set = await db.query<{ id: string }>(
    `insert into core.client_sets (org_id, name, kind) values ($1, 'Group C1+C2', 'static') returning id`,
    [ORG_A],
  );
  await db.query(
    `insert into core.client_set_members (set_id, location_id, org_id) values ($1, $2, $4), ($1, $3, $4)`,
    [set.rows[0].id, C1, C2, ORG_A],
  );

  await assign('bk1', ORG_A, { location: C1 });
  await assign('bk2', ORG_A, { location: C2 });
  await assign('grp', ORG_A, { set: set.rows[0].id });
  await assign('ctl', ORG_A, { all: true });
  await assign('exp', ORG_A, { location: C2 }, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
  await assign('susp', ORG_A, { location: C1 });
  await db.query(`update core.memberships set status = 'suspended' where id = $1`, [ids.membership.get('susp')]);
  await assign('b_admin', ORG_B, { all: true });

  // Business rows — triggers (period lock, balance, numbering) are irrelevant to read
  // scope, so fixtures load with replication-role replica (constraints still checked).
  await db.exec(`set session_replication_role = replica`);
  for (const [org, loc] of [[ORG_A, OWN], [ORG_A, C1], [ORG_A, C2], [ORG_B, LB]] as const) {
    const je = crypto.randomUUID();
    await insertRow('public.gl_entries', { id: je, org_id: org, location_id: loc, created_by: crypto.randomUUID() });
    await insertRow('public.gl_entry_lines', { org_id: org, gl_entry_id: je, line_number: 1, location_id: loc, debit_cents: 100, credit_cents: 0 });
    const bill = crypto.randomUUID();
    billIds.set(loc, bill);
    await insertRow('public.bills', { id: bill, org_id: org, location_id: loc });
    await insertRow('public.bill_lines', { org_id: org, bill_id: bill });
    await insertRow('public.invoices', { org_id: org, location_id: loc });
    await insertRow('public.bank_transactions', { org_id: org, location_id: loc });
    // a still member-writable client-owned table (class B, AI working state) for the write probes:
    // bank_transactions is SELECT-only for members since migration 172.
    await insertRow('public.agent_runs', { org_id: org, location_id: loc, recipe: 'probe', title: 'probe' });
  }
  // an org-level (no client) vendor pattern stays visible to everyone in the tenant
  await insertRow('public.vendor_patterns', { org_id: ORG_A, location_id: null });
  await insertRow('public.vendor_patterns', { org_id: ORG_A, location_id: C2 });
  // intercompany C1 → OWN
  await insertRow('public.intercompany_transactions', { org_id: ORG_A, from_location_id: C1, to_location_id: OWN, nature: 'FUNDING' });
  await db.exec(`set session_replication_role = origin`);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── enforce ───────────────────────────────────────────────────────────────────────

describe('enforce: client scope is honoured by the database', () => {
  beforeAll(async () => {
    await setMode(ORG_A, 'enforce');
    await setMode(ORG_B, 'enforce');
  });

  const expectations: ReadonlyArray<[Who, string[]]> = [
    ['bk1', [C1]],
    ['bk2', [C2]],
    ['grp', [C1, C2].sort()],
    ['ctl', [OWN, C1, C2].sort()],
    ['exp', []],
    ['susp', []],
    ['b_admin', [LB]],
  ];

  for (const { table, col } of REPRESENTATIVE) {
    for (const [who, want] of expectations) {
      it(`${who} sees exactly ${want.length} client(s) in ${table}`, async () => {
        expect(await visibleClients(who, table, col)).toEqual(want);
      });
    }
  }

  it('child rows follow their parent (bill_lines via bills)', async () => {
    expect(await visibleChildClients('bk1', 'public.bill_lines', 'bill_id', 'public.bills')).toEqual([C1]);
    expect(await visibleChildClients('bk2', 'public.bill_lines', 'bill_id', 'public.bills')).toEqual([C2]);
    expect(await visibleChildClients('ctl', 'public.bill_lines', 'bill_id', 'public.bills')).toEqual([OWN, C1, C2].sort());
  });

  it('org-level rows (location_id null) stay visible; client rows are scoped', async () => {
    const rows = await as('bk1', async () =>
      (await db.query<{ v: string | null }>(`select location_id::text as v from public.vendor_patterns order by 1 nulls first`)).rows,
    );
    expect(rows.map((r) => r.v)).toEqual([null]);
  });

  it('intercompany rows are visible to either party, not to an outsider', async () => {
    const n = async (who: Who) =>
      as(who, async () => (await db.query<{ n: number }>(`select count(*)::int as n from public.intercompany_transactions`)).rows[0].n);
    expect(await n('bk1')).toBe(1); // C1 is the from-party
    expect(await n('bk2')).toBe(0);
    expect(await n('ctl')).toBe(1);
  });

  it('tenant B sees nothing of tenant A, even by id', async () => {
    const r = await as('b_admin', async () =>
      (await db.query(`select 1 from public.bills where id = $1`, [billIds.get(C1)])).rows.length,
    );
    expect(r).toBe(0);
  });

  it('anon sees nothing and does not error', async () => {
    expect(await visibleClients('anon', 'public.bills')).toEqual([]);
    expect(await visibleClients('anon', 'core.locations', 'id')).toEqual([]);
  });

  it('service_role is unaffected (hosted service_role also has BYPASSRLS; here via its service_all policy)', async () => {
    expect(await as('service', async () => (await db.query<{ b: boolean }>(`select core.client_scope_bypass() as b`)).rows[0].b)).toBe(true);
    expect(await visibleClients('service', 'core.client_set_members')).toEqual([C1, C2].sort());
    expect(await visibleClients('bk1', 'core.client_set_members')).toEqual([C1]);
  });

  // Write probes run on public.agent_runs (still member-writable, client-owned): the money
  // tables these used to probe (bank_transactions …) are SELECT-only for members since 171/172.
  it('writes are scope-checked: bk1 can update C1 but not C2, and cannot move a row out of scope', async () => {
    const upd = async (who: Who, loc: string) =>
      as(who, async () => (await db.query(`update public.agent_runs set location_id = location_id where location_id = $1`, [loc])).affectedRows ?? 0);
    expect(await upd('bk1', C1)).toBe(1);
    expect(await upd('bk1', C2)).toBe(0); // invisible → nothing to update
    const moved = await errorOf(() =>
      as('bk1', () => db.query(`update public.agent_runs set location_id = $2 where location_id = $1`, [C1, C2])),
    );
    expect(moved).toMatch(/row-level security/i);
  });

  it('bk1 cannot insert a row for a client outside scope (WITH CHECK), but RLS does not block C1', async () => {
    const ins = (loc: string) =>
      errorOf(() =>
        as('bk1', () =>
          db.query(
            `insert into public.agent_runs (org_id, location_id, recipe, title)
             values ($1, $2, 'probe-insert', 'probe')`,
            [ORG_A, loc],
          ),
        ),
      );
    expect(await ins(C2)).toMatch(/row-level security/i);
    const c1 = await ins(C1);
    expect(c1 === null || !/row-level security/i.test(c1)).toBe(true);
    await db.query(`delete from public.agent_runs where recipe = 'probe-insert'`);
  });

  it('clients are created only through the server (migration 167 / M4): even an all-clients controller cannot insert core.locations directly', async () => {
    // Members are SELECT-only on core.locations since 167; the app creates clients via the
    // admin client after a permission check. Client scope (163) still gates what they see.
    const err = await errorOf(() =>
      as('ctl', async () => {
        await db.query(
          `insert into core.locations (org_id, name, short_code) values ($1, 'Client Three', 'C3')`,
          [ORG_A],
        );
      }),
    );
    expect(err).toMatch(/permission denied|row-level security/i);
  });

  it('a client-scoped bookkeeper cannot create a new client', async () => {
    const err = await errorOf(() =>
      as('bk1', () => db.query(`insert into core.locations (org_id, name, short_code) values ($1, 'Rogue', 'RG')`, [ORG_A])),
    );
    expect(err).toMatch(/row-level security|permission denied/i);
  });
});

// ── off / shadow: unchanged ───────────────────────────────────────────────────────

describe('off and shadow: behaviour is exactly the org policy', () => {
  for (const mode of ['off', 'shadow'] as const) {
    it(`${mode}: every tenant-A member sees every tenant-A client; B still sees only B`, async () => {
      await setMode(ORG_A, mode);
      await setMode(ORG_B, mode);
      for (const { table, col } of REPRESENTATIVE) {
        for (const who of ['bk1', 'bk2', 'grp', 'ctl', 'exp', 'susp'] as const) {
          expect(await visibleClients(who, table, col), `${mode} ${who} ${table}`).toEqual([OWN, C1, C2].sort());
        }
        expect(await visibleClients('b_admin', table, col)).toEqual([LB]);
      }
    });
  }
});

// ── the contract (2A depends on it) ───────────────────────────────────────────────

describe('contract: core.can_access_location / core.accessible_location_ids', () => {
  for (const mode of ['off', 'enforce'] as const) {
    it(`answers the assignment truth regardless of mode (${mode})`, async () => {
      await setMode(ORG_A, mode);
      const ids_ = async (who: Who) =>
        as(who, async () => (await db.query<{ v: string }>(`select x::text as v from core.accessible_location_ids() x order by 1`)).rows.map((r) => r.v));
      expect(await ids_('bk1')).toEqual([C1]);
      expect(await ids_('grp')).toEqual([C1, C2].sort());
      expect(await ids_('ctl')).toEqual([OWN, C1, C2].sort());
      expect(await ids_('exp')).toEqual([]);
      expect(await ids_('susp')).toEqual([]);
      const can = async (who: Who, loc: string | null) =>
        as(who, async () => (await db.query<{ ok: boolean }>(`select core.can_access_location($1::uuid) as ok`, [loc])).rows[0].ok);
      expect(await can('bk1', C1)).toBe(true);
      expect(await can('bk1', C2)).toBe(false);
      expect(await can('bk1', null)).toBe(true);
      expect(await can('ctl', LB)).toBe(false); // another tenant's client
      expect(await can('b_admin', C1)).toBe(false);
    });
  }

  it('service_role → true / every location', async () => {
    const ok = await as('service', async () => (await db.query<{ ok: boolean }>(`select core.can_access_location($1::uuid) as ok`, [C2])).rows[0].ok);
    expect(ok).toBe(true);
  });

  it('client_scope_state() returns mode + scope in one call', async () => {
    await setMode(ORG_A, 'shadow');
    const s = await as('bk1', async () => (await db.query<{ s: { mode: string; all_clients: boolean; location_ids: string[]; membership_id: string } }>(`select core.client_scope_state() as s`)).rows[0].s);
    expect(s.mode).toBe('shadow');
    expect(s.all_clients).toBe(false);
    expect(s.location_ids).toEqual([C1]);
    expect(s.membership_id).toBe(ids.membership.get('bk1'));
  });
});

// ── shadow logging ────────────────────────────────────────────────────────────────

describe('shadow log: core.log_client_scope_denials', () => {
  const log = (who: Who, locs: string[], surface = 'company_list') =>
    as(who, async () => (await db.query<{ n: number }>(`select core.log_client_scope_denials($1::uuid[], $2) as n`, [locs, surface])).rows[0].n);

  it('off: records nothing', async () => {
    await setMode(ORG_A, 'off');
    expect(await log('bk1', [C1, C2])).toBe(0);
  });

  it('shadow: records only the genuinely out-of-scope client, once per day (hits++)', async () => {
    await setMode(ORG_A, 'shadow');
    expect(await log('bk1', [C1, C2, LB])).toBe(1); // C1 in scope, LB not a tenant-A client
    expect(await log('bk1', [C2])).toBe(1);
    const rows = await db.query<{ location_id: string; decision: string; hits: number; mode: string }>(
      `select location_id::text, decision, hits, mode from core.client_scope_shadow_log where org_id = $1`,
      [ORG_A],
    );
    expect(rows.rows).toEqual([{ location_id: C2, decision: 'would_deny', hits: 2, mode: 'shadow' }]);
  });

  it('an all-clients holder never logs', async () => {
    expect(await log('ctl', [C1, C2])).toBe(0);
  });

  it('rejects an unknown surface', async () => {
    expect(await errorOf(() => log('bk1', [C2], 'nope'))).toMatch(/unknown client-scope surface/);
  });

  it('members cannot write the log directly; only tenant admins can read it', async () => {
    const w = await errorOf(() =>
      as('bk1', () => db.query(`insert into core.client_scope_shadow_log (org_id, location_id, surface, mode, decision) values ($1, $2, 'api', 'shadow', 'would_deny')`, [ORG_A, C2])),
    );
    expect(w).toMatch(/permission denied|row-level security/i);
    const n = async (who: Who) => as(who, async () => (await db.query<{ n: number }>(`select count(*)::int as n from core.client_scope_shadow_log`)).rows[0].n);
    expect(await n('bk1')).toBe(0);
    expect(await n('ctl')).toBe(1); // 'owner' normalises to company_admin
    expect(await n('b_admin')).toBe(0); // other tenant
  });
});

// ── guard ─────────────────────────────────────────────────────────────────────────

describe('guard: every client-owned table carries the restrictive client-scope policy', () => {
  async function policyOn(): Promise<Map<string, { permissive: string; roles: string; qual: string; with_check: string }>> {
    const r = await db.query<{ t: string; permissive: string; roles: string; qual: string; with_check: string }>(
      `select schemaname || '.' || tablename as t, permissive, roles::text as roles, qual, with_check
         from pg_policies where policyname = 'client_scope_rls'`,
    );
    return new Map(r.rows.map((x) => [x.t, x]));
  }

  it('every public/core table with an owning uuid location_id is covered (or explicitly excluded)', async () => {
    const tables = await db.query<{ t: string }>(
      `select c.table_schema || '.' || c.table_name as t
         from information_schema.columns c
         join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
        where tb.table_type = 'BASE TABLE' and c.table_schema in ('public', 'core') and c.column_name = 'location_id'
        order by 1`,
    );
    const policies = await policyOn();
    const missing = tables.rows.map((r) => r.t).filter((t) => !EXCLUDED.has(t) && !policies.has(t));
    expect(missing, 'add the table to core.apply_client_scope_rls() (re-run it) or justify an exclusion').toEqual([]);
    expect(tables.rows.length).toBeGreaterThan(50);
  });

  it('the special owning columns are covered: locations(id), accounts(company_location_id), intercompany, report_packs', async () => {
    const p = await policyOn();
    for (const t of ['core.locations', 'public.accounts', 'public.intercompany_transactions', 'public.intercompany_balances', 'public.intercompany_loans', 'public.report_packs']) {
      const exists = (await db.query<{ r: string | null }>(`select to_regclass($1)::text as r`, [t])).rows[0].r;
      if (exists) expect(p.has(t), t).toBe(true);
    }
  });

  it('every policy is RESTRICTIVE, applies to PUBLIC, and USING = WITH CHECK through the contract', async () => {
    for (const [t, p] of await policyOn()) {
      expect(p.permissive, t).toBe('RESTRICTIVE');
      expect(p.roles, t).toBe('{public}');
      expect(p.qual, t).toContain('client_scope_bypass');
      expect(p.qual, t).toContain('accessible_location_ids');
      expect(p.with_check, t).toBe(p.qual);
    }
  });

  it('every child of a client-owned table is scoped by its parent or on the (shrinking) deferred list', async () => {
    const r = await db.query<{ child: string }>(
      `with scoped as (
         select distinct table_schema, table_name from information_schema.columns
          where table_schema in ('public', 'core') and column_name = 'location_id'
       )
       select distinct cn.nspname || '.' || c.relname as child
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
         join pg_class p on p.oid = k.confrelid join pg_namespace pn on pn.oid = p.relnamespace
        where k.contype = 'f' and cn.nspname in ('public', 'core') and c.relkind = 'r'
          and (pn.nspname, p.relname) in (select table_schema, table_name from scoped)
          and (cn.nspname, c.relname) not in (select table_schema, table_name from scoped)
        order by 1`,
    );
    const policies = await policyOn();
    const unscoped = r.rows.map((x) => x.child).filter((t) => !policies.has(t) && !DEFERRED_CHILDREN.has(t));
    expect(unscoped, 'scope the child via its parent in core.apply_client_scope_rls(), or add it to DEFERRED_CHILDREN with a reason').toEqual([]);
  });

  it('the policy helpers are executable by the roles whose queries evaluate them, never by PUBLIC', async () => {
    const r = await db.query<{ f: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      `select p.proname as f,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'core' and p.proname in ('accessible_location_ids', 'can_access_location', 'client_scope_bypass')`,
    );
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row, row.f).toEqual({ f: row.f, anon: true, auth: true, svc: true, pub: false });
    const internal = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', 'core.client_scope_caller_membership()', 'execute') as anon,
              has_function_privilege('authenticated', 'core.client_scope_caller_membership()', 'execute') as auth,
              has_function_privilege('service_role', 'core.client_scope_caller_membership()', 'execute') as svc`,
    );
    expect(internal.rows[0]).toEqual({ anon: false, auth: false, svc: true });
    const apply = await db.query<{ auth: boolean }>(
      `select has_function_privilege('authenticated', 'core.apply_client_scope_rls()', 'execute') as auth`,
    );
    expect(apply.rows[0].auth).toBe(false);
  });

  it('only service_role can change the staging mode (column is on a member-read-only table)', async () => {
    const err = await errorOf(() =>
      as('ctl', () => db.query(`update core.organizations set client_scope_rls_mode = 'off' where id = $1`, [ORG_A])),
    );
    // mig 154 revoked UPDATE on core.organizations from members: a tenant user can never
    // switch their own tenant out of `enforce`.
    expect(err).toMatch(/permission denied/i);
  });
});
