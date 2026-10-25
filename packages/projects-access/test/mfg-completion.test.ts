/**
 * Manufacturing (ETO cabinetry / millwork) completion (migration 1125) against a PGlite replay of every
 * migration: bid board + award, drawing takeoff on 1115 sheets (parity with lib/mfg/takeoff.ts),
 * parametric products (parity with lib/mfg/products.ts), proposals + e-sign settlement, site measure
 * and selections gates, shop-drawing stamps gating drawings approval, current-set enforcement,
 * engineering queue, CO re-engineering, cut list, family routings, traveler, sheet goods + counts,
 * issue from nests, outside processing, shipping + proof of delivery, stored-material and on-ship
 * billing, installer + punch + back-charges, job cost by bucket, WIP, owner dashboard, portal feed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { as, q, type Fixture, type Persona, ORG_A, L1, J1, J2 } from './fixture';
import { call, callErr, customer, forbidden, one, setupIndustry, stockLocation, vendor, costCode } from './industry';
import { takeoffQty, calibrate } from '../../../apps/projects/src/lib/mfg/takeoff';
import { expandProduct, type ProductDef } from '../../../apps/projects/src/lib/mfg/products';

let f: Fixture;
const ids: Record<string, string> = {};
const J = (v: unknown) => JSON.stringify(v);
let seq = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function upload(p: Persona, name = 'file.pdf'): Promise<string> {
  seq += 1;
  return as(f, p, async () => (await q<{ id: string }>(f.db,
    `insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, uploaded_by_user)
     values ($1, $2, $3, 'application/pdf', 1234, 'OTHER', 'pm.doc_files', $4) returning id`, [ORG_A, `${ORG_A}/pm/docs/m${seq}-${name}`, name, f.clerk[p]]))[0]!.id);
}
async function docFile(p: Persona, job: string, title: string): Promise<string> {
  const d = await upload(p, `${title}.pdf`);
  return as(f, p, async () => (await q<{ r: { file_id: string } }>(f.db, `select pm.doc_create($1, null, $2, $3::jsonb) as r`,
    [job, d, J({ mime_type: 'application/pdf', content_sha256: sha(`m-${seq}`), title })]))[0]!.r.file_id);
}
async function sheet(p: Persona, job: string, set: string, page: number, number: string): Promise<string> {
  const d = await upload(p, `p${page}.pdf`);
  return as(f, p, async () => (await q<{ r: { revision_id: string } }>(f.db, `select pm.drawing_add_sheet($1, $2, $3::jsonb) as r`,
    [set, d, J({ page_index: page, sheet_number: number, extraction: 'text', confidence: 0.9, width_pt: 2592, height_pt: 1728 })]))[0]!.r.revision_id);
}
async function newSet(p: Persona, job: string, name: string): Promise<string> {
  return as(f, p, async () => (await q<{ id: string }>(f.db, `select pm.drawing_set_create($1, $2::jsonb) as id`, [job, J({ name, set_kind: 'ifc', issued_on: '2026-10-01' })]))[0]!.id);
}

beforeAll(async () => {
  f = await setupIndustry('mfg-completion');
  await q(f.db, `insert into pm.mfg_settings (org_id, location_id) values ($1, $2) on conflict do nothing`, [ORG_A, L1]);
  ids.sl = await stockLocation(f, 'SHOP', 'SHOP');
  ids.gc1 = await customer(f, 'Acme Builders');
  ids.gc2 = await customer(f, 'Beta Construction');
  ids.finisher = await vendor(f, 'Ace Finishing');
  for (const [code, name, rate] of [['cnc', 'CNC router', 6000], ['edge', 'Edgebander', 4500], ['assy', 'Assembly', 3000]] as const) {
    ids[code] = (await one<{ id: string }>(f, `insert into pm.work_centers (org_id, location_id, code, name, capacity_minutes_per_week, rate_cents) values ($1, $2, $3, $4, 2400, $5) returning id`,
      [ORG_A, L1, code, name, rate])).id;
  }
  ids.routing = (await one<{ id: string }>(f, `insert into pm.routings (org_id, location_id, code, name) values ($1, $2, 'BOX', 'Frameless box') returning id`, [ORG_A, L1])).id;
  await q(f.db, `insert into pm.routing_steps (org_id, routing_id, seq, work_center_id, name, setup_minutes, run_minutes_per_unit, run_basis) values
                   ($1, $2, 1, $3, 'Cut and bore', 30, 2, 'PART'), ($1, $2, 2, $4, 'Edgeband', 15, 0.5, 'LF'), ($1, $2, 3, $5, 'Assemble', 0, 20, 'BOX')`,
    [ORG_A, ids.routing, ids.cnc, ids.edge, ids.assy]);
  ids.kitchen = (await one<{ id: string }>(f, `insert into pm.wbs_nodes (org_id, job_id, kind, code, name, sort) values ($1, $2, 'AREA', 'K', 'Kitchen', 1) returning id`, [ORG_A, J1])).id;
  ids.bath = (await one<{ id: string }>(f, `insert into pm.wbs_nodes (org_id, job_id, kind, code, name, sort) values ($1, $2, 'AREA', 'B', 'Bath', 2) returning id`, [ORG_A, J1])).id;
  ids.estimate = f.ids[`estimate:${J1}`]!;
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

const product: ProductDef = {
  params: { w: { default: 24, min: 9, max: 48 }, h: { default: 34.5 }, d: { default: 24 }, doors: { default: 2 } },
  components: [
    { kind: 'SHEET', key: 'MAPLE PLY|18.0', coef: { const: 0.5, w: 0.02 }, unit_cost_cents: 6000 },
    { kind: 'EDGEBAND', key: 'MAPLE EB', coef: { w: 0.3, h: 0.2 }, unit_cost_cents: 50 },
    { kind: 'HARDWARE', key: 'BLUM-HINGE', coef: { doors: 2 }, unit_cost_cents: 400 },
    { kind: 'LABOR', key: 'assy', coef: { const: 20, doors: 5 } },
    { kind: 'INSTALL', key: 'install', coef: { const: 0.75 } },
  ],
  price_coef: { const: 20000, w: 1000 },
  markup_pct: null,
};

describe('bid board, products, takeoff (MFG-03/05/07)', () => {
  it('one estimate to several GCs; a loss needs a reason', async () => {
    ids.opp = await call<string>(f, 'owner', `pm.mfg_save_opportunity($1, null, $2::jsonb)`, [L1, J({ name: 'Riverside condos millwork', est_value_cents: 25000000, bid_due_on: '2026-11-15', architect: 'HDR' })]);
    ids.bid1 = await call<string>(f, 'owner', `pm.mfg_save_bid($1, $2, $3::jsonb)`, [ids.opp, ids.gc1, J({ estimate_id: ids.estimate, amount_cents: 24000000, submitted_on: '2026-10-20' })]);
    ids.bid2 = await call<string>(f, 'owner', `pm.mfg_save_bid($1, $2, $3::jsonb)`, [ids.opp, ids.gc2, J({ estimate_id: ids.estimate, amount_cents: 24500000 })]);
    expect((await one<{ stage: string }>(f, `select stage from pm.mfg_opportunities where id = $1`, [ids.opp])).stage).toBe('SUBMITTED');
    expect(await callErr(f, 'owner', `pm.mfg_move_opportunity($1, 'LOST')`, [ids.opp])).toMatch(/PM_INVALID/);
    expect(await callErr(f, 'owner', `pm.mfg_move_opportunity($1, 'WON')`, [ids.opp])).toMatch(/PM_INVALID/);
    const b = await call<{ opportunities: Array<{ id: string; bids: unknown[]; est_value_cents: number | null }> }>(f, 'owner', `pm.mfg_bid_board($1)`, [L1]);
    expect(b.opportunities.find((o) => o.id === ids.opp)?.bids).toHaveLength(2);
    expect(await callErr(f, 'labor', `pm.mfg_bid_board($1)`, [L1])).toMatch(forbidden);
  });
  it('a parametric product expands identically in SQL and lib/mfg/products.ts; parameters are bounded; the line lands in the draft estimate', async () => {
    ids.product = await call<string>(f, 'owner', `pm.mfg_save_product($1, $2::jsonb)`, [L1, J({ code: 'B-2DR', name: 'Base 2-door', family: 'BASE', ...product })]);
    const x = await call<{ components: Array<{ key: string; qty: number; cost_cents: number }>; cost_cents: number; sell_cents: number; labor_minutes: number; install_hours: number }>(
      f, 'owner', `pm.mfg_expand_product($1, '{"w":30,"qty":2}')`, [ids.product]);
    const m = expandProduct(product, { w: 30, qty: 2 }, { assy: 50 });
    expect(Number(x.cost_cents)).toBe(m.cost_cents);
    expect(Number(x.sell_cents)).toBe(m.sell_cents);
    expect(m).toMatchObject({ cost_cents: 20990, sell_cents: 100000, labor_minutes: 60, install_hours: 1.5 });
    expect(x.components.map((c) => [c.key, Number(c.qty)])).toEqual(m.components.map((c) => [c.key, c.qty]));
    expect(await callErr(f, 'owner', `pm.mfg_expand_product($1, '{"w":60}')`, [ids.product])).toMatch(/at most 48/);
    const sup = await call<{ cost_cents: number | null; sell_cents: number }>(f, 'supervisor', `pm.mfg_expand_product($1, '{"w":30}')`, [ids.product]);
    expect(sup.cost_cents).toBeNull();
    const st = await one<{ status: string }>(f, `select status from pm.estimates where id = $1`, [ids.estimate]);
    expect(st.status).toBe('DRAFT');
    const l = await call<{ estimate_line_id: string; sell_cents: number }>(f, 'owner', `pm.mfg_add_product_line($1, $2, '{"w":30,"qty":2}', $3::jsonb)`, [ids.estimate, ids.product, J({ wbs_id: ids.kitchen, cost_code_id: f.ids[`costCode:${L1}`] })]);
    expect(Number(l.sell_cents)).toBe(100000);
    const el = await one<{ amount_cents: string; ext: { mfg: { product_id: string } } }>(f, `select amount_cents, ext from pm.estimate_lines where id = $1`, [l.estimate_line_id]);
    expect(el.ext.mfg.product_id).toBe(ids.product);
  });
  it('takeoff: calibrate, measure runs / areas / counts in LF / SF / EA identical to lib/mfg/takeoff.ts; rescaling re-measures', async () => {
    const set = await newSet('pm', J1, 'Arch IFC');
    ids.rev = await sheet('pm', J1, set, 0, 'A-201');
    await as(f, 'pm', () => q(f.db, `select pm.drawing_publish_set($1)`, [set]));
    expect(await callErr(f, 'owner', `pm.mfg_save_takeoff($1, null, '{"kind":"LINEAR","points":[[0.1,0.1],[0.3,0.1]]}')`, [ids.rev])).toMatch(/scale first/);
    const sc = await call<{ pts_per_unit: number }>(f, 'owner', `pm.mfg_set_takeoff_scale($1, '[0.1,0.5]', '[0.2,0.5]', 10, 'FT')`, [ids.rev]);
    const page = { width: 2592, height: 1728 };
    expect(Number(sc.pts_per_unit)).toBeCloseTo(calibrate([0.1, 0.5], [0.2, 0.5], 10, page), 6);
    const run = [[0.1, 0.1], [0.3, 0.1]] as const;
    const area = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.25], [0.1, 0.25]] as const;
    const t1 = await call<{ takeoff_id: string; qty: number; uom: string }>(f, 'owner', `pm.mfg_save_takeoff($1, null, $2::jsonb)`, [ids.rev, J({ kind: 'LINEAR', label: 'Base run', room: 'Kitchen', points: run, wbs_id: ids.kitchen })]);
    expect([Number(t1.qty), t1.uom]).toEqual([takeoffQty('LINEAR', run, page, Number(sc.pts_per_unit), 'FT'), 'LF']);
    expect(Number(t1.qty)).toBe(20);
    const t2 = await call<{ qty: number; uom: string }>(f, 'owner', `pm.mfg_save_takeoff($1, null, $2::jsonb)`, [ids.rev, J({ kind: 'AREA', label: 'Panel wall', room: 'Kitchen', points: area })]);
    expect([Number(t2.qty), t2.uom]).toEqual([100, 'SF']);
    expect(takeoffQty('AREA', area, page, Number(sc.pts_per_unit), 'FT')).toBe(100);
    const t3 = await call<{ qty: number; uom: string }>(f, 'owner', `pm.mfg_save_takeoff($1, null, '{"kind":"COUNT","label":"Pulls","points":[[0.5,0.5],[0.6,0.5],[0.7,0.5]]}')`, [ids.rev]);
    expect([Number(t3.qty), t3.uom]).toEqual([3, 'EA']);
    await call(f, 'owner', `pm.mfg_set_takeoff_scale($1, '[0.1,0.5]', '[0.2,0.5]', 20, 'FT')`, [ids.rev]);
    expect(Number((await one<{ qty: string }>(f, `select qty from pm.mfg_takeoffs where id = $1`, [t1.takeoff_id])).qty)).toBe(40);
    const s = await call<{ takeoffs: unknown[]; scale: { unit: string } }>(f, 'owner', `pm.mfg_takeoff_sheet($1)`, [ids.rev]);
    expect(s.takeoffs).toHaveLength(3);
    const sum = await call<Array<{ room: string | null; label: string; qty: number }>>(f, 'owner', `pm.mfg_takeoff_summary($1)`, [J1]);
    expect(sum.find((r) => r.label === 'Base run')).toMatchObject({ room: 'Kitchen' });
    expect(await callErr(f, 'owner', `pm.mfg_save_takeoff($1, null, '{"kind":"LINEAR","points":[[1.2,0.1],[0.3,0.1]]}')`, [ids.rev])).toMatch(/fractions/);
  });
});

describe('proposal → award → deposit; measure / selections / shop drawings gates (MFG-11/12/14/15/16/17)', () => {
  it('a proposal carries alternates / exclusions / the deposit schedule; signing the envelope signs it', async () => {
    expect(await callErr(f, 'owner', `pm.mfg_save_proposal($1, '{"deposit_schedule":[{"label":"A","pct":0.7},{"label":"B","pct":0.5}]}')`, [ids.estimate])).toMatch(/more than 100/);
    const p = await call<{ id: string; version: number }>(f, 'owner', `pm.mfg_save_proposal($1, $2::jsonb)`, [ids.estimate, J({
      title: 'Riverside millwork', alternates: [{ label: 'Crown upgrade', amount_cents: 120000 }], allowances: [{ label: 'Hardware', amount_cents: 50000 }],
      clarifications: ['Field measure before drafting'], exclusions: ['Countertops', 'Appliance install'] })]);
    expect(p.version).toBe(1);
    ids.proposal = p.id;
    ids.propFile = await docFile('pm', J1, 'Proposal v1');
    const env = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.esign_create($1, '[{"name":"Pat GC","email":"pat@gc.test"}]'::jsonb) as id`, [ids.propFile]))[0]!.id);
    await call(f, 'owner', `pm.mfg_mark_proposal_sent($1, $2, $3)`, [ids.proposal, ids.propFile, env]);
    await q(f.db, `update pm.esign_envelopes set status = 'completed', completed_at = now() where id = $1`, [env]);
    const d = await call<{ status: string; signer_name: string; alternates: unknown[] }>(f, 'owner', `pm.mfg_proposal_detail($1)`, [ids.proposal]);
    expect(d.status).toBe('SIGNED');
    expect(d.signer_name).toBe('Pat GC');
    expect(d.alternates).toHaveLength(1);
  });
  it('the award accepts the sent estimate, sets the GC on the job, loses the other bid; the first deposit follows the schedule', async () => {
    await q(f.db, `update pm.estimate_lines set cost_code_id = $2 where estimate_id = $1 and cost_code_id is null`, [ids.estimate, f.ids[`costCode:${L1}`]]);
    await q(f.db, `update pm.contracts set status = 'ACTIVE' where job_id = $1`, [J1]);
    await call(f, 'owner', `pm.send_estimate($1)`, [ids.estimate]);
    const a = await call<{ estimate_accepted: boolean; job_id: string }>(f, 'owner', `pm.mfg_award_bid($1)`, [ids.bid1]);
    expect(a).toMatchObject({ estimate_accepted: true, job_id: J1 });
    expect((await one<{ status: string }>(f, `select status from pm.mfg_opportunity_bids where id = $1`, [ids.bid2])).status).toBe('LOST');
    const dep = await call<{ amount_cents: number; label: string }>(f, 'owner', `pm.mfg_request_proposal_deposit($1)`, [ids.proposal]);
    expect(dep.label).toBe('Deposit at signing');
    const money = await one<{ revised_contract_cents: string }>(f, `select revised_contract_cents from pm.v_job_money where job_id = $1`, [J1]);
    expect(Number(dep.amount_cents)).toBe(Math.round(Number(money.revised_contract_cents) * 0.5));
  });
  it('shop drawings: no drawings approval before release; revise & resubmit opens the next revision; release waits for the field measure', async () => {
    ids.wo = await call<string>(f, 'owner', `pm.create_production_order($1, 'Kitchen boxes', 1, $2, null, $3)`, [J1, ids.routing, ids.kitchen]);
    ids.sd = await call<string>(f, 'owner', `pm.mfg_create_shop_drawing($1, $2, 'Kitchen elevations')`, [J1, ids.kitchen]);
    expect(await callErr(f, 'owner', `pm.mfg_create_shop_drawing($1, $2, 'Again')`, [J1, ids.kitchen])).toMatch(/PM_DUPLICATE/);
    expect(await callErr(f, 'owner', `pm.approve_drawings($1)`, [ids.wo])).toMatch(/PM_SHOP_DRAWINGS_NOT_APPROVED/);
    // R6: the reviewer is outside the organization
    expect(await callErr(f, 'owner', `pm.mfg_check_reviewer($1, 'GM@example.test')`, [ids.sd])).toMatch(/PM_SOD_VIOLATION/);
    expect(await call<{ ok: boolean }>(f, 'owner', `pm.mfg_check_reviewer($1, 'pm@acmebuilders.example')`, [ids.sd])).toEqual({ ok: true });
    const file = await docFile('pm', J1, 'SD-001 r0');
    await call(f, 'owner', `pm.mfg_submit_shop_drawing($1, $2, 'ARCHITECT')`, [ids.sd, file]);
    expect(await callErr(f, 'owner', `pm.mfg_record_stamp($1, 'REVISE_RESUBMIT', 'HDR')`, [ids.sd])).toMatch(/comments/);
    // security review M6: a hand-recorded stamp needs the stamped file on this job and someone other than the submitter
    expect(await callErr(f, 'owner', `pm.mfg_record_stamp($1, 'REVISE_RESUBMIT', 'HDR', 'Raise uppers 2 in')`, [ids.sd])).toMatch(/attach the stamped drawing/);
    const stamped0 = await docFile('gm', J1, 'SD-001 r0 stamped');
    const otherJob = await docFile('owner', J2, 'Some other job');
    expect(await callErr(f, 'gm', `pm.mfg_record_stamp($1, 'REVISE_RESUBMIT', 'HDR', 'Raise uppers 2 in', $2)`, [ids.sd, otherJob])).toMatch(/attach the stamped drawing/);
    expect(await callErr(f, 'owner', `pm.mfg_record_stamp($1, 'REVISE_RESUBMIT', 'HDR', 'Raise uppers 2 in', $2)`, [ids.sd, stamped0])).toMatch(/PM_SOD_VIOLATION/);
    const st = await call<{ next_revision_id: string }>(f, 'gm', `pm.mfg_record_stamp($1, 'REVISE_RESUBMIT', 'HDR', 'Raise uppers 2 in', $2)`, [ids.sd, stamped0]);
    expect(st.next_revision_id).toBeTruthy();
    expect((await one<{ n: string }>(f, `select count(*)::text as n from pm.mfg_eng_tasks where shop_drawing_id = $1 and kind = 'REVISION'`, [st.next_revision_id])).n).toBe('1');
    ids.sd = st.next_revision_id;
    const file2 = await docFile('pm', J1, 'SD-001 r1');
    await call(f, 'owner', `pm.mfg_submit_shop_drawing($1, $2)`, [ids.sd, file2]);
    await call(f, 'gm', `pm.mfg_record_stamp($1, 'APPROVED', 'Acme Builders PM', null, $2)`, [ids.sd, await docFile('gm', J1, 'SD-001 r1 stamped')]);
    expect(await callErr(f, 'gm', `pm.mfg_release_shop_drawing($1)`, [ids.sd])).toMatch(/PM_MEASURE_REQUIRED/);
    const m = await call<string>(f, 'owner', `pm.mfg_schedule_measure($1, $2, current_date)`, [J1, ids.kitchen]);
    expect(await callErr(f, 'owner', `pm.mfg_record_measure($1, '[]')`, [m])).toMatch(/PM_INVALID/);
    await call(f, 'owner', `pm.mfg_record_measure($1, '[{"wall":"A","width_in":144.25,"height_in":96}]')`, [m]);
    // security review R6: the submitter (owner) does not also release it; someone else does
    expect(await callErr(f, 'owner', `pm.mfg_release_shop_drawing($1)`, [ids.sd])).toMatch(/PM_SOD_VIOLATION/);
    const r = await call<{ status: string; orders_approved: number }>(f, 'gm', `pm.mfg_release_shop_drawing($1)`, [ids.sd]);
    expect(r).toMatchObject({ status: 'RELEASED', orders_approved: 1 });
    expect((await one<{ drawings_approved_at: string | null }>(f, `select drawings_approved_at from pm.work_orders where id = $1`, [ids.wo])).drawings_approved_at).toBeTruthy();
    const log = await call<Array<{ revision: number; status: string }>>(f, 'owner', `pm.mfg_shop_drawing_log($1)`, [J1]);
    expect(log.map((x) => `${x.revision}:${x.status}`)).toEqual(['1:RELEASED', '0:SUPERSEDED']);
  });
  it('an approved cabinet selection over its allowance opens a priced upcharge CO', async () => {
    const s = await call<{ selections: number }>(f, 'owner', `pm.mfg_seed_cabinet_selections($1, $2, $3::jsonb)`, [J1, ids.bath, J([
      { category: 'Door style', title: 'Bath door style', allowance_cents: 0, options: [{ label: 'Shaker', upcharge_cents: 0 }, { label: 'Inset', upcharge_cents: 85000 }] }])]);
    expect(s.selections).toBe(1);
    const sel = await one<{ id: string; inset: string }>(f, `select s.id, (select o.id from pm.selection_options o where o.selection_id = s.id and o.label = 'Inset') as inset from pm.selections s where s.title = 'Bath door style'`);
    const eb = await call<{ status: string; blocked_reason: string }>(f, 'owner', `pm.mfg_move_eng_task($1, 'IN_PROGRESS')`,
      [await call<string>(f, 'owner', `pm.mfg_save_eng_task($1, null, $2::jsonb)`, [J1, J({ wbs_id: ids.bath, title: 'Bath drafting', est_hours: 10, slot_on: '2026-12-01' })])]);
    expect(eb).toMatchObject({ status: 'BLOCKED' });
    await call(f, 'owner', `pm.approve_selection($1, $2, 'Pat Owner')`, [sel.id, sel.inset]);
    const co = await one<{ stage: string; amount_cents: string }>(f, `select stage, amount_cents from pm.change_orders where selection_id = $1`, [sel.id]);
    expect(co.stage).toBe('PCO');
    expect(Number(co.amount_cents)).toBe(85000);
  });
  it('current-set rule: a shop seat without Documents edit sees only current revisions; the company can turn it off', async () => {
    const s1 = await newSet('owner', J2, 'Shop set 1');
    const r1 = await sheet('owner', J2, s1, 0, 'M-101');
    await as(f, 'owner', () => q(f.db, `select pm.drawing_publish_set($1)`, [s1]));
    const s2 = await newSet('owner', J2, 'Shop set 2');
    await sheet('owner', J2, s2, 0, 'M-101');
    await as(f, 'owner', () => q(f.db, `select pm.drawing_publish_set($1)`, [s2]));
    const seen = async (p: Persona) => (await as(f, p, () => q(f.db, `select id from pm.drawing_revisions where job_id = $1`, [J2]))).length;
    expect(await seen('owner')).toBe(2);
    const labor = await seen('labor');
    expect(labor).toBe(1);
    expect((await call<{ watermark: string | null }>(f, 'owner', `pm.mfg_sheet_status($1)`, [r1])).watermark).toMatch(/SUPERSEDED/);
    await call(f, 'owner', `pm.mfg_set_ops_settings($1, '{"current_set_only":false}')`, [L1]);
    expect(await seen('labor')).toBe(2);
    await call(f, 'owner', `pm.mfg_set_ops_settings($1, '{"current_set_only":true}')`, [L1]);
  });
});

describe('engineering, CO re-engineering, cut list, routings, traveler (MFG-18/20/22/25/32)', () => {
  it('the engineering queue: due = slot − buffer; a waived measure unblocks; hours roll up; drafter load per week', async () => {
    const t = await one<{ id: string; due_on: string }>(f, `select id, due_on::text from pm.mfg_eng_tasks where title = 'Bath drafting'`);
    expect(t.due_on).toBe('2026-11-26');
    const m = await call<string>(f, 'owner', `pm.mfg_schedule_measure($1, $2, current_date)`, [J1, ids.bath]);
    await call(f, 'owner', `pm.mfg_waive_measure($1, 'Builder plans are dimensioned; rough-in verified by GC')`, [m]);
    expect((await call<{ status: string }>(f, 'owner', `pm.mfg_move_eng_task($1, 'IN_PROGRESS')`, [t.id])).status).toBe('IN_PROGRESS');
    expect(Number((await call<{ actual_hours: number }>(f, 'owner', `pm.mfg_log_eng_hours($1, 2.5)`, [t.id])).actual_hours)).toBe(2.5);
    const b = await call<{ tasks: Array<{ id: string; actual_hours: number }>; load: Array<{ hours: number }>; capacity_hours_per_week: number }>(f, 'owner', `pm.mfg_eng_board($1)`, [L1]);
    expect(b.tasks.find((x) => x.id === t.id)).toBeTruthy();
    expect(b.load.length).toBeGreaterThan(0);
  });
  it('a CO approved on an area opens re-engineering, supersedes the released shop drawing, and flags the traveler', async () => {
    const co = (await one<{ id: string }>(f, `insert into pm.change_orders (org_id, job_id, title, stage, amount_cents, co_type) values ($1, $2, 'Add pantry pull-out', 'PCO', 120000, 'CLIENT') returning id`, [ORG_A, J1])).id;
    await call(f, 'owner', `pm.mfg_link_co_areas($1, $2::uuid[])`, [co, [ids.kitchen]]);
    await q(f.db, `update pm.change_orders set stage = 'APPROVED', approved_at = now() where id = $1`, [co]).catch(async () => q(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co]));
    const imp = await call<{ tasks: Array<{ title: string }>; orders: Array<{ work_order_id: string }> }>(f, 'owner', `pm.mfg_co_impact($1)`, [co]);
    expect(imp.tasks).toHaveLength(1);
    expect(imp.orders.map((o) => o.work_order_id)).toContain(ids.wo);
    const sd = await q<{ revision: number; status: string }>(f.db, `select revision, status from pm.mfg_shop_drawings where job_id = $1 and wbs_id = $2 order by revision`, [J1, ids.kitchen]);
    expect(sd.map((x) => `${x.revision}:${x.status}`)).toEqual(['0:SUPERSEDED', '1:SUPERSEDED', '2:DRAFTING']);
    const tr = await call<{ co_flag: boolean; operations: unknown[]; sheets: unknown[] }>(f, 'supervisor', `pm.mfg_traveler($1)`, [ids.wo]);
    expect(tr.co_flag).toBe(true);
    expect(tr.operations).toHaveLength(3);
  });
  it('cut list: edge banding per edge, sq ft, 4×8 sheets at the nest yield, editable edges while NEW', async () => {
    const cad = [
      { line_kind: 'ASSEMBLY', assembly_ref: 'B24', description: 'Base 24', qty: 2 },
      { line_kind: 'PART', assembly_ref: 'B24', part_code: 'B24-SIDE', description: 'Side', material: 'Maple ply', thickness_mm: 18, length_mm: 720, width_mm: 560, qty: 10, edgeband: 'L1', grain: 'LENGTH' },
      { line_kind: 'SHEET', description: 'Maple ply 18 mm', material: 'Maple ply', thickness_mm: 18, qty: 12 },
    ];
    const s = await call<{ import_id: string }>(f, 'owner', `pm.mfg_stage_cad_import($1, 'CABINET_VISION', 'kitchen.csv', $2::jsonb, $3)`, [J1, J(cad), ids.wo]);
    await call(f, 'owner', `pm.mfg_apply_cad_import($1)`, [s.import_id]);
    const c = await call<{ parts: Array<{ id: string; part_code: string; sqft: number; edge_lf: number; edges: { l1: string | null; l2: string | null } }>; materials: Array<{ material: string; sheets_4x8: number; sqft: number }> }>(f, 'owner', `pm.mfg_cut_list($1)`, [ids.wo]);
    const side = c.parts.find((p) => p.part_code === 'B24-SIDE')!;
    expect(Number(side.sqft)).toBeCloseTo((720 * 560 * 10) / 92903.04, 2);
    expect(Number(side.edge_lf)).toBeCloseTo((10 * 720) / 304.8, 2);
    expect(side.edges).toMatchObject({ l1: 'EB', l2: null });
    expect(Number(c.materials[0]!.sheets_4x8)).toBe(Math.ceil((720 * 560 * 10) / 92903.04 / 32 / 0.8));
    await call(f, 'owner', `pm.mfg_set_part_edges($1, '{"l1":"EB","l2":"EB"}', 'K-SIDE-1')`, [side.id]);
    const c2 = await call<{ parts: Array<{ part_code: string; edge_lf: number; label_id: string }> }>(f, 'owner', `pm.mfg_cut_list($1)`, [ids.wo]);
    expect(Number(c2.parts.find((p) => p.part_code === 'B24-SIDE')!.edge_lf)).toBeCloseTo((10 * 1440) / 304.8, 2);
  });
  it('a family routing template copies onto a new production order', async () => {
    await call(f, 'owner', `pm.mfg_set_family_routing($1, 'BASE', $2)`, [L1, ids.routing]);
    const wo2 = await call<string>(f, 'owner', `pm.create_production_order($1, 'Bath vanity', 1, null, null, $2)`, [J1, ids.bath]);
    expect(Number((await call<{ operations: number }>(f, 'owner', `pm.mfg_apply_family_routing($1, 'base')`, [wo2])).operations)).toBe(3);
    expect(await callErr(f, 'owner', `pm.mfg_apply_family_routing($1, 'WALL')`, [wo2])).toMatch(/PM_UNKNOWN_ROUTING/);
    ids.wo2 = wo2;
  });
});

describe('sheet goods, nests, outside processing, shipping + POD (MFG-40/42/43/44)', () => {
  it('sheet specs, allocation against free stock, and a cycle count posts the variance', async () => {
    await call(f, 'owner', `pm.mfg_save_sheet_spec($1, '{"material":"Maple ply","thickness_mm":18,"grain":"LENGTH","core":"VC"}')`, [L1]);
    const spec = await one<{ material_key: string; item_id: string }>(f, `select material_key, item_id from pm.mfg_sheet_specs where material = 'Maple ply'`);
    ids.sheetItem = spec.item_id;
    ids.sheetKey = spec.material_key;
    await call(f, 'owner', `pm.record_material_move('RECEIPT', $1, 30, null, $2)`, [spec.item_id, ids.sl]);
    await call(f, 'owner', `pm.mfg_allocate($1, $2, $3, 15)`, [J1, spec.item_id, ids.sl]);
    expect(await callErr(f, 'owner', `pm.mfg_allocate($1, $2, $3, 20)`, [J2, spec.item_id, ids.sl])).toMatch(/only 15 free/);
    const inv = await call<Array<{ material_key: string; on_hand: number; allocated: number }>>(f, 'owner', `pm.mfg_sheet_inventory($1)`, [L1]);
    expect(inv.find((x) => x.material_key === spec.material_key)).toMatchObject({ allocated: 15 });
    const cnt = await call<string>(f, 'owner', `pm.mfg_start_count($1)`, [ids.sl]);
    await call(f, 'owner', `pm.mfg_record_count($1, $2, 29)`, [cnt, spec.item_id]);
    expect((await call<{ adjustments: number }>(f, 'owner', `pm.mfg_post_count($1)`, [cnt])).adjustments).toBe(1);
  });
  it('issue from the nest: the nest quantity by default; over tolerance needs a reason and is flagged', async () => {
    const a = await call<{ issued: Array<{ material_key: string; issued_qty: number; flagged: boolean }> }>(f, 'owner', `pm.mfg_issue_from_nest($1, $2)`, [ids.wo, ids.sl]);
    expect(a.issued[0]).toMatchObject({ material_key: ids.sheetKey, flagged: false });
    expect(Number(a.issued[0]!.issued_qty)).toBe(12);
    expect(await callErr(f, 'owner', `pm.mfg_issue_from_nest($1, $2, $3::jsonb)`, [ids.wo, ids.sl, J([{ material_key: ids.sheetKey, qty: 14 }])])).toMatch(/over the nest/);
    const b = await call<{ issued: Array<{ flagged: boolean }> }>(f, 'owner', `pm.mfg_issue_from_nest($1, $2, $3::jsonb, 'Recut two sides after a tear-out')`, [ids.wo, ids.sl, J([{ material_key: ids.sheetKey, qty: 14 }])]);
    expect(b.issued[0]!.flagged).toBe(true);
    expect((await one<{ status: string }>(f, `select status from pm.mfg_allocations where job_id = $1 limit 1`, [J1])).status).toBe('ISSUED');
  });
  it('outside processing gets its own draft PO and shows late against its due date', async () => {
    const op = await one<{ id: string }>(f, `select id from pm.wo_operations where work_order_id = $1 order by seq offset 1 limit 1`, [ids.wo]);
    const o = await call<{ outside_op_id: string; commitment_id: string }>(f, 'owner', `pm.mfg_send_outside($1, $2, $3::jsonb)`, [op.id, ids.finisher, J({ amount_cents: 45000, due_back_on: '2026-01-02' })]);
    expect(o.commitment_id).toBeTruthy();
    expect((await one<{ status: string; commitment_type: string }>(f, `select status, commitment_type from pm.commitments where id = $1`, [o.commitment_id]))).toMatchObject({ status: 'DRAFT', commitment_type: 'PO' });
    const b = await call<Array<{ id: string; late: boolean }>>(f, 'owner', `pm.mfg_outside_board($1)`, [L1]);
    expect(b.find((x) => x.id === o.outside_op_id)?.late).toBe(true);
    await call(f, 'owner', `pm.mfg_receive_outside($1)`, [o.outside_op_id]);
  });
  it('a packing list from the area\'s cabinets; load check; delivery with a signature, a damaged cabinet opens a remake', async () => {
    const s = await call<{ shipment_id: string; items: number }>(f, 'owner', `pm.mfg_create_shipment($1, $2::uuid[], '{"promised_on":"2030-01-01","truck":"Box truck 2"}')`, [J1, [ids.kitchen]]);
    expect(s.items).toBe(1);
    ids.ship = s.shipment_id;
    const c1 = await call<{ ok: boolean; not_loaded: number }>(f, 'owner', `pm.mfg_check_load($1)`, [ids.ship]);
    expect(c1).toMatchObject({ ok: false, not_loaded: 1 });
    const items = (await call<{ items: Array<{ id: string }> }>(f, 'owner', `pm.mfg_shipment_detail($1)`, [ids.ship])).items.map((i) => i.id);
    await call(f, 'owner', `pm.mfg_mark_items($1, $2::uuid[], 'loaded')`, [ids.ship, items]);
    expect((await call<{ not_loaded: number }>(f, 'owner', `pm.mfg_check_load($1)`, [ids.ship])).not_loaded).toBe(0);
    await call(f, 'owner', `pm.mfg_mark_items($1, $2::uuid[], 'exception', true, 'DAMAGED')`, [ids.ship, items]);
    expect(await callErr(f, 'owner', `pm.mfg_deliver_shipment($1, '', null)`, [ids.ship])).toMatch(/PM_INVALID/);
    // security review M5: the signature / photos are files of this org on this job (or the caller's own new upload)
    expect(await callErr(f, 'owner', `pm.mfg_deliver_shipment($1, 'Site super', $2)`, [ids.ship, await upload('gm', 'sig.png')])).toMatch(/PM_INVALID: that delivery signature/);
    const sig = await upload('owner', 'sig.png');
    const d = await call<{ status: string; remakes: number; progress_pending: boolean }>(f, 'owner', `pm.mfg_deliver_shipment($1, 'Site super', $2)`, [ids.ship, sig]);
    expect(d).toMatchObject({ status: 'DELIVERED', remakes: 1, progress_pending: false });
    expect(await q(f.db, `select 1 from pm.document_links where document_id = $1 and job_id = $2`, [sig, J1])).toHaveLength(1);
    const board = await call<Array<{ id: string; on_time: boolean | null }>>(f, 'owner', `pm.mfg_shipment_board($1)`, [L1]);
    expect(board.find((x) => x.id === ids.ship)?.on_time).toBe(true);
  });
});

describe('billing, install, punch, cost, WIP, dashboard, portal (MFG-46..55)', () => {
  it('stored materials bill in the stored column; the delivery bills the area less what was stored; once only', async () => {
    const m = await call<string>(f, 'owner', `pm.mfg_add_stored_material($1, $2::jsonb)`, [J1, J({ wbs_id: ids.kitchen, description: 'Finished kitchen boxes', stored_at: 'Shop bay 3', value_cents: 30000, insured: true })]);
    const b = await call<{ billing_request_id: string; amount_cents: number }>(f, 'owner', `pm.mfg_bill_stored_materials($1, $2::uuid[])`, [J1, [m]]);
    expect(Number(b.amount_cents)).toBe(30000);
    expect(Number((await one<{ s: string }>(f, `select sum(stored_materials_cents)::text as s from pm.billing_request_lines where billing_request_id = $1`, [b.billing_request_id])).s)).toBe(30000);
    const s = await call<{ amount_cents: number }>(f, 'owner', `pm.mfg_bill_shipment($1)`, [ids.ship]);
    expect(Number(s.amount_cents)).toBe(100000 - 30000);
    expect(await callErr(f, 'owner', `pm.mfg_bill_shipment($1)`, [ids.ship])).toMatch(/PM_DUPLICATE/);
    const bb = await call<{ stored: Array<{ status: string }>; requests: unknown[] }>(f, 'owner', `pm.mfg_billing_board($1)`, [J1]);
    expect(bb.stored[0]!.status).toBe('DELIVERED');
    expect(bb.requests.length).toBeGreaterThanOrEqual(2);
  });
  it('installer: today\'s installs, punch with a GC back-charge (billed) and a vendor back-charge (needs the vendor), customer sign-off', async () => {
    const crew = await one<{ id: string }>(f, `insert into pm.crews (org_id, location_id, name, kind) values ($1, $2, 'Install A', 'INSTALL') returning id`, [ORG_A, L1]);
    const inst = await call<{ install_id: string }>(f, 'owner', `pm.mfg_schedule_install($1, current_date, current_date + 1, $2, null, $3)`, [J1, crew.id, ids.kitchen]);
    const home = await call<{ installs: Array<{ install_id: string; area: string }> }>(f, 'owner', `pm.mfg_installer_home($1)`, [L1]);
    expect(home.installs.find((i) => i.install_id === inst.install_id)?.area).toBe('Kitchen');
    expect(await callErr(f, 'owner', `pm.mfg_log_install_time($1, 4, 'Kitchen')`, [inst.install_id])).toMatch(/PM_NO_EMPLOYEE/);
    // security review M4: the crew logs it (or dispatch:edit), idempotent by command, at most 16 h a day
    const who = 'supervisor' as const;
    const cmd = 'c0ffee00-0000-4000-8000-000000000001';
    expect(await callErr(f, who, `pm.mfg_log_install_time($1, 4, 'Kitchen', null, $2)`, [inst.install_id, cmd])).toMatch(/your crew is on|PM_FORBIDDEN/);
    await q(f.db, `insert into pm.crew_members (org_id, crew_id, employee_id) values ($1, $2, $3)`, [ORG_A, crew.id, f.employee[who]]);
    const t1 = await call<{ time_entry_id: string; replayed: boolean }>(f, who, `pm.mfg_log_install_time($1, 4, 'Kitchen', null, $2)`, [inst.install_id, cmd]);
    expect(t1.replayed).toBe(false);
    expect(await call<{ time_entry_id: string; replayed: boolean }>(f, who, `pm.mfg_log_install_time($1, 4, 'Kitchen', null, $2)`, [inst.install_id, cmd])).toEqual({ time_entry_id: t1.time_entry_id, replayed: true });
    expect(await callErr(f, who, `pm.mfg_log_install_time($1, 13, 'Kitchen', null, $2)`, [inst.install_id, 'c0ffee00-0000-4000-8000-000000000002'])).toMatch(/at most 16 hours a day/);
    const p = await call<{ punch_id: string }>(f, 'owner', `pm.mfg_add_punch($1, $2::jsonb)`, [J1, J({ title: 'Drywall damage behind sink base', room: 'Kitchen', wbs_id: ids.kitchen, responsible: 'GC' })]);
    const bc = await call<{ billing_request_id: string }>(f, 'owner', `pm.mfg_backcharge($1, 'GC', 25000)`, [p.punch_id]);
    expect(bc.billing_request_id).toBeTruthy();
    expect(await callErr(f, 'owner', `pm.mfg_backcharge($1, 'VENDOR', 5000)`, [p.punch_id])).toMatch(/PM_UNKNOWN_VENDOR/);
    expect(await callErr(f, 'owner', `pm.mfg_install_signoff($1, 'Homeowner', null, $2::uuid[])`, [inst.install_id, [await upload('gm', 'photo.jpg')]])).toMatch(/PM_INVALID: that install photo/);
    const so = await call<{ open_punch: number }>(f, 'owner', `pm.mfg_install_signoff($1, 'Homeowner', $2)`, [inst.install_id, await upload('owner', 'sig.png')]);
    expect(so.open_punch).toBe(1);
    const pb = await call<Array<{ id: string; backcharge_status: string; backcharge_cents: number | null }>>(f, 'owner', `pm.mfg_punch_board($1)`, [J1]);
    expect(pb.find((x) => x.id === p.punch_id)).toMatchObject({ backcharge_status: 'BILLED', backcharge_cents: 25000 });
    const w = await call<{ work_order_id: string; punch_id: string }>(f, 'owner', `pm.mfg_open_warranty($1, 'Door out of adjustment')`, [J1]);
    expect(w.work_order_id).toBeTruthy();
  });
  it('job cost by area and bucket; WIP; the owner dashboard; money hidden without the capability', async () => {
    const cc = await costCode(f, '06-400', 'Architectural woodwork', 'MATERIALS');
    expect(await call<number>(f, 'owner', `pm.mfg_set_cost_buckets($1, $2::jsonb)`, [L1, J([{ cost_code_id: cc, bucket: 'MATERIAL' }])])).toBe(1);
    const jc = await call<{ rows: Array<{ area: string; bucket: string; estimate_cents: number }>; totals: { estimate_cents: number } }>(f, 'owner', `pm.mfg_job_cost($1)`, [J1]);
    expect(jc.rows.some((r) => r.area === 'Kitchen')).toBe(true);
    expect(Number(jc.totals.estimate_cents)).toBeGreaterThan(0);
    const wip = await call<Array<{ job_id: string; contract_cents: number }>>(f, 'owner', `pm.mfg_wip($1)`, [L1]);
    expect(wip.find((r) => r.job_id === J1)).toBeTruthy();
    expect(await call<number>(f, 'owner', `pm.mfg_pin_wip($1, '2026-10-31')`, [L1])).toBeGreaterThanOrEqual(1);
    const dash = await call<{ on_time_pct: number; win_rate: number; amounts_visible: { financials: boolean } }>(f, 'owner', `pm.mfg_owner_dashboard($1)`, [L1]);
    expect(Number(dash.on_time_pct)).toBe(1);
    expect(Number(dash.win_rate)).toBe(1);
    expect(await callErr(f, 'labor', `pm.mfg_job_cost($1)`, [J1])).toMatch(forbidden);
    const area = await call<{ areas: Array<{ wbs_id: string; gates: { measure_done: boolean } }> }>(f, 'owner', `pm.mfg_area_board($1)`, [J1]);
    expect(area.areas).toHaveLength(2);
    expect(area.areas.every((x) => x.gates.measure_done)).toBe(true);
    const cfg = await call<{ settings: { current_set_only: boolean } }>(f, 'owner', `pm.mfg_ops_config($1)`, [L1]);
    expect(cfg.settings.current_set_only).toBe(true);
  });
  it('the portal feed is service-only: no member can call it', async () => {
    expect(await callErr(f, 'owner', `pm.mfg_portal_job_feed($1, $2)`, [ORG_A, J1])).toMatch(/permission denied/);
    const feed = await one<{ r: { shop_drawings: unknown[]; deliveries: unknown[] } }>(f, `select pm.mfg_portal_job_feed($1, $2) as r`, [ORG_A, J1]);
    expect(feed.r.deliveries).toHaveLength(1);
  });
});
