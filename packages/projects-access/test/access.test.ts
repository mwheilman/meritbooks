/**
 * Wave 0a access foundation — DB enforcement (spec §6), against a PGlite replay of every
 * migration (001…1110). Runs as PostgREST would: SET ROLE authenticated + JWT claims.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyMigration } from './pg';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, L2, J1, J2, J3, JB } from './fixture';

let f: Fixture;

beforeAll(async () => {
  f = await buildFixture();
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

const ids = (rows: Array<{ job_id: string }>): string[] => rows.map((r) => r.job_id).sort();
const jobsIn = async (p: Persona, table: string): Promise<string[]> =>
  as(f, p, async () => [...new Set(ids(await q<{ job_id: string }>(f.db, `select job_id from pm.${table}`)))]);
const count = async (p: Persona, sql: string, params: unknown[] = []): Promise<number> =>
  as(f, p, async () => (await q<{ n: number }>(f.db, `select count(*)::int as n from (${sql}) x`, params))[0].n);

// Tables with job_id spanning every class that has job rows in the fixture.
const JOB_TABLES = ['tasks', 'work_orders', 'work_order_lines', 'projects', 'budgets', 'contracts', 'change_orders', 'billing_requests'] as const;
const MONEY_TABLES = ['budgets', 'budget_lines', 'contracts', 'change_orders', 'billing_requests', 'commitments', 'job_costs',
  'sov_versions', 'retainage_ledger', 'deposit_requests', 'draws', 'progress_snapshots', 'time_entry_events'] as const;

describe('§2.4 pm.my_access() contract', () => {
  it('returns one row per company × capability × role, with the template key', async () => {
    const rows = await as(f, 'pm', async () =>
      q<{ location_id: string; capability: string; actions: string[]; role_key: string; role_name: string }>(f.db, `select * from pm.my_access() order by capability`));
    expect(new Set(rows.map((r) => r.location_id))).toEqual(new Set([L1]));
    expect(new Set(rows.map((r) => r.role_key))).toEqual(new Set(['projects_pm']));
    const fin = rows.find((r) => r.capability === 'projects.financials');
    expect(fin?.actions).toEqual(['view', 'edit', 'export']);
    expect(rows.find((r) => r.capability === 'projects.labor_rates')).toBeUndefined();
    expect(rows.find((r) => r.capability === 'projects.jobs_all')).toBeUndefined();
  });

  it('all_clients expands to every company of the org; pm.can() agrees', async () => {
    const locs = await as(f, 'owner', async () => q<{ location_id: string }>(f.db, `select distinct location_id from pm.my_access()`));
    expect(locs.map((r) => r.location_id).sort()).toEqual([L1, L2].sort());
    expect(await as(f, 'owner', async () => (await q<{ ok: boolean }>(f.db, `select pm.can('projects.settings','configure', $1) as ok`, [L2]))[0].ok)).toBe(true);
    expect(await as(f, 'gm', async () => (await q<{ ok: boolean }>(f.db, `select pm.can('projects.billing','post', $1) as ok`, [L2]))[0].ok)).toBe(false);
    expect(await as(f, 'gm', async () => (await q<{ ok: boolean }>(f.db, `select pm.can('projects.billing','post', $1) as ok`, [L1]))[0].ok)).toBe(true);
    expect(await as(f, 'labor', async () => (await q<{ ok: boolean }>(f.db, `select pm.can('projects.financials','view') as ok`))[0].ok)).toBe(false);
  });

  it('a person with no assignment holds nothing', async () => {
    const m = await q<{ id: string }>(f.db, `insert into core.users (clerk_user_id) values ('user_nobody') returning id`);
    await f.db.query(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member')`, [m[0].id, ORG_A]);
    await f.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_nobody', org_id: ORG_A, role: 'authenticated' })]);
    await f.db.exec('set role authenticated');
    try {
      expect((await q<{ n: number }>(f.db, `select count(*)::int n from pm.my_access()`))[0].n).toBe(0);
      expect((await q<{ n: number }>(f.db, `select count(*)::int n from pm.tasks`))[0].n).toBe(0);
    } finally {
      await f.db.exec('reset role');
      await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
    }
  });
});

describe('org isolation (acceptance 6) — unchanged, and AND-ed with the class rule', () => {
  for (const t of JOB_TABLES) {
    it(`${t}: org B owner never sees org A rows; org A owner never sees org B rows`, async () => {
      expect(await jobsIn('bOwner', t)).toEqual([JB]);
      expect((await jobsIn('owner', t)).includes(JB)).toBe(false);
    });
  }
  it('every classified pm table returns no other-org row for any persona', async () => {
    const tables = (await q<{ table_name: string }>(f.db,
      `select a.table_name from pm.access_table_classes a
        join information_schema.columns c on c.table_schema = 'pm' and c.table_name = a.table_name and c.column_name = 'org_id'
       where to_regclass('pm.' || a.table_name) is not null order by 1`)).map((r) => r.table_name);
    for (const p of ['owner', 'gm', 'pm', 'labor', 'dispatcher', 'legacyStaff'] as const) {
      for (const t of tables) {
        const n = await as(f, p, async () => {
          const err = await errorOf(f.db, `select 1 from pm.${t} limit 1`);
          if (err) return 0; // no table SELECT for members (internal tables) — nothing visible either way
          return (await q<{ n: number }>(f.db, `select count(*)::int n from pm.${t} where org_id <> $1`, [ORG_A]))[0].n;
        });
        expect(n, `${p} ${t}`).toBe(0);
      }
    }
  });
});

describe('company scope (acceptance 5)', () => {
  it('a GM / dispatcher assigned to L1 reads L1 jobs only', async () => {
    for (const p of ['gm', 'dispatcher'] as const) {
      expect(await jobsIn(p, 'tasks'), p).toEqual([J1, J2].sort());
      expect(await jobsIn(p, 'work_orders'), p).toEqual([J1, J2].sort());
    }
  });
  it('company-scoped (C) rows follow the company: GM sees L1 estimates only', async () => {
    const locs = await as(f, 'gm', async () => q<{ location_id: string }>(f.db, `select distinct location_id from pm.estimates`));
    expect(locs.map((r) => r.location_id)).toEqual([L1]);
    expect(await count('gm', `select 1 from pm.estimate_lines`)).toBe(2);
  });
  it('the owner (all companies) reads every job of the org', async () => {
    expect(await jobsIn('owner', 'tasks')).toEqual([J1, J2, J3].sort());
  });
});

describe('job scope (acceptance 1, 2)', () => {
  it('Labor sees only the job they are dispatched on', async () => {
    expect(await jobsIn('labor', 'tasks')).toEqual([J2]);
    expect(await jobsIn('labor', 'work_orders')).toEqual([J2]);
    expect(await jobsIn('labor', 'projects')).toEqual([J2]);
  });
  it('Supervisor sees the job they are assigned a task on; PM the job they are on the team of', async () => {
    expect(await jobsIn('supervisor', 'tasks')).toEqual([J1]);
    expect(await jobsIn('pm', 'tasks')).toEqual([J1]);
  });
  it('pm.v_job_team lists the team only on reachable jobs', async () => {
    const pmTeam = await as(f, 'pm', async () => q<{ job_id: string; slot: string; role_name: string; email: string }>(f.db, `select * from pm.v_job_team`));
    expect(pmTeam.map((r) => [r.job_id, r.slot])).toContainEqual([J1, 'pm']);
    expect(pmTeam.find((r) => r.email === 'pm@example.test')?.role_name).toBe('Project manager');
    expect(await count('labor', `select 1 from pm.v_job_team`)).toBe(0);
  });
  it('job_team_upsert needs projects.team:edit on a reachable job', async () => {
    const err = await as(f, 'labor', async () => errorOf(f.db, `select pm.job_team_upsert($1, $2, 'crew')`, [J2, f.membership.labor]));
    expect(err).toMatch(/PM_FORBIDDEN/);
    const err2 = await as(f, 'pm', async () => errorOf(f.db, `select pm.job_team_upsert($1, $2, 'crew')`, [J2, f.membership.labor]));
    expect(err2).toMatch(/PM_FORBIDDEN/); // J2 is not the PM's job
    const err3 = await as(f, 'bOwner', async () => errorOf(f.db, `select pm.job_team_upsert($1, $2, 'crew')`, [J1, f.membership.labor]));
    expect(err3).toMatch(/PM_FORBIDDEN/);
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.job_team_upsert($1, $2, 'foreman')`, [J1, f.membership.supervisor]))).toBeNull();
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.job_team_remove($1, $2)`, [J1, f.membership.supervisor]))).toBeNull();
  });
});

describe('money visibility (acceptance 1–4)', () => {
  for (const t of MONEY_TABLES) {
    it(`${t}: empty for Labor, Supervisor and Dispatcher`, async () => {
      for (const p of ['labor', 'supervisor', 'dispatcher'] as const) {
        expect(await count(p, `select 1 from pm.${t}`), `${p} ${t}`).toBe(0);
      }
    });
  }
  it('PM sees money only on their own job', async () => {
    for (const t of ['budgets', 'contracts', 'change_orders', 'billing_requests'] as const) {
      expect(await jobsIn('pm', t), t).toEqual([J1]);
    }
    expect(await count('pm', `select 1 from pm.budget_lines`)).toBe(1);
  });
  it('Owner sees all money; GM all money in their company', async () => {
    expect(await jobsIn('owner', 'budgets')).toEqual([J1, J2, J3].sort());
    expect(await jobsIn('gm', 'budgets')).toEqual([J1, J2].sort());
  });
  it('money views built on money tables return no dollars for non-money roles', async () => {
    const rows = await as(f, 'dispatcher', async () =>
      q<{ original_contract_cents: string; budget_total_cents: string | null }>(f.db, `select original_contract_cents, budget_total_cents from pm.v_project_list`));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(Number(r.original_contract_cents)).toBe(0);
      expect(r.budget_total_cents).toBeNull();
    }
  });
});

describe('masked columns', () => {
  it('base money columns are not selectable by members', async () => {
    for (const [t, c] of [['time_entries', 'cost_rate_cents'], ['time_entries', 'bill_rate_cents'], ['estimate_lines', 'cost_cents'],
                          ['estimates', 'cost_total_cents'], ['work_order_lines', 'unit_cost_cents'], ['tasks', 'billing_amount_cents'],
                          ['units', 'contract_price_cents'], ['work_centers', 'rate_cents']] as const) {
      const err = await as(f, 'owner', async () => errorOf(f.db, `select ${c} from pm.${t} limit 1`));
      expect(err, `${t}.${c}`).toMatch(/permission denied/);
    }
    // every other column still reads
    expect(await as(f, 'labor', async () => errorOf(f.db, `select id, hours, approval_state from pm.time_entries`))).toBeNull();
  });

  it('time entries: Labor sees own hours, no rates; PM sees bill rate on own job, never pay; owner sees both', async () => {
    const labor = await as(f, 'labor', async () =>
      q<{ id: string; hours: string; cost_rate_cents: string | null; bill_rate_cents: string | null }>(f.db, `select id, hours, cost_rate_cents, bill_rate_cents from pm.v_time_entries_masked`));
    expect(labor.map((r) => r.id)).toEqual([f.ids.laborTime]);
    expect(labor[0].cost_rate_cents).toBeNull();
    expect(labor[0].bill_rate_cents).toBeNull();
    const sup = await as(f, 'supervisor', async () => q<{ id: string; cost_rate_cents: string | null }>(f.db, `select id, cost_rate_cents from pm.v_time_entries_masked`));
    expect(sup.map((r) => r.id)).toEqual([f.ids.supervisorTime]); // own entry; J2 crew time is not on their job
    expect(sup[0].cost_rate_cents).toBeNull();
    const pm = await as(f, 'pm', async () => q<{ id: string; cost_rate_cents: string | null; bill_rate_cents: string | null }>(f.db, `select id, cost_rate_cents, bill_rate_cents from pm.v_time_entries_masked`));
    expect(pm.map((r) => r.id)).toEqual([f.ids.supervisorTime]); // time:approve on J1 only
    expect(pm[0].cost_rate_cents).toBeNull();
    expect(Number(pm[0].bill_rate_cents)).toBe(9500);
    const owner = await as(f, 'owner', async () => q<{ cost_rate_cents: string | null }>(f.db, `select cost_rate_cents from pm.v_time_entries_masked order by id`));
    expect(owner.length).toBe(2);
    expect(owner.every((r) => r.cost_rate_cents !== null)).toBe(true);
  });

  it('work-order line cost, task billing value and estimate cost are null without the money capability', async () => {
    const d = await as(f, 'dispatcher', async () => q<{ unit_cost_cents: string | null; unit_price_cents: string }>(f.db, `select unit_cost_cents, unit_price_cents from pm.v_work_order_lines_masked`));
    expect(d.length).toBe(2);
    expect(d.every((r) => r.unit_cost_cents === null && Number(r.unit_price_cents) === 9000)).toBe(true);
    const o = await as(f, 'owner', async () => q<{ unit_cost_cents: string | null }>(f.db, `select unit_cost_cents from pm.v_work_order_lines_masked`));
    expect(o.every((r) => Number(r.unit_cost_cents) === 4000)).toBe(true);
    const lt = await as(f, 'labor', async () => q<{ billing_amount_cents: string | null; title: string }>(f.db, `select title, billing_amount_cents from pm.v_tasks_masked`));
    expect(lt.length).toBe(1);
    expect(lt[0].billing_amount_cents).toBeNull();
    const pt = await as(f, 'pm', async () => q<{ billing_amount_cents: string | null }>(f.db, `select billing_amount_cents from pm.v_tasks_masked`));
    expect(Number(pt[0].billing_amount_cents)).toBe(500000);
    const gmEst = await as(f, 'gm', async () => q<{ cost_cents: string | null }>(f.db, `select cost_cents from pm.v_estimate_lines_masked`));
    expect(gmEst.every((r) => Number(r.cost_cents) === 700)).toBe(true);
  });

  it('masked views keep the class scope: no other-org or out-of-reach rows', async () => {
    expect(await count('bOwner', `select 1 from pm.v_tasks_masked where org_id <> $1`, [ORG_B])).toBe(0);
    expect(await count('labor', `select 1 from pm.v_tasks_masked where job_id <> $1`, [J2])).toBe(0);
    expect(await count('labor', `select 1 from pm.v_estimates_masked`)).toBe(0);
  });
});

describe('time visibility', () => {
  it('office / accounting roles (time:view + jobs_all:view) see every entry in their company, not other companies', async () => {
    await f.db.query(`insert into pm.time_entries (org_id, job_id, user_id, work_date, hours) values ($1, $2, 'user_x', current_date, 1)`, [ORG_A, J3]);
    const rows = await as(f, 'accountant', async () => q<{ job_id: string }>(f.db, `select distinct job_id from pm.v_time_entries_masked`));
    expect(ids(rows)).toEqual([J1, J2].sort());
    expect(await jobsIn('owner', 'v_time_entries_masked')).toEqual([J1, J2, J3].sort());
  });
  it('approvers on own jobs see their jobs only; crews see their own entries only', async () => {
    expect(await jobsIn('pm', 'v_time_entries_masked')).toEqual([J1]);
    expect(await jobsIn('labor', 'v_time_entries_masked')).toEqual([J2]);
    expect(await count('supervisor', `select 1 from pm.v_time_entries_masked where job_id <> $1`, [J1])).toBe(0);
  });
  it('dispatcher (time:view + jobs_all at L1) sees company time on L1 only', async () => {
    expect(await jobsIn('dispatcher', 'v_time_entries_masked')).toEqual([J1, J2].sort());
  });
});

describe('pm.v_company_team', () => {
  it('lists company members with names and Projects roles where the caller holds team:view', async () => {
    const rows = await as(f, 'pm', async () =>
      q<{ location_id: string; email: string; display_name: string; role_key: string | null; in_company: boolean }>(f.db, `select * from pm.v_company_team`));
    expect(new Set(rows.map((r) => r.location_id))).toEqual(new Set([L1]));
    expect(rows.find((r) => r.email === 'labor@example.test')?.role_key).toBe('projects_labor');
    expect(rows.find((r) => r.email === 'labor@example.test')?.display_name).toBe('T labor');
    expect(rows.some((r) => r.email === 'owner@example.test' && r.role_key === 'projects_owner')).toBe(true);
    expect(rows.some((r) => r.email === 'bOwner@example.test')).toBe(false);
  });
  it('owner sees both companies; labor (no team:view) and other tenants see nothing of org A', async () => {
    const o = await as(f, 'owner', async () => q<{ location_id: string }>(f.db, `select distinct location_id from pm.v_company_team`));
    expect(o.map((r) => r.location_id).sort()).toEqual([L1, L2].sort());
    expect(await count('labor', `select 1 from pm.v_company_team`)).toBe(0);
    expect(await count('bOwner', `select 1 from pm.v_company_team where location_id in ($1, $2)`, [L1, L2])).toBe(0);
  });
});

describe('writes mirror the read rule plus the edit capability', () => {
  it('Labor can log their own time on their job, not on another job, not for someone else', async () => {
    const ok = await as(f, 'labor', async () => errorOf(f.db,
      `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours) values ($1, $2, $3, current_date, 2)`, [ORG_A, J2, f.employee.labor]));
    expect(ok).toBeNull();
    const other = await as(f, 'labor', async () => errorOf(f.db,
      `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours) values ($1, $2, $3, current_date, 2)`, [ORG_A, J1, f.employee.labor]));
    expect(other).toMatch(/row-level security/);
    const someoneElse = await as(f, 'labor', async () => errorOf(f.db,
      `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours) values ($1, $2, $3, current_date, 2)`, [ORG_A, J2, f.employee.supervisor]));
    expect(someoneElse).toMatch(/row-level security/);
  });
  it('Labor cannot create tasks; Supervisor can edit tasks on their job only', async () => {
    const t = await as(f, 'labor', async () => errorOf(f.db, `insert into pm.tasks (org_id, job_id, title) values ($1, $2, 'x')`, [ORG_A, J2]));
    expect(t).toMatch(/row-level security/);
    const upd = await as(f, 'supervisor', async () => q<{ id: string }>(f.db, `update pm.tasks set title = 'edited' where job_id = any($1::uuid[]) returning id`, [[J1, J2]]));
    expect(upd.map((r) => r.id)).toEqual([f.ids[`task:${J1}`]]);
  });
  it('Supervisor can file a change order without a price and read it back, but never its money', async () => {
    const err = await as(f, 'supervisor', async () => errorOf(f.db,
      `insert into pm.change_orders (org_id, job_id, number, title) values ($1, $2, 'CO-SUP', 'Field request')`, [ORG_A, J1]));
    expect(err).toBeNull();
    // the PM prices it later
    await f.db.query(`update pm.change_orders set amount_cents = 77700, cost_impact_cents = 55500 where number = 'CO-SUP'`);
    const own = await as(f, 'supervisor', async () =>
      q<{ number: string; amount_cents: string | null; cost_impact_cents: string | null }>(f.db, `select number, amount_cents, cost_impact_cents from pm.v_change_orders_masked`));
    expect(own).toEqual([{ number: 'CO-SUP', amount_cents: null, cost_impact_cents: null }]);
    expect(await count('supervisor', `select id, number, title, stage from pm.change_orders`)).toBe(1);   // author row, plain columns
    expect(await as(f, 'supervisor', async () => errorOf(f.db, `select amount_cents from pm.change_orders`))).toMatch(/permission denied/);
    const pmView = await as(f, 'pm', async () => q<{ number: string; amount_cents: string | null }>(f.db, `select number, amount_cents from pm.v_change_orders_masked order by number`));
    expect(Number(pmView.find((r) => r.number === 'CO-SUP')?.amount_cents)).toBe(77700);
    // v_job_money (now over the masked source) shows the author no dollars, the PM the real pending total
    const sup = await as(f, 'supervisor', async () => q<{ pending_co_cents: string }>(f.db, `select pending_co_cents from pm.v_job_money where job_id = $1`, [J1]));
    expect(Number(sup[0].pending_co_cents)).toBe(0);
    const pmm = await as(f, 'pm', async () => q<{ pending_co_cents: string }>(f.db, `select pending_co_cents from pm.v_job_money where job_id = $1`, [J1]));
    expect(Number(pmm[0].pending_co_cents)).toBe(100000 + 77700);
  });
  it('definer money math is never masked: PM approval snapshots the real contract value', async () => {
    await f.db.query(`update pm.contracts set status = 'ACTIVE' where job_id = $1`, [J1]);
    const err = await as(f, 'pm', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J1}`]]));
    expect(err).toBeNull();
    const snap = await q<{ approved_co_cents: string; contract_value_cents: string }>(f.db,
      `select approved_co_cents, contract_value_cents from pm.progress_snapshots where job_id = $1 order by snapshot_version desc limit 1`, [J1]);
    expect(Number(snap[0].approved_co_cents)).toBe(100000);
    expect(Number(snap[0].contract_value_cents)).toBe(2500000 + 100000);
  });
  it('masked views give definer code base values even when the caller has no money capability', async () => {
    await f.db.exec(`create or replace function pm.zz_probe(p_job uuid) returns bigint language sql stable security definer set search_path = pm, core, public
                       as $$ select coalesce(sum(amount_cents), 0)::bigint from pm.v_change_orders_masked where job_id = p_job $$;
                     grant execute on function pm.zz_probe(uuid) to authenticated;`);
    try {
      const direct = await as(f, 'supervisor', async () => q<{ s: string }>(f.db, `select coalesce(sum(amount_cents), 0)::bigint as s from pm.v_change_orders_masked where job_id = $1`, [J1]));
      const viaDefiner = await as(f, 'supervisor', async () => q<{ s: string }>(f.db, `select pm.zz_probe($1) as s`, [J1]));
      expect(Number(direct[0].s)).toBe(0);
      expect(Number(viaDefiner[0].s)).toBe(100000 + 77700);
    } finally {
      await f.db.exec(`drop function pm.zz_probe(uuid)`);
    }
  });
  it('PM cannot write a budget on a job that is not theirs', async () => {
    const err = await as(f, 'pm', async () => errorOf(f.db, `insert into pm.budgets (org_id, job_id, kind, version) values ($1, $2, 'REVISED', 2)`, [ORG_A, J2]));
    expect(err).toMatch(/row-level security/);
    const ok = await as(f, 'pm', async () => errorOf(f.db, `insert into pm.budgets (org_id, job_id, kind, version) values ($1, $2, 'REVISED', 2)`, [ORG_A, J1]));
    expect(ok).toBeNull();
  });
  it('settings tables: any company member reads, only settings:configure writes', async () => {
    expect(await count('labor', `select 1 from pm.job_types`)).toBe(1);
    const err = await as(f, 'gm', async () => errorOf(f.db,
      `insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, '02', 'X', 'OTHER')`, [ORG_A, L1]));
    expect(err).toMatch(/row-level security/);
    const ok = await as(f, 'owner', async () => errorOf(f.db,
      `insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, '02', 'X', 'OTHER')`, [ORG_A, L1]));
    expect(ok).toBeNull();
  });
});

describe('definer money RPCs refuse without the capability', () => {
  const forbidden = /PM_FORBIDDEN/;
  it('Labor cannot approve/emit billing, set a contract, or approve a change order', async () => {
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.approve_and_emit_billing($1)`, [f.ids[`billing:${J2}`]]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.set_contract($1, 100, 'PRIME', null, null, null, null)`, [J2]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J2}`]]))).toMatch(forbidden);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.approve_time_entries($1::uuid[])`, [[f.ids.laborTime]]))).toMatch(forbidden);
  });
  it('Supervisor cannot set progress or a contract; Dispatcher cannot generate billing', async () => {
    expect(await as(f, 'supervisor', async () => errorOf(f.db, `select pm.set_progress($1, 0.5, null)`, [J1]))).toMatch(forbidden);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.generate_progress_billing($1, null, null)`, [J1]))).toMatch(forbidden);
  });
  it('PM: refused on a job that is not theirs, passes the guard on their own job', async () => {
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J2}`]]))).toMatch(forbidden);
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.approve_and_emit_billing($1)`, [f.ids[`billing:${J1}`]]))).toMatch(/requires projects\.billing:approve/);
    const own = await as(f, 'pm', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J1}`]]));
    expect(own ?? '').not.toMatch(forbidden);
  });
  it('cross-org callers are refused before anything runs', async () => {
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J1}`]]))).toMatch(forbidden);
  });
  it('every registered guard was injected after the outer BEGIN', async () => {
    const rows = await q<{ function_name: string; guarded: number; total: number }>(f.db,
      `select g.function_name,
              count(*) filter (where p.prosrc like '%pm_access_guard%')::int as guarded, count(*)::int as total
         from pm.access_rpc_guards g join pg_proc p on p.proname = g.function_name
         join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'pm'
        group by 1`);
    const registered = (await q<{ n: number }>(f.db, `select count(*)::int n from pm.access_rpc_guards`))[0].n;
    expect(rows.length).toBe(registered);
    for (const r of rows) expect(r.guarded, r.function_name).toBe(r.total);
  });
});

describe('backfill (acceptance 7): nobody is locked out', () => {
  it('pre-existing owner → projects_owner on all companies', async () => {
    const r = await q<{ key: string; scope_type: string; source: string }>(f.db,
      `select rd.key, a.scope_type, a.source from core.access_assignments a join core.role_definitions rd on rd.id = a.role_id
        where a.membership_id = $1`, [f.membership.legacyOwner]);
    expect(r).toContainEqual({ key: 'projects_owner', scope_type: 'all_clients', source: 'backfill' });
  });
  it('pre-existing members keep reaching every job (projects_pm + legacy all-jobs set)', async () => {
    for (const p of ['legacyStaff', 'legacyPm'] as const) {
      expect(await jobsIn(p, 'tasks'), p).toEqual([J1, J2, J3].sort());
      expect(await jobsIn(p, 'budgets'), p).toEqual([J1, J2, J3].sort());
    }
  });
  it('a full-access owner still reads every org-A row of every member-readable pm table (no over-restriction)', async () => {
    const tables = (await q<{ table_name: string }>(f.db,
      `select a.table_name from pm.access_table_classes a
        join information_schema.columns c on c.table_schema = 'pm' and c.table_name = a.table_name and c.column_name = 'org_id'
       where has_table_privilege('authenticated', 'pm.' || a.table_name, 'select') order by 1`)).map((r) => r.table_name);
    expect(tables.length).toBeGreaterThan(80);
    for (const t of tables) {
      const all = (await q<{ n: number }>(f.db, `select count(*)::int n from pm.${t} where org_id = $1`, [ORG_A]))[0].n;
      const seen = await count('owner', `select 1 from pm.${t}`);
      expect(seen, t).toBe(all);
    }
  });
  it('backfilled members keep every job row and its money (J and M tables)', async () => {
    const tables = (await q<{ table_name: string }>(f.db,
      `select a.table_name from pm.access_table_classes a where a.class in ('J', 'M') and a.read_caps <> '{projects.labor_rates}'
          and has_table_privilege('authenticated', 'pm.' || a.table_name, 'select') order by 1`)).map((r) => r.table_name);
    for (const t of tables) {
      const all = (await q<{ n: number }>(f.db, `select count(*)::int n from pm.${t} where org_id = $1`, [ORG_A]))[0].n;
      expect(await count('legacyStaff', `select 1 from pm.${t}`), t).toBe(all);
    }
  });
  it('job teams are seeded from pm.projects.pm_user_id', async () => {
    const r = await q<{ slot: string }>(f.db, `select slot from pm.job_members where job_id = $1 and membership_id = $2`, [J1, f.membership.legacyPm]);
    expect(r).toEqual([{ slot: 'pm' }]);
  });
  it('every active internal member of every tenant holds at least one Projects grant', async () => {
    const backfilled = [f.membership.legacyOwner, f.membership.legacyStaff, f.membership.legacyPm];
    for (const m of backfilled) {
      const r = await q<{ ok: boolean }>(f.db, `select pm.access_has_projects_assignment($1) as ok`, [m]);
      expect(r[0].ok).toBe(true);
    }
  });
  it('new owner seats get projects_owner automatically', async () => {
    const r = await q<{ key: string }>(f.db,
      `select rd.key from core.access_assignments a join core.role_definitions rd on rd.id = a.role_id where a.membership_id = $1`, [f.membership.bOwner]);
    expect(r.map((x) => x.key)).toContain('projects_owner');
  });
  it('the backfill is idempotent', async () => {
    await f.db.query(`select pm.access_backfill($1)`, [ORG_A]); // picks up members added since (e.g. user_nobody)
    const before = (await q<{ n: number }>(f.db, `select count(*)::int n from core.access_assignments`))[0].n;
    await f.db.query(`select pm.access_backfill($1)`, [ORG_A]);
    await f.db.query(`select pm.access_backfill($1)`, [ORG_B]);
    expect((await q<{ n: number }>(f.db, `select count(*)::int n from core.access_assignments`))[0].n).toBe(before);
  });
});

describe('registry guard: every pm table is classified', () => {
  it('no unclassified base table in schema pm', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
  });
  it('every classified table carries the four restrictive policies', async () => {
    const r = await q<{ table_name: string; n: number }>(f.db,
      `select a.table_name, count(p.policyname)::int as n from pm.access_table_classes a
         left join pg_policies p on p.schemaname = 'pm' and p.tablename = a.table_name and p.policyname like 'pm\\_access\\_%' and p.permissive = 'RESTRICTIVE'
        group by 1`);
    for (const x of r) expect(x.n, x.table_name).toBe(4);
  });
  it('a new unclassified table is reported and blocks the policy installer', async () => {
    await f.db.exec(`create table pm.zz_unclassified (id uuid primary key, org_id uuid)`);
    try {
      expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([{ access_unclassified_tables: 'zz_unclassified' }]);
      expect(await errorOf(f.db, `select pm.access_apply_policies()`)).toMatch(/PM_ACCESS_UNCLASSIFIED: .*zz_unclassified/);
    } finally {
      await f.db.exec(`drop table pm.zz_unclassified`);
    }
  });
});

describe('capability mirror is module-scoped', () => {
  it('a Books-only re-mirror never deprecates projects.* (and keeps Books behavior)', async () => {
    await f.db.exec('begin');
    try {
      await f.db.query(`select core.rbac_mirror_capabilities($1::jsonb)`, [JSON.stringify([
        { key: 'gl.accounts', module: 'books', domain: 'GL', actions: ['view'], label: 'Chart of accounts', description: '', tags: [], risk_tier: 'standard', platform_only: false, field_classes: [], supports_constraints: [], introduced_in: 'wave1', status: 'active' },
      ])]);
      const r = await q<{ module: string; status: string; n: number }>(f.db, `select module, status, count(*)::int n from core.capabilities group by 1, 2 order by 1, 2`);
      expect(r.find((x) => x.module === 'projects' && x.status === 'active')?.n).toBe(20);
      expect(r.find((x) => x.module === 'projects' && x.status === 'deprecated')).toBeUndefined();
      expect(r.find((x) => x.module === 'books' && x.status === 'active')?.n).toBe(1);
      expect(r.find((x) => x.module === 'books' && x.status === 'deprecated')?.n).toBeGreaterThan(100); // 157 behavior within the input's module
      expect(r.find((x) => x.module === 'core' && x.status === 'active')?.n).toBeGreaterThan(0);        // modules absent from the input are untouched
    } finally {
      await f.db.exec('rollback');
    }
  });
});

describe('idempotency', () => {
  it('1110 applies a second time and nothing changes', async () => {
    const before = await q(f.db, `select (select count(*)::int from core.access_assignments) a, (select count(*)::int from pg_policies where schemaname = 'pm') p,
                                         (select count(*)::int from core.role_definitions) r, (select count(*)::int from pm.job_members) j`);
    await applyMigration(f.db, '1110_pm_access.sql');
    const after = await q(f.db, `select (select count(*)::int from core.access_assignments) a, (select count(*)::int from pg_policies where schemaname = 'pm') p,
                                        (select count(*)::int from core.role_definitions) r, (select count(*)::int from pm.job_members) j`);
    expect(after).toEqual(before);
    expect(await jobsIn('labor', 'tasks')).toEqual([J2]);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.approve_change_order($1)`, [f.ids[`co:${J2}`]]))).toMatch(/PM_FORBIDDEN/);
  });
});
