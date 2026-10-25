/**
 * 1113 approvals engine: company-size tiers, preparer ≠ approver (DB), the solo / two-person
 * exception report, delegation, escalation, multi-step chains, reopen on edit, the DB gate on
 * every approvable object (stage_transitions.approval_policy_key enforced), the shared audit
 * stream, RLS per persona, and the client mirror of the default tiers (parity).
 *
 * Runs on the 1110 fixture with every later migration applied (numeric order).
 * Company sizes at seed time: L1 has 10 Projects members → "s" (6–20); L2 has 4 → "xs";
 * org B's LB has one owner → "xs" in solo mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigration } from './pg';
import { buildFixture, applyAfter1110, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, L2, LB, J1, J2, J3, JB } from './fixture';
import { DEFAULT_RULES, ROLE_SETS, SET_LABELS, defaultChain } from '../../../apps/projects/src/lib/approvals/defaults';

let f: Fixture;
let db: PGlite;
let vendor: string;
const ids: Record<string, string> = {};

interface Decide { status: string; request_id: string; step: number; step_count: number; waiting_on: string | null; message: string | null; self_approval_allowed: boolean; result: Record<string, unknown> | null }
interface Item { id: string; object_type: string; object_id: string; amount_cents: number | null; money_visible: boolean; can_act: boolean; on_behalf_of: string | null; escalated: boolean; step_label: string | null; facts: Record<string, unknown>; facts_money: Record<string, unknown> | null; self_approval: boolean; bulk_ok: boolean }

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

const decide = (p: Persona, type: string, id: string, decision = 'approve', o: { reason?: string; self?: string; ref?: string } = {}) =>
  as(f, p, async () => (await q<{ r: Decide }>(db, `select pm.approval_decide($1, $2, $3, $4, $5, $6, 'web') as r`,
    [type, id, decision, o.reason ?? null, o.self ?? null, o.ref ?? null]))[0]!.r);
const act = (p: Persona, req: string, decision = 'approve', reason: string | null = null, self: string | null = null) =>
  as(f, p, async () => (await q<{ r: Decide }>(db, `select pm.approval_act($1, $2, $3, $4, 'phone') as r`, [req, decision, reason, self]))[0]!.r);
const actErr = (p: Persona, req: string, decision = 'approve', reason: string | null = null, self: string | null = null) =>
  as(f, p, async () => errorOf(db, `select pm.approval_act($1, $2, $3, $4, 'web')`, [req, decision, reason, self]));
const decideErr = (p: Persona, type: string, id: string, o: { self?: string; ref?: string } = {}) =>
  as(f, p, async () => errorOf(db, `select pm.approval_decide($1, $2, 'approve', null, $3, $4, 'web')`, [type, id, o.self ?? null, o.ref ?? null]));
const inbox = (p: Persona, tab = 'mine') =>
  as(f, p, async () => (await q<{ r: { items: Item[]; counts: { mine: number; waiting: number } } }>(db, `select pm.approval_inbox($1) as r`, [tab]))[0]!.r);
const asErr = (p: Persona, sql: string, params: unknown[] = []) => as(f, p, async () => errorOf(db, sql, params));

async function po(amountCents: number, createdBy: string, job = J1, loc = L1): Promise<string> {
  const c = await one<{ id: string }>(
    `insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, created_by)
     values ($1, $2, $3, $4, 'PO', 'Lumber', $5) returning id`, [ORG_A, loc, job, vendor, createdBy]);
  await db.query(`insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, description, amount_cents)
                  values ($1, $2, 1, $3, 'Studs', $4)`, [ORG_A, c.id, f.ids[`costCode:${loc}`], amountCents]);
  return c.id;
}
const status = async (table: string, id: string, col = 'status') => (await one<{ s: string }>(`select ${col}::text as s from pm.${table} where id = $1`, [id])).s;
const reqOf = async (type: string, id: string) =>
  one<{ id: string; status: string; step_count: number; current_step: number; round: number; amount_cents: string }>(
    `select id, status, step_count, current_step, round, amount_cents from pm.approval_requests where object_type = $1 and object_id = $2 order by created_at desc limit 1`, [type, id]);

beforeAll(async () => {
  f = await buildFixture();
  db = f.db;
  await applyAfter1110(db);
  vendor = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Prairie Lumber') returning id`, [ORG_A])).id;
  // J1's contract is live and its original budget approved (1,000,000 on cost code 01)
  await db.query(`update pm.contracts set status = 'ACTIVE' where job_id = $1`, [J1]);
  await db.query(`update pm.budgets set status = 'APPROVED' where job_id = $1 and kind = 'ORIGINAL'`, [J1]);
  await db.exec(`create or replace function pm.zz_probe(p text) returns void language plpgsql security definer set search_path = pm, core, public
                   as $$ begin execute p; end $$;
                 grant execute on function pm.zz_probe(text) to authenticated;`);
}, 900_000);

afterAll(async () => {
  await db?.close();
});

describe('seeding and the size table', () => {
  it('every Projects company gets the engine, sized from its people', async () => {
    const rows = await q<{ location_id: string; size_bucket: string; solo_mode: boolean }>(db,
      `select location_id, size_bucket, solo_mode from pm.approval_settings order by location_id`);
    const by = Object.fromEntries(rows.map((r) => [r.location_id, r]));
    expect(by[L1]).toMatchObject({ size_bucket: 's', solo_mode: false });
    expect(by[L2]).toMatchObject({ size_bucket: 'xs', solo_mode: false });
    expect(by[LB]).toMatchObject({ size_bucket: 'xs', solo_mode: true });
  });

  it('L1 holds exactly the "s" defaults (commitment rows seed commitment_change too)', async () => {
    const expected = DEFAULT_RULES.filter((r) => r.size === 's').reduce((n, r) => n + (r.object_type === 'commitment' ? 2 : 1), 0);
    const got = await one<{ n: number }>(`select count(*)::int as n from pm.approval_rules where location_id = $1 and source = 'default'`, [L1]);
    expect(got.n).toBe(expected);
  });

  it('the app mirror of the defaults is identical to the database (parity)', async () => {
    const dbRules = (await one<{ r: unknown[] }>(`select pm.approval_default_rules() as r`)).r;
    expect(dbRules).toEqual(DEFAULT_RULES.map((r) => ({ ...r })));
    for (const [set, roles] of Object.entries(ROLE_SETS)) {
      const row = await one<{ roles: string[]; label: string }>(`select pm.approval_role_set($1) as roles, pm.approval_set_label($1) as label`, [set]);
      expect(row.roles, set).toEqual([...roles]);
      expect(row.label, set).toBe(SET_LABELS[set as keyof typeof SET_LABELS]);
    }
  });

  it('the database chain for a size matches the app preview (tiers route upward with the amount)', async () => {
    const cases: Array<[string, number, Record<string, boolean>]> = [
      ['commitment', 500_000, {}], ['commitment', 5_000_000, {}], ['commitment', 900_000, { over_budget: true }],
      ['change_order', 100_000, {}], ['budget_transfer', 600_000, {}], ['draw', 1, {}], ['time_entry', 0, {}],
    ];
    for (const [type, amt, facts] of cases) {
      const chain = (await one<{ c: Array<{ label: string }> }>(`select pm._approval_build_chain($1, $2, $3, null, $4, $5) as c`,
        [ORG_A, L1, type, amt, JSON.stringify(facts)])).c;
      expect(chain.map((s) => s.label), `${type} ${amt}`).toEqual(defaultChain('s', type as never, amt, facts).map((s) => s.label));
    }
    expect(defaultChain('s', 'commitment', 500_000).map((s) => s.label)).toEqual(['Project manager']);
    expect(defaultChain('s', 'commitment', 5_000_000).map((s) => s.label)).toEqual(['Owner']);
    expect(defaultChain('m', 'draw', 1).map((s) => s.label)).toEqual(['Project manager', 'Project accountant', 'Owner']);
  });

  it('changing the size reseeds defaults and keeps custom rules', async () => {
    await as(f, 'owner', async () => {
      await db.query(`insert into pm.approval_rules (org_id, location_id, object_type, step_order, approver_roles, label)
                      values ($1, $2, 'draw', 9, '{projects_owner}', 'Custom owner check')`, [ORG_A, L2]);
      await db.query(`select pm.approval_set_company($1, 'm')`, [L2]);
    });
    const r = await q<{ size_bucket: string }>(db, `select size_bucket from pm.approval_settings where location_id = $1`, [L2]);
    expect(r[0]!.size_bucket).toBe('m');
    const custom = await q(db, `select 1 from pm.approval_rules where location_id = $1 and source = 'custom' and label = 'Custom owner check'`, [L2]);
    expect(custom.length).toBe(1);
    const pur = await q(db, `select 1 from pm.approval_rules where location_id = $1 and source = 'default' and role_set = 'PUR'`, [L2]);
    expect(pur.length).toBe(2);
    await as(f, 'owner', async () => { await db.query(`select pm.approval_set_company($1, 'xs')`, [L2]); });
  });

  it('only settings:configure holders write rules; a member edit becomes custom', async () => {
    expect(await asErr('gm', `insert into pm.approval_rules (org_id, location_id, object_type, approver_roles, label) values ($1, $2, 'draw', '{projects_owner}', 'X')`, [ORG_A, L1]))
      .toMatch(/row-level security/);
    expect(await asErr('gm', `select pm.approval_set_company($1, 'm')`, [L1])).toMatch(/PM_FORBIDDEN/);
    const labor = await as(f, 'labor', () => q(db, `select size_bucket from pm.approval_settings where location_id = $1`, [L1]));
    expect(labor.length).toBe(1);
  });
});

describe('amount tiers (company size "s")', () => {
  it('a $5,000 PO is a PM approval; the PM who prepared it only sends it on', async () => {
    ids.po5 = await po(500_000, 'user_pm');
    const r = await decide('pm', 'commitment', ids.po5);
    expect(r.status).toBe('submitted');
    expect(r.waiting_on).toBe('Project manager');
    expect(await status('commitments', ids.po5)).toBe('DRAFT');
    const gm = await decide('gm', 'commitment', ids.po5);
    expect(gm.status).toBe('approved');
    expect(await status('commitments', ids.po5)).toBe('APPROVED');
    const approval = await one<{ a: Record<string, unknown> }>(`select approval as a from pm.commitments where id = $1`, [ids.po5]);
    expect(approval.a).toMatchObject({ engine: true, request_id: gm.request_id });
  });

  it('a $50,000 PO routes to the owner: the PM and GM are under the tier', async () => {
    ids.po50 = await po(5_000_000, 'user_accountant');
    const pm = await decide('pm', 'commitment', ids.po50);
    expect(pm.status).toBe('submitted');
    expect(pm.waiting_on).toBe('Owner');
    expect(await actErr('gm', pm.request_id)).toMatch(/PM_APPROVAL_NOT_YOURS/);
    const own = await act('owner', pm.request_id);
    expect(own.status).toBe('approved');
    expect(await status('commitments', ids.po50)).toBe('APPROVED');
  });

  it('a PO that pushes a cost code over budget adds the owner step and shows the overrun', async () => {
    ids.poOver = await po(900_000, 'user_accountant');
    const r = await decide('pm', 'commitment', ids.poOver);
    expect(r.status).toBe('pending');
    expect(r.step_count).toBe(2);
    expect(r.waiting_on).toBe('Owner');
    const item = (await inbox('owner')).items.find((i) => i.object_id === ids.poOver);
    expect(item?.facts.over_budget).toBe(true);
    expect(item?.facts_money?.overrun_cents).toBe(500_000 + 5_000_000 + 900_000 - 1_000_000);
    expect((await act('owner', r.request_id)).status).toBe('approved');
  });

  it("a person's own dollar limit (Books amount_limit model) narrows a tier", async () => {
    await db.query(`insert into pm.job_members (org_id, job_id, membership_id, slot) values ($1, $2, $3, 'pm') on conflict do nothing`, [ORG_A, J2, f.membership.pm]);
    const c = await po(400_000, 'user_accountant', J2);
    await db.query(`update core.access_assignments set constraint_overrides = '{"amount_limit":{"max_per_item_cents":300000}}'
                     where membership_id = $1`, [f.membership.pm]);
    try {
      const r = await decide('pm', 'commitment', c);
      expect(r.status).toBe('submitted');
      expect(await actErr('pm', r.request_id)).toMatch(/PM_APPROVAL_NOT_YOURS/);
    } finally {
      await db.query(`update core.access_assignments set constraint_overrides = '{}' where membership_id = $1`, [f.membership.pm]);
    }
    const r2 = await one<{ id: string }>(`select id from pm.approval_requests where object_id = $1`, [c]);
    expect((await act('pm', r2.id)).status).toBe('approved');
  });
});

describe('preparer ≠ approver in the database', () => {
  it('the history refuses a preparer approval whatever writes it', async () => {
    const c = await po(100_000, 'user_gm');
    const r = await decide('gm', 'commitment', c);
    expect(r.status).toBe('submitted');
    const e = await errorOf(db, `insert into pm.approval_actions (org_id, request_id, step_order, decision, actor_user) values ($1, $2, 1, 'APPROVE', 'user_gm')`,
      [ORG_A, r.request_id]);
    expect(e).toMatch(/PM_SOD_VIOLATION/);
    expect(await actErr('gm', r.request_id)).toMatch(/PM_SOD_VIOLATION: The person who prepares/);
    ids.poGm = c;
    ids.reqGm = r.request_id;
  });

  it('members cannot forge approvals: no write grants on the engine tables, history is append-only', async () => {
    expect(await asErr('owner', `insert into pm.approval_actions (org_id, request_id, decision, actor_user) values ($1, $2, 'APPROVE', 'user_owner')`, [ORG_A, ids.reqGm]))
      .toMatch(/permission denied/);
    expect(await asErr('owner', `update pm.approval_requests set status = 'APPROVED' where id = $1`, [ids.reqGm])).toMatch(/permission denied/);
    expect(await errorOf(db, `update pm.approval_actions set reason = 'x' where request_id = $1`, [ids.reqGm])).toMatch(/PM_APPROVAL_HISTORY/);
  });

  it('solo / two-person company: self-approval needs a typed reason and lands on the exception report', async () => {
    await db.query(`update pm.change_orders set created_by = 'user_bOwner' where id = $1`, [f.ids[`co:${JB}`]]);
    await db.query(`update pm.contracts set status = 'ACTIVE' where job_id = $1`, [JB]);
    const first = await decide('bOwner', 'change_order', f.ids[`co:${JB}`]);
    expect(first.status).toBe('submitted');
    expect(first.self_approval_allowed).toBe(true);
    expect(await decideErr('bOwner', 'change_order', f.ids[`co:${JB}`], { self: 'ok' })).toMatch(/PM_APPROVAL_SELF_REASON/);
    const done = await decide('bOwner', 'change_order', f.ids[`co:${JB}`], 'approve', { self: 'Only person in the company' });
    expect(done.status).toBe('approved');
    expect(await status('change_orders', f.ids[`co:${JB}`], 'stage')).toBe('APPROVED');
    const report = await as(f, 'bOwner', async () => (await q<{ r: Array<{ title: string; reason: string }> }>(db, `select pm.approval_exception_report() as r`))[0]!.r);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ reason: 'Only person in the company' });
    // not a solo company: the same request is refused
    expect(await as(f, 'pm', () => errorOf(db, `select pm.approval_exception_report()`))).toMatch(/PM_FORBIDDEN/);
  });
});

describe('delegation', () => {
  let del: string;
  it('never to yourself, never to someone who approves nothing', async () => {
    expect(await asErr('owner', `select pm.approval_set_delegation($1, now(), now() + interval '7 days')`, [f.membership.owner])).toMatch(/PM_DELEGATION_SELF/);
    expect(await asErr('owner', `select pm.approval_set_delegation($1, now(), now() + interval '7 days')`, [f.membership.labor])).toMatch(/PM_DELEGATION_NO_AUTHORITY/);
    expect(await errorOf(db, `insert into pm.approval_delegations (org_id, delegator_membership_id, delegate_membership_id, starts_at, ends_at)
                              values ($1, $2, $2, now(), now() + interval '1 day')`, [ORG_A, f.membership.gm])).toMatch(/not_self/);
  });

  it("the owner's cover lets the GM approve owner-tier POs up to the cap, logged for the owner", async () => {
    del = (await as(f, 'owner', () => one<{ id: string }>(
      `select pm.approval_set_delegation($1, now() - interval '1 minute', now() + interval '7 days', 10000000, '{commitment}', true, 'Vacation') as id`,
      [f.membership.gm]))).id;
    const c = await po(6_000_000, 'user_accountant', J2);
    const r = await decide('gm', 'commitment', c);
    expect(r.status).toBe('approved');
    const hist = await q<{ on_behalf_of_membership: string; delegation_id: string; actor_user: string }>(db,
      `select on_behalf_of_membership, delegation_id, actor_user from pm.approval_actions where request_id = $1 and decision = 'APPROVE'`, [r.request_id]);
    expect(hist[0]).toMatchObject({ on_behalf_of_membership: f.membership.owner, delegation_id: del, actor_user: 'user_gm' });
    const gmSees = await as(f, 'gm', () => q(db, `select id from pm.approval_delegations`));
    expect(gmSees.length).toBe(1);
    expect((await as(f, 'dispatcher', () => q(db, `select id from pm.approval_delegations`))).length).toBe(0);
  });

  it("not above the cap, not outside its object types, never above the delegate's own limit", async () => {
    const big = await po(15_000_000, 'user_accountant', J2);
    expect((await decide('gm', 'commitment', big)).status).toBe('submitted');
    const c = await po(6_000_000, 'user_accountant', J2);
    await db.query(`update core.access_assignments set constraint_overrides = '{"amount_limit":{"max_per_item_cents":2000000}}' where membership_id = $1`, [f.membership.gm]);
    try {
      expect((await decide('gm', 'commitment', c)).status).toBe('submitted');
    } finally {
      await db.query(`update core.access_assignments set constraint_overrides = '{}' where membership_id = $1`, [f.membership.gm]);
    }
    // a budget transfer is not in the cover's object types
    const b = await one<{ id: string }>(`insert into pm.budgets (org_id, job_id, kind, version, status, created_by) values ($1, $2, 'REVISED', 9, 'DRAFT', 'user_pm') returning id`, [ORG_A, J2]);
    await db.query(`insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, 1800000)`, [ORG_A, b.id, f.ids[`costCode:${L1}`]]);
    expect((await decide('gm', 'budget_transfer', b.id)).status).toBe('submitted');
    await db.query(`delete from pm.approval_requests where object_id = $1`, [b.id]);
    await db.query(`delete from pm.budgets where id = $1`, [b.id]);
  });

  it("a delegate never approves the delegator's own items", async () => {
    const c = await po(6_500_000, 'user_owner', J2);
    expect((await decide('gm', 'commitment', c)).status).toBe('submitted');
  });

  it('owner-tier items need a management delegate (a PM covering the owner cannot take them)', async () => {
    const d = (await as(f, 'owner', () => one<{ id: string }>(`select pm.approval_set_delegation($1, now() - interval '1 minute', now() + interval '2 days') as id`, [f.membership.pm]))).id;
    const c = await po(7_000_000, 'user_accountant', J2);
    expect((await decide('pm', 'commitment', c)).status).toBe('submitted');
    await as(f, 'owner', () => db.query(`select pm.approval_revoke_delegation($1)`, [d]));
  });

  it('revoked cover stops at once', async () => {
    await as(f, 'owner', () => db.query(`select pm.approval_revoke_delegation($1)`, [del]));
    const c = await po(6_000_000, 'user_accountant', J2);
    expect((await decide('gm', 'commitment', c)).status).toBe('submitted');
  });
});

describe('multi-step chains, distinct approvers, reopen on edit', () => {
  it('PM then GM: the same person cannot take both steps; an edit sends it back to step 1', async () => {
    await as(f, 'owner', () => db.query(`insert into pm.approval_rules (org_id, location_id, object_type, step_order, approver_roles, label)
                                          values ($1, $2, 'change_order', 2, '{projects_gm,projects_owner}', 'General manager')`, [ORG_A, L1]));
    const co = f.ids[`co:${J1}`]!;
    const s1 = await decide('pm', 'change_order', co);
    expect(s1).toMatchObject({ status: 'pending', step: 2, step_count: 2, waiting_on: 'General manager' });
    expect(await status('change_orders', co, 'stage')).toBe('PCO');
    expect(await actErr('pm', s1.request_id)).toMatch(/PM_APPROVAL_NOT_YOURS|PM_APPROVAL_DISTINCT/);
    // the price changes before the GM decides → reopened at step 1, round 2
    await db.query(`update pm.change_orders set amount_cents = 120000 where id = $1`, [co]);
    const re = await act('gm', s1.request_id);
    expect(re.status).toBe('reopened');
    const r = await reqOf('change_order', co);
    expect(r).toMatchObject({ round: 2, current_step: 1 });
    expect(Number(r.amount_cents)).toBe(120000);
    expect((await act('pm', r.id)).status).toBe('pending');
    const done = await act('gm', r.id);
    expect(done.status).toBe('approved');
    expect(await status('change_orders', co, 'stage')).toBe('APPROVED');
  });

  it('reject needs a reason, sends a time entry back, and closes the request', async () => {
    const sent = await decide('labor', 'time_entry', f.ids.laborTime!, 'submit');
    expect(sent.status).toBe('submitted');
    expect(await actErr('dispatcher', sent.request_id, 'reject', 'no')).toMatch(/PM_FORBIDDEN/);
    expect(await actErr('owner', sent.request_id, 'reject')).toMatch(/PM_APPROVAL_REASON/);
    const r = await act('owner', sent.request_id, 'reject', 'Wrong job — this was J1');
    expect(r.status).toBe('rejected');
    expect(await status('time_entries', f.ids.laborTime!, 'approval_state')).toBe('REJECTED');
    expect(await actErr('owner', sent.request_id)).toMatch(/PM_APPROVAL_CLOSED/);
  });

  it('time approval runs the real labor costing at the last step', async () => {
    await db.query(`update core.employees set hourly_rate_cents = 3000 where id = $1`, [f.employee.supervisor]);
    const r = await decide('pm', 'time_entry', f.ids.supervisorTime!);
    expect(r.status).toBe('approved');
    const t = await one<{ approval_state: string; cost_rate_cents: string }>(`select approval_state, cost_rate_cents from pm.time_entries where id = $1`, [f.ids.supervisorTime]);
    expect(t.approval_state).toBe('APPROVED');
    expect(Number(t.cost_rate_cents)).toBeGreaterThan(0);
  });
});

describe('escalation', () => {
  it('an overdue step opens to the escalation roles and shows as escalated', async () => {
    // billing at L1: a custom rule makes it a project-accountant step (the GM is not on that ladder)
    await as(f, 'owner', async () => {
      await db.query(`update pm.approval_rules set is_active = false where location_id = $1 and object_type = 'billing_request' and source = 'default'`, [L1]);
      await db.query(`insert into pm.approval_rules (org_id, location_id, object_type, step_order, approver_roles, label)
                      values ($1, $2, 'billing_request', 1, '{projects_project_accountant}', 'Project accountant')`, [ORG_A, L1]);
    });
    const br = f.ids[`billing:${J1}`]!;
    const r = await decide('pm', 'billing_request', br, 'submit');
    expect(r.waiting_on).toBe('Project accountant');
    expect((await inbox('gm')).items.some((i) => i.object_id === br)).toBe(false);
    await db.query(`update pm.approval_request_steps set due_at = now() - interval '1 day' where request_id = $1`, [r.request_id]);
    const gm = (await inbox('gm')).items.find((i) => i.object_id === br);
    expect(gm).toMatchObject({ can_act: true, escalated: true });
    const esc = await q(db, `select 1 from pm.approval_actions where request_id = $1 and decision = 'ESCALATE'`, [r.request_id]);
    expect(esc.length).toBe(1);
    await inbox('gm');
    expect((await q(db, `select 1 from pm.approval_actions where request_id = $1 and decision = 'ESCALATE'`, [r.request_id])).length).toBe(1);
    // the engine runs the real billing function: its own preconditions still hold (no lines → refused, nothing changes)
    expect(await actErr('gm', r.request_id)).toMatch(/PRECONDITION_FAILED/);
    expect((await reqOf('billing_request', br)).status).toBe('PENDING');
  });
});

describe('the DB gate on every approvable object', () => {
  const probe = (p: Persona, sql: string) => asErr(p, `select pm.zz_probe($1)`, [sql]);
  const required = /PM_APPROVAL_REQUIRED/;

  it('direct RPC calls no longer approve', async () => {
    expect(await asErr('pm', `select pm.approve_change_order($1)`, [f.ids[`co:${J3}`]])).toMatch(/PM_FORBIDDEN/); // not their company (1110)
    const co = await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage) values ($1, $2, 'CO-X1', 'Extra', 5000, 'PCO') returning id`, [ORG_A, J1]);
    expect(await asErr('pm', `select pm.approve_change_order($1)`, [co.id])).toMatch(required);
    const c = await po(100_000, 'user_accountant');
    expect(await asErr('owner', `select pm.approve_commitment($1)`, [c])).toMatch(required);
    expect(await asErr('owner', `select pm.approve_time_entries($1::uuid[])`, [[f.ids.laborTime]])).toMatch(/PM_TIME_NOT_SUBMITTED|PM_APPROVAL_REQUIRED/);
  });

  it('each object table refuses its approval move outside the engine', async () => {
    const c = await one<{ id: string }>(`insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, status, approved_at, approved_by)
                                         values ($1, $2, $3, $4, 'PO', 'Signed', 'APPROVED', now(), 'user_owner') returning id`, [ORG_A, L1, J1, vendor]);
    const cco = await one<{ id: string }>(`insert into pm.commitment_changes (org_id, job_id, commitment_id, cost_code_id, description, amount_cents)
                                           values ($1, $2, $3, $4, 'More studs', 1000) returning id`, [ORG_A, J1, c.id, f.ids[`costCode:${L1}`]]);
    const sched = await one<{ id: string }>(`insert into pm.draw_schedules (org_id, job_id, lender_name, loan_commitment_cents, status, activated_at)
                                             values ($1, $2, 'First Bank', 100000000, 'ACTIVE', now()) returning id`, [ORG_A, J1]);
    const draw = await one<{ id: string }>(`insert into pm.draws (org_id, job_id, draw_schedule_id, draw_number, period_end, created_by)
                                            values ($1, $2, $3, 1, current_date, 'user_pm') returning id`, [ORG_A, J1, sched.id]);
    const deal = await one<{ id: string }>(`insert into pm.dealer_deals (org_id, location_id, number, stage, created_by) values ($1, $2, 'D-1', 'WRITTEN', 'user_pm') returning id`, [ORG_A, L1]);
    const est = await one<{ id: string }>(`insert into pm.estimates (org_id, location_id, job_id, number) values ($1, $2, $3, 'E-LOW') returning id`, [ORG_A, L1, J1]);
    await db.query(`insert into pm.estimate_lines (org_id, estimate_id, description, qty, unit_cost_cents, unit_price_cents, amount_cents) values ($1, $2, 'Thin', 1, 950, 1000, 1000)`, [ORG_A, est.id]);
    const rev = await one<{ id: string }>(`insert into pm.budgets (org_id, job_id, kind, version, status, created_by) values ($1, $2, 'REVISED', 2, 'DRAFT', 'user_pm') returning id`, [ORG_A, J1]);
    await db.query(`insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, 1600000)`, [ORG_A, rev.id, f.ids[`costCode:${L1}`]]);
    ids.draw = draw.id; ids.deal = deal.id; ids.estLow = est.id; ids.revision = rev.id;
    const moves: Array<[string, string]> = [
      ['change_orders', `update pm.change_orders set stage = 'APPROVED', approved_at = now() where id = '${f.ids[`co:${J2}`]}'`],
      ['commitments', `update pm.commitments set status = 'APPROVED', approved_at = now() where id = '${await po(1000, 'user_pm')}'`],
      ['commitment_changes', `update pm.commitment_changes set status = 'APPROVED', approved_at = now() where id = '${cco.id}'`],
      ['billing_requests', `update pm.billing_requests set status = 'EMITTED', event_id = gen_random_uuid() where id = '${f.ids[`billing:${J2}`]}'`],
      ['draws', `update pm.draws set status = 'SUBMITTED', submitted_at = now() where id = '${draw.id}'`],
      ['time_entries', `update pm.time_entries set approval_state = 'APPROVED', approved_at = now() where id = '${f.ids.laborTime}'`],
      ['estimates', `update pm.estimates set status = 'SENT', sent_at = now() where id = '${est.id}'`],
      ['budgets', `update pm.budgets set status = 'APPROVED' where id = '${rev.id}'`],
      ['dealer_deals', `update pm.dealer_deals set stage = 'APPROVED', approved_at = now() where id = '${deal.id}'`],
    ];
    for (const [t, sql] of moves) expect(await probe('owner', sql), t).toMatch(required);
    // an estimate at or above the margin floor is not gated
    expect(await probe('owner', `update pm.estimates set status = 'SENT', sent_at = now() where id = '${f.ids[`estimate:${J1}`]}'`)).toBeNull();
    // service paths (migrations, cron) are not gated
    expect(await errorOf(db, `update pm.dealer_deals set stage = 'QUOTE' where id = $1`, [deal.id])).toBeNull();
    await db.query(`update pm.dealer_deals set stage = 'WRITTEN' where id = $1`, [deal.id]);
  });

  it('a below-floor estimate is sent once approved; a budget revision becomes the budget once approved', async () => {
    expect(await as(f, 'pm', () => one<{ n: boolean }>(`select pm.approval_needed('estimate', $1) as n`, [ids.estLow]))).toEqual({ n: true });
    expect(await as(f, 'pm', () => one<{ n: boolean }>(`select pm.approval_needed('estimate', $1) as n`, [f.ids[`estimate:${J2}`]]))).toEqual({ n: false });
    const e = await decide('pm', 'estimate', ids.estLow!);
    expect(e.waiting_on).toBe('Owner');
    expect((await act('owner', e.request_id)).status).toBe('approved');
    expect(await status('estimates', ids.estLow!)).toBe('SENT');

    expect(await asErr('pm', `update pm.budgets set status = 'APPROVED' where id = $1`, [ids.revision])).toMatch(required);
    const b = await decide('pm', 'budget_transfer', ids.revision!);
    expect(b).toMatchObject({ status: 'submitted', waiting_on: 'Owner' }); // 600,000 moved > the PM's 500,000 tier
    expect((await act('owner', b.request_id)).status).toBe('approved');
    expect(await status('budgets', ids.revision!)).toBe('APPROVED');
  });

  it('stage_transitions.approval_policy_key is enforced', async () => {
    const inst = await one<{ id: string }>(`select id from pm.pack_installs where location_id = $1 limit 1`, [L1]);
    for (const [k, label, cs, sort] of [['active', 'Active', 'ACTIVE', 1], ['closed', 'Closed', 'CLOSED', 2]] as const) {
      await db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, sort, core_status, is_terminal, is_initial, is_active)
                      values ($1, $2, $3, 'm', $4, $5, $6, $7, $8, false, true) on conflict do nothing`, [ORG_A, L1, inst.id, k, label, sort, cs, k === 'closed']);
    }
    await db.query(`insert into pm.approval_policies (org_id, location_id, install_id, key, label, tiers)
                    values ($1, $2, $3, 'job_close_approval', 'Project financial close', '[{"max_cents":null,"roles":["controller"],"count":1}]')`, [ORG_A, L1, inst.id]);
    await db.query(`insert into pm.stage_transitions (org_id, location_id, install_id, machine_key, from_stage, to_stage, guards, approval_policy_key)
                    values ($1, $2, $3, 'm', 'active', 'closed', '{}', 'job_close_approval')`, [ORG_A, L1, inst.id]);
    const rules = await q<{ approver_roles: string[]; source: string }>(db, `select approver_roles, source from pm.approval_rules where policy_key = 'job_close_approval'`);
    expect(rules).toEqual([{ approver_roles: ['projects_owner', 'projects_project_accountant'], source: 'pack' }]);

    expect(await asErr('pm', `select pm.transition_stage($1, 'closed')`, [J1])).toMatch(required);
    expect(await asErr('labor', `select pm.approval_decide('stage_transition', $1, 'submit', null, null, 'closed')`, [J2])).toMatch(/PM_FORBIDDEN/);
    const r = await decide('pm', 'stage_transition', J1, 'approve', { ref: 'closed' });
    expect(r).toMatchObject({ status: 'submitted', waiting_on: 'Project financial close · Controller' });
    expect(await actErr('gm', r.request_id)).toMatch(/PM_FORBIDDEN|PM_APPROVAL_NOT_YOURS/);
    expect((await act('accountant', r.request_id)).status).toBe('approved');
    const ch = await q<{ channel: string }>(db, `select channel from pm.approval_actions where request_id = $1 and decision = 'APPROVE'`, [r.request_id]);
    expect(ch).toEqual([{ channel: 'phone' }]);
    const p = await one<{ stage_key: string }>(`select stage_key from pm.projects where job_id = $1`, [J1]);
    expect(p.stage_key).toBe('closed');
    const a = await one<{ meta: Record<string, unknown> }>(`select meta from pm.activity where job_id = $1 and verb = 'stage.changed' order by created_at desc limit 1`, [J1]);
    expect(a.meta.approval_enforced).toBe(true);
  });
});

describe('security review fixes (1113)', () => {
  it("H1: nobody hands themselves someone else's approvals; cover for others is an owner act", async () => {
    expect(await asErr('gm', `select pm.approval_set_delegation($1, now(), now() + interval '7 days', null, '{}', false, 'x', $2)`, [f.membership.gm, f.membership.owner]))
      .toMatch(/PM_DELEGATION_SELF/);
    expect(await asErr('pm', `select pm.approval_set_delegation($1, now(), now() + interval '7 days', null, '{}', false, 'x', $2)`, [f.membership.pm, f.membership.gm]))
      .toMatch(/PM_DELEGATION_SELF/);
    expect(await asErr('gm', `select pm.approval_set_delegation($1, now(), now() + interval '7 days', null, '{}', false, 'x', $2)`, [f.membership.accountant, f.membership.owner]))
      .toMatch(/PM_FORBIDDEN/);
    const ok = await as(f, 'owner', () => one<{ id: string }>(`select pm.approval_set_delegation($1, now(), now() + interval '1 day', null, '{}', false, 'x', $2) as id`,
      [f.membership.accountant, f.membership.gm]));
    expect(ok.id).toBeTruthy();
    await as(f, 'owner', () => db.query(`select pm.approval_revoke_delegation($1)`, [ok.id]));
  });

  it('H2: members cannot forge or edit an approved budget, its lines, or insert past approval', async () => {
    const cc = f.ids[`costCode:${L1}`];
    expect(await asErr('pm', `insert into pm.budgets (org_id, job_id, kind, version, status, label) values ($1, $2, 'REVISED', 7, 'APPROVED', 'forged')`, [ORG_A, J1]))
      .toMatch(/PM_APPROVAL_REQUIRED/);
    const orig = await one<{ id: string }>(`select id from pm.budgets where job_id = $1 and kind = 'ORIGINAL'`, [J1]);
    expect(await asErr('pm', `update pm.budget_lines set amount_cents = 1 where budget_id = $1`, [orig.id])).toMatch(/PM_BUDGET_LOCKED/);
    expect(await asErr('pm', `insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, 99999999)`, [ORG_A, orig.id, cc]))
      .toMatch(/PM_BUDGET_LOCKED/);
    expect(await asErr('pm', `update pm.budgets set status = 'DRAFT' where id = $1`, [orig.id])).toMatch(/PM_BUDGET_LOCKED/);
    expect(await asErr('pm', `insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage, approved_at) values ($1, $2, 'CO-F', 'Forged', 1, 'APPROVED', now())`, [ORG_A, J1]))
      .toMatch(/PM_APPROVAL_REQUIRED|row-level security/);
    // a draft revision stays editable
    const d = await as(f, 'pm', () => one<{ id: string }>(`insert into pm.budgets (org_id, job_id, kind, version) values ($1, $2, 'REVISED', 8) returning id`, [ORG_A, J2]));
    expect(await asErr('pm', `insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, 1000)`, [ORG_A, d.id, cc])).toBeNull();
  });

  it('H3: an approver who edits a submitted item becomes its preparer and cannot approve their own edit', async () => {
    const co = await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, cost_impact_cents, stage, created_by)
                                          values ($1, $2, 'CO-H3', 'Extra', 100000, 50000, 'PCO', 'user_supervisor') returning id`, [ORG_A, J1]);
    expect((await decide('supervisor', 'change_order', co.id, 'submit')).status).toBe('submitted');
    expect(await asErr('pm', `update pm.change_orders set amount_cents = 9000000, cost_impact_cents = 100 where id = $1`, [co.id])).toBeNull();
    // the edit made the PM a preparer at once: their Approve only sends it on
    const second = await decide('pm', 'change_order', co.id);
    expect(second.status).toBe('submitted');
    expect(await actErr('pm', second.request_id)).toMatch(/PM_SOD_VIOLATION/);
    const r = await one<{ preparers: string[] }>(`select preparers from pm.approval_requests where id = $1`, [second.request_id]);
    expect(r.preparers).toContain('user_pm');
    expect(await status('change_orders', co.id, 'stage')).toBe('PCO');
  });

  it('re-review H2: every editor of a submitted item stays a preparer (not only the last one)', async () => {
    const co = await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, cost_impact_cents, stage, created_by)
                                          values ($1, $2, 'CO-E1', 'Extra', 100000, 50000, 'PCO', 'user_supervisor') returning id`, [ORG_A, J1]);
    const sub = await decide('supervisor', 'change_order', co.id, 'submit');
    expect(await asErr('pm', `update pm.change_orders set amount_cents = 9000000, cost_impact_cents = 100 where id = $1`, [co.id])).toBeNull();
    expect(await asErr('gm', `update pm.change_orders set description = 'typo fix' where id = $1`, [co.id])).toBeNull();
    const now = await one<{ preparers: string[] }>(`select preparers from pm.approval_requests where id = $1`, [sub.request_id]);
    expect(now.preparers).toEqual(expect.arrayContaining(['user_supervisor', 'user_pm', 'user_gm']));
    expect((await decide('pm', 'change_order', co.id)).status).toBe('submitted');
    expect(await actErr('pm', sub.request_id)).toMatch(/PM_SOD_VIOLATION/);
    expect(await actErr('gm', sub.request_id)).toMatch(/PM_SOD_VIOLATION/);
    // an independent approver acts: the material change restarts the chain, and nobody drops out
    expect((await act('owner', sub.request_id)).status).toBe('reopened');
    const after = await one<{ preparers: string[]; round: number }>(`select preparers, round from pm.approval_requests where id = $1`, [sub.request_id]);
    expect(after.round).toBe(2);
    expect(after.preparers).toEqual(expect.arrayContaining(['user_supervisor', 'user_pm', 'user_gm']));
    expect(await actErr('gm', sub.request_id)).toMatch(/PM_SOD_VIOLATION/);
    expect((await act('owner', sub.request_id)).status).toBe('pending');
  });

  it('re-review H1: one original budget per job; a member approves it only as the first budget', async () => {
    // J1 already has an approved original: a second ORIGINAL can't even be started
    expect(await asErr('pm', `insert into pm.budgets (org_id, job_id, kind, version, status, label) values ($1, $2, 'ORIGINAL', 2, 'DRAFT', 'v2')`, [ORG_A, J1]))
      .toMatch(/PM_BUDGET_LOCKED/);
    // and the database holds at most one approved ORIGINAL per job, whoever writes it
    expect(await errorOf(db, `insert into pm.budgets (org_id, job_id, kind, version, status) values ($1, $2, 'ORIGINAL', 9, 'APPROVED')`, [ORG_A, J1]))
      .toMatch(/pm_budgets_one_approved_original|duplicate key/);
    // J3's draft original is its first budget: the owner may approve it directly…
    const j3 = await one<{ id: string }>(`select id from pm.budgets where job_id = $1 and kind = 'ORIGINAL'`, [J3]);
    expect(await asErr('owner', `update pm.budgets set status = 'APPROVED' where id = $1`, [j3.id])).toBeNull();
    // …a legacy second draft original (made by definer code) cannot be approved around the engine
    const legacy = await one<{ id: string }>(`insert into pm.budgets (org_id, job_id, kind, version, status) values ($1, $2, 'FORECAST', 1, 'DRAFT') returning id`, [ORG_A, J3]);
    await db.query(`update pm.budgets set status = 'SUPERSEDED' where id = $1`, [j3.id]);
    const d2 = await one<{ id: string }>(`insert into pm.budgets (org_id, job_id, kind, version, status) values ($1, $2, 'ORIGINAL', 2, 'DRAFT') returning id`, [ORG_A, J3]);
    expect(await asErr('owner', `update pm.budgets set status = 'APPROVED' where id = $1`, [d2.id])).toMatch(/PM_APPROVAL_REQUIRED/);
    await db.query(`delete from pm.budgets where id = any ($1::uuid[])`, [[legacy.id, d2.id]]);
  });

  it('M1: solo self-approval ends once the company has more than two people', async () => {
    const co = await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage, created_by)
                                          values ($1, $2, 'CO-M1', 'Extra', 1000, 'PCO', 'user_bOwner') returning id`, [ORG_B, JB]);
    const rd = await one<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'projects_pm'`, [ORG_B]);
    for (const i of [1, 2]) {
      const u = await one<{ id: string }>(`insert into core.users (clerk_user_id, email) values ($1, $2) returning id`, [`user_bx${i}`, `bx${i}@example.test`]);
      const m = await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member') returning id`, [u.id, ORG_B]);
      await db.query(`insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, source) values ($1, $2, 'role', $3, 'all_clients', 'manual')`,
        [ORG_B, m.id, rd.id]);
    }
    const r = await decide('bOwner', 'change_order', co.id, 'approve', { self: 'Only person in the company' });
    expect(r.status).toBe('submitted');
    expect(r.self_approval_allowed).toBe(false);
    expect(await status('change_orders', co.id, 'stage')).toBe('PCO');
  });

  it('M2: billing cannot leave draft as UNISSUED / ISSUED around the engine', async () => {
    for (const st of ['UNISSUED', 'ISSUED']) {
      expect(await asErr('owner', `select pm.zz_probe($1)`, [`update pm.billing_requests set status = '${st}' where id = '${f.ids[`billing:${J2}`]}'`]), st)
        .toMatch(/PM_APPROVAL_REQUIRED/);
    }
  });

  it('notifications: the next approvers are told (server-built text, preparers never), then the sender', async () => {
    const c = await po(120_000, 'user_accountant', J2);
    const sub = await decide('accountant', 'commitment', c, 'submit');
    const plan = await as(f, 'accountant', () => one<{ p: { event: string; recipients: string[]; title: string; body: string; title_money: string | null } }>(
      `select pm.approval_notify_plan($1) as p`, [sub.request_id]));
    expect(plan.p.event).toBe('approval.requested');
    expect(plan.p.recipients).toContain(f.membership.gm);
    expect(plan.p.recipients).not.toContain(f.membership.accountant);
    expect(plan.p.recipients).not.toContain(f.membership.labor);
    expect(plan.p.title).toMatch(/needs your approval$/);
    expect(plan.p.title_money).toMatch(/\(\$1,200\.00\)$/);
    const sent = await as(f, 'accountant', () => one<{ n: number }>(
      `select pm.notify_emit('approval.requested', $1, null, 'commitment', $2, $3::uuid[], $4, $5, $6, null, '/approvals?tab=mine', 'test:1', 'projects.financials') as n`,
      [J2, c, plan.p.recipients, plan.p.title, plan.p.body, plan.p.title_money]));
    expect(sent.n).toBeGreaterThan(0);
    expect((await act('gm', sub.request_id)).status).toBe('approved');
    const done = await as(f, 'gm', () => one<{ p: { event: string; recipients: string[]; title: string } }>(`select pm.approval_notify_plan($1) as p`, [sub.request_id]));
    expect(done.p.event).toBe('approval.decided');
    expect(done.p.recipients).toEqual([f.membership.accountant]);
    expect(done.p.title).toMatch(/was approved$/);
    expect(await asErr('dispatcher', `select pm.approval_notify_plan($1)`, [sub.request_id])).toMatch(/PM_FORBIDDEN/);
  });
});

describe('inbox, bulk, audit, RLS per persona', () => {
  it('bulk approves where allowed and refuses the rest per row', async () => {
    const a = await po(100_000, 'user_accountant', J2);
    const b = await po(120_000, 'user_accountant', J2);
    const ra = (await decide('accountant', 'commitment', a, 'submit')).request_id;
    const rb = (await decide('accountant', 'commitment', b, 'submit')).request_id;
    const rd = (await decide('pm', 'draw', ids.draw!, 'submit')).request_id;
    const mine = await inbox('gm');
    expect(mine.items.filter((i) => [ra, rb].includes(i.id)).every((i) => i.bulk_ok)).toBe(true);
    const res = await as(f, 'owner', async () => (await q<{ r: { done: number; refused: number; results: Array<{ id: string; ok: boolean; code?: string }> } }>(db,
      `select pm.approval_act_many($1::uuid[], 'approve') as r`, [[ra, rb, rd]]))[0]!.r);
    expect(res.done).toBe(2);
    expect(res.refused).toBe(1);
    expect(res.results.find((x) => x.id === rd)?.ok).toBe(false);
    expect(await status('commitments', a)).toBe('APPROVED');
  });

  it('every decision is in the shared audit stream (core.action_log) against the object', async () => {
    const rows = await q<{ action: string }>(db, `select action from core.action_log where subject_table = 'pm.commitments' and subject_id = $1 order by created_at`, [ids.po5]);
    expect(rows.map((r) => r.action)).toEqual(['approval.submitted', 'approval.approved']);
  });

  it('labor sees only their own requests; another tenant sees nothing; amounts are not member-readable', async () => {
    const labor = await as(f, 'labor', () => q<{ object_type: string }>(db, `select object_type from pm.approval_requests`));
    expect(labor.every((r) => r.object_type === 'time_entry')).toBe(true);
    expect((await inbox('labor')).items).toHaveLength(0);
    expect((await as(f, 'bOwner', () => q(db, `select id from pm.approval_requests where org_id = $1`, [ORG_A])))).toHaveLength(0);
    expect(await asErr('pm', `select amount_cents from pm.approval_requests`)).toMatch(/permission denied/);
    expect(await asErr('dispatcher', `select pm.approval_request_detail($1)`, [ids.reqGm])).toMatch(/PM_FORBIDDEN/);
  });

  it('the waiting tab masks money the preparer may not see', async () => {
    const co = await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage, created_by)
                                          values ($1, $2, 'CO-S1', 'Field change', 250000, 'PCO', 'user_supervisor') returning id`, [ORG_A, J2]);
    await db.query(`insert into pm.tasks (org_id, job_id, title, assignee_user_id) values ($1, $2, 'J2 task', 'user_supervisor')`, [ORG_A, J2]);
    const r = await decide('supervisor', 'change_order', co.id, 'submit');
    expect(r.status).toBe('submitted');
    const sup = (await inbox('supervisor', 'waiting')).items.find((i) => i.object_id === co.id);
    expect(sup).toMatchObject({ amount_cents: null, money_visible: false });
    const gm = (await inbox('gm')).items.find((i) => i.object_id === co.id);
    expect(gm).toMatchObject({ amount_cents: 250000, money_visible: true, can_act: true });
  });

  it('re-applying 1113 is idempotent (settings, rules and history kept; patches not doubled)', async () => {
    const before = await one<{ s: number; r: number; a: number }>(`select (select count(*)::int from pm.approval_settings) as s,
      (select count(*)::int from pm.approval_rules) as r, (select count(*)::int from pm.approval_actions) as a`);
    await applyMigration(db, '1113_pm_approvals.sql');
    const after = await one<{ s: number; r: number; a: number }>(`select (select count(*)::int from pm.approval_settings) as s,
      (select count(*)::int from pm.approval_rules) as r, (select count(*)::int from pm.approval_actions) as a`);
    expect(after).toEqual(before);
    const def = await one<{ d: string }>(`select pg_get_functiondef('pm.approve_change_order(uuid)'::regprocedure) as d`);
    expect(def.d.split('approval_sod_excepted').length - 1).toBe(1);
    expect(def.d.split('pm_access_guard').length - 1).toBe(1);
  });

  it('registries: every pm table classified, no unguarded definer RPC, no unprotected core table', async () => {
    expect(await q(db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(db, `select * from pm.access_unguarded_rpcs() x where x not like '%zz_probe%'`)).toEqual([]);
    expect(await q(db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
  });
});
