/**
 * Residential depth (migration 1119) against a PGlite replay of every migration: the proposal builder
 * (catalog + assemblies, labor rule, options, allowances, payment schedule, state notice, tax) and
 * accept → job in one click (in person and the e-sign path), selections with the allowance delta
 * shown first and the overage → CO → deposit → PO flow, field / demo-discovery / internal change
 * orders, trade confirmations by link, bids + leveling, PO-matched trade invoices behind the compliance
 * gate, milestone + cost-plus billing, the builder chain (lots, plans, options, purchase agreement,
 * design-center cutoffs, start package, VPOs, closing, warranty walks), remodel records, and RLS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, L1, J1 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';
import { priceLine, proposalTotals, allowanceDelta, pinPaymentSchedule, type TotalsLine } from '../../../apps/projects/src/lib/residential/pricing';

let f: Fixture;
const ids: Record<string, string> = {};
const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}
/** Run one statement as a persona and return its single value `r`. */
const call = async <T = unknown>(p: Persona, sql: string, params: unknown[] = []): Promise<T> =>
  as(f, p, async () => (await q<{ r: T }>(f.db, sql, params))[0]!.r);
const fails = (p: Persona, sql: string, params: unknown[] = []) => as(f, p, async () => errorOf(f.db, sql, params));

const skipped: string[] = [];
beforeAll(async () => {
  f = await buildFixture();
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if (n <= 1117 || n === 1119) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[residential.test] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
  const db = f.db;
  await db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                  select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs where location_id = $1
                  on conflict do nothing`, [L1]);
  await db.query(`update pm.contracts set status = 'ACTIVE' where job_id = $1`, [J1]);
  await db.query(`update pm.budgets set status = 'APPROVED' where job_id = $1 and kind = 'ORIGINAL'`, [J1]);
  await db.query(`insert into pm.res_settings (org_id, location_id, state_code, default_markup_pct, default_deposit_pct) values ($1, $2, 'IA', 0.25, 0.10)`, [ORG_A, L1]);
  ids.cc = f.ids[`costCode:${L1}`];
  ids.card = (await one<{ id: string }>(`insert into pm.labor_rate_cards (org_id, location_id, key, label, base_rate_cents, burden_pct, overhead_pct)
                                         values ($1, $2, 'carpenter', 'Carpenter', 3000, 0.25, 0.15) returning id`, [ORG_A, L1])).id;
  ids.tile = (await one<{ id: string }>(`insert into pm.res_catalog_items (org_id, location_id, code, name, cost_code_id, uom, unit_cost_cents, waste_pct, markup_pct,
                                           labor_rate_card_id, labor_hours_per_unit, category)
                                         values ($1, $2, 'TILE-PORC', 'Porcelain floor tile', $3, 'SF', 450, 0.10, 0.50, $4, 0.25, 'Tile') returning id`, [ORG_A, L1, ids.cc, ids.card])).id;
  ids.thinset = (await one<{ id: string }>(`insert into pm.res_catalog_items (org_id, location_id, code, name, cost_code_id, uom, unit_cost_cents, markup_pct)
                                            values ($1, $2, 'THINSET', 'Thinset mortar', $3, 'BAG', 2200, 0.30) returning id`, [ORG_A, L1, ids.cc])).id;
  ids.asm = (await one<{ id: string }>(`insert into pm.res_assemblies (org_id, location_id, code, name, uom) values ($1, $2, 'TILE-FLOOR', 'Tile floor (per SF)', 'SF') returning id`, [ORG_A, L1])).id;
  await db.query(`insert into pm.res_assembly_items (org_id, assembly_id, catalog_item_id, qty_per_unit, sort) values ($1, $2, $3, 1, 1), ($1, $2, $4, 0.02, 2)`,
    [ORG_A, ids.asm, ids.tile, ids.thinset]);
  // homeowner + lead
  ids.cust = (await one<{ id: string }>(`insert into core.customers (org_id, name, email, phone, location_id) values ($1, 'Pat Smith', 'pat@example.test', '515-555-0101', $2) returning id`, [ORG_A, L1])).id;
  ids.contact = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, last_name, email, phone, sms_consent, is_primary, can_sign)
                                            values ($1, $2, 'Pat', 'Smith', 'pat@example.test', '515-555-0101', true, true, true) returning id`, [ORG_A, ids.cust])).id;
  const pipe = await one<{ pipeline_id: string; stage_id: string }>(`select p.id as pipeline_id, s.id as stage_id from crm.pipelines p join crm.pipeline_stages s on s.pipeline_id = p.id
                                                                       where p.location_id = $1 order by s.sort limit 1`, [L1]);
  ids.lead = (await one<{ id: string }>(`insert into crm.leads (org_id, location_id, pipeline_id, stage_id, title, customer_id, contact_id, source)
                                         values ($1, $2, $3, $4, 'Smith kitchen remodel', $5, $6, 'Houzz') returning id`,
    [ORG_A, L1, pipe.pipeline_id, pipe.stage_id, ids.cust, ids.contact])).id;
  // trades
  ids.vendor = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Prairie Cabinets') returning id`, [ORG_A])).id;
  ids.vendor2 = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Hawkeye Plumbing') returning id`, [ORG_A])).id;
  ids.vendor3 = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Cyclone Plumbing') returning id`, [ORG_A])).id;
  ids.vcontact = (await one<{ id: string }>(`insert into core.contacts (org_id, vendor_id, first_name, phone, email, sms_consent, is_primary)
                                             values ($1, $2, 'Dale', '515-555-0199', 'dale@hawkeye.test', true, true) returning id`, [ORG_A, ids.vendor2])).id;
  await db.query(`insert into core.contacts (org_id, vendor_id, first_name, email, is_primary) values ($1, $2, 'Cy', 'bids@cyclone.test', true)`, [ORG_A, ids.vendor3]);
  await db.query(`insert into core.sms_consents (org_id, phone, source, consent_text) values ($1, '+15155550199', 'test', 'ok'), ($1, '+15155550101', 'test', 'ok')
                  on conflict do nothing`, [ORG_A]).catch(() => undefined);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('migration 1119 registers with the 1110 access foundation', () => {
  it('every pm table classified, every member definer RPC guarded, nothing in pm for anon', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
  });
  it('cost columns are revoked from members on the base tables', async () => {
    for (const [t, c] of [['res_catalog_items', 'unit_cost_cents'], ['res_proposals', 'cost_cents'], ['res_proposal_lines', 'cost_cents'],
                          ['res_proposal_lines', 'overhead_cents'], ['res_plans', 'base_cost_cents'], ['res_lots', 'land_cost_cents']] as const) {
      const r = await q<{ ok: boolean }>(f.db, `select has_column_privilege('authenticated', $1, $2, 'SELECT') as ok`, [`pm.${t}`, c]);
      expect(r[0]!.ok, `${t}.${c}`).toBe(false);
    }
  });
});

