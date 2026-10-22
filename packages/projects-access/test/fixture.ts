/**
 * Two-tenant fixture for the Wave 0a access suite (spec §6).
 *
 *   org A: companies L1, L2.  Jobs J1, J2 (L1), J3 (L2).
 *   org B: company LB.        Job  JB.
 *
 * Members created BEFORE 1110 (so the deploy backfill handles them):
 *   legacyOwner (membership role owner), legacyStaff (member), legacyPm (member; pm_user_id on J1).
 * Members created AFTER 1110 with explicit Projects roles (scope in brackets):
 *   owner (owner seat → auto projects_owner, all companies), gm [L1], pm [L1, on J1's team],
 *   supervisor [L1, task assignee on J1], labor [L1, dispatched on J2], dispatcher [L1],
 *   accountant [L1, project accountant]. gm…accountant are flagged Projects-only seats
 *   (core.memberships.projects_only); owners and the legacy members are not.
 *   bOwner (org B owner seat).
 */

import type { PGlite } from '@electric-sql/pglite';
import { applyMigration, createReplayDb } from './pg';

export const ORG_A = 'a0000000-0000-4000-8000-000000000001';
export const ORG_B = 'b0000000-0000-4000-8000-000000000001';
export const L1 = 'a0000000-0000-4000-8000-0000000000a1';
export const L2 = 'a0000000-0000-4000-8000-0000000000a2';
export const LB = 'b0000000-0000-4000-8000-0000000000b1';
export const J1 = 'a0000000-0000-4000-8000-000000000101';
export const J2 = 'a0000000-0000-4000-8000-000000000102';
export const J3 = 'a0000000-0000-4000-8000-000000000103';
export const JB = 'b0000000-0000-4000-8000-000000000101';
export const JOBS_A = [J1, J2, J3] as const;

export type Persona =
  | 'legacyOwner' | 'legacyStaff' | 'legacyPm'
  | 'owner' | 'gm' | 'pm' | 'supervisor' | 'labor' | 'dispatcher' | 'accountant' | 'bOwner';

export interface Fixture {
  db: PGlite;
  membership: Record<Persona, string>;
  clerk: Record<Persona, string>;
  employee: Partial<Record<Persona, string>>;
  ids: Record<string, string>;
}

const clerkOf = (p: Persona): string => `user_${p}`;

export async function q<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

async function addMember(db: PGlite, p: Persona, org: string, role: string): Promise<string> {
  const u = await one<{ id: string }>(db, `insert into core.users (clerk_user_id, email, first_name, last_name) values ($1, $2, 'T', $3) returning id`,
    [clerkOf(p), `${p}@example.test`, p]);
  const m = await one<{ id: string }>(db, `insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`, [u.id, org, role]);
  return m.id;
}

async function addEmployee(db: PGlite, p: Persona, org: string): Promise<string> {
  const e = await one<{ id: string }>(db,
    `insert into core.employees (org_id, clerk_user_id, first_name, last_name, is_active) values ($1, $2, 'T', $3, true) returning id`,
    [org, clerkOf(p), p]);
  return e.id;
}

async function assignRole(db: PGlite, org: string, membership: string, roleKey: string, location: string | null): Promise<void> {
  const r = await one<{ id: string }>(db, `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = $2`, [org, roleKey]);
  if (location) {
    await db.query(`insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, source)
                    values ($1, $2, 'role', $3, 'client', $4, 'manual')`, [org, membership, r.id, location]);
  } else {
    await db.query(`insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source)
                    values ($1, $2, 'role', $3, 'all_clients', 'manual')`, [org, membership, r.id]);
  }
}

/** Run as a PostgREST caller (SET ROLE authenticated + JWT claims). Always resets. */
export async function as<T>(f: Fixture, p: Persona, fn: () => Promise<T>): Promise<T> {
  const org = p === 'bOwner' ? ORG_B : ORG_A;
  await f.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: clerkOf(p), org_id: org, role: 'authenticated' })]);
  await f.db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await f.db.exec('reset role');
    await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
    await f.db.query(`select set_config('pm.access_entry', '', false)`);
  }
}

