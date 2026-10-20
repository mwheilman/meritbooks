/**
 * Migration 170 — wave-2 security review fixes, proven against a real Postgres (PGlite
 * migration replay WITH hosted Supabase's default grants, so the attack surface is real).
 *
 *   §1  payroll_runs / payroll_run_employees: members are SELECT-only; the service role writes.
 *   §2  per-person payroll amounts are not member-selectable (column mask); the rest is.
 *   §3  public.approvals: every illegal status change is refused for every writer; parties
 *       and amount are pinned; v2 checks capability on ANY change into APPROVED / RELEASED.
 *   §4  a drain whose lease lapsed cannot finalize; one invoice / internal invoice per event.
 *   §5  core.replace_security_policy: atomic allowlist replace + access-log entry; service only.
 *   §6  mode changes are logged; a downgrade from v2 needs a second tenant admin (or a logged
 *       reason when there is only one); the requester can't confirm their own request.
 *   §7  FK cascades pass through the append-only guards (field_reveals, sod_exceptions).
 *   §8  the access-governance member policies evaluate the caller helpers once (initPlan).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG = '70700000-0000-0000-0000-000000000001';
const ORG_SOLO = '70700000-0000-0000-0000-000000000002';
const LOC = '70700000-1111-0000-0000-000000000001';
const MEMBER = 'user_2g_member';

let db: PGlite;

async function insertRow(table: string, values: Record<string, string | number | boolean | null>): Promise<void> {
  const [schema, name] = table.split('.');
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null
        and is_generated = 'NEVER'`,
    [schema, name],
  );
  const names = Object.keys(values);
  const params: unknown[] = names.map((n) => values[n]);
  const exprs = names.map((_, i) => `$${i + 1}`);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    names.push(c.column_name);
    if (label.rows[0]) { params.push(label.rows[0].enumlabel); exprs.push(`$${params.length}::${c.udt_name}`); }
    else if (/int|numeric/.test(c.udt_name)) { params.push(1); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'bool') { params.push(false); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'uuid') { params.push(crypto.randomUUID()); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'date') { params.push('2026-01-01'); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'jsonb') { params.push('{}'); exprs.push(`$${params.length}::jsonb`); }
    else { params.push(`x-${Math.random().toString(36).slice(2, 8)}`); exprs.push(`$${params.length}`); }
  }
  await db.query(`insert into ${table} (${names.map((n) => `"${n}"`).join(', ')}) values (${exprs.join(', ')})`, params);
}

async function asRole<T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>, orgId = ORG): Promise<T> {
  const claims = role === 'authenticated' ? { sub: MEMBER, org_id: orgId, role: 'authenticated' } : { role };
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

/** A user + active membership with a legacy role. Returns { userId, membershipId }. */
async function seat(orgId: string, clerk: string, role: string): Promise<{ userId: string; membershipId: string }> {
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  await insertRow('core.users', { id: userId, clerk_user_id: clerk });
  await insertRow('core.memberships', { id: membershipId, org_id: orgId, user_id: userId, role, status: 'active' });
  return { userId, membershipId };
}

const logCount = async (orgId: string, event: string) =>
  Number((await db.query<{ n: string }>(`select count(*) n from core.access_change_log where org_id = $1 and event = $2`, [orgId, event])).rows[0].n);