describe('proposal builder', () => {
  it('a proposal from a lead creates the presale job + customer (matcher) + estimate, with the default payment schedule', async () => {
    ids.proposal = await call<string>('gm', `select pm.res_create_proposal($1, $2, null, 'Smith kitchen', null, $3::jsonb) as r`,
      [L1, ids.lead, JSON.stringify({ schedule_template_key: 'kitchen_remodel', scope_narrative: 'Full kitchen remodel', exclusions: ['Appliances'], planned_start: '2027-01-11' })]);
    const p = await one<{ job_id: string; estimate_id: string; customer_id: string; state_code: string; status: string }>(
      `select job_id, estimate_id, customer_id, state_code, status from pm.res_proposals where id = $1`, [ids.proposal]);
    ids.pjob = p.job_id; ids.pest = p.estimate_id;
    expect(p.customer_id).toBe(ids.cust);   // the lead's customer — no duplicate
    expect(p.state_code).toBe('IA');
    const sched = await q<{ kind: string; trigger_ref: string | null }>(f.db, `select kind, trigger_ref from pm.res_payment_schedule where proposal_id = $1 order by seq`, [ids.proposal]);
    expect(sched.map((s) => s.kind)).toEqual(['DEPOSIT', 'MILESTONE', 'MILESTONE', 'MILESTONE', 'FINAL']);
    expect(sched.map((s) => s.trigger_ref)).toEqual([null, 'demolition', 'cabinets', 'install_tops', 'complete']);
    // the author joined the job team
    expect((await one<{ n: number }>(`select count(*)::int n from pm.job_members where job_id = $1 and membership_id = $2`, [ids.pjob, f.membership.gm])).n).toBe(1);
  });

  it('assemblies add material + labor lines; labor prices at pay + burden + overhead with overhead kept out of cost', async () => {
    const n = await call<number>('gm', `select pm.res_add_catalog_lines($1, null, $2, 200, null, 'Kitchen') as r`, [ids.proposal, ids.asm]);
    expect(n).toBe(3);   // tile, its install labor, thinset
    const lines = await q<{ description: string; qty: string; cost_cents: string; overhead_cents: string; price_cents: string; labor_rate_card_id: string | null }>(f.db,
      `select description, qty, cost_cents, overhead_cents, price_cents, labor_rate_card_id from pm.res_proposal_lines where proposal_id = $1 order by sort`, [ids.proposal]);
    const tile = lines.find((l) => l.description === 'Porcelain floor tile')!;
    const labor = lines.find((l) => l.labor_rate_card_id)!;
    // 200 SF × 1.10 waste × $4.50 = $990.00 cost; × 1.5 = $1,485.00
    expect([Number(tile.cost_cents), Number(tile.price_cents)]).toEqual([99000, 148500]);
    expect(priceLine({ qty: 200, wastePct: '0.10', unitCostCents: 450, markupPct: '0.50' })).toMatchObject({ costCents: 99000, priceCents: 148500 });
    // labor: 50 h; cost rate 3000 × 1.25 = 3750; estimating 3750 × 1.15 = 4313 (rounded); sell = estimating × 1.5 (the item's markup)
    const want = priceLine({ qty: 50, unitCostCents: 0, labor: { costRateCents: 3750, estimatingRateCents: 4313 }, markupPct: '0.50' });
    expect([Number(labor.qty), Number(labor.cost_cents), Number(labor.overhead_cents), Number(labor.price_cents)])
      .toEqual([50, want.costCents, want.overheadCents, want.priceCents]);
    expect(Number(labor.overhead_cents)).toBe(50 * 4313 - 50 * 3750);
  });

  it('options (good / better alternates + an add-on), allowance lines and contingency; totals match the app mirror', async () => {
    const db = f.db;
    ids.optGood = (await one<{ id: string }>(`insert into pm.res_proposal_options (org_id, proposal_id, kind, group_key, tier, label, is_selected, sort)
                                              values ($1, $2, 'ALTERNATE', 'counters', 'GOOD', 'Laminate counters', false, 1) returning id`, [ORG_A, ids.proposal])).id;
    ids.optBetter = (await one<{ id: string }>(`insert into pm.res_proposal_options (org_id, proposal_id, kind, group_key, tier, label, is_selected, sort)
                                                values ($1, $2, 'ALTERNATE', 'counters', 'BETTER', 'Quartz counters', true, 2) returning id`, [ORG_A, ids.proposal])).id;
    ids.optLights = (await one<{ id: string }>(`insert into pm.res_proposal_options (org_id, proposal_id, kind, label, is_selected, sort)
                                                values ($1, $2, 'ADD_ON', 'Under-cabinet lighting', false, 3) returning id`, [ORG_A, ids.proposal])).id;
    await db.query(`insert into pm.res_proposal_lines (org_id, proposal_id, option_id, cost_code_id, description, qty, unit_cost_cents, markup_pct) values
                      ($1, $2, $3, $5, 'Laminate tops', 30, 2500, 0.4), ($1, $2, $4, $5, 'Quartz tops', 30, 6000, 0.4)`, [ORG_A, ids.proposal, ids.optGood, ids.optBetter, ids.cc]);
    await db.query(`insert into pm.res_proposal_lines (org_id, proposal_id, option_id, cost_code_id, description, qty, unit_cost_cents, margin_pct, tax_category)
                    values ($1, $2, $3, $4, 'LED tape + driver', 1, 42000, 0.35, 'EQUIPMENT')`, [ORG_A, ids.proposal, ids.optLights, ids.cc]);
    await db.query(`insert into pm.res_proposal_lines (org_id, proposal_id, cost_code_id, description, qty, unit_cost_cents, unit_price_cents, is_allowance, allowance_category, room)
                    values ($1, $2, $3, 'Cabinet allowance', 1, 960000, 1200000, true, 'Cabinets', 'Kitchen'),
                           ($1, $2, $3, 'Flooring allowance', 1, 320000, 400000, true, 'Flooring', null)`, [ORG_A, ids.proposal, ids.cc]);
    await db.query(`update pm.res_proposal_lines set selection_titles = '{"Kitchen floor","Mudroom floor"}' where proposal_id = $1 and description = 'Flooring allowance'`, [ids.proposal]);
    await as(f, 'gm', async () => { await q(f.db, `update pm.res_proposals set contingency_pct = 0.05 where id = $1`, [ids.proposal]); });
    // alternates: one per group
    expect(await fails('gm', `select pm.res_select_options($1, $2)`, [ids.proposal, [ids.optGood, ids.optBetter]])).toMatch(/PM_RES_OPTION_GROUP/);
    expect(await call<number>('gm', `select pm.res_select_options($1, $2) as r`, [ids.proposal, [ids.optBetter, ids.optLights]])).toBe(3);

    const rows = await q<{ option_id: string | null; price_cents: string; cost_cents: string; overhead_cents: string; is_allowance: boolean; is_contingency: boolean; tax_category: string; selected: boolean | null }>(f.db,
      `select l.option_id, l.price_cents, l.cost_cents, l.overhead_cents, l.is_allowance, l.is_contingency, l.tax_category, o.is_selected as selected
         from pm.res_proposal_lines l left join pm.res_proposal_options o on o.id = l.option_id where l.proposal_id = $1`, [ids.proposal]);
    const included: TotalsLine[] = rows.filter((r) => r.option_id === null || r.selected).map((r) => ({
      optionId: r.option_id, priceCents: Number(r.price_cents), costCents: Number(r.cost_cents), overheadCents: Number(r.overhead_cents),
      isAllowance: r.is_allowance, isContingency: r.is_contingency, taxCategory: r.tax_category as TotalsLine['taxCategory'],
    }));
    const want = proposalTotals({ contractType: 'FIXED_PRICE', taxForm: 'LUMP_SUM_IMPROVEMENT', taxRate: 0, contingencyPct: '0.05', depositPct: '0.10' }, included);
    const p = await one<{ total_cents: string; options_price_cents: string; allowance_cents: string; contingency_cents: string; cost_cents: string; overhead_cents: string; deposit_due_cents: string }>(
      `select total_cents, options_price_cents, allowance_cents, contingency_cents, cost_cents, overhead_cents, deposit_due_cents from pm.res_proposals where id = $1`, [ids.proposal]);
    expect({ total: Number(p.total_cents), options: Number(p.options_price_cents), allowance: Number(p.allowance_cents), contingency: Number(p.contingency_cents),
             cost: Number(p.cost_cents), overhead: Number(p.overhead_cents), deposit: Number(p.deposit_due_cents) })
      .toEqual({ total: want.totalCents, options: want.optionsPriceCents, allowance: want.allowanceCents, contingency: want.contingencyCents,
                 cost: want.costCents, overhead: want.overheadCents, deposit: want.depositDueCents });
    expect(want.allowanceCents).toBe(1600000);
    // LED: cost 42000 at 35 % margin → round(42000 / 0.65) = 64615
    expect(Number(rows.find((r) => r.tax_category === 'EQUIPMENT')!.price_cents)).toBe(64615);
  });

  it('retail-plus-install taxes product, not install labor (Iowa rule); lump-sum improvement carries none on the invoice', async () => {
    const t = await call<{ tax_cents: number; categories: Record<string, { taxable: boolean }> }>('gm',
      `select pm.res_tax_preview($1) as r`, [ids.proposal]);
    expect(t.tax_cents).toBe(0);
    await as(f, 'gm', async () => { await q(f.db, `update pm.res_proposals set tax_contract_form = 'RETAIL_PLUS_INSTALL', tax_rate = 0.07 where id = $1`, [ids.proposal]); });
    const r = await call<{ tax_cents: number; categories: Record<string, { taxable: boolean; price_cents: number }> }>('gm', `select pm.res_tax_preview($1) as r`, [ids.proposal]);
    expect(r.categories.LABOR!.taxable).toBe(false);
    expect(r.categories.MATERIAL!.taxable).toBe(true);
    const taxable = r.categories.MATERIAL!.price_cents + (r.categories.EQUIPMENT?.price_cents ?? 0);
    expect(r.tax_cents).toBe(Math.round(taxable * 0.07));
    await as(f, 'gm', async () => { await q(f.db, `update pm.res_proposals set tax_contract_form = 'LUMP_SUM_IMPROVEMENT', tax_rate = 0.07 where id = $1`, [ids.proposal]); });
  });

  it('send: validates (uncoded lines, schedule = 100 %), syncs the estimate without overhead in cost, snapshots, pins the Iowa notice', async () => {
    const r = await call<{ status: string; total_cents: number }>('gm', `select pm.res_send_proposal($1) as r`, [ids.proposal]);
    expect(r.status).toBe('sent');
    const p = await one<{ status: string; cancellation_notice: string; cancel_days: number; total_cents: string; cost_cents: string }>(
      `select status, cancellation_notice, cancel_days, total_cents, cost_cents from pm.res_proposals where id = $1`, [ids.proposal]);
    expect(p.status).toBe('SENT');
    expect(p.cancellation_notice).toMatch(/Iowa Code ch\. 555A/);
    const e = await one<{ status: string; total_cents: string; cost_total_cents: string }>(`select status, total_cents, cost_total_cents from pm.estimates where id = $1`, [ids.pest]);
    expect(e.status).toBe('SENT');
    expect(Number(e.total_cents)).toBe(Number(p.total_cents));
    expect(Number(e.cost_total_cents)).toBe(Number(p.cost_cents));   // pay + burden only — overhead is not cost
    expect((await one<{ n: number }>(`select count(*)::int n from pm.res_proposal_snapshots where proposal_id = $1`, [ids.proposal])).n).toBe(1);
    // locked for members once sent
    expect(await fails('gm', `update pm.res_proposal_lines set qty = 1 where proposal_id = $1`, [ids.proposal])).toMatch(/PM_RES_PROPOSAL_LOCKED/);
  });

  it('labor (no estimates) cannot read or send proposals', async () => {
    expect((await as(f, 'labor', async () => q(f.db, `select id from pm.res_proposals`))).length).toBe(0);
    expect(await fails('labor', `select pm.res_send_proposal($1)`, [ids.proposal])).toMatch(forbidden);
    expect(await fails('supervisor', `select pm.res_accept_proposal($1, 'X')`, [ids.proposal])).toMatch(forbidden);
  });
});

