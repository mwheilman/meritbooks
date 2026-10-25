/**
 * Commercial depth (migration 1120) against a PGlite replay of every migration: the change chain
 * (change event → RFQ → PCO → prime CO → commitment COs, exposure), pay apps right the first time
 * (CO → SOV, step-downs, stored materials, pencil → certified → final, revise), sub pay apps with
 * the approval chain, lien waivers / COI holds on JOB_COMMITMENT, T&M → billing, EAC → JOB_PROGRESS,
 * WIP (live and Books-pinned), document control, field logs, quality, safety, productivity,
 * templates, proposals, the close gate, the inbox, and money masking per persona.
 * The SQL math is checked against the browser mirror (apps/projects/src/lib/commercial).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, J1, J2 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';
import { computeMarkup, retainageLine, wipRow, roundCents } from '../../../apps/projects/src/lib/commercial/math';
import { productivity, priceTicket, checkCoi, waiverFormKey } from '../../../apps/projects/src/lib/commercial/field';
import { parseTranscript } from '../../../apps/projects/src/lib/commercial/voice';

let f: Fixture;
const id: Record<string, string> = {};
const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;
let today = '';

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}
const asQ = <T = Record<string, unknown>>(p: Persona, sql: string, params: unknown[] = []) => as(f, p, () => q<T>(f.db, sql, params));
const asOne = async <T = Record<string, unknown>>(p: Persona, sql: string, params: unknown[] = []): Promise<T> => {
  const r = await asQ<T>(p, sql, params);
  if (!r[0]) throw new Error(`no row (${p}): ${sql}`);
  return r[0];
};
const asErr = (p: Persona, sql: string, params: unknown[] = []) => as(f, p, () => errorOf(f.db, sql, params));
const n = (v: unknown) => Number(v);
const count = async (p: Persona, sql: string, params: unknown[] = []) => n((await asOne<{ c: number }>(p, `select count(*)::int c from (${sql}) x`, params)).c);
const plus = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const skipped: string[] = [];
async function applyAll(): Promise<void> {
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const num = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if (num === 1111 || num === 1112 || num === 1113 || num === 1114 || num === 1115 || num === 1120) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[commercial.test] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
}

beforeAll(async () => {
  f = await buildFixture();
  await applyAll();
  today = (await one<{ d: string }>(`select current_date::text d`)).d;
  const db = f.db;
  // Books on (events are emitted); the approval engine off at L1 so the object RPCs run directly
  await db.query(`update core.organizations set entitlements = coalesce(entitlements, '{}'::jsonb) || '{"books": true}'::jsonb where id = $1`, [ORG_A]);
  await db.query(`delete from pm.approval_settings where location_id = $1`, [L1]);
  await db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                  select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs where location_id = $1
                  on conflict do nothing`, [L1]);
  id.customer = (await one<{ id: string }>(`insert into core.customers (org_id, name, location_id) values ($1, 'Northside Clinic LLC', $2) returning id`, [ORG_A, L1])).id;
  await db.query(`update core.jobs set customer_id = $2 where id = $1`, [J1, id.customer]);
  await db.query(`update pm.contracts set status = 'ACTIVE', retention_pct = 0.10 where job_id = $1`, [J1]);
  id.ccElec = (await one<{ id: string }>(`insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, '26 05 00', 'Electrical', 'LABOR') returning id`, [ORG_A, L1])).id;
  id.ccDw = (await one<{ id: string }>(`insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values ($1, $2, '09 29 00', 'Drywall', 'SUBCONTRACTOR') returning id`, [ORG_A, L1])).id;
  const k = await one<{ id: string }>(`select id from pm.contracts where job_id = $1`, [J1]);
  id.sov1 = (await one<{ id: string }>(`insert into pm.sov_versions (org_id, job_id, contract_id, version, status, activated_at) values ($1, $2, $3, 1, 'ACTIVE', now()) returning id`, [ORG_A, J1, k.id])).id;
  await db.query(`insert into pm.sov_lines (org_id, sov_version_id, line_no, cost_code_id, description, scheduled_value_cents, sort) values
                  ($1, $2, 1, $3, 'Electrical', 1500000, 1), ($1, $2, 2, $4, 'Drywall', 1000000, 2)`, [ORG_A, id.sov1, id.ccElec, id.ccDw]);
  id.vendor = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Drywall Pros') returning id`, [ORG_A])).id;
  id.vendor2 = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Sparky Electric') returning id`, [ORG_A])).id;
  id.sc = (await one<{ id: string }>(`insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, number, status, retainage_pct, version,
                  approved_by, approved_at, created_by) values ($1, $2, $3, $4, 'SUBCONTRACT', 'SC-1', 'APPROVED', 0.10, 1, 'user_gm', now(), 'user_gm') returning id`,
    [ORG_A, L1, J1, id.vendor])).id;
  id.scLine = (await one<{ id: string }>(`insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, description, amount_cents, original_amount_cents)
                  values ($1, $2, 1, $3, 'Drywall and taping', 600000, 600000) returning id`, [ORG_A, id.sc, id.ccDw])).id;
  await db.query(`insert into pm.cm_contract_settings (org_id, job_id, project_state) values ($1, $2, 'CA')`, [ORG_A, J1]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('registry, guards, idempotency', () => {
  it('every pm table is classified and every member-executable definer RPC is guarded or allowlisted', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    const cm = await q<{ n: number }>(f.db, `select count(*)::int n from pm.access_table_classes where table_name like 'cm\\_%'`);
    expect(cm[0]!.n).toBeGreaterThanOrEqual(67);
  });
  it('no 1120 function is executable by anon or PUBLIC; service-only hooks are not member-executable', async () => {
    const anon = await q(f.db, `select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                                where s.nspname = 'pm' and p.proname ~ '^(_?cm_|tg_cm_)' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anon).toEqual([]);
    for (const fn of ['cm_rfq_portal_respond', 'cm_portal_submit_sub_pay_app', 'cm_rfi_email_reply', '_cm_sync_cos_to_sov', '_cm_verify_coi']) {
      const r = await q<{ x: boolean }>(f.db, `select bool_or(has_function_privilege('authenticated', p.oid, 'execute')) x from pg_proc p
                                              join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'pm' and p.proname = $1`, [fn]);
      expect(r[0]!.x, fn).toBe(false);
    }
  });
  it('the statutory waiver forms are seeded and the form choice matches the browser mirror', async () => {
    const forms = await q<{ key: string }>(f.db, `select key from pm.cm_lien_waiver_forms order by key`);
    expect(forms.length).toBe(4 + 9 * 4 + 2);
    for (const [st, t] of [['CA', 'CONDITIONAL_PROGRESS'], ['FL', 'CONDITIONAL_PROGRESS'], ['FL', 'UNCONDITIONAL_FINAL'], ['IA', 'UNCONDITIONAL_PROGRESS'], [null, 'CONDITIONAL_FINAL']] as const) {
      const sqlKey = (await q<{ key: string | null }>(f.db, `select key from pm.cm_lien_waiver_forms where state_code is not distinct from $1 and waiver_type = $2 and state_code is not null`, [st, t]))[0]?.key ?? `GENERIC_${t}`;
      expect(waiverFormKey(st, t), `${st} ${t}`).toBe(sqlKey);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('change chain: change event → RFQ → PCO → prime CO → commitment COs', () => {
  it('field roles log a change without a price; pricing needs the money capability', async () => {
    const ce = await asOne<{ id: string; number: string }>('supervisor', `insert into pm.cm_change_events (job_id, title, source_type) values ($1, 'Unforeseen conduit reroute', 'FIELD') returning id, number`, [J1]);
    expect(ce.number).toMatch(/^CE-\d{3}$/);
    id.ceField = ce.id;
    // the field cannot price it: either refused outright or the row is out of its update reach
    const priceErr = await asErr('supervisor', `update pm.cm_change_events set rom_revenue_cents = 5000 where id = $1`, [ce.id]);
    if (priceErr !== null) expect(priceErr).toMatch(/PM_MONEY_FORBIDDEN|permission denied|row-level security/);
    expect((await one<{ v: string | null }>(`select rom_revenue_cents v from pm.cm_change_events where id = $1`, [ce.id])).v).toBeNull();
    // masked: the field sees the event, never its price
    await asQ('pm', `update pm.cm_change_events set rom_revenue_cents = 7000, rom_cost_cents = 5000 where id = $1`, [ce.id]);
    const sup = await asOne<{ rom_revenue_cents: string | null; rom_cost_cents: string | null }>('supervisor', `select rom_revenue_cents, rom_cost_cents from pm.v_cm_change_events_masked where id = $1`, [ce.id]);
    expect(sup).toEqual({ rom_revenue_cents: null, rom_cost_cents: null });
    const pmv = await asOne<{ rom_revenue_cents: string }>('pm', `select rom_revenue_cents from pm.v_cm_change_events_masked where id = $1`, [ce.id]);
    expect(n(pmv.rom_revenue_cents)).toBe(7000);
    expect(await asErr('supervisor', `select rom_cost_cents from pm.cm_change_events`)).toMatch(/permission denied/);
    // a crew member (no change-order capability, not on J1) sees nothing
    expect(await count('labor', `select 1 from pm.cm_change_events`)).toBe(0);
    expect(await count('dispatcher', `select 1 from pm.cm_change_events`)).toBe(0);
  });

  it('RFQ to the sub, priced and accepted; the PCO applies the markup rules exactly like the browser', async () => {
    const rules = [
      { kind: 'OHP', applies_to: 'SELF_PERFORM', pct: 0.10, compounding: false, sort: 1 },
      { kind: 'OHP', applies_to: 'SUBCONTRACT', pct: 0.05, compounding: false, sort: 2 },
      { kind: 'BOND', applies_to: 'ALL', pct: 0.01, compounding: true, sort: 3 },
    ];
    for (const r of rules) {
      await asQ('pm', `insert into pm.cm_markup_rules (job_id, kind, applies_to, pct, compounding, sort) values ($1, $2, $3, $4, $5, $6)`, [J1, r.kind, r.applies_to, r.pct, r.compounding, r.sort]);
    }
    const ce = await asOne<{ id: string }>('pm', `insert into pm.cm_change_events (job_id, title, description, source_type, reason_code) values ($1, 'Add corridor soffit', 'ASI-04 soffit at corridor 2', 'ASI', 'OWNER_CHANGE') returning id`, [J1]);
    id.ce = ce.id;
    await asQ('pm', `insert into pm.cm_change_event_lines (change_event_id, line_no, cost_code_id, cost_type, description, rom_cost_cents, rom_revenue_cents) values ($1, 1, $2, 'LABOR', 'Electrical relocate', 100000, 130000)`, [ce.id, id.ccElec]);
    await asQ('pm', `insert into pm.cm_change_event_lines (change_event_id, line_no, cost_code_id, cost_type, description, vendor_id, commitment_id, rom_cost_cents) values ($1, 2, $2, 'SUBCONTRACTOR', 'Soffit framing and board', $3, $4, 200000)`, [ce.id, id.ccDw, id.vendor, id.sc]);
    const sums = await asOne<{ rom_cost_cents: string }>('pm', `select rom_cost_cents from pm.v_cm_change_events_masked where id = $1`, [ce.id]);
    expect(n(sums.rom_cost_cents)).toBe(300000);

    id.rfq = (await asOne<{ r: string }>('pm', `select pm.cm_send_rfq($1, $2, $3, null, null) r`, [ce.id, id.vendor, id.sc])).r;
    expect(await asErr('supervisor', `select pm.cm_rfq_respond($1, '{"total_cents": 1}'::jsonb)`, [id.rfq])).toMatch(forbidden);
    expect(await asErr('pm', `select pm.cm_rfq_respond($1, '{"labor_cents": 100000, "material_cents": 80000, "total_cents": 190000}'::jsonb)`, [id.rfq])).toMatch(/PM_RFQ_TOTAL/);
    await asQ('pm', `select pm.cm_rfq_respond($1, '{"labor_cents": 100000, "material_cents": 80000, "responder_name": "J. Pro"}'::jsonb)`, [id.rfq]);
    await asQ('pm', `select pm.cm_rfq_decide($1, true)`, [id.rfq]);

    id.pco = (await asOne<{ r: string }>('pm', `select pm.cm_build_pco($1, array[$2]::uuid[], 'Corridor soffit', null) r`, [J1, ce.id])).r;
    const p = await asOne<{ tier: string; cost_cents: string; markup_cents: string; amount_cents: string; number: string }>('pm',
      `select tier, cost_cents, markup_cents, amount_cents, number from pm.v_cm_pcos_masked where id = $1`, [id.pco]);
    const lines = await asQ<{ cost_cents: string; cost_type: string; source: 'SELF' | 'SUB' }>('pm', `select cost_cents, cost_type, source from pm.v_cm_pco_lines_masked where pco_id = $1`, [id.pco]);
    expect(lines.map((l) => [l.source, n(l.cost_cents)]).sort()).toEqual([['SELF', 100000], ['SUB', 180000]]);
    const ts = computeMarkup(
      rules.map((r) => ({ kind: r.kind as 'OHP' | 'BOND', appliesTo: r.applies_to as 'ALL' | 'SELF_PERFORM' | 'SUBCONTRACT', costType: null, pct: r.pct, compounding: r.compounding, tierMaxCents: null, sort: r.sort })),
      lines.map((l) => ({ costCents: n(l.cost_cents), costType: l.cost_type as 'LABOR', source: l.source })));
    expect(p.tier).toBe('PCO');
    expect(n(p.cost_cents)).toBe(280000);
    expect(n(p.markup_cents)).toBe(10000 + 9000 + 2990);
    expect(n(p.markup_cents)).toBe(ts.markupCents);
    expect(n(p.amount_cents)).toBe(ts.amountCents);
    expect(p.number).toMatch(/^PCO-\d{3}$/);
    // members cannot move a PCO's status or totals directly
    expect(await asErr('pm', `update pm.cm_pcos set amount_cents = 1 where id = $1`, [id.pco])).toMatch(/permission denied|PM_PCO_STATE/);
  });

  it('submitting the PCO creates the prime CO; the owner\'s approval flows back; subs get draft commitment COs', async () => {
    id.co = (await asOne<{ r: string }>('pm', `select pm.cm_submit_pco($1, null) r`, [id.pco])).r;
    const co = await one<{ stage: string; amount_cents: string; cost_impact_cents: string; created_by: string }>(`select stage, amount_cents, cost_impact_cents, created_by from pm.change_orders where id = $1`, [id.co]);
    expect(co).toMatchObject({ stage: 'COR', created_by: 'user_pm' });
    expect(n(co.amount_cents)).toBe(301990);
    expect((await one<{ status: string }>(`select status from pm.cm_change_events where id = $1`, [id.ce])).status).toBe('SUBMITTED');
    // the field and dispatch never read PCO rows; the project accountant reads them with cost
    expect(await count('supervisor', `select 1 from pm.cm_pcos`)).toBe(0);
    expect(await count('dispatcher', `select 1 from pm.cm_pcos`)).toBe(0);
    expect(n((await asOne<{ c: string }>('accountant', `select cost_cents c from pm.v_cm_pcos_masked where id = $1`, [id.pco])).c)).toBe(280000);
    // owner approval (here: the GM, preparer ≠ approver) lands on the PCO and its change events
    expect(await asErr('pm', `select pm.approve_change_order($1)`, [id.co])).toMatch(/PM_SOD_VIOLATION/);
    await asQ('gm', `select pm.approve_change_order($1)`, [id.co]);
    expect((await one<{ status: string }>(`select status from pm.cm_pcos where id = $1`, [id.pco])).status).toBe('APPROVED');
    expect((await one<{ status: string }>(`select status from pm.cm_change_events where id = $1`, [id.ce])).status).toBe('APPROVED');
    let ex = await asOne<{ approved_cents: string; owner_co_without_sub_co_cents: string }>('pm', `select * from pm.cm_v_change_exposure where job_id = $1`, [J1]);
    expect(n(ex.approved_cents)).toBe(301990);
    expect(n(ex.owner_co_without_sub_co_cents)).toBe(180000);
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_propose_ccos($1) r`, [id.co])).r)).toBe(1);
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_propose_ccos($1) r`, [id.co])).r)).toBe(0);
    const cco = await one<{ id: string; amount_cents: string; status: string }>(`select id, amount_cents, status from pm.commitment_changes where owner_co_id = $1`, [id.co]);
    expect([n(cco.amount_cents), cco.status]).toEqual([180000, 'DRAFT']);
    await asQ('gm', `select pm.approve_commitment_change($1)`, [cco.id]);
    ex = await asOne('pm', `select * from pm.cm_v_change_exposure where job_id = $1`, [J1]);
    expect(n(ex.owner_co_without_sub_co_cents)).toBe(0);
  });

  it('CCD / work proceeding before pricing is flagged and ages on the exposure board', async () => {
    await asQ('pm', `select pm.cm_change_event_proceed($1, true, 'CCD-01', $2::date)`, [id.ceField, plus(-10)]);
    const ex = await asOne<{ proceeding_count: number; proceeding_oldest_days: number }>('pm', `select proceeding_count, proceeding_oldest_days from pm.cm_v_change_exposure where job_id = $1`, [J1]);
    expect([ex.proceeding_count, ex.proceeding_oldest_days]).toEqual([1, 10]);
    expect((await one<{ source_type: string }>(`select source_type from pm.cm_change_events where id = $1`, [id.ceField])).source_type).toBe('CCD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('owner pay apps: CO → SOV, stored materials, step-downs, pencil → certified → final, revise', () => {
  it('the auditor flags the approved CO before it is on the SOV; syncing adds it and keeps the SOV tied to the contract', async () => {
    const before = await asQ<{ rule: string }>('pm', `select rule from pm.cm_billing_audit($1)`, [J1]);
    expect(before.map((r) => r.rule)).toContain('APPROVED_CO_NOT_ON_SOV');
    expect(await asErr('supervisor', `select pm.cm_sync_cos_to_sov($1)`, [J1])).toMatch(forbidden);
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_sync_cos_to_sov($1) r`, [J1])).r)).toBe(1);
    const v = await one<{ id: string; total: string; version: number }>(`select v.id, v.version, sum(l.scheduled_value_cents) total from pm.sov_versions v join pm.sov_lines l on l.sov_version_id = v.id
                                                                       where v.job_id = $1 and v.status = 'ACTIVE' group by v.id, v.version`, [J1]);
    expect([v.version, n(v.total)]).toEqual([2, 2801990]);
    id.sov = v.id;
    const ls = await q<{ id: string; line_no: number }>(f.db, `select id, line_no from pm.sov_lines where sov_version_id = $1 order by line_no`, [v.id]);
    id.lElec = ls[0]!.id; id.lDw = ls[1]!.id; id.lCo = ls[2]!.id;
    const after = await asQ<{ rule: string }>('pm', `select rule from pm.cm_billing_audit($1)`, [J1]);
    expect(after.map((r) => r.rule)).not.toContain('APPROVED_CO_NOT_ON_SOV');
  });

  it('application #1: line retainage + stored materials; a pencil cannot go final until certified', async () => {
    await asQ('pm', `insert into pm.cm_retainage_steps (job_id, side, from_pct, rate) values ($1, 'RECEIVABLE', 0.5, 0.05)`, [J1]);
    id.app1 = (await asOne<{ r: string }>('pm', `select pm.cm_draft_pay_app($1, '2026-09-30', $2::jsonb, true) r`, [J1,
      JSON.stringify([{ sov_line_id: id.lElec, pct_complete: 0.4 }, { sov_line_id: id.lDw, work_to_date_cents: 400000, stored_materials_cents: 50000 }])])).r;
    const r = await one<{ application_no: number; gross_earned_cents: string; retainage_cents: string; net_cents: string }>(`select application_no, gross_earned_cents, retainage_cents, net_cents from pm.billing_requests where id = $1`, [id.app1]);
    expect([r.application_no, n(r.gross_earned_cents), n(r.retainage_cents), n(r.net_cents)]).toEqual([1, 1050000, 105000, 945000]);
    expect((await one<{ stage: string }>(`select stage from pm.cm_pay_app_status where billing_request_id = $1`, [id.app1])).stage).toBe('PENCIL');
    expect(await asErr('accountant', `select pm.approve_and_emit_billing($1)`, [id.app1])).toMatch(/PM_PAYAPP_NOT_CERTIFIED/);
    await asQ('pm', `select pm.cm_send_pencil($1, 'Owner rep')`, [id.app1]);
    expect(await asErr('pm', `select pm.cm_certify_pay_app($1, 'A. Architect', 900000, false)`, [id.app1])).toMatch(/PM_PAYAPP_CERT_MISMATCH/);
    await asQ('pm', `select pm.cm_certify_pay_app($1, 'A. Architect', 945000, false)`, [id.app1]);
    await asQ('accountant', `select pm.approve_and_emit_billing($1)`, [id.app1]);
    expect((await one<{ status: string }>(`select status from pm.billing_requests where id = $1`, [id.app1])).status).toBe('EMITTED');
    expect((await one<{ stage: string }>(`select stage from pm.cm_pay_app_status where billing_request_id = $1`, [id.app1])).stage).toBe('FINAL');
    const ev = await one<{ payload: { billing_subtype: string; retainage_cents: number; gross_earned_cents: number } }>(
      `select payload from core.events e join pm.billing_requests b on b.event_id = e.event_id where b.id = $1`, [id.app1]);
    expect(ev.payload).toMatchObject({ billing_subtype: 'SOV', retainage_cents: 105000, gross_earned_cents: 1050000 });
  });

  it('application #2 carries forward; the owner returns the pencil and the revision keeps the number', async () => {
    id.app2 = (await asOne<{ r: string }>('pm', `select pm.cm_draft_pay_app($1, '2026-10-31', $2::jsonb, true) r`, [J1,
      JSON.stringify([{ sov_line_id: id.lElec, pct_complete: 0.8 }, { sov_line_id: id.lDw, work_to_date_cents: 800000, stored_materials_cents: 0 }])])).r;
    const l = await q<{ sov_line_id: string; previous_work_cents: string; this_period_work_cents: string; previous_stored_cents: string; retainage_this_period_cents: string; retainage_rate: string }>(f.db,
      `select sov_line_id, previous_work_cents, this_period_work_cents, previous_stored_cents, retainage_this_period_cents, retainage_rate from pm.billing_request_lines where billing_request_id = $1 and line_type = 'STANDARD' order by sort`, [id.app2]);
    const dw = l.find((x) => x.sov_line_id === id.lDw)!;
    expect([n(dw.previous_work_cents), n(dw.this_period_work_cents), n(dw.previous_stored_cents), n(dw.retainage_this_period_cents)]).toEqual([400000, 400000, 50000, 35000]);
    // the browser mirror agrees (installing the stored material moves its retainage to work)
    expect(retainageLine({ mode: 'NEW_WORK_ONLY', rate: 0.1, storedRate: null, previousWork: 400000, thisPeriodWork: 400000, storedNow: 0, storedBefore: 50000, heldBefore: 45000 }).thisPeriod).toBe(35000);
    await asQ('pm', `select pm.cm_send_pencil($1, null)`, [id.app2]);
    await asQ('pm', `select pm.cm_return_pencil($1, 'Electrical is closer to 70%')`, [id.app2]);
    const rev = (await asOne<{ r: string }>('pm', `select pm.cm_revise_pay_app($1, $2::jsonb, 'Architect: electrical 70%') r`, [id.app2,
      JSON.stringify([{ sov_line_id: id.lElec, pct_complete: 0.7 }, { sov_line_id: id.lDw, work_to_date_cents: 800000, stored_materials_cents: 0 }])])).r;
    const nr = await one<{ application_no: number; status: string }>(`select application_no, status from pm.billing_requests where id = $1`, [rev]);
    expect(nr).toEqual({ application_no: 2, status: 'DRAFT' });
    expect((await one<{ status: string }>(`select status from pm.billing_requests where id = $1`, [id.app2])).status).toBe('VOID');
    const st = await one<{ revision: number; stage: string }>(`select revision, stage from pm.cm_pay_app_status where billing_request_id = $1`, [rev]);
    expect(st).toEqual({ revision: 2, stage: 'PENCIL' });
    expect(n((await one<{ c: number }>(`select count(*)::int c from pm.cm_pay_app_revisions where job_id = $1 and application_no = 2`, [J1])).c)).toBe(1);
    id.app2 = rev;
    const net = n((await one<{ n: string }>(`select net_cents n from pm.billing_requests where id = $1`, [rev])).n);
    await asQ('pm', `select pm.cm_certify_pay_app($1, 'A. Architect', $2, true)`, [rev, net]);
    await asQ('accountant', `select pm.approve_and_emit_billing($1)`, [rev]);
  });

  it('application #3: past 50% complete the 5% step-down applies to new work only', async () => {
    id.app3 = (await asOne<{ r: string }>('pm', `select pm.cm_draft_pay_app($1, '2026-11-30', $2::jsonb, true) r`, [J1,
      JSON.stringify([{ sov_line_id: id.lElec, pct_complete: 1 }, { sov_line_id: id.lDw, pct_complete: 1 }, { sov_line_id: id.lCo, pct_complete: 0.5 }])])).r;
    const l = await q<{ sov_line_id: string; this_period_work_cents: string; retainage_this_period_cents: string; retainage_rate: string }>(f.db,
      `select sov_line_id, this_period_work_cents, retainage_this_period_cents, retainage_rate from pm.billing_request_lines where billing_request_id = $1 and line_type = 'STANDARD'`, [id.app3]);
    for (const x of l) expect(Number(x.retainage_rate), x.sov_line_id).toBe(0.05);
    const byLine = Object.fromEntries(l.map((x) => [x.sov_line_id, [n(x.this_period_work_cents), n(x.retainage_this_period_cents)]]));
    expect(byLine[id.lElec]).toEqual([450000, 22500]);
    expect(byLine[id.lDw]).toEqual([200000, 10000]);
    expect(byLine[id.lCo]).toEqual([150995, roundCents(0.05 * 150995)]);
    const g702 = await one<{ retainage_total_cents: string; current_payment_due_cents: string; request_net_cents: string }>(
      `select retainage_total_cents, current_payment_due_cents, request_net_cents from pm.v_pay_application where billing_request_id = $1`, [id.app3]);
    expect(n(g702.current_payment_due_cents)).toBe(n(g702.request_net_cents));
    const preview = (await asOne<{ p: { over_under_after_cents: number | null; warnings: unknown[] } }>('pm', `select pm.cm_pay_app_preview($1) p`, [id.app3])).p;
    expect(preview).toHaveProperty('over_under_after_cents');
    expect(await count('supervisor', `select 1 from pm.cm_pay_app_status`)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sub pay apps, lien waivers, COI: compliance holds block payment on JOB_COMMITMENT', () => {
  const holdOf = async () => (await one<{ h: boolean }>(`select bool_or(payment_hold_effective) h from pm.v_commitment_status where commitment_id = $1`, [id.sc])).h;
  const lastEventHold = async () => (await one<{ h: boolean }>(`select (payload ->> 'payment_hold')::boolean h from core.events where event_type = 'JOB_COMMITMENT'
                                                                 and payload ->> 'commitment_id' = $1 order by created_at desc, (payload ->> 'version')::int desc limit 1`, [id.sc])).h;

  it('the sub bills against its SOV (the approved CCO is in the commitment); submitting requests the conditional waiver and puts the commitment on hold', async () => {
    expect(await asErr('accountant', `select pm.cm_create_sub_pay_app($1, '2026-10-25', '[]'::jsonb)`, [id.sc])).toMatch(forbidden);
    id.sub = (await asOne<{ r: string }>('gm', `select pm.cm_create_sub_pay_app($1, '2026-10-25', $2::jsonb) r`, [id.sc, JSON.stringify([{ commitment_line_id: id.scLine, pct_complete: 0.5 }])])).r;
    const a = await one<{ gross_this_period_cents: string; retainage_this_period_cents: string; net_due_cents: string; application_no: number }>(`select * from pm.cm_sub_pay_apps where id = $1`, [id.sub]);
    expect([a.application_no, n(a.gross_this_period_cents), n(a.retainage_this_period_cents), n(a.net_due_cents)]).toEqual([1, 390000, 39000, 351000]);
    expect(await asErr('gm', `insert into pm.cm_sub_pay_apps (job_id, location_id, commitment_id, application_no, period_end) values ($1, $2, $3, 9, current_date)`, [J1, L1, id.sc])).toMatch(/permission denied|PM_SUB_PAY_APP_RPC/);
    await asQ('gm', `select pm.cm_submit_sub_pay_app($1)`, [id.sub]);
    const w = await one<{ id: string; waiver_type: string; form_key: string; status: string; amount_cents: string }>(`select id, waiver_type, form_key, status, amount_cents from pm.cm_lien_waivers where sub_pay_app_id = $1`, [id.sub]);
    expect(w).toMatchObject({ waiver_type: 'CONDITIONAL_PROGRESS', form_key: 'CA_CONDITIONAL_PROGRESS', status: 'REQUESTED' });
    id.waiver = w.id;
    expect(await holdOf()).toBe(true);
    expect(await lastEventHold()).toBe(true);
  });

  it('PM → project accountant chain; preparer ≠ approver; one person never approves two steps; approval queues the payable for Books', async () => {
    expect(await asErr('gm', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null)`, [id.sub])).toMatch(/PM_SOD_VIOLATION/);
    expect(await asErr('supervisor', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null)`, [id.sub])).toMatch(forbidden);
    const s1 = (await asOne<{ r: { status: string; waiting_on: string } }>('pm', `select pm.cm_act_sub_pay_app($1, 'APPROVE', 'Matches the field') r`, [id.sub])).r;
    expect(s1).toMatchObject({ status: 'IN_REVIEW', waiting_on: 'Project accountant' });
    expect(await asErr('pm', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null)`, [id.sub])).toMatch(/PM_FORBIDDEN|PM_SOD_DISTINCT/);
    const s2 = (await asOne<{ r: { status: string; outbox_id: string } }>('accountant', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null) r`, [id.sub])).r;
    expect(s2.status).toBe('APPROVED');
    const ob = await one<{ kind: string; status: string; payload: { event_type: string; net_cents: number; retainage_cents: number; payment_hold: boolean } }>(`select kind, status, payload from pm.cm_payable_outbox where id = $1`, [s2.outbox_id]);
    expect(ob).toMatchObject({ kind: 'PAYABLE_REQUEST', status: 'PENDING', payload: { event_type: 'JOB_PAYABLE_REQUEST', net_cents: 351000, retainage_cents: 39000, payment_hold: true } });
    const rt = await asOne<{ held_cents: string; outstanding_cents: string }>('accountant', `select held_cents, outstanding_cents from pm.cm_v_payable_retainage where commitment_id = $1`, [id.sc]);
    expect([n(rt.held_cents), n(rt.outstanding_cents)]).toEqual([39000, 39000]);
    expect(await count('supervisor', `select 1 from pm.cm_sub_pay_apps`)).toBe(0);
    // field opinion vs claim: the super thinks 35% → over-claim flagged
    await asQ('supervisor', `insert into pm.cm_sub_progress_opinions (job_id, vendor_id, period_end, pct_complete, note) values ($1, $2, '2026-10-25', 0.35, 'Board on 2 of 6 floors')`, [J1, id.vendor]);
    const chk = await asOne<{ over_claim: boolean; claimed_pct: string }>('pm', `select over_claim, claimed_pct from pm.cm_v_sub_pay_app_check where sub_pay_app_id = $1`, [id.sub]);
    expect(chk.over_claim).toBe(true);
  });

  it('the returned waiver is checked (amount, through-date, statutory form); verified releases the hold', async () => {
    expect(await asErr('accountant', `select pm.cm_receive_lien_waiver($1, null, '{}'::jsonb)`, [id.waiver])).toMatch(forbidden);
    // security review: no evidence → cannot be verified; the receiver never verifies; the 1102 path cannot bypass it
    await asQ('gm', `select pm.cm_receive_lien_waiver($1, null, $2::jsonb)`, [id.waiver, JSON.stringify({ amount_cents: 351000, through_date: '2026-10-25', form_key: 'CA_CONDITIONAL_PROGRESS' })]);
    expect(await asErr('accountant', `select pm.cm_verify_lien_waiver($1)`, [id.waiver])).toMatch(/PRECONDITION_WAIVER_DOCUMENT/);
    const cdoc = (await one<{ c: string }>(`select compliance_doc_id c from pm.cm_lien_waivers where id = $1`, [id.waiver])).c;
    expect(await asErr('gm', `select pm.verify_compliance_doc($1, null)`, [cdoc])).toMatch(/PM_WAIVER_VERIFY_HERE/);
    expect(await holdOf()).toBe(true);
    // any other file is not evidence: a receipt photo, or a plain filed document, never verifies a waiver
    const receipt = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type, doc_type) values ($1, 'x/receipt.jpg', 'receipt.jpg', 'image/jpeg', 'RECEIPT') returning id`, [ORG_A])).id;
    await asQ('gm', `select pm.cm_receive_lien_waiver($1, $2, $3::jsonb)`, [id.waiver, receipt, JSON.stringify({ amount_cents: 351000, through_date: '2026-10-25', form_key: 'CA_CONDITIONAL_PROGRESS' })]);
    expect(await asErr('accountant', `select pm.cm_verify_lien_waiver($1)`, [id.waiver])).toMatch(/PRECONDITION_WAIVER_DOCUMENT/);
    const fileDoc = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type, uploaded_by_user) values ($1::uuid, $1::text || '/pm/docs/notes.pdf', 'notes.pdf', 'application/pdf', 'user_gm') returning id`, [ORG_A])).id;
    await asQ('gm', `select pm.doc_create($1, null, $2, $3::jsonb)`, [J1, fileDoc, JSON.stringify({ kind: 'file', file_name: 'notes.pdf', mime_type: 'application/pdf', size_bytes: 10, content_sha256: 'a'.repeat(64) })]);
    await asQ('gm', `select pm.cm_receive_lien_waiver($1, $2, '{}'::jsonb)`, [id.waiver, fileDoc]);
    expect(await asErr('accountant', `select pm.cm_verify_lien_waiver($1)`, [id.waiver])).toMatch(/PRECONDITION_WAIVER_DOCUMENT/);
    // the signed waiver, filed as a lien waiver (what the upload route does)
    id.doc = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type, uploaded_by_user) values ($1::uuid, $1::text || '/pm/docs/waiver.pdf', 'waiver.pdf', 'application/pdf', 'user_gm') returning id`, [ORG_A])).id;
    await asQ('gm', `select pm.doc_create($1, null, $2, $3::jsonb)`, [J1, id.doc, JSON.stringify({ kind: 'lien_waiver', file_name: 'waiver.pdf', mime_type: 'application/pdf', size_bytes: 10, content_sha256: 'b'.repeat(64) })]);
    await asQ('gm', `select pm.cm_receive_lien_waiver($1, $2, $3::jsonb)`, [id.waiver, id.doc, JSON.stringify({ amount_cents: 351000, through_date: '2026-10-25', form_key: 'CA_CONDITIONAL_PROGRESS' })]);
    expect((await one<{ r: string }>(`select received_by r from pm.cm_lien_waivers where id = $1`, [id.waiver])).r).toBe('user_gm');
    expect(await asErr('gm', `select pm.cm_verify_lien_waiver($1)`, [id.waiver])).toMatch(/PM_SOD_VIOLATION/);
    const v = (await asOne<{ r: { ok: boolean } }>('accountant', `select pm.cm_verify_lien_waiver($1) r`, [id.waiver])).r;
    expect(v.ok).toBe(true);
    expect(await holdOf()).toBe(false);
    expect(await lastEventHold()).toBe(false);
    // Books paid: the unconditional waiver is requested and holds the next payment until it ties
    id.uw = (await asOne<{ r: string }>('accountant', `select pm.cm_record_sub_payment($1, 351000, '2026-11-05', 'CHK-1001', false) r`, [id.sc])).r;
    expect(await holdOf()).toBe(true);
    await asQ('gm', `select pm.cm_receive_lien_waiver($1, $2, $3::jsonb)`, [id.uw, id.doc, JSON.stringify({ amount_cents: 200000 })]);
    const bad = (await asOne<{ r: { ok: boolean; problems: Array<{ code: string }> } }>('accountant', `select pm.cm_verify_lien_waiver($1) r`, [id.uw])).r;
    expect(bad.ok).toBe(false);
    expect(bad.problems.map((x) => x.code)).toEqual(['AMOUNT']);
    expect(await holdOf()).toBe(true);
    // money masking: the waiver amount is cost — the accountant sees it, the dispatcher sees no waiver at all
    expect(n((await asOne<{ a: string }>('accountant', `select amount_cents a from pm.v_cm_lien_waivers_masked where id = $1`, [id.waiver])).a)).toBe(351000);
    expect(await count('dispatcher', `select 1 from pm.cm_lien_waivers`)).toBe(0);
  });

  it('COI verification reads endorsements against the requirements; deficient holds payment; renewal is chased once per tier', async () => {
    await asQ('pm', `insert into pm.cm_compliance_requirements (job_id, requirement, min_limit_cents) values ($1, 'GL_EACH_OCCURRENCE', 100000000)`, [J1]);
    await asQ('pm', `insert into pm.cm_compliance_requirements (job_id, requirement, endorsement_forms) values ($1, 'ADDITIONAL_INSURED_ONGOING', '{CG 20 10}')`, [J1]);
    const policies = [{ type: 'GL', each_occurrence_cents: 200000000, aggregate_cents: 400000000, expires: plus(10) }];
    const c1 = (await asOne<{ r: string }>('gm', `select pm.cm_record_coi($1, $2, $3, null, $4::jsonb) r`, [id.vendor, L1, J1,
      JSON.stringify({ carrier: 'Acme Mutual', policies, endorsements: ['CG 20 37'], additional_insured: true })])).r;
    const r1 = await one<{ status: string; verification: Array<{ requirement: string; ok: boolean; detail: string | null }> }>(`select status, verification from pm.cm_coi_certificates where id = $1`, [c1]);
    expect(r1.status).toBe('DEFICIENT');
    const ts = checkCoi({ policies, endorsements: ['CG 20 37'], additionalInsured: true, waiverOfSubrogation: false, primaryNoncontributory: false, emr: null, w9OnFile: false, licenseNo: null, licenseExpires: null },
      [{ requirement: 'ADDITIONAL_INSURED_ONGOING', minLimitCents: null, maxValue: null, endorsementForms: ['CG 20 10'], required: true },
       { requirement: 'GL_EACH_OCCURRENCE', minLimitCents: 100000000, maxValue: null, endorsementForms: [], required: true }], today);
    expect(ts.status).toBe('DEFICIENT');
    expect(r1.verification.map((x) => [x.requirement, x.ok, x.detail]).sort()).toEqual(ts.results.map((x) => [x.requirement, x.ok, x.detail]).sort());
    const doc = await one<{ status: string; notes: string }>(`select status, notes from pm.compliance_docs where commitment_id = $1 and doc_type = 'COI' order by created_at desc limit 1`, [id.sc]);
    expect(doc.status).toBe('REJECTED');
    expect(doc.notes).toMatch(/CG 20 10/);
    const c2 = (await asOne<{ r: string }>('gm', `select pm.cm_record_coi($1, $2, $3, null, $4::jsonb) r`, [id.vendor, L1, J1,
      JSON.stringify({ carrier: 'Acme Mutual', policies, endorsements: ['cg 20 10', 'CG 20 37'], additional_insured: true })])).r;
    expect((await one<{ status: string }>(`select status from pm.cm_coi_certificates where id = $1`, [c2])).status).toBe('VERIFIED');
    expect((await one<{ status: string }>(`select status from pm.cm_coi_certificates where id = $1`, [c1])).status).toBe('SUPERSEDED');
    expect((await one<{ status: string }>(`select status from pm.compliance_docs where commitment_id = $1 and doc_type = 'COI' order by created_at desc limit 1`, [id.sc])).status).toBe('VERIFIED');
    expect(n((await asOne<{ r: number }>('gm', `select pm.cm_compliance_chase_run($1) r`, [L1])).r)).toBeGreaterThanOrEqual(1);
    expect(n((await asOne<{ r: number }>('gm', `select pm.cm_compliance_chase_run($1) r`, [L1])).r)).toBe(0);
    expect(n((await one<{ c: number }>(`select count(*)::int c from pm.cm_compliance_chases where coi_id = $1 and tier = 15`, [c2])).c)).toBe(1);
    expect(await asErr('supervisor', `select pm.cm_compliance_chase_run($1)`, [L1])).toMatch(forbidden);
  });

  it('retainage payable is released only against a verified final waiver', async () => {
    expect(await asErr('gm', `select pm.cm_release_sub_retainage($1, null)`, [id.sc])).toMatch(/PRECONDITION_FINAL_WAIVER/);
  });

  it('security review: whoever revises a pay application can never approve it, in any round', async () => {
    const app = (await asOne<{ r: string }>('gm', `select pm.cm_create_sub_pay_app($1, '2026-11-25', $2::jsonb) r`, [id.sc, JSON.stringify([{ commitment_line_id: id.scLine, pct_complete: 0.6 }])])).r;
    await asQ('gm', `select pm.cm_submit_sub_pay_app($1)`, [app]);
    await asQ('pm', `select pm.cm_act_sub_pay_app($1, 'REVISE', 'Board count is off')`, [app]);
    await asQ('pm', `select pm.cm_revise_sub_pay_app($1, $2::jsonb)`, [app, JSON.stringify([{ commitment_line_id: id.scLine, pct_complete: 0.55 }])]);
    await asQ('gm', `select pm.cm_submit_sub_pay_app($1)`, [app]);
    const pr = await one<{ preparers: string[]; created_by: string; submitted_by: string }>(`select preparers, created_by, submitted_by from pm.cm_sub_pay_apps where id = $1`, [app]);
    expect([pr.created_by, pr.submitted_by]).toEqual(['user_gm', 'user_gm']);
    expect([...pr.preparers].sort()).toEqual(['user_gm', 'user_pm']);
    // before the fix the PM (neither creator nor submitter) could approve its own revision
    expect(await asErr('pm', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null)`, [app])).toMatch(/PM_SOD_VIOLATION/);
    expect(await asErr('gm', `select pm.cm_act_sub_pay_app($1, 'APPROVE', null)`, [app])).toMatch(/PM_SOD_VIOLATION/);
    // members cannot clear the list by hand
    expect(await asErr('gm', `update pm.cm_sub_pay_apps set preparers = '{}' where id = $1`, [app])).toMatch(/permission denied|PM_SUB_PAY_APP_RPC/);
    await asQ('gm', `select pm.cm_void_sub_pay_app($1, 'regression test')`, [app]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T&M tickets → GC signature → T&M billing', () => {
  it('the foreman writes the ticket (no cost), the GC signs on the device, then it is locked', async () => {
    await asQ('pm', `insert into pm.cm_rate_sheets (job_id, labor_rates, material_markup_pct) values ($1, '[{"class": "default", "st_cents": 10000}]'::jsonb, 0.15)`, [J1]);
    const t = await asOne<{ id: string; number: string }>('supervisor', `insert into pm.cm_tm_tickets (job_id, work_date, description) values ($1, $2::date, 'Relocate panel per GC super') returning id, number`, [J1, today]);
    id.tm = t.id;
    expect(t.number).toBe('TM-001');
    await asQ('supervisor', `insert into pm.cm_tm_ticket_lines (ticket_id, kind, labor_class, hours_st, hours_ot) values ($1, 'LABOR', 'default', 8, 2)`, [t.id]);
    expect(await asErr('supervisor', `insert into pm.cm_tm_ticket_lines (ticket_id, kind, qty, unit_cost_cents, description) values ($1, 'MATERIAL', 10, 500, 'Wire')`, [t.id])).toMatch(/PM_MONEY_FORBIDDEN/);
    await asQ('pm', `insert into pm.cm_tm_ticket_lines (ticket_id, kind, qty, unit_cost_cents, description) values ($1, 'MATERIAL', 10, 500, 'Wire')`, [t.id]);
    const sup = await asQ<{ unit_cost_cents: string | null }>('supervisor', `select unit_cost_cents from pm.v_cm_tm_ticket_lines_masked where ticket_id = $1 and kind = 'MATERIAL'`, [t.id]);
    expect(sup).toEqual([{ unit_cost_cents: null }]);
    await asQ('supervisor', `select pm.cm_tm_submit($1)`, [t.id]);
    expect(await asErr('supervisor', `select pm.cm_tm_sign($1, 'GC Super', null, null, null, 'DEVICE')`, [t.id])).toMatch(/signature/);
    await asQ('supervisor', `select pm.cm_tm_sign($1, 'GC Super', 'Superintendent', 'Big GC', 'data:image/png;base64,iVBOR', 'DEVICE')`, [t.id]);
    expect(await asErr('supervisor', `update pm.cm_tm_ticket_lines set hours_st = 10 where ticket_id = $1`, [t.id])).toMatch(/PM_TM_LOCKED/);
    expect(await count('labor', `select 1 from pm.cm_tm_tickets`)).toBe(0);
  });

  it('billing prices the ticket at the rate sheet exactly like the browser; each ticket bills once; a void frees it', async () => {
    const priced = (await asOne<{ p: { total_cents: number } }>('pm', `select pm.cm_tm_price($1) p`, [id.tm])).p;
    const ts = priceTicket([
      { kind: 'LABOR', laborClass: 'default', hoursSt: 8, hoursOt: 2, hoursDt: 0, qty: null, unitCostCents: null, equipmentHours: null, description: '' },
      { kind: 'MATERIAL', laborClass: null, hoursSt: 0, hoursOt: 0, hoursDt: 0, qty: 10, unitCostCents: 500, equipmentHours: null, description: 'Wire' },
    ], { laborRates: [{ class: 'default', st_cents: 10000 }], materialMarkupPct: 0.15, equipmentRates: [], equipmentMarkupPct: 0, subMarkupPct: 0.1 });
    expect(priced.total_cents).toBe(ts.totalCents);
    expect(ts.totalCents).toBe(80000 + 30000 + 5750);
    expect((await asQ<{ rule: string }>('pm', `select rule from pm.cm_billing_audit($1)`, [J1])).map((r) => r.rule)).toContain('SIGNED_TM_UNBILLED');
    const req = (await asOne<{ r: string }>('pm', `select pm.cm_bill_tm_tickets($1, array[$2]::uuid[], null) r`, [J1, id.tm])).r;
    const b = await one<{ billing_type: string; gross_earned_cents: string }>(`select billing_type, gross_earned_cents from pm.billing_requests where id = $1`, [req]);
    expect([b.billing_type, n(b.gross_earned_cents)]).toEqual(['TIME_MATERIALS', 115750]);
    expect((await one<{ status: string }>(`select status from pm.cm_tm_tickets where id = $1`, [id.tm])).status).toBe('BILLED');
    expect(await asErr('pm', `select pm.cm_bill_tm_tickets($1, array[$2]::uuid[], null)`, [J1, id.tm])).toMatch(/PRECONDITION_TM_NOT_BILLABLE/);
    await asQ('accountant', `select pm.void_billing_request($1, 'wrong period')`, [req]);
    expect((await one<{ status: string }>(`select status from pm.cm_tm_tickets where id = $1`, [id.tm])).status).toBe('SIGNED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('monthly EAC (PM prepares, executive approves) → JOB_PROGRESS; WIP live, pinned and Books-pinned', () => {
  it('the forecast needs commentary when it moves; the PM cannot approve it; the GM approval emits JOB_PROGRESS with the approval keys', async () => {
    id.eac = (await asOne<{ r: string }>('pm', `select pm.cm_start_eac($1, '2026-10-31') r`, [J1])).r;
    expect((await asOne<{ r: string }>('pm', `select pm.cm_start_eac($1, '2026-10-31') r`, [J1])).r).toBe(id.eac);
    const lines = await asQ<{ id: string; cost_code_id: string | null }>('pm', `select id, cost_code_id from pm.cm_eac_lines where forecast_id = $1`, [id.eac]);
    expect(lines.length).toBeGreaterThan(0);
    await asQ('pm', `update pm.cm_eac_lines set ctc_cents = 2600000 where id = $1`, [lines[0]!.id]);
    expect(await asErr('pm', `update pm.cm_eac_lines set actual_cents = 1 where id = $1`, [lines[0]!.id])).toMatch(/permission denied|PM_EAC_LINES/);
    expect(await asErr('pm', `select pm.cm_submit_eac($1, null, null, null, null)`, [id.eac])).toMatch(/PM_EAC_COMMENTARY/);
    await asQ('pm', `select pm.cm_submit_eac($1, 'SCOPE_GAP', 'Owner-added soffits and panel relocation', 0, 0)`, [id.eac]);
    expect(await asErr('pm', `select pm.cm_decide_eac($1, true, null)`, [id.eac])).toMatch(/PM_FORBIDDEN/);
    expect(await asErr('supervisor', `select pm.cm_decide_eac($1, true, null)`, [id.eac])).toMatch(forbidden);
    const d = (await asOne<{ r: { status: string; event_id: string; loss: boolean } }>('gm', `select pm.cm_decide_eac($1, true, null) r`, [id.eac])).r;
    expect(d.status).toBe('APPROVED');
    const fc = await one<{ total_eac_cents: string; snapshot_version: number }>(`select total_eac_cents, snapshot_version from pm.cm_eac_forecasts where id = $1`, [id.eac]);
    const ev = await one<{ payload: Record<string, unknown> }>(`select payload from core.events where event_id = $1`, [d.event_id]);
    expect(ev.payload).toMatchObject({ event_type: 'JOB_PROGRESS', trigger: 'PROGRESS_UPDATE', approved_by: 'user_gm', prepared_by: 'user_pm', eac_reason_code: 'SCOPE_GAP' });
    expect(Number(ev.payload.cost_estimate_cents)).toBe(n(fc.total_eac_cents));
    const snap = await one<{ cost_estimate_cents: string }>(`select cost_estimate_cents from pm.progress_snapshots where job_id = $1 and snapshot_version = $2`, [J1, fc.snapshot_version]);
    expect(n(snap.cost_estimate_cents)).toBe(n(fc.total_eac_cents));
    // the GM cannot approve a forecast the GM prepared
    const own = (await asOne<{ r: string }>('gm', `select pm.cm_start_eac($1, '2026-11-30') r`, [J1])).r;
    await asQ('gm', `select pm.cm_submit_eac($1, 'OTHER', 'roll forward', null, null)`, [own]);
    expect(await asErr('gm', `select pm.cm_decide_eac($1, true, null)`, [own])).toMatch(/PM_SOD_VIOLATION/);
  });

  it('security review: an executive who edited a forecast line cannot approve it; later JOB_PROGRESS keeps the approved EAC', async () => {
    const fc = (await asOne<{ r: string }>('pm', `select pm.cm_start_eac($1, '2026-12-31') r`, [J1])).r;
    const line = (await asOne<{ id: string; ctc_cents: string }>('pm', `select id, ctc_cents from pm.cm_eac_lines where forecast_id = $1 order by sort limit 1`, [fc]));
    await asQ('gm', `update pm.cm_eac_lines set ctc_cents = $2 where id = $1`, [line.id, n(line.ctc_cents) + 100]);
    await asQ('pm', `select pm.cm_submit_eac($1, 'SCOPE_GAP', 'GM adjusted the soffit line', 0, 0)`, [fc]);
    const f = await one<{ preparers: string[]; prepared_by: string }>(`select preparers, prepared_by from pm.cm_eac_forecasts where id = $1`, [fc]);
    expect(f.prepared_by).toBe('user_pm');
    expect([...f.preparers].sort()).toEqual(['user_gm', 'user_pm']);
    expect(await asErr('gm', `select pm.cm_decide_eac($1, true, null)`, [fc])).toMatch(/PM_SOD_VIOLATION/);
    await asQ('gm', `select pm.cm_decide_eac($1, false, 'Another executive will review')`, [fc]);
    // a change-order snapshot after the approval sends the approved forecast, not the budget estimate
    const approved = n((await one<{ t: string }>(`select total_eac_cents t from pm.cm_eac_forecasts where id = $1`, [id.eac])).t);
    const budget = n((await one<{ c: string }>(`select cost_estimate_cents c from pm.v_job_money where job_id = $1`, [J1])).c);
    expect(approved).not.toBe(budget);
    const ev = (await asOne<{ r: string }>('gm', `select pm.emit_job_progress($1, 'CHANGE_ORDER') r`, [J1])).r;
    const p = (await one<{ payload: Record<string, unknown> }>(`select payload from core.events where event_id = $1`, [ev])).payload;
    expect([Number(p.cost_estimate_cents), p.cost_estimate_source, p.trigger]).toEqual([approved, 'APPROVED_EAC', 'CHANGE_ORDER']);
    const snap = await one<{ c: string }>(`select cost_estimate_cents c from pm.progress_snapshots where event_id = $1`, [ev]);
    expect(n(snap.c)).toBe(approved);
    expect(await asErr('supervisor', `select pm.emit_job_progress($1, 'CHANGE_ORDER')`, [J1])).toMatch(forbidden);
  });

  it('the live WIP row ties to the browser mirror; pinning re-prints identically and a re-pin is a revision', async () => {
    const rows = await asQ<Record<string, string | number | boolean | null>>('accountant', `select * from pm.cm_wip_schedule($1, '2026-10-31')`, [L1]);
    const w = rows.find((r) => r.job_id === J1)!;
    expect(w.source).toBe('PROJECTS');
    const ts = wipRow({ contractCents: n(w.contract_cents), eacCents: n(w.eac_cents), costToDateCents: n(w.cost_to_date_cents), excludedCents: n(w.uninstalled_materials_cents),
      billedCents: n(w.billed_cents), priorGpPct: w.prior_gp_pct === null ? null : Number(w.prior_gp_pct) });
    expect([n(w.earned_cents), n(w.over_billed_cents), n(w.under_billed_cents), n(w.gp_cents), n(w.backlog_cents), n(w.loss_provision_cents)])
      .toEqual([ts.earnedCents, ts.overBilledCents, ts.underBilledCents, ts.gpCents, ts.backlogCents, ts.lossProvisionCents]);
    expect(n(w.billed_cents)).toBeGreaterThan(0);
    expect(await asErr('supervisor', `select * from pm.cm_wip_schedule($1, '2026-10-31')`, [L1])).toMatch(forbidden);
    expect(await asErr('accountant', `select pm.cm_pin_wip($1, '2026-10-31')`, [L1])).toMatch(forbidden);
    expect(n((await asOne<{ r: number }>('gm', `select pm.cm_pin_wip($1, '2026-10-31') r`, [L1])).r)).toBeGreaterThan(0);
    await asQ('gm', `select pm.cm_pin_wip($1, '2026-10-31')`, [L1]);
    const s = await q<{ revision: number; status: string }>(f.db, `select revision, status from pm.cm_wip_snapshots where job_id = $1 and period_end = '2026-10-31' order by revision`, [J1]);
    expect(s).toEqual([{ revision: 1, status: 'SUPERSEDED' }, { revision: 2, status: 'PINNED' }]);
    expect(await asErr('gm', `update pm.cm_wip_snapshots set eac_cents = 1 where job_id = $1`, [J1])).toMatch(/permission denied|PM_IMMUTABLE/);
  });

  it("Books' POSTED WIP run wins over the live computation", async () => {
    const run = await one<{ id: string }>(`insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, status) values ($1, $2, '2026-10', '2026-10-31', 'POSTED') returning id`, [ORG_A, L1]);
    await f.db.query(`insert into public.rev_rec_wip_run_lines (org_id, run_id, location_id, job_id, method, contract_cents, eac_cents, cost_to_date_cents, pct_complete,
                      earned_cents, billed_cents, under_cents, over_cents, est_gross_profit_cents) values ($1, $2, $3, $4, 'COST_TO_COST', 2801990, 2000000, 1000000, 0.5, 1400995, 1500000, 0, 99005, 801990)`,
      [ORG_A, run.id, L1, J1]);
    const w = (await asQ<{ job_id: string; source: string; earned_cents: string; over_billed_cents: string }>('accountant', `select job_id, source, earned_cents, over_billed_cents from pm.cm_wip_schedule($1, '2026-10-31')`, [L1])).find((r) => r.job_id === J1)!;
    expect([w.source, n(w.earned_cents), n(w.over_billed_cents)]).toEqual(['BOOKS_PINNED', 1400995, 99005]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document control: RFIs, submittals, meetings', () => {
  it('RFIs open with a due date, the ball moves, the official answer returns it to the author, and a cost impact becomes a change event', async () => {
    const r = await asOne<{ id: string; number: string }>('supervisor', `insert into pm.cm_rfis (job_id, subject, question, spec_section) values ($1, 'Ceiling height at corridor 2', 'Plans conflict: 9''-0" vs 8''-6"?', '09 51 00') returning id, number`, [J1]);
    id.rfi = r.id;
    expect(r.number).toBe('RFI-001');
    expect(await asErr('supervisor', `update pm.cm_rfis set status = 'OPEN' where id = $1`, [r.id])).toMatch(/permission denied|PM_RFI_STATE/);
    await asQ('supervisor', `select pm.cm_rfi_open($1, null)`, [r.id]);
    expect((await one<{ due_on: string }>(`select due_on::text from pm.cm_rfis where id = $1`, [r.id])).due_on).toBe(plus(7));
    await asQ('supervisor', `select pm.cm_rfi_set_ball($1, 'INTERNAL', $2, null, null, null, null)`, [r.id, f.membership.pm]);
    expect((await asQ<{ kind: string; item_id: string }>('pm', `select kind, item_id from pm.cm_ball_in_court(null)`)).some((x) => x.kind === 'RFI' && x.item_id === r.id)).toBe(true);
    const notes = await q<{ c: number }>(f.db, `select count(*)::int c from core.notifications where membership_id = $1 and event_type = 'rfi.assigned'`, [f.membership.pm]).catch(() => [{ c: -1 }]);
    if (notes[0]!.c !== -1) expect(notes[0]!.c).toBeGreaterThanOrEqual(1);
    await asQ('pm', `select pm.cm_rfi_respond($1, 'Use 8''-6" per A-501.', true, 'Arch of record', 'APP')`, [r.id]);
    const after = await one<{ status: string; ball_in_court_membership: string }>(`select status, ball_in_court_membership from pm.cm_rfis where id = $1`, [r.id]);
    expect(after).toEqual({ status: 'ANSWERED', ball_in_court_membership: f.membership.supervisor });
    const ce = (await asOne<{ r: string }>('pm', `select pm.cm_rfi_to_change_event($1) r`, [r.id])).r;
    expect((await one<{ source_type: string; source_id: string }>(`select source_type, source_id from pm.cm_change_events where id = $1`, [ce]))).toEqual({ source_type: 'RFI', source_id: r.id });
    // private RFIs: hidden from the field, visible to the job's change approvers
    const p = await asOne<{ id: string }>('pm', `insert into pm.cm_rfis (job_id, subject, question, is_private) values ($1, 'Owner budget question', 'q', true) returning id`, [J1]);
    expect(await count('supervisor', `select 1 from pm.cm_rfis where id = $1`, [p.id])).toBe(0);
    expect(await count('gm', `select 1 from pm.cm_rfis where id = $1`, [p.id])).toBe(1);
    expect(await count('labor', `select 1 from pm.cm_rfis`)).toBe(0);
  });

  it('the submittal register comes from the spec book; review runs in steps; fabrication waits for approval', async () => {
    await asQ('pm', `select pm.cm_import_spec_sections($1, $2::jsonb)`, [J1, JSON.stringify([
      { number: '08 71 00', title: 'Door Hardware' }, { number: '26 24 13', title: 'Switchboards' }, { number: '01 33 00', title: 'Submittal Procedures' }])]);
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_generate_submittal_register($1) r`, [J1])).r)).toBe(4 + 5);
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_generate_submittal_register($1) r`, [J1])).r)).toBe(0);
    const sw = await one<{ id: string; long_lead: boolean; lead_time_days: number; number: string }>(`select id, long_lead, lead_time_days, number from pm.cm_submittals
                       where job_id = $1 and spec_section = '26 24 13' and submittal_type = 'SHOP_DRAWING'`, [J1]);
    expect([sw.long_lead, sw.lead_time_days, sw.number]).toEqual([true, 120, '262413-002']);
    await asQ('pm', `update pm.cm_submittals set required_on_site = $2::date where id = $1`, [sw.id, plus(200)]);
    expect((await one<{ submit_by: string }>(`select submit_by::text from pm.cm_submittals where id = $1`, [sw.id])).submit_by).toBe(plus(200 - 120 - 10));
    await asQ('pm', `select pm.cm_submittal_submit($1, $2::jsonb)`, [sw.id, JSON.stringify([{ kind: 'GC', membership: f.membership.pm, step: 1 }, { kind: 'ARCHITECT', name: 'Arch of record', step: 2 }])]);
    expect(await asErr('pm', `select pm.cm_submittal_release_fab($1, null)`, [sw.id])).toMatch(/PM_SUBMITTAL_FAB_GATE/);
    expect(await asErr('pm', `update pm.cm_submittals set procurement_status = 'IN_FABRICATION' where id = $1`, [sw.id])).toMatch(/PM_SUBMITTAL_FAB_GATE/);
    const steps = await q<{ id: string; step: number; status: string }>(f.db, `select id, step, status from pm.cm_submittal_reviews where submittal_id = $1 order by step`, [sw.id]);
    expect(steps.map((s) => s.status)).toEqual(['ACTIVE', 'PENDING']);
    await asQ('pm', `select pm.cm_submittal_respond($1, 'NO_EXCEPTIONS', null, null)`, [steps[0]!.id]);
    expect((await one<{ status: string }>(`select status from pm.cm_submittal_reviews where id = $1`, [steps[1]!.id])).status).toBe('ACTIVE');
    await asQ('pm', `select pm.cm_submittal_respond($1, 'APPROVED_AS_NOTED', 'Provide 2000A main', 'AAN')`, [steps[1]!.id]);
    expect((await one<{ status: string }>(`select status from pm.cm_submittals where id = $1`, [sw.id])).status).toBe('APPROVED_AS_NOTED');
    await asQ('pm', `select pm.cm_submittal_release_fab($1, null)`, [sw.id]);
    await asQ('pm', `update pm.cm_submittals set procurement_status = 'SHIPPED', ship_on = $2::date where id = $1`, [sw.id, plus(60)]);
    expect((await asOne<{ procurement_status: string }>('pm', `select procurement_status from pm.cm_v_submittal_schedule where submittal_id = $1`, [sw.id])).procurement_status).toBe('SHIPPED');
  });

  it('meetings carry open items forward with a note; closed items stay closed', async () => {
    const m1 = await asOne<{ id: string }>('pm', `insert into pm.cm_meetings (job_id, meeting_type, series_key, number, title) values ($1, 'OAC', 'OAC', 1, 'OAC meeting #1') returning id`, [J1]);
    await asQ('pm', `insert into pm.cm_meeting_attendees (meeting_id, name, company, membership_id) values ($1, 'Pat PM', 'GC', $2)`, [m1.id, f.membership.pm]);
    const i1 = await asOne<{ id: string; item_no: string }>('pm', `insert into pm.cm_meeting_items (origin_meeting_id, topic, owner_membership) values ($1, 'Confirm ceiling heights', $2) returning id, item_no`, [m1.id, f.membership.supervisor]);
    expect(i1.item_no).toBe('1.01');
    await asQ('pm', `insert into pm.cm_meeting_items (origin_meeting_id, topic, status) values ($1, 'Badge office', 'CLOSED')`, [m1.id]);
    const m2 = (await asOne<{ r: string }>('pm', `select pm.cm_meeting_next($1, null) r`, [m1.id])).r;
    const carried = await q<{ item_id: string; carried: boolean }>(f.db, `select item_id, carried from pm.cm_meeting_item_notes where meeting_id = $1`, [m2]);
    expect(carried).toEqual([{ item_id: i1.id, carried: true }]);
    expect((await one<{ number: number; title: string }>(`select number, title from pm.cm_meetings where id = $1`, [m2]))).toEqual({ number: 2, title: 'OAC meeting #2' });
    expect(n((await one<{ c: number }>(`select count(*)::int c from pm.cm_meeting_attendees where meeting_id = $1`, [m2])).c)).toBe(1);
    expect((await asQ<{ kind: string }>('supervisor', `select kind from pm.cm_ball_in_court(null)`)).map((x) => x.kind)).toContain('MEETING_ITEM');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('field: daily log (sign + lock, amendments, copy forward, voice), inspections, safety, productivity', () => {
  it('the super logs manpower by company and delays, signs, and the log locks; amendments are kept', async () => {
    id.log = (await asOne<{ r: string }>('supervisor', `select pm.cm_daily_log_open($1, '2026-10-20', true) r`, [J1])).r;
    await asQ('supervisor', `insert into pm.cm_log_entries (daily_log_id, kind, vendor_id, company_name, trade, headcount, hours) values ($1, 'MANPOWER', $2, 'Drywall Pros', 'Drywall', 6, 48)`, [id.log, id.vendor]);
    await asQ('supervisor', `insert into pm.cm_log_entries (daily_log_id, kind, company_name, trade, headcount, hours) values ($1, 'MANPOWER', 'Own forces', 'Electrical', 4, 32)`, [id.log]);
    await asQ('supervisor', `insert into pm.cm_log_entries (daily_log_id, kind, cause, duration_hours, description) values ($1, 'DELAY', 'WEATHER', 3, 'Rain held the roof crew')`, [id.log]);
    await asQ('supervisor', `update pm.cm_daily_logs set work_performed = 'Hung board L2; pulled feeders' where id = $1`, [id.log]);
    await asQ('supervisor', `select pm.cm_daily_log_sign($1, 'Sam Super')`, [id.log]);
    const fl = await one<{ crew_count: number; hours: string; body: string }>(`select fl.crew_count, fl.hours, fl.body from pm.field_logs fl join pm.cm_daily_logs d on d.field_log_id = fl.id where d.id = $1`, [id.log]);
    expect([fl.crew_count, Number(fl.hours), fl.body]).toEqual([10, 80, 'Hung board L2; pulled feeders']);
    expect(await asErr('supervisor', `update pm.cm_log_entries set headcount = 7 where daily_log_id = $1 and kind = 'MANPOWER' and trade = 'Drywall'`, [id.log])).toMatch(/PM_DAILY_LOG_LOCKED/);
    expect(await asErr('supervisor', `update pm.field_logs set body = 'x' where id = (select field_log_id from pm.cm_daily_logs where id = $1)`, [id.log])).toMatch(/PM_DAILY_LOG_LOCKED/);
    await asQ('supervisor', `select pm.cm_daily_log_amend($1, 'Inspector visit omitted', '{"kind": "INSPECTION", "description": "Fire marshal above-ceiling: pass"}'::jsonb)`, [id.log]);
    expect((await one<{ status: string; amended_count: number }>(`select status, amended_count from pm.cm_daily_logs where id = $1`, [id.log]))).toEqual({ status: 'AMENDED', amended_count: 1 });
    const delays = await asQ<{ days: string; cause: string }>('pm', `select days, cause from pm.cm_v_delay_register where daily_log_id = $1`, [id.log]);
    expect(delays.map((d) => [d.cause, Number(d.days)])).toEqual([['WEATHER', 0.38]]);
    // copy forward manpower into the next day
    const next = (await asOne<{ r: string }>('supervisor', `select pm.cm_daily_log_open($1, '2026-10-21', true) r`, [J1])).r;
    expect(n((await one<{ c: number }>(`select count(*)::int c from pm.cm_log_entries where daily_log_id = $1 and kind = 'MANPOWER'`, [next])).c)).toBe(2);
    expect(await asErr('labor', `select pm.cm_daily_log_open($1, '2026-10-21', true)`, [J1])).toMatch(forbidden);
    // voice hook: the parser proposes; the super applies
    const proposed = parseTranscript('Drywall Pros had 5 guys for 8 hours. We waited 2 hours on the inspector. Delivered 40 sticks of conduit from Graybar. Finished rough-in on level 2.',
      [{ vendorId: id.vendor, name: 'Drywall Pros' }]);
    expect(proposed.map((p) => p.kind)).toEqual(['MANPOWER', 'DELAY', 'DELIVERY', 'WORK_SUMMARY']);
    expect(proposed[0]).toMatchObject({ headcount: 5, hours: 8, vendor_id: id.vendor });
    expect(proposed[1]).toMatchObject({ cause: 'INSPECTION', duration_hours: 2 });
    const v = await asOne<{ id: string }>('supervisor', `insert into pm.cm_daily_log_voice (daily_log_id, transcript, proposed) values ($1, 'x', $2::jsonb) returning id`, [next, JSON.stringify(proposed)]);
    expect(n((await asOne<{ r: number }>('supervisor', `select pm.cm_daily_log_apply_voice($1, $2::jsonb) r`, [v.id, JSON.stringify(proposed)])).r)).toBe(3);
    expect((await one<{ work_performed: string }>(`select work_performed from pm.cm_daily_logs where id = $1`, [next])).work_performed).toMatch(/rough-in/);
  });

  it('inspections come from templates; a failure opens an observation; OSHA 300A rates use hours worked', async () => {
    expect(n((await asOne<{ r: number }>('owner', `select pm.cm_seed_commercial($1) r`, [L1])).r)).toBe(8);
    expect(n((await asOne<{ r: number }>('owner', `select pm.cm_seed_commercial($1) r`, [L1])).r)).toBe(0);
    const tpl = await one<{ id: string }>(`select id from pm.cm_checklist_templates where location_id = $1 and key = 'pre_pour'`, [L1]);
    const ins = (await asOne<{ r: string }>('supervisor', `select pm.cm_start_inspection($1, $2, null, 'Level 3 deck') r`, [J1, tpl.id])).r;
    const items = await asQ<{ id: string; requires_photo: boolean }>('supervisor', `select id, requires_photo from pm.cm_inspection_items where inspection_id = $1 order by sort`, [ins]);
    expect(await asErr('supervisor', `select pm.cm_complete_inspection($1, null, null)`, [ins])).toMatch(/PM_INSPECTION_OPEN_ITEMS/);
    for (const [i, it] of items.entries()) {
      await asQ('supervisor', `update pm.cm_inspection_items set response = $2, photo_ids = $3::uuid[] where id = $1`,
        [it.id, i === 1 ? 'FAIL' : 'PASS', it.requires_photo ? ['00000000-0000-4000-8000-000000000001'] : []]);
    }
    const done = (await asOne<{ r: { result: string; observations: number } }>('supervisor', `select pm.cm_complete_inspection($1, 'Sam Super', null) r`, [ins])).r;
    expect(done).toEqual({ result: 'PARTIAL', observations: 1 });
    expect(n((await one<{ c: number }>(`select count(*)::int c from pm.cm_observations where job_id = $1 and inspection_item_id is not null`, [J1])).c)).toBe(1);
    // incidents: recordable injury; injury detail is not crew-visible
    await asQ('supervisor', `insert into pm.cm_incidents (job_id, incident_type, occurred_at, person_name, description, osha_recordable, osha_classification, days_away)
                             values ($1, 'INJURY', '2026-10-15 10:00', 'Lee Worker', 'Laceration from sheet metal', true, 'DAYS_AWAY', 3)`, [J1]);
    await asQ('owner', `insert into pm.cm_safety_hours (location_id, period_month, hours) values ($1, '2026-01-01', 200000)`, [L1]);
    const a = (await asOne<{ r: { trir: number; dart: number; days_away_cases: number; total_days_away: number } }>('gm', `select pm.cm_osha_300a($1, 2026) r`, [L1])).r;
    expect(a.days_away_cases).toBe(1);
    expect(a.total_days_away).toBe(3);
    expect(Number(a.trir)).toBeCloseTo(1, 1);
    expect((await asQ<{ person_name: string }>('gm', `select person_name from pm.cm_osha_300($1, 2026)`, [L1]))).toEqual([{ person_name: 'Lee Worker' }]);
    expect(await count('labor', `select 1 from pm.cm_incidents`)).toBe(0);
  });

  it('labor productivity: earned vs actual hours by cost code (hours only), with a weekly fade alert that names the cause', async () => {
    await asQ('pm', `insert into pm.cm_cost_code_units (job_id, cost_code_id, budget_qty, uom, budget_hours) values ($1, $2, 100, 'LF', 50)`, [J1, id.ccElec]);
    const week = '2026-10-12';
    await asQ('supervisor', `insert into pm.cm_installed_quantities (job_id, cost_code_id, work_date, qty, uom) values ($1, $2, '2026-10-14', 40, 'LF')`, [J1, id.ccElec]);
    await f.db.query(`insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, pay_type, cost_code_id, approval_state) values
                      ($1, $2, $3, '2026-10-14', 10, 'REG', $4, 'SUBMITTED'), ($1, $2, $3, '2026-10-15', 10, 'REG', $4, 'SUBMITTED'), ($1, $2, $3, '2026-10-16', 10, 'OT', $4, 'SUBMITTED')`,
      [ORG_A, J1, f.employee.supervisor, id.ccElec]);
    const p = (await asQ<{ cost_code_id: string; pct_complete: string; earned_hours: string; actual_hours: string; productivity_factor: string; projected_hours: string }>('supervisor',
      `select * from pm.cm_labor_productivity($1, '2026-10-18')`, [J1])).find((x) => x.cost_code_id === id.ccElec)!;
    const ts = productivity({ budgetQty: 100, budgetHours: 50, unitHours: null, installedQty: 40, lastPct: null, pctEntry: false, actualHours: 30 });
    expect([Number(p.pct_complete), Number(p.earned_hours), Number(p.actual_hours), Number(p.productivity_factor), Number(p.projected_hours)])
      .toEqual([ts.pctComplete, ts.earnedHours, 30, ts.productivityFactor, ts.projectedHours]);
    expect(n((await asOne<{ r: number }>('supervisor', `select pm.cm_run_fade_alerts($1, $2::date) r`, [J1, week])).r)).toBe(1);
    const al = await one<{ severity: string; cause_hint: string }>(`select severity, cause_hint from pm.cm_fade_alerts where job_id = $1 and cost_code_id = $2`, [J1, id.ccElec]);
    expect(al.severity).toBe('CRITICAL');
    expect(al.cause_hint).toMatch(/overtime/);
    expect(await asErr('labor', `select * from pm.cm_labor_productivity($1, null)`, [J1])).toMatch(forbidden);
    const plan = (await asOne<{ r: { yesterday: unknown[]; crew: unknown[] } }>('supervisor', `select pm.cm_foreman_plan($1, '2026-10-17') r`, [J1])).r;
    expect(JSON.stringify(plan)).not.toMatch(/_cents/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('templates (global update), proposals, directory, close gate, inbox, executive view, masking', () => {
  it('a template sets the contract terms; changing it pushes to the jobs that applied it', async () => {
    const t = await one<{ id: string }>(`select id from pm.cm_project_templates where location_id = $1 and key = 'ground_up'`, [L1]);
    expect(await asErr('supervisor', `select pm.cm_apply_project_template($1, $2)`, [J1, t.id])).toMatch(forbidden);
    const r = (await asOne<{ r: { markup_rules: number; retainage_steps: number } }>('pm', `select pm.cm_apply_project_template($1, $2) r`, [J1, t.id])).r;
    expect(r.markup_rules).toBe(4);
    expect((await one<{ change_tiers: number; bonded: boolean }>(`select change_tiers, bonded from pm.cm_contract_settings where job_id = $1`, [J1]))).toEqual({ change_tiers: 3, bonded: true });
    // three tiers: a PCO must roll into a COR before it reaches the owner
    const ce = await asOne<{ id: string }>('pm', `insert into pm.cm_change_events (job_id, title, rom_cost_cents) values ($1, 'Owner hardware change', 10000) returning id`, [J1]);
    const pco = (await asOne<{ r: string }>('pm', `select pm.cm_build_pco($1, array[$2]::uuid[], null, null) r`, [J1, ce.id])).r;
    expect(await asErr('pm', `select pm.cm_submit_pco($1, null)`, [pco])).toMatch(/PM_PCO_TIER/);
    const cor = (await asOne<{ r: string }>('pm', `select pm.cm_roll_to_cor(array[$1]::uuid[], null) r`, [pco])).r;
    expect((await one<{ tier: string }>(`select tier from pm.cm_pcos where id = $1`, [cor])).tier).toBe('COR');
    await asQ('pm', `select pm.cm_submit_pco($1, null)`, [cor]);
    await asQ('owner', `update pm.cm_project_templates set payload = payload || '{"contract_settings": {"change_tiers": 2}}'::jsonb where id = $1`, [t.id]);
    expect(n((await asOne<{ r: number }>('owner', `select pm.cm_push_project_template($1) r`, [t.id])).r)).toBe(1);
    expect((await one<{ change_tiers: number }>(`select change_tiers from pm.cm_contract_settings where job_id = $1`, [J1])).change_tiers).toBe(2);
  });

  it('a trade proposal with alternates becomes the job and its contract when accepted', async () => {
    const p = await asOne<{ id: string; number: string }>('pm', `insert into pm.cm_proposals (location_id, customer_id, project_name, base_bid_cents, alternates, exclusions)
                       values ($1, $2, 'Clinic electrical', 5000000, '[{"label": "LED upgrade", "amount_cents": 250000}, {"label": "Generator", "amount_cents": 900000}]'::jsonb, '{Permits,Utility fees}') returning id, number`, [L1, id.customer]);
    expect(p.number).toMatch(/^PR-L1-\d{4}-001$/);
    expect(await asErr('pm', `update pm.cm_proposals set status = 'ACCEPTED' where id = $1`, [p.id])).toMatch(/permission denied|PM_PROPOSAL_STATE/);
    await asQ('pm', `select pm.cm_proposal_send($1, null)`, [p.id]);
    const job = (await asOne<{ r: string }>('pm', `select pm.cm_proposal_accept($1, 'build', array[0]) r`, [p.id])).r;
    expect(n((await one<{ c: string }>(`select original_cents c from pm.contracts where job_id = $1`, [job])).c)).toBe(5250000);
    expect((await one<{ status: string }>(`select status from pm.cm_proposals where id = $1`, [p.id])).status).toBe('ACCEPTED');
  });

  it('directory from the shared masters; the close gate lists what is open (counts only, field-visible)', async () => {
    expect(n((await asOne<{ r: number }>('pm', `select pm.cm_seed_project_directory($1) r`, [J1])).r)).toBe(2);
    const dir = await asQ<{ party_role: string; company_name: string }>('pm', `select party_role, company_name from pm.cm_v_project_directory where job_id = $1 order by party_role`, [J1]);
    expect(dir).toEqual([{ party_role: 'OWNER', company_name: 'Northside Clinic LLC' }, { party_role: 'SUBCONTRACTOR', company_name: 'Drywall Pros' }]);
    await asQ('pm', `select pm.cm_generate_closeout($1)`, [J1]);
    const g = (await asOne<{ r: { ready: boolean; blockers: Array<{ code: string }> } }>('supervisor', `select pm.cm_job_close_gate($1) r`, [J1])).r;
    expect(g.ready).toBe(false);
    expect(g.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['COMMITMENTS_OPEN', 'FINAL_WAIVERS', 'CLOSEOUT_ITEMS', 'CHANGES_OPEN']));
    expect(JSON.stringify(g)).not.toMatch(/_cents/);
    expect(await asErr('supervisor', `select pm.cm_close_job($1, null)`, [J1])).toMatch(forbidden);
    expect(await asErr('accountant', `select pm.cm_close_job($1, null)`, [J1])).toMatch(/PM_CLOSE_BLOCKED/);
  });

  it('the executive summary rolls up what the caller can see', async () => {
    const s = (await asOne<{ r: { jobs: number; exposure: { approved_cents: number }; billing: { sub_pay_apps_in_review: number } } }>('gm', `select pm.cm_executive_summary($1) r`, [L1])).r;
    expect(s.jobs).toBeGreaterThanOrEqual(2);
    expect(Number(s.exposure.approved_cents)).toBeGreaterThanOrEqual(301990);
    const sup = (await asOne<{ r: { contract_cents: number; exposure: { approved_cents: number } } }>('supervisor', `select pm.cm_executive_summary($1) r`, [L1])).r;
    expect(Number(sup.contract_cents)).toBe(0);
    expect(Number(sup.exposure.approved_cents)).toBe(0);
  });

  it('money tables are invisible without the capability; nothing crosses tenants', async () => {
    for (const t of ['cm_pcos', 'cm_pco_lines', 'cm_rfqs', 'cm_sub_pay_apps', 'cm_eac_forecasts', 'cm_wip_snapshots', 'cm_payable_outbox', 'cm_contract_settings',
      'cm_markup_rules', 'cm_rate_sheets', 'cm_pay_app_status', 'cm_review_packages']) {
      expect(await count('supervisor', `select 1 from pm.${t}`), `supervisor ${t}`).toBe(0);
      expect(await count('labor', `select 1 from pm.${t}`), `labor ${t}`).toBe(0);
      expect(await count('dispatcher', `select 1 from pm.${t}`), `dispatcher ${t}`).toBe(0);
    }
    const tables = (await q<{ t: string }>(f.db, `select table_name t from pm.access_table_classes a where table_name like 'cm\\_%'
                       and exists (select 1 from information_schema.columns c where c.table_schema = 'pm' and c.table_name = a.table_name and c.column_name = 'org_id')`)).map((r) => r.t);
    for (const t of tables) {
      const err = await asErr('bOwner', `select 1 from pm.${t} limit 1`);
      if (err) continue;
      expect(await count('bOwner', `select 1 from pm.${t}`), t).toBe(0);
    }
    expect(ORG_B).not.toBe(ORG_A);
    expect(J2).not.toBe(J1);
  });

  it('1120 re-applies cleanly (idempotent)', async () => {
    const before = await one<{ c: number }>(`select count(*)::int c from pm.cm_lien_waiver_forms`);
    await applyMigration(f.db, '1120_pm_commercial_depth.sql');
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect((await one<{ c: number }>(`select count(*)::int c from pm.cm_lien_waiver_forms`)).c).toBe(before.c);
  });
});