let admin1: { userId: string; membershipId: string };
let admin2: { userId: string; membershipId: string };
let soloAdmin: { userId: string; membershipId: string };

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec('alter role service_role bypassrls');
  await db.exec(`insert into core.organizations (id, name, slug) values
    ('${ORG}', 'Tenant 2G', 'tenant-2g'), ('${ORG_SOLO}', 'Solo 2G', 'solo-2g')`);
  await insertRow('core.locations', { id: LOC, org_id: ORG, name: 'Client', short_code: 'C2G' });
  await seat(ORG, MEMBER, 'business_user');
  admin1 = await seat(ORG, 'user_2g_admin1', 'company_admin');
  admin2 = await seat(ORG, 'user_2g_admin2', 'company_admin');
  soloAdmin = await seat(ORG_SOLO, 'user_2g_solo', 'company_admin');
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── §1 + §2 payroll ──────────────────────────────────────────────────────────────
describe('§1 payroll write lock + §2 comp column mask', () => {
  let runId: string;
  beforeAll(async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.payroll_runs (org_id, location_id, period_start, period_end, pay_date, status, gross_cents, net_cents, prepared_by)
       values ($1, $2, '2026-08-01', '2026-08-15', '2026-08-20', 'PREVIEWED', 100000, 70000, 'prep') returning id`, [ORG, LOC]);
    runId = r.rows[0].id;
    await db.query(
      `insert into public.payroll_run_employees (org_id, payroll_run_id, gross_cents, net_cents) values ($1, $2, 100000, 70000)`,
      [ORG, runId]);
  });

  for (const table of ['public.payroll_runs', 'public.payroll_run_employees']) {
    it(`members cannot INSERT / UPDATE / DELETE / TRUNCATE ${table}`, async () => {
      const errs = await asRole('authenticated', async () => ({
        insert: await errorOf(`insert into ${table} default values`),
        update: await errorOf(`update ${table} set org_id = org_id where true`),
        del: await errorOf(`delete from ${table} where true`),
        truncate: await errorOf(`truncate ${table}`),
      }));
      for (const [k, v] of Object.entries(errs)) expect(v, `${table} ${k}`).toMatch(/permission denied/i);
    });
  }

  it('the exploit is closed: a member cannot PATCH a run to APPROVED', async () => {
    const e = await asRole('authenticated', () =>
      errorOf(`update public.payroll_runs set status = 'APPROVED', approved_by = 'anyone' where id = $1`, [runId]));
    expect(e).toMatch(/permission denied/i);
  });

  it('members still read run totals, but not per-person amounts', async () => {
    const run = await asRole('authenticated', () =>
      db.query<{ gross_cents: string }>(`select gross_cents from public.payroll_runs where id = $1`, [runId]));
    expect(run.rows).toHaveLength(1);
    const ids = await asRole('authenticated', () =>
      db.query<{ id: string }>(`select id, employee_id, hours from public.payroll_run_employees where payroll_run_id = $1`, [runId]));
    expect(ids.rows).toHaveLength(1);
    for (const col of ['gross_cents', 'net_cents', 'employee_tax_cents', 'employer_tax_cents', 'deductions_cents', 'benefits_cents', 'earnings']) {
      const e = await asRole('authenticated', () => errorOf(`select ${col} from public.payroll_run_employees`));
      expect(e, col).toMatch(/permission denied/i);
    }
    const star = await asRole('authenticated', () => errorOf(`select * from public.payroll_run_employees`));
    expect(star).toMatch(/permission denied/i);
  });

  it('the service role (the app, after its permission check) reads and writes', async () => {
    const r = await asRole('service_role', () =>
      db.query<{ net_cents: string }>(`update public.payroll_run_employees set net_cents = net_cents where payroll_run_id = $1 returning net_cents`, [runId]));
    expect(Number(r.rows[0].net_cents)).toBe(70000);
  });

  it('the registry records the comp columns as column_revoke', async () => {
    const r = await db.query<{ n: string }>(
      `select count(*) n from core.field_class_columns where table_name = 'payroll_run_employees' and enforcement = 'column_revoke'`);
    expect(Number(r.rows[0].n)).toBe(7);
  });
});

// ── §3 approvals ─────────────────────────────────────────────────────────────────
describe('§3 approvals transition guard', () => {
  const make = async (status: string, approvedBy: string | null = null): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `insert into public.approvals (org_id, kind, subject_table, subject_id, amount_cents, status, prepared_by, approved_by)
       values ($1, 'AP_DISBURSEMENT', 'bills', gen_random_uuid(), 1000, $2, 'prep', $3) returning id`, [ORG, status, approvedBy]);
    return r.rows[0].id;
  };

  it('refuses illegal status changes for every writer (service role included)', async () => {
    const draft = await make('DRAFT');
    expect(await asRole('service_role', () => errorOf(`update public.approvals set status = 'APPROVED', approved_by = 'a' where id = $1`, [draft]))).toMatch(/Invalid approval transition DRAFT -> APPROVED/);
    const pending = await make('PENDING_APPROVAL');
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'r' where id = $1`, [pending])).toMatch(/PENDING_APPROVAL -> RELEASED/);
    await db.query(`update public.approvals set status = 'REJECTED' where id = $1`, [pending]);
    expect(await errorOf(`update public.approvals set status = 'APPROVED', approved_by = 'a' where id = $1`, [pending])).toMatch(/REJECTED -> APPROVED/);
    const released = await make('APPROVED', 'appr');
    await db.query(`update public.approvals set status = 'RELEASED', released_by = 'rel', provider_correlation_id = 'p1' where id = $1`, [released]);
    expect(await errorOf(`update public.approvals set status = 'APPROVED', released_by = null where id = $1`, [released])).toMatch(/RELEASED -> APPROVED/);
    await db.query(`update public.approvals set status = 'SETTLED' where id = $1`, [released]);
    expect(await errorOf(`update public.approvals set status = 'RETURNED' where id = $1`, [released])).toMatch(/SETTLED -> RETURNED/);
  });

  it('allows the legal path and the un-finalized claim revert', async () => {
    const id = await make('DRAFT');
    for (const sql of [
      `update public.approvals set status = 'PENDING_APPROVAL' where id = $1`,
      `update public.approvals set status = 'APPROVED', approved_by = 'appr' where id = $1`,
      `update public.approvals set status = 'RELEASED', released_by = 'rel' where id = $1`,
      `update public.approvals set status = 'APPROVED', released_by = null where id = $1`, // claim revert
      `update public.approvals set status = 'RELEASED', released_by = 'rel' where id = $1`,
      `update public.approvals set provider_correlation_id = 'prov-1' where id = $1`,
      `update public.approvals set status = 'SETTLED' where id = $1`,
    ]) expect(await errorOf(sql, [id]), sql).toBeNull();
  });

  it('pins the parties, the amount and a stamped provider reference', async () => {
    const id = await make('APPROVED', 'appr');
    expect(await errorOf(`update public.approvals set approved_by = 'someone_else' where id = $1`, [id])).toMatch(/approver is recorded only/);
    expect(await errorOf(`update public.approvals set prepared_by = 'x' where id = $1`, [id])).toMatch(/never change/);
    expect(await errorOf(`update public.approvals set amount_cents = 999999 where id = $1`, [id])).toMatch(/amount of an approved item/);
    expect(await errorOf(`update public.approvals set released_by = 'rel' where id = $1`, [id])).toMatch(/releaser is recorded only/);
    await db.query(`update public.approvals set status = 'RELEASED', released_by = 'rel' where id = $1`, [id]);
    await db.query(`update public.approvals set provider_correlation_id = 'p-1' where id = $1`, [id]);
    expect(await errorOf(`update public.approvals set provider_correlation_id = 'p-2' where id = $1`, [id])).toMatch(/cannot be rewritten/);
    expect(await errorOf(`update public.approvals set status = 'APPROVED', released_by = null where id = $1`, [id])).toMatch(/RELEASED -> APPROVED/);
  });

  it('refuses inserting an already-released approval', async () => {
    expect(await errorOf(
      `insert into public.approvals (org_id, kind, subject_table, subject_id, status, prepared_by, approved_by, released_by)
       values ($1, 'AP_DISBURSEMENT', 'bills', gen_random_uuid(), 'RELEASED', 'p', 'a', 'r')`, [ORG])).toMatch(/cannot be created as RELEASED/);
  });

  it('in v2, an APPROVED insert is capability-checked too (not only PENDING → APPROVED)', async () => {
    await db.query(`update core.organizations set access_enforcement_mode = 'v2' where id = $1`, [ORG]);
    try {
      expect(await errorOf(
        `insert into public.approvals (org_id, kind, subject_table, subject_id, status, prepared_by, approved_by)
         values ($1, 'PAYROLL_RUN', 'payroll_runs', gen_random_uuid(), 'APPROVED', 'p', 'nobody_with_caps')`, [ORG])).toMatch(/R-11/);
    } finally {
      await db.query(`update core.organizations set access_enforcement_mode = 'dual' where id = $1`, [ORG]);
    }
  });
});