describe('accept → job in one click', () => {
  it('in person: contract, baseline budget (no overhead), schedule from template, payment milestones on tasks, deposit, selections, household, lead won', async () => {
    const r = await call<{ contract_cents: number; deposit_cents: number; selections_created: number; household_invites: number; warnings: string[] }>('gm',
      `select pm.res_accept_proposal($1, 'Pat Smith', 'IN_PERSON') as r`, [ids.proposal]);
    expect(r.warnings).toEqual([]);
    const p = await one<{ status: string; total_cents: string; cost_cents: string }>(`select status, total_cents, cost_cents from pm.res_proposals where id = $1`, [ids.proposal]);
    expect(p.status).toBe('ACCEPTED');
    const k = await one<{ original_cents: string; status: string }>(`select original_cents, status from pm.contracts where job_id = $1`, [ids.pjob]);
    expect([Number(k.original_cents), k.status]).toEqual([Number(p.total_cents), 'ACTIVE']);
    const b = await one<{ n: string }>(`select coalesce(sum(amount_cents), 0)::text n from pm.v_job_current_budget_lines where job_id = $1`, [ids.pjob]);
    expect(Number(b.n)).toBe(Number(p.cost_cents));
    const tasks = await one<{ n: number; pay: number }>(`select count(*) filter (where template_ref like 'kitchen_remodel:%')::int n,
                                                               count(*) filter (where title like 'Payment:%')::int pay from pm.tasks where job_id = $1`, [ids.pjob]);
    expect(tasks.n).toBe(35);   // the kitchen template: 6 phases + 29 tasks and milestones
    expect(tasks.pay).toBe(3);   // demolition, cabinets, install_tops; the final bills on 'Substantial completion' itself
    const sched = await q<{ kind: string; amount_cents: string; status: string; deposit_request_id: string | null; billing_task_id: string | null }>(f.db,
      `select kind, amount_cents, status, deposit_request_id, billing_task_id from pm.res_payment_schedule where proposal_id = $1 order by seq`, [ids.proposal]);
    expect(sched.reduce((s, x) => s + Number(x.amount_cents), 0)).toBe(Number(p.total_cents));
    expect(sched.map((x) => Number(x.amount_cents))).toEqual(pinPaymentSchedule(Number(p.total_cents), [{ pct: '0.1' }, { pct: '0.225' }, { pct: '0.27' }, { pct: '0.27' }, { pct: '0.135' }]));
    expect(sched[0]!.deposit_request_id).not.toBeNull();
    expect(sched.slice(1).every((x) => x.status === 'SCHEDULED' && x.billing_task_id)).toBe(true);
    const dep = await one<{ amount_cents: string; status: string }>(`select amount_cents, status from pm.deposit_requests where id = $1`, [sched[0]!.deposit_request_id]);
    expect(Number(dep.amount_cents)).toBe(r.deposit_cents);
    // allowances → selections (one, and two sharing the flooring allowance)
    const sels = await q<{ title: string; category: string; allowance_id: string; shared: boolean; needed_by_on: string | null }>(f.db,
      `select title, category, allowance_id, (ext ->> '_res_shared')::boolean as shared, needed_by_on::text from pm.selections where job_id = $1 order by title`, [ids.pjob]);
    expect(sels.map((s) => s.title)).toEqual(['Cabinet allowance', 'Kitchen floor', 'Mudroom floor']);
    expect(sels.filter((s) => s.shared).length).toBe(2);
    expect(sels.find((s) => s.title === 'Cabinet allowance')!.needed_by_on).not.toBeNull();   // from the cabinets task − buffer
    expect(r.household_invites).toBeGreaterThanOrEqual(1);
    const hh = await one<{ portal_status: string; can_sign: boolean; contact_id: string }>(`select portal_status, can_sign, contact_id from pm.res_household_members where job_id = $1`, [ids.pjob]);
    expect(hh.can_sign).toBe(true);
    if ((await one<{ t: string | null }>(`select to_regclass('pm.portal_grants')::text as t`)).t) {
      // 1118 present: the household is invited to the customer portal (the gm holds customers:edit)
      expect(hh.portal_status).toBe('INVITED');
      expect((await one<{ n: number }>(`select count(*)::int n from pm.portal_grants where contact_id = $1 and audience = 'customer'`, [hh.contact_id])).n).toBe(1);
    } else {
      expect(hh.portal_status).toBe('PENDING_INVITE');
    }
    expect((await one<{ won: boolean }>(`select won_at is not null as won from crm.leads where id = $1`, [ids.lead])).won).toBe(true);
    // idempotent
    const again = await call<{ contract_cents: number }>('gm', `select pm.res_accept_proposal($1, 'Pat Smith') as r`, [ids.proposal]);
    expect(again.contract_cents).toBe(r.contract_cents);
  });

  it('e-sign path: the estimate accepted by its signed document completes the proposal in the same transaction', async () => {
    ids.p2 = await call<string>('gm', `select pm.res_create_proposal(null, null, $1, 'J1 bath add', null, '{"schedule_template_key":"bathroom_remodel"}'::jsonb) as r`, [J1]);
    await f.db.query(`insert into pm.res_proposal_lines (org_id, proposal_id, cost_code_id, description, qty, unit_cost_cents, markup_pct) values ($1, $2, $3, 'Bath scope', 1, 800000, 0.4)`,
      [ORG_A, ids.p2, ids.cc]);
    expect((await call<{ status: string }>('gm', `select pm.res_send_proposal($1) as r`, [ids.p2])).status).toBe('sent');
    const est = (await one<{ estimate_id: string }>(`select estimate_id from pm.res_proposals where id = $1`, [ids.p2])).estimate_id;
    // what lib/esign/callbacks.ts runs on envelope.completed (kind estimate)
    await as(f, 'gm', async () => { await q(f.db, `select pm.accept_estimate($1)`, [est]); });
    const p = await one<{ status: string; sign_method: string; result: { schedule: unknown } }>(`select status, sign_method, result from pm.res_proposals where id = $1`, [ids.p2]);
    expect([p.status, p.sign_method]).toEqual(['ACCEPTED', 'E_SIGNATURE']);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.tasks where job_id = $1 and template_ref like 'bathroom_remodel:%'`, [J1])).n).toBe(25);
  });
});

describe('selections & allowances', () => {
  beforeAll(async () => {
    const s = await one<{ id: string }>(`select id from pm.selections where job_id = $1 and title = 'Cabinet allowance'`, [ids.pjob]);
    ids.selCab = s.id;
    ids.optA = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_cost_cents, unit_price_cents, vendor_id, lead_time_days, image_url)
                                           values ($1, $2, 'Shaker painted', 1, 800000, 1100000, $3, 28, 'https://example.test/a.jpg') returning id`, [ORG_A, s.id, ids.vendor])).id;
    ids.optB = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_cost_cents, unit_price_cents, vendor_id, lead_time_days, vendor_deposit_pct)
                                           values ($1, $2, 'Inset walnut', 1, 950000, 1384000, $3, 42, 0.5) returning id`, [ORG_A, s.id, ids.vendor])).id;
  });

  it('shows the delta against the allowance before choosing (and nothing without contract value)', async () => {
    const pv = await call<{ allowance_cents: number; options: Array<{ id: string; over_cents: number; under_cents: number; needed_by_on: string | null }> }>('gm',
      `select pm.res_selection_preview($1) as r`, [ids.selCab]);
    expect(pv.allowance_cents).toBe(1200000);
    const b = pv.options.find((o) => o.id === ids.optB)!;
    expect([b.over_cents, b.under_cents]).toEqual([184000, 0]);
    expect(allowanceDelta(1384000, 1200000)).toEqual({ overCents: 184000, underCents: 0, remainingCents: 1200000 });
    expect(pv.options.find((o) => o.id === ids.optA)!.under_cents).toBe(100000);
    expect(b.needed_by_on).not.toBeNull();
  });

  it('choosing over allowance: client approval → allowance CO signed by the customer and approved → deposit → draft PO + procurement → vendor deposit', async () => {
    const r = await call<{ over_cents: number; change_order_id: string; change_order_state: string; deposit_request_id: string; commitment_id: string;
      procurement_item_id: string; vendor_deposit_id: string; warnings: string[] }>('gm',
      `select pm.res_choose_selection($1, $2, 'Pat Smith', 'PORTAL') as r`, [ids.selCab, ids.optB]);
    expect(r.over_cents).toBe(184000);
    const co = await one<{ stage: string; amount_cents: string; co_type: string; signer_name: string; created_by: string }>(
      `select stage, amount_cents, co_type, signer_name, created_by from pm.change_orders where id = $1`, [r.change_order_id]);
    expect([co.co_type, Number(co.amount_cents), co.signer_name]).toEqual(['ALLOWANCE', 184000, 'Pat Smith']);
    expect(co.created_by).toMatch(/^customer:/);
    expect(r.change_order_state).toBe(co.stage === 'APPROVED' ? 'approved' : 'awaiting_internal_approval');
    expect(Number((await one<{ a: string }>(`select amount_cents::text a from pm.deposit_requests where id = $1`, [r.deposit_request_id])).a)).toBe(184000);
    const po = await one<{ status: string; vendor_id: string; total: string }>(`select c.status, c.vendor_id, (select sum(amount_cents) from pm.commitment_lines l where l.commitment_id = c.id)::text total
                                                                                  from pm.commitments c where c.id = $1`, [r.commitment_id]);
    expect([po.status, po.vendor_id, Number(po.total)]).toEqual(['DRAFT', ids.vendor, 950000]);
    expect((await one<{ c: string }>(`select commitment_id::text c from pm.procurement_items where id = $1`, [r.procurement_item_id])).c).toBe(r.commitment_id);
    expect(Number((await one<{ a: string }>(`select amount_cents::text a from pm.res_vendor_deposits where id = $1`, [r.vendor_deposit_id])).a)).toBe(475000);
    expect((await one<{ status: string }>(`select status from pm.selections where id = $1`, [ids.selCab])).status).toBe('APPROVED');
  });

  it('a shared allowance: the second choice sees what the first used; reconciliation nets the rest into one CO', async () => {
    const [k, m] = await q<{ id: string }>(f.db, `select id from pm.selections where job_id = $1 and title in ('Kitchen floor','Mudroom floor') order by title`, [ids.pjob]);
    const ok = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_price_cents) values ($1, $2, 'LVP oak', 1, 300000) returning id`, [ORG_A, k!.id])).id;
    const om = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_price_cents) values ($1, $2, 'Slate tile', 1, 150000) returning id`, [ORG_A, m!.id])).id;
    expect((await call<{ over_cents: number }>('gm', `select pm.res_choose_selection($1, $2, 'Pat Smith') as r`, [k!.id, ok])).over_cents).toBe(0);
    const pv = await call<{ remaining_cents: number; used_by_others_cents: number; options: Array<{ over_cents: number }> }>('gm', `select pm.res_selection_preview($1) as r`, [m!.id]);
    expect([pv.used_by_others_cents, pv.remaining_cents, pv.options[0]!.over_cents]).toEqual([300000, 100000, 50000]);
    expect((await call<{ over_cents: number }>('gm', `select pm.res_choose_selection($1, $2, 'Pat Smith', 'IN_PERSON', null, null, 'NEXT_MILESTONE') as r`, [m!.id, om])).over_cents).toBe(50000);
    const added = await one<{ added: string }>(`select added_cents::text added from pm.res_payment_schedule where proposal_id = $1 and seq = 2`, [ids.proposal]);
    expect(Number(added.added)).toBe(50000);
    const al = (await one<{ allowance_id: string }>(`select allowance_id from pm.selections where id = $1`, [k!.id])).allowance_id;
    const rec = await call<{ net_cents: number; prior_co_cents: number }>('gm', `select pm.res_reconcile_allowance($1) as r`, [al]);
    expect([rec.prior_co_cents, rec.net_cents]).toEqual([50000, 0]);   // 4,500 chosen − 4,000 allowance − 500 already on a CO
  });

  it('reminders go to the household as held customer texts until go-live', async () => {
    await f.db.query(`update pm.selections set due_on = current_date + 2, deadline_source = 'MANUAL' where job_id = $1 and status = 'OPEN'`, [ids.pjob]);
    const s = await one<{ id: string }>(`insert into pm.selections (org_id, job_id, category, title, due_on, deadline_source) values ($1, $2, 'Plumbing', 'Faucet', current_date + 2, 'MANUAL') returning id`, [ORG_A, ids.pjob]);
    const n = await call<number>('gm', `select pm.res_send_selection_reminders($1) as r`, [ids.pjob]);
    expect(n).toBeGreaterThanOrEqual(1);
    const msgs = await q<{ status: string; channel: string }>(f.db, `select status, channel from core.outbound_messages where event_type = 'customer.selection_reminder' and job_id = $1`, [ids.pjob]);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.every((x) => ['held', 'suppressed', 'queued'].includes(x.status))).toBe(true);
    expect((await one<{ c: number }>(`select reminder_count c from pm.selections where id = $1`, [s.id])).c).toBe(1);
  });
});

describe('change orders', () => {
  it('a demo-discovery request from the field: stop-work, clause, evidence; supervisors cannot price it', async () => {
    const doc = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type) values ($1, 'x/rot.jpg', 'rot.jpg', 'image/jpeg', 10, 'OTHER') returning id`, [ORG_A])).id;
    ids.fco = await call<string>('supervisor', `select pm.res_request_field_co($1, 'Rotten subfloor under the tub', '40 sq ft', 'rotten subfloor under the tub forty square feet', $2, null, true, false, 'Hall bath') as r`, [J1, [doc]]);
    const co = await one<{ co_type: string; stop_work: boolean; contract_clause: string; stage: string; evidence: number }>(
      `select co_type, stop_work, contract_clause, stage, cardinality(evidence_document_ids) evidence from pm.change_orders where id = $1`, [ids.fco]);
    expect(co).toMatchObject({ co_type: 'DEMO_DISCOVERY', stop_work: true, stage: 'PCO', evidence: 1 });
    expect(co.contract_clause).toMatch(/unforeseen/i);
    expect(await fails('supervisor', `select pm.res_price_change_order($1, '[{"description":"x","qty":1,"unit_cost_cents":100}]'::jsonb)`, [ids.fco])).toMatch(forbidden);
    // unsigned work in progress is flagged on the exposure log
    await f.db.query(`insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours) values ($1, $2, $3, current_date, 2)`, [ORG_A, J1, f.employee.supervisor]);
    const ex = await one<{ exposure_state: string; work_logged_unsigned: boolean }>(`select exposure_state, work_logged_unsigned from pm.v_res_co_exposure where id = $1`, [ids.fco]);
    expect(ex).toEqual({ exposure_state: 'unpriced', work_logged_unsigned: true });
  });

  it('PM prices from lines, the homeowner fast-signs on the tablet, the engine approves', async () => {
    const pr = await call<{ amount_cents: number; cost_impact_cents: number }>('pm',
      `select pm.res_price_change_order($1, '[{"description":"Replace subfloor","qty":40,"unit_cost_cents":900,"markup_pct":0.5},{"description":"Labor","qty":6,"unit_cost_cents":5000,"markup_pct":0.5}]'::jsonb, 1) as r`, [ids.fco]);
    expect([pr.cost_impact_cents, pr.amount_cents]).toEqual([66000, 99000]);
    const s = await call<{ state: string }>('pm', `select pm.res_record_co_signature($1, 'Pat Smith', 'IN_PERSON') as r`, [ids.fco]);
    const stage = (await one<{ stage: string }>(`select stage from pm.change_orders where id = $1`, [ids.fco])).stage;
    expect(s.state).toBe(stage === 'APPROVED' ? 'approved' : 'awaiting_internal_approval');
    expect(['APPROVED', 'COR']).toContain(stage);
    const sum = await call<{ open: number; pending_value_cents: number | null }>('pm', `select pm.res_co_exposure_summary($1) as r`, [L1]);
    expect(sum.open).toBeGreaterThanOrEqual(0);
  });

  it('no-charge internal CO keeps price 0 and records the cost and reason', async () => {
    const id = await call<string>('pm', `select pm.res_create_internal_co($1, 'Wrong vanity ordered', 'BUILDER_ERROR', 45000) as r`, [J1]);
    const co = await one<{ amount_cents: string; cost_impact_cents: string; co_type: string; reason_code: string }>(`select amount_cents, cost_impact_cents, co_type, reason_code from pm.change_orders where id = $1`, [id]);
    expect([Number(co.amount_cents), Number(co.cost_impact_cents), co.co_type, co.reason_code]).toEqual([0, 45000, 'NO_CHARGE', 'BUILDER_ERROR']);
    expect(await fails('supervisor', `select pm.res_create_internal_co($1, 'x', 'GOODWILL', 1)`, [J1])).toMatch(forbidden);
  });
});