export async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function buildFixture(): Promise<Fixture> {
  const { db } = await createReplayDb({ before: 1110 });
  const membership = {} as Record<Persona, string>;
  const employee: Partial<Record<Persona, string>> = {};
  const ids: Record<string, string> = {};

  // ── tenants, companies, jobs (state BEFORE 1110) ────────────────────────────────
  await db.query(`insert into core.organizations (id, name, slug, tenant_type) values ($1, 'Org A', 'org-a', 'company'), ($2, 'Org B', 'org-b', 'company')`, [ORG_A, ORG_B]);
  for (const [id, org, code] of [[L1, ORG_A, 'L1'], [L2, ORG_A, 'L2'], [LB, ORG_B, 'LB']] as const) {
    await db.query(`insert into core.locations (id, org_id, name, short_code) values ($1, $2, $3, $3)`, [id, org, code]);
  }
  for (const [id, org, loc, num] of [[J1, ORG_A, L1, 'J1'], [J2, ORG_A, L1, 'J2'], [J3, ORG_A, L2, 'J3'], [JB, ORG_B, LB, 'JB']] as const) {
    await db.query(`insert into core.jobs (id, org_id, location_id, job_number, name) values ($1, $2, $3, $4, $4)`, [id, org, loc, num]);
  }

  membership.legacyOwner = await addMember(db, 'legacyOwner', ORG_A, 'owner');
  membership.legacyStaff = await addMember(db, 'legacyStaff', ORG_A, 'member');
  membership.legacyPm = await addMember(db, 'legacyPm', ORG_A, 'member');

  // pm config + pm.projects for J1 (legacyPm is its PM) — exercises the job_members seed
  for (const [org, loc] of [[ORG_A, L1], [ORG_A, L2], [ORG_B, LB]] as const) {
    const inst = await one<{ id: string }>(db,
      `insert into pm.pack_installs (org_id, location_id, pack_key, pack_version, role, resolved, plan_hash)
       values ($1, $2, 'general_contractor', '1.0.0', 'primary', '{}'::jsonb, 'h') returning id`, [org, loc]);
    const jt = await one<{ id: string }>(db,
      `insert into pm.job_types (org_id, location_id, install_id, key, label, archetype, billing_modes, default_billing_mode, stage_machine_key)
       values ($1, $2, $3, 'build', 'Build', 'project', array['FIXED'], 'FIXED', 'm') returning id`, [org, loc, inst.id]);
    ids[`jobType:${loc}`] = jt.id;
    const cc = await one<{ id: string }>(db,
      `insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, '01', 'General', 'OTHER') returning id`, [org, loc]);
    ids[`costCode:${loc}`] = cc.id;
  }
  for (const [job, org, loc] of [[J1, ORG_A, L1], [J2, ORG_A, L1], [J3, ORG_A, L2], [JB, ORG_B, LB]] as const) {
    await db.query(`insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key, pm_user_id) values ($1, $2, $3, $4, 'active', $5)`,
      [job, org, loc, ids[`jobType:${loc}`], job === J1 ? clerkOf('legacyPm') : null]);
  }

  // ── 1110 (provision + backfill run here) ────────────────────────────────────────
  await applyMigration(db, '1110_pm_access.sql');

  // ── members with explicit Projects roles (after 1110) ───────────────────────────
  membership.owner = await addMember(db, 'owner', ORG_A, 'owner');          // trigger → projects_owner
  membership.bOwner = await addMember(db, 'bOwner', ORG_B, 'owner');
  membership.gm = await addMember(db, 'gm', ORG_A, 'member');
  membership.pm = await addMember(db, 'pm', ORG_A, 'member');
  membership.supervisor = await addMember(db, 'supervisor', ORG_A, 'member');
  membership.labor = await addMember(db, 'labor', ORG_A, 'member');
  membership.dispatcher = await addMember(db, 'dispatcher', ORG_A, 'member');
  membership.accountant = await addMember(db, 'accountant', ORG_A, 'member');
  await assignRole(db, ORG_A, membership.gm, 'projects_gm', L1);
  await assignRole(db, ORG_A, membership.pm, 'projects_pm', L1);
  await assignRole(db, ORG_A, membership.supervisor, 'projects_supervisor', L1);
  await assignRole(db, ORG_A, membership.labor, 'projects_labor', L1);
  await assignRole(db, ORG_A, membership.dispatcher, 'projects_dispatcher', L1);
  await assignRole(db, ORG_A, membership.accountant, 'projects_project_accountant', L1);
  employee.labor = await addEmployee(db, 'labor', ORG_A);
  employee.supervisor = await addEmployee(db, 'supervisor', ORG_A);

  // ── job data (as the migration role) ────────────────────────────────────────────
  for (const [job, org, loc] of [[J1, ORG_A, L1], [J2, ORG_A, L1], [J3, ORG_A, L2], [JB, ORG_B, LB]] as const) {
    const t = await one<{ id: string }>(db, `insert into pm.tasks (org_id, job_id, title, billing_amount_cents, assignee_user_id) values ($1, $2, $3, 500000, $4) returning id`,
      [org, job, `task ${job.slice(-2)}`, job === J1 ? clerkOf('supervisor') : null]);
    ids[`task:${job}`] = t.id;
    const b = await one<{ id: string }>(db, `insert into pm.budgets (org_id, job_id, kind) values ($1, $2, 'ORIGINAL') returning id`, [org, job]);
    await db.query(`insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, 1000000)`, [org, b.id, ids[`costCode:${loc}`]]);
    await db.query(`insert into pm.contracts (org_id, job_id, original_cents) values ($1, $2, 2500000)`, [org, job]);
    const co = await one<{ id: string }>(db, `insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage) values ($1, $2, $3, 'Extra', 100000, 'PCO') returning id`, [org, job, `CO-${job.slice(-3)}`]);
    ids[`co:${job}`] = co.id;
    const br = await one<{ id: string }>(db,
      `insert into pm.billing_requests (org_id, location_id, job_id, billing_type, source_ref) values ($1, $2, $3, 'PROGRESS', $4) returning id`,
      [org, loc, job, `pm:test:${job}`]);
    ids[`billing:${job}`] = br.id;
    const wo = await one<{ id: string }>(db, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Service') returning id`, [org, loc, job]);
    ids[`wo:${job}`] = wo.id;
    await db.query(`insert into pm.work_order_lines (org_id, job_id, work_order_id, description, qty, unit_price_cents, unit_cost_cents) values ($1, $2, $3, 'Part', 1, 9000, 4000)`,
      [org, job, wo.id]);
    const est = await one<{ id: string }>(db, `insert into pm.estimates (org_id, location_id, job_id, number) values ($1, $2, $3, $4) returning id`, [org, loc, job, `E-${job.slice(-2)}`]);
    ids[`estimate:${job}`] = est.id;
    await db.query(`insert into pm.estimate_lines (org_id, estimate_id, description, qty, unit_cost_cents, unit_price_cents, amount_cents) values ($1, $2, 'Line', 1, 700, 1000, 1000)`, [org, est.id]);
  }
  // labor is dispatched on J2 (own job); a time entry of their own on J2 and someone else's on J1
  await db.query(`insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot) values ($1, $2, $3, $4, tstzrange(now(), now() + interval '2 hours'))`,
    [ORG_A, J2, ids[`wo:${J2}`], employee.labor]);
  const te = await one<{ id: string }>(db,
    `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, approval_state, cost_rate_cents, bill_rate_cents)
     values ($1, $2, $3, current_date, 8, 'SUBMITTED', 4200, 9500) returning id`, [ORG_A, J2, employee.labor]);
  ids.laborTime = te.id;
  const te2 = await one<{ id: string }>(db,
    `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, approval_state, cost_rate_cents, bill_rate_cents)
     values ($1, $2, $3, current_date, 6, 'SUBMITTED', 5100, 9500) returning id`, [ORG_A, J1, employee.supervisor]);
  ids.supervisorTime = te2.id;
  await db.query(`insert into pm.labor_rate_cards (org_id, location_id, key, label, base_rate_cents) values ($1, $2, 'journeyman', 'Journeyman', 3500)`, [ORG_A, L1]);

  // pm joins J1's team through the RPC, as the owner (proves the RPC + team:edit)
  await as({ db, membership, clerk: {} as Record<Persona, string>, employee, ids }, 'owner', async () => {
    await db.query(`select pm.job_team_upsert($1, $2, 'pm')`, [J1, membership.pm]);
  });

  // the explicit-role staff are Projects-only seats (opt-in flag, set by the owner through the RPC)
  await as({ db, membership, clerk: {} as Record<Persona, string>, employee, ids }, 'owner', async () => {
    for (const p of ['gm', 'pm', 'supervisor', 'labor', 'dispatcher', 'accountant'] as const) {
      await db.query(`select pm.set_projects_only($1, true)`, [membership[p]]);
    }
  });

  const clerk = Object.fromEntries((Object.keys(membership) as Persona[]).map((p) => [p, clerkOf(p)])) as Record<Persona, string>;
  return { db, membership, clerk, employee, ids };
}
