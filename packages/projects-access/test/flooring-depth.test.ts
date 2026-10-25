/**
 * Flooring depth (migration 1122): the UoM engine (SQL ≡ lib/flooring/uom.ts), measure import →
 * quote by room with tax mode and missed-item flags, roll / dye-lot inventory with cut tickets,
 * remnants and lot-mix warnings, the job-readiness gate and SF install capacity, installer pay
 * tickets (piece rate, splits, job minimum, chargebacks; 1099 → payable held, W-2 → PIECE time).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, errorOf, q, type Fixture, ORG_A, L1, J1, J2 } from './fixture';
import { call, callErr, forbidden, one, registryClean, setupIndustry, stockLocation, vendor } from './industry';
import { materialQty, type FlooringUom } from '../../../apps/projects/src/lib/flooring/uom';

let f: Fixture;
const ids: Record<string, string> = {};

beforeAll(async () => {
  f = await setupIndustry('flooring-depth');
  ids.sl = await stockLocation(f, 'DEPOT');
  const item = await one<{ id: string }>(f, `select pm.ensure_part_item($1, 'CPT-SAXONY', 'Saxony carpet') as id`, [ORG_A]);
  await as(f, 'owner', async () => {
    const ins = async (sql: string, p: unknown[]) => (await q<{ id: string }>(f.db, sql, p))[0]!.id;
    ids.carpet = await ins(`insert into pm.flr_products (location_id, item_id, style, color, category, sell_uom, roll_width_ft, waste_pct, cost_cents, price_retail_cents)
                            values ($1, $2, 'Saxony', 'Oat', 'CARPET', 'SY', 12, 0.10, 1500, 3200) returning id`, [L1, item.id]);
    ids.pad = await ins(`insert into pm.flr_products (location_id, style, category, sell_uom, cost_cents, price_retail_cents) values ($1, '8 lb pad', 'PAD', 'SY', 300, 650) returning id`, [L1]);
    ids.lvp = await ins(`insert into pm.flr_products (location_id, style, color, category, sell_uom, carton_sf, cost_cents, price_retail_cents) values ($1, 'Oak plank', 'Natural', 'LVP', 'CARTON', 23.68, 5500, 9900) returning id`, [L1]);
    await q(f.db, `insert into pm.flr_labor_rates (location_id, code, description, unit, applies_to, categories, sell_cents, pay_cents, job_minimum_pay_cents) values
                     ($1, 'CPT_INSTALL', 'Carpet install', 'SY', 'FLOOR', '{CARPET}', 900, 600, 0),
                     ($1, 'LVP_INSTALL', 'LVP install', 'SF', 'FLOOR', '{LVP}', 250, 150, 15000),
                     ($1, 'STAIR', 'Stairs, per step', 'STEP', 'STAIRS', '{}', 2500, 1500, 0),
                     ($1, 'TACK', 'Tack strip', 'LF', 'PERIMETER', '{CARPET}', 75, 40, 0)`, [L1]);
  });
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('UoM engine (FLR-09): SQL and the browser agree', () => {
  it('on 300 random inputs across every unit', async () => {
    const uoms: FlooringUom[] = ['SF', 'SY', 'ROLL', 'CARTON', 'LF', 'STEP', 'EA'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 300; i++) {
      const uom = uoms[i % uoms.length]!;
      const inp = {
        uom, sf: Math.round(rnd() * 200000) / 100, lf: Math.round(rnd() * 50000) / 100, each: Math.round(rnd() * 3000) / 100,
        waste: Math.round(rnd() * 2500) / 10000, cartonSf: Math.round((5 + rnd() * 30) * 100) / 100, rollWidthFt: [12, 13.5, 15, 6.5][i % 4]!,
      };
      const sql = await one<{ r: { qty: number } }>(f, `select pm.flr_material_qty($1, $2, $3, $4, $5, $6, $7) as r`,
        [inp.uom, inp.sf, inp.lf, inp.each, inp.waste, inp.cartonSf, inp.rollWidthFt]);
      expect(Number(sql.r.qty), JSON.stringify(inp)).toBe(materialQty(inp).qty);
    }
  });
});

describe('measure import → quote by room, tax mode (FLR-08/15/16, make-or-break 7)', () => {
  it('a MeasureSquare file becomes a measure with rooms (waste defaults by category)', async () => {
    const rooms = [
      { room: 'Bedroom 2', area_kind: 'FLOOR', category: 'CARPET', sqft: 180, linear_ft: 54 },
      { room: 'Stairs', area_kind: 'STAIRS', category: 'CARPET', sqft: 40, each_count: 13 },
      { room: 'Kitchen', area_kind: 'FLOOR', category: 'LVP', sqft: 220 },
    ];
    const r = await call<{ measure_id: string; rooms: number; sqft: number }>(f, 'pm', `pm.flr_import_measure($1, 'MEASURESQUARE', $2::jsonb, 'MSQ-0042')`, [J1, JSON.stringify(rooms)]);
    expect(r).toMatchObject({ rooms: 3, sqft: 440 });
    ids.measure = r.measure_id;
    const k = await one<{ waste_pct: string }>(f, `select waste_pct from pm.measure_areas where measure_id = $1 and room_name = 'Kitchen'`, [ids.measure]);
    expect(Number(k.waste_pct)).toBe(0.08);
  });
  it('the quote prices material with waste, pad, labor on net, stairs per step and tack strip; flags the misses', async () => {
    const areas = await q<{ id: string; room_name: string }>(f.db, `select id, room_name from pm.measure_areas where measure_id = $1`, [ids.measure]);
    const a = (n: string) => areas.find((x) => x.room_name === n)!.id;
    const choices = [
      { area_id: a('Bedroom 2'), product_id: ids.carpet, pad_product_id: ids.pad, tier: 'BETTER' },
      { area_id: a('Stairs'), product_id: ids.carpet },
      { area_id: a('Kitchen'), product_id: ids.lvp },
    ];
    const r = await call<{ estimate_id: string; lines: number; flags: Array<{ code: string; room: string }>; total_cents: number }>(
      f, 'pm', `pm.flr_build_quote($1, $2, $3::jsonb)`, [J1, ids.measure, JSON.stringify(choices)]);
    ids.estimate = r.estimate_id;
    expect(r.lines).toBe(8);
    expect(r.flags.map((x) => x.code).sort()).toEqual(['CARPET_NO_PAD', 'HARD_SURFACE_NO_TRANSITION']);
    const lines = await q<{ description: string; qty: string; amount_cents: string; line_class: string }>(f.db,
      `select el.description, el.qty, el.amount_cents, fq.line_class from pm.estimate_lines el join pm.flr_quote_lines fq on fq.estimate_line_id = el.id where el.estimate_id = $1 order by el.line_no`, [ids.estimate]);
    const bedroom = lines.find((l) => l.description.startsWith('Bedroom 2 — Saxony'))!;
    const expected = materialQty({ uom: 'SY', sf: 180, waste: 0.1, rollWidthFt: 12 });
    expect(Number(bedroom.qty)).toBe(expected.qty);
    expect(Number(bedroom.amount_cents)).toBe(Math.round(expected.qty * 3200));
    expect(Number(lines.find((l) => l.description.startsWith('Kitchen — Oak'))!.qty)).toBe(11);
    expect(Number(lines.find((l) => l.description.startsWith('Stairs — Stairs, per step'))!.amount_cents)).toBe(13 * 2500);
    expect(Number(lines.find((l) => l.description.startsWith('Kitchen — LVP install'))!.amount_cents)).toBe(220 * 250);
    const total = lines.reduce((s, l) => s + Number(l.amount_cents), 0);
    expect(r.total_cents).toBe(total);
  });
  it('tax mode is per job: exempt needs the certificate; the quote reports it', async () => {
    expect(await callErr(f, 'pm', `pm.flr_set_job_settings($1, 'EXEMPT')`, [J1])).toMatch(/certificate/);
    await call(f, 'pm', `pm.flr_set_job_settings($1, 'REAL_PROPERTY', 'BUILDER', null, null, 0)`, [J1]);
    const areas = await q<{ id: string }>(f.db, `select id from pm.measure_areas where measure_id = $1 and room_name = 'Kitchen'`, [ids.measure]);
    const r = await call<{ tax_mode: string; price_level: string }>(f, 'pm', `pm.flr_build_quote($1, $2, $3::jsonb, null, 'Option B: kitchen only')`,
      [J1, ids.measure, JSON.stringify([{ area_id: areas[0]!.id, product_id: ids.lvp }])]);
    expect(r).toMatchObject({ tax_mode: 'REAL_PROPERTY', price_level: 'BUILDER' });
    expect(await callErr(f, 'labor', `pm.flr_build_quote($1, $2, '[]'::jsonb)`, [J2, ids.measure])).toMatch(forbidden);
  });
});

describe('rolls, dye lots, cut tickets, remnants (FLR-24/25/27, make-or-break 6)', () => {
  it('rolls received by lot; a cut ticket reserves length, refuses an overdraw, warns on a lot mix', async () => {
    const recv = (roll: string, lot: string, len: number) =>
      call<string>(f, 'owner', `pm.flr_receive_roll($1, $2, $3, $4, 144, $5, $6, 'A-01', 1500)`, [L1, ids.carpet, roll, lot, len, ids.sl]);
    ids.r1 = await recv('R-1', 'L-A', 1200);
    ids.r2 = await recv('R-2', 'L-B', 600);
    ids.r3 = await recv('R-3', 'L-A', 200);
    ids.r4 = await recv('R-4', 'L-A', 100);
    expect(await callErr(f, 'dispatcher', `pm.flr_receive_roll($1, $2, 'R-9', 'L-Z', 144, 100)`, [L1, ids.carpet])).toMatch(forbidden);
    expect(await callErr(f, 'supervisor', `pm.flr_receive_roll($1, $2, 'R-9', 'L-Z', 144, 100, null, null, 10)`, [L1, ids.carpet])).toMatch(forbidden);
    const t = await call<{ ticket_id: string; warnings: unknown[] }>(f, 'pm', `pm.flr_create_cut_ticket($1, $2::jsonb)`,
      [J1, JSON.stringify([{ roll_id: ids.r1, room: 'Bedroom 2', length_in: 400 }, { roll_id: ids.r1, room: 'Stairs', length_in: 300 }])]);
    expect(t.warnings).toEqual([]);
    ids.ticket = t.ticket_id;
    expect(await callErr(f, 'pm', `pm.flr_create_cut_ticket($1, $2::jsonb)`, [J1, JSON.stringify([{ roll_id: ids.r2, length_in: 700 }])])).toMatch(/PM_FLR_ROLL_SHORT/);
    const t2 = await call<{ warnings: Array<{ code: string; lots: string[] }> }>(f, 'pm', `pm.flr_create_cut_ticket($1, $2::jsonb)`, [J1, JSON.stringify([{ roll_id: ids.r2, length_in: 100 }])]);
    expect(t2.warnings[0]).toMatchObject({ code: 'LOT_MIX', lots: ['L-A', 'L-B'] });
    expect((await call<{ warnings: unknown[] }>(f, 'pm', `pm.flr_lot_check($1)`, [J1])).warnings).toHaveLength(1);
  });
  it('each cut updates remaining length and issues the material at the lot; drops become remnants or scrap', async () => {
    const cuts = await q<{ id: string; seq: number }>(f.db, `select id, seq from pm.flr_cuts where ticket_id = $1 order by seq`, [ids.ticket]);
    const c1 = await call<{ remaining_in: number; roll_status: string; move_id: string }>(f, 'pm', `pm.flr_record_cut($1)`, [cuts[0]!.id]);
    expect(c1).toMatchObject({ roll_status: 'RESERVED' });
    expect(Number(c1.remaining_in)).toBe(800);
    expect(c1.move_id).toBeTruthy();
    const c2 = await call<{ remaining_in: number; roll_status: string }>(f, 'pm', `pm.flr_record_cut($1, 310)`, [cuts[1]!.id]);
    expect(c2.roll_status).toBe('AVAILABLE');
    expect(Number(c2.remaining_in)).toBe(490);
    expect((await one<{ status: string }>(f, `select status from pm.flr_cut_tickets where id = $1`, [ids.ticket])).status).toBe('CUT');
    const mk = async (roll: string, len: number) => {
      const t = await call<{ ticket_id: string }>(f, 'pm', `pm.flr_create_cut_ticket($1, $2::jsonb)`, [J1, JSON.stringify([{ roll_id: roll, length_in: len }])]);
      const c = await one<{ id: string }>(f, `select id from pm.flr_cuts where ticket_id = $1`, [t.ticket_id]);
      return call<{ roll_status: string; scrap_in: number; remaining_in: number }>(f, 'pm', `pm.flr_record_cut($1)`, [c.id]);
    };
    expect(await mk(ids.r3, 120)).toMatchObject({ roll_status: 'REMNANT' });
    const scrap = await mk(ids.r4, 90);
    expect(scrap.roll_status).toBe('DEPLETED');
    expect(Number(scrap.scrap_in)).toBe(10);
    const s = await call<{ rolls: Array<{ roll_id: string; status: string }> }>(f, 'pm', `pm.flr_suggest_roll($1, $2, 50, $3)`, [L1, ids.carpet, J1]);
    expect(s.rolls[0]).toMatchObject({ roll_id: ids.r3, status: 'REMNANT' });
  });
});

describe('job readiness gate + install board with SF capacity (FLR-29/30)', () => {
  it('a job that is not ready cannot be booked without a reason; checks make it ready', async () => {
    await as(f, 'owner', () => q(f.db, `insert into pm.flr_capacity (location_id, sf_per_day, jobs_per_day) values ($1, 1000, 3)`, [L1]));
    const rd = await call<{ ready: boolean; checks: Array<{ key: string; ok: boolean }> }>(f, 'dispatcher', `pm.flr_job_readiness($1)`, [J2]);
    expect(rd.ready).toBe(false);
    expect(await callErr(f, 'dispatcher', `pm.flr_book_install($1, current_date + 7, 300)`, [J2])).toMatch(/PM_FLR_NOT_READY/);
    for (const k of ['MOISTURE', 'OLD_FLOOR_REMOVED']) {
      await call(f, 'supervisor', `pm.flr_record_site_check($1, $2, true, 2.1)`, [J1, k]);
      await call(f, 'owner', `pm.flr_record_site_check($1, $2, true)`, [J2, k]);
    }
    await call(f, 'owner', `pm.flr_set_job_settings($1, 'RETAIL', 'RETAIL', null, null, 0)`, [J2]);
    expect((await call<{ ready: boolean }>(f, 'dispatcher', `pm.flr_job_readiness($1)`, [J1])).ready).toBe(true);
    expect((await call<{ ready: boolean }>(f, 'dispatcher', `pm.flr_job_readiness($1)`, [J2])).ready).toBe(true);
  });
  it('SF capacity per day is enforced; an override with a reason is logged; the board shows the overbook', async () => {
    const b1 = await call<{ booking_id: string; full_days: unknown[] }>(f, 'dispatcher', `pm.flr_book_install($1, current_date + 7, 800)`, [J1]);
    expect(b1.full_days).toEqual([]);
    expect(await callErr(f, 'dispatcher', `pm.flr_book_install($1, current_date + 7, 300)`, [J2])).toMatch(/PM_FLR_CAPACITY_FULL/);
    const b2 = await call<{ full_days: unknown[] }>(f, 'dispatcher', `pm.flr_book_install($1, current_date + 7, 300, 1, null, 'Customer moving in Friday')`, [J2]);
    expect(b2.full_days).toHaveLength(1);
    const board = await call<{ days: Array<{ booked_sf: number; over: boolean }>; bookings: unknown[] }>(f, 'dispatcher', `pm.flr_install_board($1, current_date + 7, current_date + 7)`, [L1]);
    expect(Number(board.days[0]!.booked_sf)).toBe(1100);
    expect(board.days[0]!.over).toBe(true);
    expect(board.bookings).toHaveLength(2);
    expect(await callErr(f, 'pm', `pm.flr_book_install($1, current_date + 8, 10)`, [J1])).toMatch(forbidden);
  });
});

describe('installer pay tickets + chargebacks (FLR-34/35, make-or-break 5)', () => {
  it('a completion splits piece pay across a W-2 and a 1099 installer and flags a tally over the measure', async () => {
    ids.sub = await vendor(f, 'Ace Install LLC');
    const r = await call<{ tickets: Array<{ ticket_id: string; worker_type: string; gross_cents: number; over_measured: boolean }> }>(f, 'supervisor', `pm.flr_ticket_from_completion($1, current_date, $2::jsonb, $3::jsonb)`,
      [J1, JSON.stringify([{ labor_code: 'CPT_INSTALL', qty: 20 }, { labor_code: 'STAIR', qty: 14 }]),
       JSON.stringify([{ worker_type: 'W2', employee_id: f.employee.labor, pct: 0.6, hours_worked: 6 }, { worker_type: '1099', vendor_id: ids.sub, pct: 0.4 }])]);
    const w2 = r.tickets.find((t) => t.worker_type === 'W2')!;
    const sub = r.tickets.find((t) => t.worker_type === '1099')!;
    // the supervisor who records the completion does not hold labor rates: no pay comes back (security review H1)
    expect([w2.gross_cents, sub.gross_cents]).toEqual([null, null]);
    const g = await q<{ worker_type: string; gross_cents: string }>(f.db, `select worker_type, gross_cents from pm.flr_pay_tickets where id = any($1::uuid[]) order by worker_type`, [[w2.ticket_id, sub.ticket_id]]);
    expect(g.map((x) => Number(x.gross_cents))).toEqual([13200, 19800]);
    expect(w2.over_measured).toBe(true);
    ids.w2 = w2.ticket_id; ids.t1099 = sub.ticket_id;
    expect(await callErr(f, 'supervisor', `pm.flr_ticket_from_completion($1, current_date, '[{"labor_code":"STAIR","qty":1}]'::jsonb, '[{"worker_type":"W2","employee_id":"${f.employee.labor}","pct":0.5}]'::jsonb)`, [J1])).toMatch(/100%/);
  });
  it('the job minimum tops up a small ticket', async () => {
    const r = await call<{ tickets: Array<{ ticket_id: string; gross_cents: number | null }> }>(f, 'supervisor', `pm.flr_ticket_from_completion($1, current_date, '[{"labor_code":"LVP_INSTALL","qty":10}]'::jsonb, $2::jsonb)`,
      [J1, JSON.stringify([{ worker_type: 'W2', employee_id: f.employee.labor, pct: 1, hours_worked: 2 }])]);
    expect(Number((await one<{ gross_cents: string }>(f, `select gross_cents from pm.flr_pay_tickets where id = $1`, [r.tickets[0]!.ticket_id])).gross_cents)).toBe(15000);
  });
  it('finalize → approve (not by the finalizer): W-2 becomes a PIECE time entry; 1099 a held payable net of the acknowledged chargeback', async () => {
    await call(f, 'supervisor', `pm.flr_finalize_pay_ticket($1)`, [ids.w2]);
    expect(await callErr(f, 'supervisor', `pm.flr_approve_pay_ticket($1)`, [ids.w2])).toMatch(/PM_SOD_VIOLATION/);
    const a = await call<{ posting: string; time_entry_id: string; net_cents: number }>(f, 'pm', `pm.flr_approve_pay_ticket($1)`, [ids.w2]);
    expect(a.posting).toBe('TIME_ENTRY');
    const te = await one<{ pay_type: string; hours: string; units: string; approval_state: string }>(f, `select pay_type, hours, units, approval_state from pm.time_entries where id = $1`, [a.time_entry_id]);
    expect(te).toMatchObject({ pay_type: 'PIECE', approval_state: 'SUBMITTED' });
    expect([Number(te.hours), Number(te.units)]).toEqual([6, 198]);
    const cb = await call<string>(f, 'supervisor', `pm.flr_propose_chargeback($1, '1099', $2, 'CALLBACK', 'Seam peaking in bedroom 2', 5000, $3)`, [L1, ids.sub, J1]);
    expect(await callErr(f, 'supervisor', `pm.flr_acknowledge_chargeback($1)`, [cb])).toMatch(/who acknowledged/);
    await call(f, 'supervisor', `pm.flr_acknowledge_chargeback($1, 'Joe Ace (phone)')`, [cb]);
    await call(f, 'supervisor', `pm.flr_finalize_pay_ticket($1)`, [ids.t1099]);
    const b = await call<{ posting: string; net_cents: number; chargebacks_cents: number }>(f, 'pm', `pm.flr_approve_pay_ticket($1)`, [ids.t1099]);
    expect(b).toMatchObject({ posting: 'PAYABLE_HELD', net_cents: 8200, chargebacks_cents: 5000 });
    const t = await one<{ payable_payload: { amount_cents: number; event_type: string } }>(f, `select payable_payload from pm.flr_pay_tickets where id = $1`, [ids.t1099]);
    expect(t.payable_payload).toMatchObject({ amount_cents: 8200, event_type: 'JOB_PAYABLE_REQUEST' });
    expect((await one<{ status: string }>(f, `select status from pm.flr_chargebacks where id = $1`, [cb])).status).toBe('APPLIED');
  });
  it('an installer sees only their own tickets and pay', async () => {
    const mine = await as(f, 'labor', () => q<{ worker_type: string }>(f.db, `select distinct worker_type from pm.flr_pay_tickets`));
    expect(mine).toEqual([{ worker_type: 'W2' }]);
    const rate = await as(f, 'labor', () => q(f.db, `select 1 from pm.flr_pay_ticket_lines`));
    expect(rate.length).toBeGreaterThan(0);
    const masked = await as(f, 'supervisor', () => q<{ pay_cents: string | null }>(f.db, `select pay_cents from pm.v_flr_labor_rates_masked limit 1`));
    expect(masked[0]!.pay_cents).toBeNull();
  });
});

describe('security review 1122 H1: installer pay is labor-rates money; 1099 tickets and waivers belong to AP', () => {
  it('a supervisor with time:approve sees the tickets but not the pay, and cannot read the base money columns', async () => {
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select gross_cents from pm.flr_pay_tickets limit 1`))).toMatch(/permission denied/);
    const t = await as(f, 'supervisor', () => q<{ gross_cents: string | null; net_cents: string | null; payable_payload: unknown }>(f.db, `select gross_cents, net_cents, payable_payload from pm.v_flr_pay_tickets_masked`));
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.gross_cents == null && x.net_cents == null && x.payable_payload == null)).toBe(true);
    const l = await as(f, 'supervisor', () => q<{ rate_cents: string | null; amount_cents: string | null }>(f.db, `select rate_cents, amount_cents from pm.v_flr_pay_ticket_lines_masked`));
    expect(l.every((x) => x.rate_cents == null && x.amount_cents == null)).toBe(true);
    const c = await as(f, 'supervisor', () => q<{ amount_cents: string | null }>(f.db, `select amount_cents from pm.v_flr_chargebacks_masked`));
    expect(c.every((x) => x.amount_cents == null)).toBe(true);
    const own = await as(f, 'labor', () => q<{ gross_cents: string | null }>(f.db, `select gross_cents from pm.v_flr_pay_tickets_masked`));
    expect(own.every((x) => x.gross_cents != null)).toBe(true);
  });
  it('a 1099 ticket needs an AP approver (commitments or billing approve) who did not make it; a W-2 ticket stays on time approval', async () => {
    const r = await call<{ tickets: Array<{ ticket_id: string; worker_type: string }> }>(f, 'gm', `pm.flr_ticket_from_completion($1, current_date, '[{"labor_code":"LVP_INSTALL","qty":20}]'::jsonb, $2::jsonb)`,
      [J1, JSON.stringify([{ worker_type: '1099', vendor_id: ids.sub, pct: 1 }])]);
    const id = r.tickets[0]!.ticket_id;
    await call(f, 'pm', `pm.flr_finalize_pay_ticket($1)`, [id]);
    expect(await callErr(f, 'supervisor', `pm.flr_approve_pay_ticket($1)`, [id])).toMatch(forbidden);
    expect(await callErr(f, 'gm', `pm.flr_approve_pay_ticket($1)`, [id])).toMatch(/PM_SOD_VIOLATION/);
    const ok = await call<{ posting: string }>(f, 'owner', `pm.flr_approve_pay_ticket($1)`, [id]);
    expect(ok.posting).toBe('PAYABLE_HELD');
  });
  it('waiving a chargeback needs commitments or billing approve and is never done by the proposer', async () => {
    const cb = await call<string>(f, 'owner', `pm.flr_propose_chargeback($1, '1099', $2, 'DAMAGE', 'Scratched door casing', 2500, $3)`, [L1, ids.sub, J1]);
    expect(await callErr(f, 'supervisor', `pm.flr_acknowledge_chargeback($1, null, true)`, [cb])).toMatch(forbidden);
    expect(await callErr(f, 'owner', `pm.flr_acknowledge_chargeback($1, null, true)`, [cb])).toMatch(/PM_SOD_VIOLATION/);
    await call(f, 'gm', `pm.flr_acknowledge_chargeback($1, null, true)`, [cb]);
    expect((await one<{ status: string }>(f, `select status from pm.flr_chargebacks where id = $1`, [cb])).status).toBe('WAIVED');
  });
});

describe('registry', () => {
  it('stays clean after the flows', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});