describe('trade partners', () => {
  it('assign → text with a one-time link → the trade proposes a date (anon, token only); unconfirmed inside 72 h is red', async () => {
    const t = await one<{ id: string }>(`select id from pm.tasks where job_id = $1 and template_ref = 'kitchen_remodel:plumbing_rough'`, [ids.pjob]);
    const token = 'trade-token-aaaaaaaaaaaaaaaaaaaaaaaa1';
    const r = await call<{ task_trade_id: string; contact_id: string }>('gm', `select pm.res_assign_trade($1, $2, null, $3, 'https://app.test/t/x') as r`, [t.id, ids.vendor2, sha(token)]);
    expect(r.contact_id).toBe(ids.vcontact);
    expect((await one<{ n: number }>(`select count(*)::int n from core.outbound_messages where event_type = 'trade.schedule_request'`)).n).toBe(1);
    // anon: view + propose
    await f.db.exec('set role anon');
    try {
      const v = (await q<{ r: { ok: boolean; task: string } }>(f.db, `select public.res_trade_respond($1, 'VIEW') as r`, [token]))[0]!.r;
      expect(v).toMatchObject({ ok: true, task: 'Plumbing rough-in' });
      const bad = (await q<{ r: { ok: boolean } }>(f.db, `select public.res_trade_respond('wrong-token-xxxxxxxxxxxxxxxx', 'CONFIRM') as r`))[0]!.r;
      expect(bad.ok).toBe(false);
      const p = (await q<{ r: { ok: boolean; status: string } }>(f.db, `select public.res_trade_respond($1, 'PROPOSE', current_date + 30, 'Booked that week') as r`, [token]))[0]!.r;
      expect(p).toEqual({ ok: true, status: 'PROPOSED' });
      expect(await errorOf(f.db, `select pm.res_send_proposal($1)`, [ids.proposal])).toMatch(/permission denied/);
    } finally {
      await f.db.exec('reset role');
    }
    // a J1 task starting tomorrow, assigned but unconfirmed → at risk
    const t2 = (await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, start_on, duration_days, status) values ($1, $2, 'Set tub', current_date + 1, 1, 'TODO') returning id`, [ORG_A, J1])).id;
    await call('pm', `select pm.res_assign_trade($1, $2) as r`, [t2, ids.vendor2]);
    expect((await one<{ at_risk: boolean }>(`select at_risk from pm.v_res_trade_confirmations where task_id = $1`, [t2])).at_risk).toBe(true);
    // an answer given in the sub portal (1118) mirrors onto the confirmation
    if ((await one<{ t: string | null }>(`select to_regclass('pm.portal_task_responses')::text as t`)).t) {
      await f.db.query(`insert into pm.portal_task_responses (org_id, job_id, task_id, vendor_id, response, resolution, resolved_at, resolved_by)
                        values ($1, $2, $3, $4, 'confirmed', 'noted', now(), 'portal')`, [ORG_A, J1, t2, ids.vendor2]);
      expect((await one<{ status: string; at_risk: boolean }>(`select status, at_risk from pm.v_res_trade_confirmations where task_id = $1`, [t2]))).toEqual({ status: 'CONFIRMED', at_risk: false });
    }
  });

  it('bid package → two trades price by line through their links → leveling flags the gap → award becomes a subcontract', async () => {
    ids.pkg = (await one<{ id: string }>(`insert into pm.res_bid_packages (org_id, job_id, title, scope, cost_code_id) values ($1, $2, 'Plumbing', 'Rough + trim', $3) returning id`, [ORG_A, J1, ids.cc])).id;
    const l1 = (await one<{ id: string }>(`insert into pm.res_bid_package_lines (org_id, package_id, description, sort) values ($1, $2, 'Rough-in', 1) returning id`, [ORG_A, ids.pkg])).id;
    const l2 = (await one<{ id: string }>(`insert into pm.res_bid_package_lines (org_id, package_id, description, sort) values ($1, $2, 'Trim', 2) returning id`, [ORG_A, ids.pkg])).id;
    const tA = 'bid-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'; const tB = 'bid-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const iA = await call<string>('pm', `select pm.res_invite_bidder($1, $2, null, $3, 'https://app.test/b/a') as r`, [ids.pkg, ids.vendor2, sha(tA)]);
    await call<string>('pm', `select pm.res_invite_bidder($1, $2, null, $3, 'https://app.test/b/b') as r`, [ids.pkg, ids.vendor3, sha(tB)]);
    await f.db.exec('set role anon');
    try {
      const view = (await q<{ r: { ok: boolean; lines: unknown[]; status: string } }>(f.db, `select public.res_bid_portal($1) as r`, [tA]))[0]!.r;
      expect(view.lines.length).toBe(2);
      expect(view.status).toBe('INVITED');            // a GET (view) writes nothing (security review LOW)
      expect((await q<{ r: { status: string } }>(f.db, `select public.res_bid_portal($1, 'open') as r`, [tA]))[0]!.r.status).toBe('VIEWED');
      const a = (await q<{ r: { total_cents: number } }>(f.db, `select public.res_bid_portal($1, 'submit', $2::jsonb) as r`,
        [tA, JSON.stringify({ prices: [{ line_id: l1, amount_cents: 420000 }, { line_id: l2, amount_cents: 180000 }] })]))[0]!.r;
      expect(a.total_cents).toBe(600000);
      await q(f.db, `select public.res_bid_portal($1, 'submit', $2::jsonb) as r`, [tB, JSON.stringify({ prices: [{ line_id: l1, amount_cents: 390000 }], exclusions: 'Trim by others' })]);
    } finally {
      await f.db.exec('reset role');
    }
    // once leveling starts, no late bid, revision or decline is taken
    expect(await fails('labor', `select pm.res_start_leveling($1)`, [ids.pkg])).toMatch(forbidden);
    expect(await call<string>('pm', `select pm.res_start_leveling($1) as r`, [ids.pkg])).toBe('LEVELING');
    await f.db.exec('set role anon');
    try {
      const late = (await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_bid_portal($1, 'submit', $2::jsonb) as r`,
        [tB, JSON.stringify({ prices: [{ line_id: l1, amount_cents: 100 }] })]))[0]!.r;
      expect(late).toEqual({ ok: false, reason: 'closed' });
      expect((await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_bid_portal($1, 'decline') as r`, [tA]))[0]!.r.reason).toBe('closed');
    } finally {
      await f.db.exec('reset role');
    }
    expect(Number((await one<{ t: string }>(`select total_cents::text t from pm.res_bid_invites where token_hash = $1`, [sha(tB)])).t)).toBe(390000);
    const lev = await call<{ lines: Array<{ line_id: string; low_cents: number; gap: boolean }>; bidders: Array<{ missing_lines: number }> }>('pm', `select pm.res_bid_leveling($1) as r`, [ids.pkg]);
    expect(lev.lines.find((x) => x.line_id === l1)!.low_cents).toBe(390000);
    expect(lev.lines.find((x) => x.line_id === l2)!.gap).toBe(true);
    expect(lev.bidders.map((b) => b.missing_lines).sort()).toEqual([0, 1]);
    ids.sub = await call<string>('gm', `select pm.res_award_bid($1) as r`, [iA]);
    const c = await one<{ commitment_type: string; status: string; total: string }>(`select commitment_type, status, (select sum(amount_cents) from pm.commitment_lines where commitment_id = c.id)::text total from pm.commitments c where id = $1`, [ids.sub]);
    expect([c.commitment_type, c.status, Number(c.total)]).toEqual(['SUBCONTRACT', 'DRAFT', 600000]);
  });

  it('trade invoice: the preparer never approves it; an overage is a commitment change decided in the approvals engine; the compliance gate holds payment', async () => {
    const d = await call<{ status: string }>('pm', `select pm.approval_decide('commitment', $1, 'approve', null, null, null, 'web') as r`, [ids.sub]);
    if ((await one<{ status: string }>(`select status from pm.commitments where id = $1`, [ids.sub])).status !== 'APPROVED') {
      expect(d.status).not.toBe('approved');
      await f.db.query(`update pm.commitments set status = 'APPROVED', approved_at = now() where id = $1`, [ids.sub]);   // service: the chain's next approver
    }
    const line = (await one<{ id: string }>(`select id from pm.commitment_lines where commitment_id = $1 and description = 'Rough-in'`, [ids.sub])).id;
    const inv = await call<{ invoice_id: string; status: string; variances: Array<{ kind: string; over_cents?: number }> }>('pm',
      `select pm.res_submit_trade_invoice($1, 'HP-1001', current_date, 450000, $2::jsonb) as r`, [ids.sub, JSON.stringify([{ commitment_line_id: line, amount_cents: 450000 }])]);
    expect(inv.status).toBe('VARIANCE');
    expect(inv.variances.find((v) => v.kind === 'over_line')!.over_cents).toBe(30000);
    expect((await one<{ entered_by: string }>(`select entered_by from pm.res_trade_invoices where id = $1`, [inv.invoice_id])).entered_by).toBe(f.clerk.pm);
    // HIGH: the person who entered it cannot approve it (the old "accept variance" switch is gone)
    expect(await fails('pm', `select pm.res_approve_trade_invoice($1)`, [inv.invoice_id])).toMatch(/PM_SOD_VIOLATION/);
    expect(await fails('pm', `select pm.res_approve_trade_invoice($1, true)`, [inv.invoice_id])).toMatch(/PM_SOD_VIOLATION|does not exist/);
    expect(await fails('supervisor', `select pm.res_approve_trade_invoice($1)`, [inv.invoice_id])).toMatch(forbidden);
    await f.db.query(`insert into pm.compliance_docs (org_id, job_id, commitment_id, vendor_id, doc_type, status, expires_on) values ($1, $2, $3, $4, 'COI', 'RECEIVED', current_date - 1)`,
      [ORG_A, J1, ids.sub, ids.vendor2]);
    // a different approver: the 30,000 overage becomes a commitment change prepared by the invoice's
    // preparer and decided through pm.approval_decide; once approved the line is raised and the
    // invoice re-matches clean — then the compliance gate holds it for the expired COI
    const held = await call<{ status: string; reasons: string[]; change_ids?: string[] }>('gm', `select pm.res_approve_trade_invoice($1, 'Extra rough-in for the moved sink') as r`, [inv.invoice_id]);
    expect(held.status).toBe('HELD');
    expect(held.reasons.join(' ')).toMatch(/insurance/);
    const cc = await one<{ status: string; amount_cents: string; created_by: string; approved_by: string; line: string }>(
      `select x.status, x.amount_cents::text, x.created_by, x.approved_by, (select amount_cents::text from pm.commitment_lines where id = x.commitment_line_id) line
         from pm.commitment_changes x where x.id = (select variance_change_ids[1] from pm.res_trade_invoices where id = $1)`, [inv.invoice_id]);
    expect([cc.status, Number(cc.amount_cents), cc.created_by, cc.approved_by, Number(cc.line)]).toEqual(['APPROVED', 30000, f.clerk.pm, f.clerk.gm, 450000]);
    if ((await one<{ n: string }>(`select count(*)::text n from pm.approval_settings where location_id = $1`, [L1])).n !== '0') {
      expect(Number((await one<{ n: string }>(`select count(*)::text n from pm.approval_requests where object_type = 'commitment_change'`)).n)).toBeGreaterThan(0);
    }
    await f.db.query(`update pm.compliance_docs set expires_on = current_date + 300 where commitment_id = $1`, [ids.sub]);
    const ok = await call<{ status: string }>('gm', `select pm.res_approve_trade_invoice($1) as r`, [inv.invoice_id]);
    expect(ok.status).toBe('APPROVED');
    expect((await one<{ approved_by: string; variances: unknown[] }>(`select approved_by, variances from pm.res_trade_invoices where id = $1`, [inv.invoice_id]))).toEqual({ approved_by: f.clerk.gm, variances: [] });
    // hard variances are never approvable: a line that matches nothing on the PO
    const bad = await call<{ invoice_id: string; status: string }>('pm', `select pm.res_submit_trade_invoice($1, 'HP-1002', current_date, 5000, $2::jsonb) as r`,
      [ids.sub, JSON.stringify([{ description: 'Trip charge', amount_cents: 5000 }])]);
    expect(await fails('gm', `select pm.res_approve_trade_invoice($1)`, [bad.invoice_id])).toMatch(/PM_RES_INVOICE_VARIANCE.*matches no PO line/);
    expect((await call<{ status: string }>('gm', `select pm.res_reject_trade_invoice($1, 'Trip charge is not in the subcontract') as r`, [bad.invoice_id])).status).toBe('REJECTED');
  });

  it('PO accept links expire; public links are rate-limited per client and per link', async () => {
    const tok = 'po-token-cccccccccccccccccccccccccccc';
    await call('pm', `select pm.res_send_po_to_trade($1, $2) as r`, [ids.sub, sha(tok)]);
    await f.db.exec('set role anon');
    try {
      expect((await q<{ r: { ok: boolean } }>(f.db, `select public.res_po_accept($1, 'view', null, 'po-test') as r`, [tok]))[0]!.r.ok).toBe(true);
    } finally { await f.db.exec('reset role'); }
    await f.db.query(`update pm.commitments set trade_accept_expires_at = now() - interval '1 minute' where id = $1`, [ids.sub]);
    await f.db.exec('set role anon');
    try {
      expect((await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_po_accept($1, 'accept', 'Dale', 'po-test') as r`, [tok]))[0]!.r).toEqual({ ok: false, reason: 'expired' });
      // failed lookups: 30 per client per hour, then refused even before the lookup result matters
      let last = { ok: true, reason: '' };
      for (let i = 0; i < 31; i++) last = (await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_trade_respond($1, 'VIEW', null, null, 'brute-1') as r`, [`guess-${i}-xxxxxxxxxxxxxxxxxxxxxxx`]))[0]!.r;
      expect(last).toEqual({ ok: false, reason: 'rate_limited' });
      // a different client is unaffected
      expect((await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_trade_respond('guess-other-xxxxxxxxxxxxxxxxxx', 'VIEW', null, null, 'brute-2') as r`))[0]!.r.reason).toBe('expired');
      // one link: 60 calls an hour
      const t = 'bid-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      let r = { ok: true, reason: '' };
      for (let i = 0; i < 61 && r.reason !== 'rate_limited'; i++) r = (await q<{ r: { ok: boolean; reason: string } }>(f.db, `select public.res_bid_portal($1, 'view', '{}', $2) as r`, [t, `cli-${i}`]))[0]!.r;
      expect(r.reason).toBe('rate_limited');
      // anon reads no counters
      expect(await errorOf(f.db, `select count(*) from pm.res_rate_counters`)).toMatch(/permission denied/);
    } finally { await f.db.exec('reset role'); }
    // the overall cap counts every call whatever p_client the caller claimed (a direct anon RPC can vary it)
    const all = await one<{ n: string }>(`select coalesce(sum(hits), 0)::text n from pm.res_rate_counters where bucket = 'res:all'`);
    expect(Number(all.n)).toBeGreaterThanOrEqual(90);
    expect(Number((await one<{ n: string }>(`select count(*)::text n from pm.res_rate_counters where bucket like 'res:cli:%'`)).n)).toBeGreaterThan(60);
  });

  it('a customer-signed change order is approved without a chain only by someone holding change_orders:approve', async () => {
    const co = await call<string>('pm', `select pm.res_request_field_co($1, 'Sister two joists', null, null, '{}', null, true, false, 'Kitchen') as r`, [J1]);
    await call('pm', `select pm.res_price_change_order($1, $2::jsonb, null) as r`, [co, JSON.stringify([{ description: 'Sister joists', qty: 2, unit_cost_cents: 15000 }])]);
    await f.db.query(`create temp table saved_settings as select * from pm.approval_settings where location_id = $1`, [L1]);
    await f.db.query(`delete from pm.approval_settings where location_id = $1`, [L1]);
    await f.db.query(`grant execute on function pm._res_customer_signed_co(uuid, text) to authenticated`);
    const nested = (p: Persona) => as(f, p, async () => {
      await f.db.exec('begin');
      try {
        await f.db.query(`select set_config('pm.access_entry', 'on', true)`);   // as inside another guarded call
        return (await q<{ r: string }>(f.db, `select pm._res_customer_signed_co($1, 'Signed on the tablet') as r`, [co]))[0]!.r;
      } finally { await f.db.exec('commit'); }
    });
    try {
      expect(await nested('accountant')).toBe('awaiting_internal_approval');
      expect((await one<{ stage: string }>(`select stage from pm.change_orders where id = $1`, [co])).stage).not.toBe('APPROVED');
      expect(await nested('gm')).toBe('approved');
      expect((await one<{ stage: string }>(`select stage from pm.change_orders where id = $1`, [co])).stage).toBe('APPROVED');
    } finally {
      await f.db.query(`revoke execute on function pm._res_customer_signed_co(uuid, text) from authenticated`);
      await f.db.query(`insert into pm.approval_settings select * from saved_settings on conflict do nothing`);
      await f.db.query(`drop table saved_settings`);
    }
  });
});