// ── §4 event drains ──────────────────────────────────────────────────────────────
describe('§4 event drain finalize + one document per event', () => {
  it('a drain whose lease lapsed cannot finalize after another drain reclaims', async () => {
    await db.query(
      `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on)
       values ($1, gen_random_uuid(), 'DEPT_INVOICE_ISSUE', 'projects', '{}', '2026-06-01')`, [ORG]);
    const claim = (token: string) => asRole('service_role', () => db.query<{ id: string }>(
      `select id from core.claim_pending_events('DEPT_INVOICE_ISSUE', $1, null, 10, $2, 900)`, [ORG, token]));
    const a = await claim('drain:A');
    expect(a.rows).toHaveLength(1);
    const id = a.rows[0].id;
    // A stalls past its lease; B reclaims the row.
    await db.query(`update core.events set claimed_at = now() - interval '20 minutes' where id = $1`, [id]);
    const b = await claim('drain:B');
    expect(b.rows.map((r) => r.id)).toEqual([id]);
    // The app's claim-conditional finalize (lib/events/claim.ts finalizeClaimedEvent).
    const finalizeAs = (token: string) => asRole('service_role', () => db.query<{ id: string }>(
      `update core.events set status = 'processed', processed_at = now()
        where id = $1 and claimed_by = $2 and status = 'pending' returning id`, [id, token]));
    expect((await finalizeAs('drain:A')).rows).toHaveLength(0);
    expect((await finalizeAs('drain:B')).rows).toHaveLength(1);
    expect((await finalizeAs('drain:B')).rows).toHaveLength(0); // never twice
  });

  it('one AR invoice and one internal invoice per source event', async () => {
    for (const [table, idx] of [['public.invoices', 'uq_invoices_org_source_event'], ['public.internal_invoices', 'uq_internal_invoices_org_source_event']]) {
      const r = await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = $1`, [idx]);
      expect(r.rows[0]?.indexdef, table).toMatch(/UNIQUE INDEX .*\(org_id, source_event_id\) WHERE \(source_event_id IS NOT NULL\)/);
    }
    // Exercise the index itself (FK / trigger setup is irrelevant to it: replica mode
    // skips FK + user triggers, never unique indexes).
    await db.exec(`set session_replication_role = replica`);
    try {
      for (const table of ['public.internal_invoices', 'public.invoices']) {
        const ev = crypto.randomUUID();
        const inv = () => insertRow(table, { org_id: ORG, location_id: LOC, source_event_id: ev, total_cents: 100 });
        await inv();
        await expect(inv(), table).rejects.toThrow(/duplicate key|source_event/);
        // a different event, or a manual document (null), is fine
        await insertRow(table, { org_id: ORG, location_id: LOC, source_event_id: crypto.randomUUID(), total_cents: 100 });
        await insertRow(table, { org_id: ORG, location_id: LOC, source_event_id: null, total_cents: 100 });
      }
    } finally {
      await db.exec(`set session_replication_role = origin`);
    }
  });
});

// ── §5 security policy ───────────────────────────────────────────────────────────
describe('§5 core.replace_security_policy', () => {
  it('is not callable by members or anon', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      const e = await asRole(role, () => errorOf(
        `select core.replace_security_policy($1, '{}'::jsonb, '[]'::jsonb, null, 'x', false)`, [ORG]));
      expect(e, role).toMatch(/permission denied/i);
    }
  });

  it('replaces the policy + allowlists atomically and logs before / after', async () => {
    const before = await logCount(ORG, 'security_policy.change');
    await asRole('service_role', () => db.query(
      `select core.replace_security_policy($1, $2::jsonb, $3::jsonb, $4, 'user_2g_admin1', false, 'tighten', '10.0.0.1')`,
      [ORG, JSON.stringify({ ip_allowlist_enforced: true, mfa_all_staff: true }),
       JSON.stringify([{ name: 'HQ', cidrs: ['10.0.0.0/8'] }, { name: 'VPN', cidrs: ['192.168.1.0/24'] }]), admin1.userId]));
    const lists = await db.query<{ name: string }>(`select name from core.ip_allowlists where org_id = $1 order by name`, [ORG]);
    expect(lists.rows.map((r) => r.name)).toEqual(['HQ', 'VPN']);
    expect(await logCount(ORG, 'security_policy.change')).toBe(before + 1);
    const row = await db.query<{ actor_user_id: string; request_ip: string; after: { loosening: boolean } }>(
      `select actor_user_id, request_ip, after from core.access_change_log where org_id = $1 and event = 'security_policy.change' order by seq desc limit 1`, [ORG]);
    expect(row.rows[0]).toMatchObject({ actor_user_id: admin1.userId, request_ip: '10.0.0.1' });

    // A failing replace (duplicate names) leaves the previous allowlists intact — no empty window.
    const e = await asRole('service_role', () => errorOf(
      `select core.replace_security_policy($1, '{}'::jsonb, $2::jsonb, null, 'x', true)`,
      [ORG, JSON.stringify([{ name: 'A', cidrs: [] }, { name: 'a', cidrs: [] }])]));
    expect(e).toMatch(/duplicate key|uq_ip_allowlists_org_name/);
    const after = await db.query<{ name: string }>(`select name from core.ip_allowlists where org_id = $1 order by name`, [ORG]);
    expect(after.rows.map((r) => r.name)).toEqual(['HQ', 'VPN']);
  });

  it('refuses enforcing an empty allowlist', async () => {
    const e = await asRole('service_role', () => errorOf(
      `select core.replace_security_policy($1, '{"ip_allowlist_enforced": true}'::jsonb, '[]'::jsonb, null, 'x', false)`, [ORG]));
    expect(e).toMatch(/at least one network/);
  });
});

// ── §6 mode changes ──────────────────────────────────────────────────────────────
describe('§6 enforcement-mode changes', () => {
  const request = (orgId: string, mode: string, actor: string, setting = 'access_enforcement_mode') =>
    asRole('service_role', () => db.query<{ r: { status: string; request_id?: string; single_admin?: boolean; mode: string } }>(
      `select core.request_access_mode_change($1, $2, $3, $4, 'rolling back for payroll week') r`, [orgId, setting, mode, actor]));
  const modeOf = async (orgId: string, col = 'access_enforcement_mode') =>
    (await db.query<{ m: string }>(`select ${col} m from core.organizations where id = $1`, [orgId])).rows[0].m;

  it('every change is logged, whoever writes it', async () => {
    const before = await logCount(ORG, 'client_scope_mode.change');
    await db.query(`update core.organizations set client_scope_rls_mode = 'shadow' where id = $1`, [ORG]);
    await db.query(`update core.organizations set client_scope_rls_mode = 'off' where id = $1`, [ORG]);
    expect(await logCount(ORG, 'client_scope_mode.change')).toBe(before + 2);
  });

  it('a downgrade from v2 waits for a SECOND tenant admin; the requester cannot confirm', async () => {
    await db.query(`update core.organizations set access_enforcement_mode = 'v2' where id = $1`, [ORG]);
    const r = (await request(ORG, 'dual', admin1.userId)).rows[0].r;
    expect(r.status).toBe('pending');
    expect(await modeOf(ORG)).toBe('v2');
    const self = await asRole('service_role', () => errorOf(
      `select core.confirm_access_mode_change($1, $2)`, [r.request_id, admin1.userId]));
    expect(self).toMatch(/second tenant admin/);
    await asRole('service_role', () => db.query(`select core.confirm_access_mode_change($1, $2)`, [r.request_id, admin2.userId]));
    expect(await modeOf(ORG)).toBe('dual');
    expect(await logCount(ORG, 'mode_change.confirm')).toBeGreaterThanOrEqual(1);
    const log = await db.query<{ actor_user_id: string; approval_ref: string }>(
      `select actor_user_id, approval_ref from core.access_change_log where org_id = $1 and event = 'enforcement_mode.change' order by seq desc limit 1`, [ORG]);
    expect(log.rows[0]).toMatchObject({ actor_user_id: admin2.userId, approval_ref: `mode_change_request:${r.request_id}` });
  });

  it('a non-admin cannot ask; an upgrade or lateral change applies at once', async () => {
    const member = (await db.query<{ id: string }>(`select id from core.users where clerk_user_id = $1`, [MEMBER])).rows[0].id;
    expect(await asRole('service_role', () => errorOf(
      `select core.request_access_mode_change($1, 'access_enforcement_mode', 'legacy', $2, 'nope')`, [ORG, member]))).toMatch(/Only a tenant admin/);
    const r = (await request(ORG, 'shadow', admin1.userId, 'client_scope_rls_mode')).rows[0].r;
    expect(r.status).toBe('applied');
    expect(await modeOf(ORG, 'client_scope_rls_mode')).toBe('shadow');
  });

  it('with a single tenant admin the downgrade applies with the logged reason', async () => {
    await db.query(`update core.organizations set client_scope_rls_mode = 'enforce' where id = $1`, [ORG_SOLO]);
    const r = (await request(ORG_SOLO, 'off', soloAdmin.userId, 'client_scope_rls_mode')).rows[0].r;
    expect(r).toMatchObject({ status: 'applied', single_admin: true });
    expect(await modeOf(ORG_SOLO, 'client_scope_rls_mode')).toBe('off');
    const log = await db.query<{ reason: string; approval_ref: string }>(
      `select reason, approval_ref from core.access_change_log where org_id = $1 and event = 'client_scope_mode.change' order by seq desc limit 1`, [ORG_SOLO]);
    expect(log.rows[0].reason).toMatch(/Single tenant admin: rolling back/);
    expect(log.rows[0].approval_ref).toBe('single_admin');
  });

  it('the mode functions are service-role only', async () => {
    const e = await asRole('authenticated', () => errorOf(
      `select core.request_access_mode_change($1, 'access_enforcement_mode', 'legacy', $2, 'x')`, [ORG, admin1.userId]));
    expect(e).toMatch(/permission denied/i);
  });
});

// ── §7 cascades ──────────────────────────────────────────────────────────────────
describe('§7 append-only ledgers let FK cascades through', () => {
  it('deleting a seat cascades through sod_exceptions and nulls field_reveals.membership_id', async () => {
    const victim = await seat(ORG, 'user_2g_leaver', 'business_user');
    const s7 = (await db.query<{ id: string }>(`select id from core.sod_rules where org_id is null and key = 'S7'`)).rows[0]?.id;
    if (s7) {
      await db.query(
        `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, justification, approved_by, granted_by)
         values ($1, $2, 'S7', $3, 'Owner-run company exception', $4, $4)`, [ORG, s7, victim.membershipId, admin1.userId]);
    }
    await db.query(
      `insert into core.field_reveals (org_id, membership_id, clerk_user_id, field_class, subject_table, subject_id, reason)
       values ($1, $2, 'user_2g_leaver', 'tin', 'vendors', 'v1', 'W-9 check')`, [ORG, victim.membershipId]);

    // direct writes are still refused
    expect(await errorOf(`delete from core.field_reveals where membership_id = $1`, [victim.membershipId])).toMatch(/append-only/);
    if (s7) expect(await errorOf(`delete from core.sod_exceptions where membership_id = $1`, [victim.membershipId])).toMatch(/never deleted/);

    expect(await errorOf(`delete from core.memberships where id = $1`, [victim.membershipId])).toBeNull();
    const fr = await db.query<{ membership_id: string | null }>(`select membership_id from core.field_reveals where clerk_user_id = 'user_2g_leaver'`);
    expect(fr.rows).toEqual([{ membership_id: null }]);
    if (s7) {
      const ex = await db.query(`select 1 from core.sod_exceptions where membership_id = $1`, [victim.membershipId]);
      expect(ex.rows).toHaveLength(0);
    }
  });

  it('deleting a grantor user nulls sod_exceptions.granted_by instead of raising', async () => {
    const s7 = (await db.query<{ id: string }>(`select id from core.sod_rules where org_id is null and key = 'S7'`)).rows[0]?.id;
    if (!s7) return;
    const holder = await seat(ORG, 'user_2g_holder', 'business_user');
    const grantor = crypto.randomUUID();
    await insertRow('core.users', { id: grantor, clerk_user_id: 'user_2g_grantor' });
    await db.query(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, justification, approved_by, granted_by)
       values ($1, $2, 'S7', $3, 'Owner-run company exception', $4, $5)`, [ORG, s7, holder.membershipId, admin1.userId, grantor]);
    expect(await errorOf(`delete from core.users where id = $1`, [grantor])).toBeNull();
    const r = await db.query<{ granted_by: string | null }>(`select granted_by from core.sod_exceptions where membership_id = $1`, [holder.membershipId]);
    expect(r.rows).toEqual([{ granted_by: null }]);
  });
});

// ── §8 RLS initPlan ──────────────────────────────────────────────────────────────
describe('§8 access-governance policies evaluate the caller helpers once', () => {
  it('every caller helper call in those policies is wrapped in a scalar subquery', async () => {
    const r = await db.query<{ tablename: string; qual: string }>(
      `select tablename, qual from pg_policies where schemaname = 'core' and policyname = 'member_read'
          and tablename in ('access_change_log', 'access_requests', 'access_reviews', 'access_review_items', 'template_updates')`);
    expect(r.rows).toHaveLength(5);
    for (const p of r.rows) {
      const calls = p.qual.match(/access_caller_[a-z_]+\(/g) ?? [];
      const wrapped = p.qual.match(/SELECT core\.access_caller_[a-z_]+\(/gi) ?? [];
      expect(calls.length, p.tablename).toBeGreaterThan(0);
      expect(wrapped.length, p.tablename).toBe(calls.length);
    }
  });

  it('a non-admin member still sees nothing in the access log; tenant isolation holds', async () => {
    const rows = await asRole('authenticated', () => db.query(`select 1 from core.access_change_log`));
    expect(rows.rows).toHaveLength(0);
  });
});