describe('billing', () => {
  it('a finished schedule task drafts its payment milestone; a missing completion photo holds it', async () => {
    const demo = await one<{ id: string }>(`select id from pm.tasks where job_id = $1 and template_ref = 'kitchen_remodel:demolition'`, [ids.pjob]);
    await as(f, 'gm', async () => { await q(f.db, `update pm.tasks set status = 'DONE' where id = $1`, [demo.id]); });
    const m = await one<{ status: string; billing_request_id: string; amount_cents: string; added_cents: string }>(
      `select status, billing_request_id, amount_cents, added_cents from pm.res_payment_schedule where proposal_id = $1 and seq = 2`, [ids.proposal]);
    expect(m.status).toBe('DRAFTED');
    const br = await one<{ status: string; net: string }>(`select status, (select sum(amount_cents) from pm.billing_request_lines where billing_request_id = r.id)::text net from pm.billing_requests r where id = $1`, [m.billing_request_id]);
    expect(br.status).toBe('DRAFT');
    expect(Number(br.net)).toBe(Number(m.amount_cents) + Number(m.added_cents));   // the floor overage rode along
    const tops = await one<{ id: string }>(`select id from pm.tasks where job_id = $1 and template_ref = 'kitchen_remodel:install_tops'`, [ids.pjob]);
    await as(f, 'gm', async () => { await q(f.db, `update pm.tasks set status = 'DONE' where id = $1`, [tops.id]); });
    const h = await one<{ status: string; hold_reason: string; id: string }>(`select id, status, hold_reason from pm.res_payment_schedule where proposal_id = $1 and trigger_ref = 'install_tops'`, [ids.proposal]);
    expect(h.status).toBe('HELD');
    expect(h.hold_reason).toMatch(/photo/);
    expect(await fails('gm', `select pm.res_release_milestone($1, 'ok')`, [h.id])).toMatch(/say why/);
    expect(await call<string>('gm', `select pm.res_release_milestone($1, 'Photos are in the homeowner''s text thread') as r`, [h.id])).toBeTruthy();
  });

  it('cost-plus: posted costs + fee, each cost billed once, with backup', async () => {
    await f.db.query(`insert into pm.res_job_terms (org_id, job_id, contract_type, fee_pct) values ($1, $2, 'COST_PLUS_PCT', 0.15)
                      on conflict (org_id, job_id) do update set contract_type = 'COST_PLUS_PCT', fee_pct = 0.15`, [ORG_A, J1]);
    for (const [ref, amt] of [['bill:1', 120000], ['bill:2', 80050]] as const) {
      await f.db.query(`insert into pm.job_costs (org_id, job_id, source_ref, cost_type, amount_cents, lifecycle, occurred_on, cost_code_id, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
                        values ($1, $2, $3, 'MATERIALS', $4, 'CLEARED', current_date, $5, gen_random_uuid(), now(), 2, now())`, [ORG_A, J1, ref, amt, ids.cc]);
    }
    const r = await call<{ cost_cents: number; fee_cents: number; backup: unknown[] }>('pm', `select pm.res_generate_cost_plus_billing($1) as r`, [J1]);
    expect([r.cost_cents, r.fee_cents, r.backup.length]).toEqual([200050, 30008, 2]);
    expect(await fails('pm', `select pm.res_generate_cost_plus_billing($1)`, [J1])).toMatch(/PM_RES_NOTHING_TO_BILL/);
  });

  it('the integrity scan and the decision queue answer for the job', async () => {
    const scan = await call<Array<{ kind: string }>>('gm', `select pm.res_billing_integrity($1) as r`, [L1]);
    expect(Array.isArray(scan)).toBe(true);
    const qd = await call<Array<{ kind: string }>>('gm', `select pm.res_decision_queue($1) as r`, [ids.pjob]);
    expect(qd.some((x) => x.kind === 'selection')).toBe(true);
  });
});

describe('home builder', () => {
  beforeAll(async () => {
    const db = f.db;
    ids.comm = (await one<{ id: string }>(`insert into pm.res_communities (org_id, location_id, code, name) values ($1, $2, 'PRAIRIE', 'Prairie Ridge') returning id`, [ORG_A, L1])).id;
    ids.plan = (await one<{ id: string }>(`insert into pm.res_plans (org_id, location_id, code, name, base_cost_cents, target_margin_pct, standard_cycle_days, schedule_template_key, job_type_key)
                                           values ($1, $2, 'ASPEN', 'The Aspen', 28000000, 0.22, 120, 'custom_home', 'build') returning id`, [ORG_A, L1])).id;
    await db.query(`insert into pm.res_plan_prices (org_id, plan_id, community_id, base_price_cents) values ($1, $2, $3, 39900000)`, [ORG_A, ids.plan, ids.comm]);
    ids.elev = (await one<{ id: string }>(`insert into pm.res_elevations (org_id, plan_id, code, name, premium_cents) values ($1, $2, 'B', 'Craftsman', 850000) returning id`, [ORG_A, ids.plan])).id;
    ids.optBsmt = (await one<{ id: string }>(`insert into pm.res_options (org_id, location_id, code, name, cutoff_stage, is_structural, cost_cents) values ($1, $2, 'BSMT', 'Finished basement', 'PRE_FRAME', true, 2500000) returning id`, [ORG_A, L1])).id;
    ids.optTile = (await one<{ id: string }>(`insert into pm.res_options (org_id, location_id, code, name, cutoff_stage, cost_cents) values ($1, $2, 'TILE', 'Tile shower upgrade', 'PRE_DRYWALL', 300000) returning id`, [ORG_A, L1])).id;
    ids.optTub = (await one<{ id: string }>(`insert into pm.res_options (org_id, location_id, code, name, cutoff_stage, excludes) values ($1, $2, 'TUB', 'Soaking tub', 'PRE_DRYWALL', $3) returning id`, [ORG_A, L1, [ids.optTile]])).id;
    await db.query(`insert into pm.res_option_prices (org_id, option_id, price_cents) values ($1, $2, 4500000), ($1, $3, 650000), ($1, $4, 300000)`, [ORG_A, ids.optBsmt, ids.optTile, ids.optTub]);
    ids.lot = (await one<{ id: string }>(`insert into pm.res_lots (org_id, location_id, community_id, lot_number, block, status, premium_cents, land_cost_cents) values ($1, $2, $3, '14', 'A', 'AVAILABLE', 1500000, 6000000) returning id`, [ORG_A, L1, ids.comm])).id;
    await db.query(`insert into pm.res_price_agreements (org_id, location_id, vendor_id, plan_id, cost_code_id, scope, amount_cents, release_stage) values
                      ($1, $2, $3, $4, $5, 'Framing labor — Aspen', 2100000, 'START'), ($1, $2, $6, $4, $5, 'Plumbing — Aspen', 1450000, 'MECHANICAL')`,
      [ORG_A, L1, ids.vendor, ids.plan, ids.cc, ids.vendor2]);
    await db.query(`insert into pm.res_price_agreements (org_id, location_id, vendor_id, option_id, cost_code_id, scope, amount_cents, release_stage) values ($1, $2, $3, $4, $5, 'Tile shower upgrade', 280000, 'TRIM')`,
      [ORG_A, L1, ids.vendor3, ids.optTile, ids.cc]);
    ids.buyer = (await one<{ id: string }>(`insert into core.customers (org_id, name, location_id) values ($1, 'Jordan Lee', $2) returning id`, [ORG_A, L1])).id;
  });

  it('the price book quotes plan + elevation + lot premium + options and enforces exclusions; margin only with financials', async () => {
    const q1 = await call<{ total_cents: number; issues: string[]; margin_pct: number | null }>('gm', `select pm.res_quote_lot($1, $2, $3, $4) as r`, [ids.lot, ids.plan, ids.elev, [ids.optTile]]);
    expect(q1.issues).toEqual([]);
    expect(q1.total_cents).toBe(39900000 + 850000 + 1500000 + 650000);
    expect(q1.margin_pct).not.toBeNull();
    const q2 = await call<{ issues: string[] }>('gm', `select pm.res_quote_lot($1, $2, null, $3) as r`, [ids.lot, ids.plan, [ids.optTile, ids.optTub]]);
    expect(q2.issues.join(' ')).toMatch(/cannot be combined/);
  });

  it('purchase agreement → signed: house job + contract = PA total, earnest-money deposit, lot sold', async () => {
    ids.pa = await call<string>('gm', `select pm.res_create_purchase_agreement($1, $2, $3, $4, $5, '{"earnest_money_cents": 1000000}'::jsonb) as r`,
      [ids.lot, ids.buyer, ids.plan, ids.elev, [ids.optTile]]);
    const s = await call<{ job_id: string; deposit_request_id: string; total_cents: number }>('gm', `select pm.res_sign_purchase_agreement($1, 'Jordan Lee') as r`, [ids.pa]);
    ids.lotJob = s.job_id;
    expect(Number((await one<{ original_cents: string }>(`select original_cents from pm.contracts where job_id = $1`, [s.job_id])).original_cents)).toBe(s.total_cents);
    expect(Number((await one<{ a: string }>(`select amount_cents::text a from pm.deposit_requests where id = $1`, [s.deposit_request_id])).a)).toBe(1000000);
    expect((await one<{ status: string; job_id: string }>(`select status, job_id from pm.res_lots where id = $1`, [ids.lot]))).toEqual({ status: 'SOLD', job_id: s.job_id });
    // members cannot hand-move a sold lot
    expect(await fails('gm', `update pm.res_lots set status = 'AVAILABLE' where id = $1`, [ids.lot])).toMatch(/PM_RES_LOT_STATE/);
  });

  it('release: schedule, start package POs by stage (START released), options without a price agreement flagged', async () => {
    const r = await call<{ package: { added: unknown[] }; released: Array<{ status: string }>; options_without_price_agreement: unknown[] }>('gm',
      `select pm.res_release_lot($1, current_date) as r`, [ids.lot]);
    expect(r.package.added.length).toBe(3);
    expect(r.released.length).toBe(1);
    const items = await q<{ release_stage: string; status: string }>(f.db, `select release_stage, status from pm.res_start_package_items where lot_id = $1 order by release_stage`, [ids.lot]);
    expect(items.map((i) => `${i.release_stage}:${i.status}`)).toEqual(['MECHANICAL:HELD', 'START:RELEASED', 'TRIM:HELD']);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.tasks where job_id = $1 and template_ref like 'custom_home:%'`, [ids.lotJob])).n).toBeGreaterThan(100);
  });

  it('design center: structural after its cutoff is refused; a finish option late carries the fee and regenerates the package', async () => {
    await f.db.query(`update pm.tasks set status = 'IN_PROGRESS' where id = (select id from pm.tasks where job_id = $1 and title ~* 'fram' and not is_summary order by sort limit 1)`, [ids.lotJob]);
    expect(await fails('gm', `select pm.res_pa_change_options($1, $2, '{}', 'Jordan Lee')`, [ids.pa, [ids.optBsmt]])).toMatch(/PM_RES_CUTOFF_PASSED/);
    const rm = await call<{ change_cents: number; late_fee_cents: number; signed: boolean }>('gm', `select pm.res_pa_change_options($1, '{}', $2, 'Jordan Lee') as r`, [ids.pa, [ids.optTile]]);
    expect([rm.change_cents, rm.signed]).toEqual([-650000, true]);
    expect((await one<{ status: string }>(`select status from pm.res_start_package_items where lot_id = $1 and release_stage = 'TRIM'`, [ids.lot])).status).toBe('VOID');
    const pa = await one<{ total_cents: string; options_cents: string }>(`select total_cents, options_cents from pm.res_purchase_agreements where id = $1`, [ids.pa]);
    expect(Number(pa.options_cents)).toBe(0);
    expect((await one<{ original_cents: string }>(`select original_cents from pm.contracts where job_id = $1`, [ids.lotJob])).original_cents).toBe(pa.total_cents);
  });

  it('VPO with reason code and chargeback; starts board shows the lot; closing gates on the checklist and schedules warranty walks', async () => {
    const v = await call<{ vpo_id: string; commitment_id: string }>('supervisor', `select pm.res_create_vpo($1, $2, 'DAMAGE_THEFT', 42000, 'Replace damaged window', $3, $4) as r`,
      [ids.lotJob, ids.vendor, ids.cc, ids.vendor2]).catch(async () =>
      call<{ vpo_id: string; commitment_id: string }>('gm', `select pm.res_create_vpo($1, $2, 'DAMAGE_THEFT', 42000, 'Replace damaged window', $3, $4) as r`, [ids.lotJob, ids.vendor, ids.cc, ids.vendor2]));
    expect((await one<{ vpo_reason: string }>(`select vpo_reason from pm.commitments where id = $1`, [v.commitment_id])).vpo_reason).toBe('DAMAGE_THEFT');
    const board = await as(f, 'gm', async () => q<{ lot_number: string; cycle_days: number; standard_cycle_days: number }>(f.db, `select lot_number, cycle_days, standard_cycle_days from pm.v_res_starts_board where lot_id = $1`, [ids.lot]));
    expect(board[0]).toMatchObject({ lot_number: '14', standard_cycle_days: 120 });
    const closing = await call<string>('gm', `select pm.res_open_closing($1, current_date + 1, 'Iowa Title') as r`, [ids.lotJob]);
    expect(await fails('gm', `select pm.res_close($1)`, [closing])).toMatch(/PM_RES_CLOSING_NOT_READY/);
    const ins = (await one<{ id: string }>(`insert into pm.res_inspections (org_id, job_id, kind) values ($1, $2, 'FINAL') returning id`, [ORG_A, ids.lotJob])).id;
    await call('gm', `select pm.res_record_inspection($1, 'PASS') as r`, [ins]);
    const walk = await call<string>('gm', `select pm.res_plan_walk($1, 'ORIENTATION') as r`, [ids.lotJob]);
    await call('gm', `select pm.res_complete_walk($1, '[]'::jsonb, 'Jordan Lee') as r`, [walk]);
    await f.db.query(`update pm.res_closings set settlement = '{"sale_price_cents": 41700000}'::jsonb,
                        checklist = (select jsonb_agg(x || '{"done": true}'::jsonb) from jsonb_array_elements(checklist) x) where id = $1`, [closing]);
    const c = await call<{ warranty_walks: number }>('gm', `select pm.res_close($1) as r`, [closing]);
    expect(c.warranty_walks).toBe(3);
    expect((await one<{ status: string }>(`select status from pm.res_lots where id = $1`, [ids.lot])).status).toBe('CLOSED');
    const walks = await q<{ kind: string; due_on: string }>(f.db, `select kind, (due_on - current_date)::int as due_on from pm.res_walks where job_id = $1 and kind like 'WARRANTY%' order by due_on`, [ids.lotJob]);
    expect(walks.map((w) => w.kind)).toEqual(['WARRANTY_30', 'WARRANTY_11M', 'WARRANTY_2Y']);
  });

  it('a failed inspection blocks its task and opens the re-inspection', async () => {
    const t = (await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, status) values ($1, $2, 'Insulation', 'TODO') returning id`, [ORG_A, J1])).id;
    const ins = (await one<{ id: string }>(`insert into pm.res_inspections (org_id, job_id, kind, task_id) values ($1, $2, 'FRAMING', $3) returning id`, [ORG_A, J1, t])).id;
    const r = await call<{ reinspection_id: string }>('pm', `select pm.res_record_inspection($1, 'FAIL', current_date, 'City', 'Missing blocking') as r`, [ins]);
    expect(r.reinspection_id).toBeTruthy();
    expect((await one<{ status: string }>(`select status from pm.tasks where id = $1`, [t])).status).toBe('BLOCKED');
    expect(await fails('pm', `update pm.res_inspections set result = 'PASS' where id = $1`, [r.reinspection_id])).toMatch(/PM_RES_INSPECTION_RESULT/);
  });
});

describe('remodeler records', () => {
  it('a pre-1978 home opens an RRP record that completes only with every verification', async () => {
    await as(f, 'pm', async () => { await q(f.db, `insert into pm.res_home_profiles (org_id, job_id, year_built, lockbox_code, pets) values ($1, $2, 1962, '4417', 'Dog in back room')
                                                    on conflict (org_id, job_id) do update set year_built = 1962, lockbox_code = '4417', pets = 'Dog in back room'`, [ORG_A, J1]); });
    const r = await one<{ status: string; required: boolean }>(`select status, required from pm.res_rrp_records where job_id = $1`, [J1]);
    expect(r).toEqual({ status: 'OPEN', required: true });
    await as(f, 'pm', async () => { await q(f.db, `update pm.res_rrp_records set renovator_name = 'Sam', renovator_cert_number = 'NAT-F123', pamphlet_ack_at = now(),
                                                    containment_verified_at = now(), cleaning_verified_at = now(), cleaning_card_result = 'PASS' where job_id = $1`, [J1]); });
    const done = await one<{ status: string; years: number }>(`select status, extract(year from age(retain_until, current_date))::int as years from pm.res_rrp_records where job_id = $1`, [J1]);
    expect(done.status).toBe('COMPLETE');
    expect(done.years).toBeGreaterThanOrEqual(2);
    // the crew sees the occupied-home profile, not the payment schedule
    expect((await as(f, 'supervisor', async () => q<{ lockbox_code: string }>(f.db, `select lockbox_code from pm.res_home_profiles where job_id = $1`, [J1])))[0]!.lockbox_code).toBe('4417');
    expect((await as(f, 'supervisor', async () => q(f.db, `select id from pm.res_payment_schedule where job_id = $1`, [J1]))).length).toBe(0);
  });

  it('day-1 containment passes only with every item and a photo', async () => {
    const c = await call<string>('supervisor', `select pm.res_start_protection_check($1, 'DAY1_CONTAINMENT') as r`, [J1]);
    const keys = ['zipwall', 'floor', 'hvac', 'negative_air', 'path', 'valuables'];
    expect((await call<{ status: string }>('supervisor', `select pm.res_complete_protection_check($1, $2) as r`, [c, keys])).status).toBe('FAILED');
    const doc = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type) values ($1, 'x/p.jpg', 'p.jpg', 'image/jpeg', 10, 'OTHER') returning id`, [ORG_A])).id;
    expect((await call<{ status: string }>('supervisor', `select pm.res_complete_protection_check($1, $2, $3) as r`, [c, keys, [doc]])).status).toBe('PASSED');
  });

  it('cabinet → counter chain re-plans from the template date', async () => {
    const ch = await call<string>('pm', `select pm.res_create_chain($1) as r`, [J1]);
    const tpl = await one<{ id: string }>(`select id from pm.res_chain_steps where chain_id = $1 and step_key = 'counter_template'`, [ch]);
    const r = await call<{ steps: Array<{ step_key: string; planned_on: string }> }>('pm', `select pm.res_advance_chain_step($1, '2027-03-01') as r`, [tpl.id]);
    const inst = r.steps.find((s) => s.step_key === 'counter_install')!;
    expect(inst.planned_on).toBe('2027-03-09');   // template + 7 days fabrication + 1 day install
  });

  it('a walkthrough turns items into punch and records acceptance', async () => {
    const w = await call<string>('pm', `select pm.res_plan_walk($1, 'FINAL_WALKTHROUGH') as r`, [J1]);
    const r = await call<{ punch_created: number }>('pm', `select pm.res_complete_walk($1, '[{"title":"Touch up paint by window","location":"Kitchen"},{"title":"Adjust pantry door"}]'::jsonb, 'Pat Smith') as r`, [w]);
    expect(r.punch_created).toBe(2);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.punch_items where job_id = $1 and ext ->> 'walk_id' = $2`, [J1, w])).n).toBe(2);
  });
});

describe('idempotency', () => {
  it('1119 applies a second time without error and changes no rows', async () => {
    const count = async () => (await one<{ n: string }>(`select (select count(*) from pm.res_proposals) + (select count(*) from pm.res_lots) + (select count(*) from pm.selections)
                                                          + (select count(*) from pm.res_state_rules) + (select count(*) from pm.access_rpc_guards) as n`)).n;
    const before = await count();
    await applyMigration(f.db, listMigrationFiles().find((x) => x.startsWith('1119_'))!);
    expect(await count()).toBe(before);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
  });
});
