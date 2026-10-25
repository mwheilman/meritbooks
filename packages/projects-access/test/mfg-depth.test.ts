/**
 * Manufacturing (ETO cabinetry / millwork) depth (migration 1122): CAD/CAM import with the diff
 * against the estimate, BOM apply, routing run bases, release-to-shop gates with the override,
 * backlog in shop-hours vs capacity, the badge kiosk (two jobs at once, offline replay), remakes /
 * cost of quality, MRP-lite demand → PO → receiving, install scheduling, and access per persona.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, q, type Fixture, ORG_A, L1, J1, J2 } from './fixture';
import { call, callErr, forbidden, one, registryClean, setupIndustry, stockLocation, vendor } from './industry';

let f: Fixture;
const ids: Record<string, string> = {};
const at = (offsetSec: number): string => new Date(Date.now() + offsetSec * 1000).toISOString();

beforeAll(async () => {
  f = await setupIndustry('mfg-depth');
  for (const [code, name] of [['cnc', 'CNC router'], ['edge', 'Edgebander'], ['assy', 'Assembly']] as const) {
    ids[code] = (await one<{ id: string }>(f, `insert into pm.work_centers (org_id, location_id, code, name, capacity_minutes_per_week) values ($1, $2, $3, $4, 2400) returning id`,
      [ORG_A, L1, code, name])).id;
  }
  ids.routing = (await one<{ id: string }>(f, `insert into pm.routings (org_id, location_id, code, name) values ($1, $2, 'BOX', 'Frameless box') returning id`, [ORG_A, L1])).id;
  await q(f.db, `insert into pm.routing_steps (org_id, routing_id, seq, work_center_id, name, setup_minutes, run_minutes_per_unit, run_basis) values
                   ($1, $2, 1, $3, 'Cut and bore', 30, 2, 'PART'), ($1, $2, 2, $4, 'Edgeband', 15, 0.5, 'LF'), ($1, $2, 3, $5, 'Assemble', 0, 20, 'BOX')`,
    [ORG_A, ids.routing, ids.cnc, ids.edge, ids.assy]);
  ids.wo = await call<string>(f, 'pm', `pm.create_production_order($1, 'Kitchen boxes', 1, $2)`, [J1, ids.routing]);
  const est = f.ids[`estimate:${J1}`]!;
  await q(f.db, `insert into pm.estimate_lines (org_id, estimate_id, description, qty, unit_cost_cents, cost_cents, amount_cents, labor_hours, ext) values
                   ($1, $2, 'Maple ply 18 mm', 10, 6000, 60000, 90000, null, '{"mfg":{"kind":"SHEET","key":"MAPLE PLY|18.0"}}'),
                   ($1, $2, 'Maple edgeband', 100, 50, 5000, 9000, null, '{"mfg":{"kind":"EDGEBAND","key":"MAPLE EB"}}'),
                   ($1, $2, 'Blum hinges', 20, 400, 8000, 12000, null, '{"mfg":{"kind":"HARDWARE","key":"BLUM-HINGE"}}'),
                   ($1, $2, 'Shop labor', 1, 0, 0, 0, 12, '{}')`, [ORG_A, est]);
  ids.estimate = est;
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

const cadLines = [
  { line_kind: 'ASSEMBLY', assembly_ref: 'B24', description: 'Base 24', qty: 2 },
  { line_kind: 'PART', assembly_ref: 'B24', part_code: 'B24-SIDE', description: 'Side', material: 'Maple ply', thickness_mm: 18, length_mm: 720, width_mm: 560, qty: 10, edgeband: 'L1', grain: 'LENGTH' },
  { line_kind: 'SHEET', description: 'Maple ply 18 mm', material: 'Maple ply', thickness_mm: 18, qty: 12 },
  { line_kind: 'EDGEBAND', description: 'Maple edgeband', material: 'Maple EB', qty: 90 },
  { line_kind: 'HARDWARE', part_code: 'BLUM-HINGE', description: 'Blum hinge', qty: 24 },
  { line_kind: 'HARDWARE', part_code: 'PULL-128', description: '128 mm pull', qty: 8 },
];

describe('CAD/CAM import + reconcile (MFG-19/20, make-or-break 3)', () => {
  it('stages a Cabinet Vision cut list and diffs it against the estimate (cost deltas only for financials)', async () => {
    const r = await call<{ import_id: string; diff: Array<{ kind: string; key: string; status: string; delta_qty: number; delta_cost_cents: number | null }> ; counts: { sheets: number } }>(
      f, 'pm', `pm.mfg_stage_cad_import($1, 'CABINET_VISION', 'kitchen.csv', $2::jsonb, $3)`, [J1, JSON.stringify(cadLines), ids.wo]);
    ids.import = r.import_id;
    const by = Object.fromEntries(r.diff.map((d) => [d.key, d]));
    expect(by['MAPLE PLY|18.0']).toMatchObject({ status: 'OVER', delta_qty: 2, delta_cost_cents: 12000 });
    expect(by['MAPLE EB']).toMatchObject({ status: 'UNDER', delta_qty: -10, delta_cost_cents: -500 });
    expect(by['BLUM-HINGE']).toMatchObject({ status: 'OVER', delta_qty: 4, delta_cost_cents: 1600 });
    expect(by['PULL-128']).toMatchObject({ status: 'NOT_ESTIMATED' });
    expect(Number(r.counts.sheets)).toBe(12);
    const s = await call<{ diff: Array<{ delta_cost_cents: number | null }> }>(f, 'supervisor', `pm.mfg_stage_cad_import($1, 'MICROVELLUM', 'x.xml', $2::jsonb)`, [J1, JSON.stringify(cadLines)]);
    expect(s.diff.every((d) => d.delta_cost_cents === null)).toBe(true);
    expect(await callErr(f, 'labor', `pm.mfg_stage_cad_import($1, 'GENERIC', 'x', $2::jsonb)`, [J2, JSON.stringify(cadLines)])).toMatch(forbidden);
  });
  it('applying writes the BOM with parts under their cabinet; a second apply is refused', async () => {
    const r = await call<{ bom_lines: number }>(f, 'pm', `pm.mfg_apply_cad_import($1)`, [ids.import]);
    expect(r.bom_lines).toBe(6);
    const part = await one<{ parent: string | null; kind: string }>(f, `select (select p.line_kind from pm.bom_lines p where p.id = b.parent_id) as parent, b.line_kind as kind from pm.bom_lines b where b.work_order_id = $1 and b.part_code = 'B24-SIDE'`, [ids.wo]);
    expect(part).toEqual({ parent: 'ASSEMBLY', kind: 'PART' });
    expect(await callErr(f, 'pm', `pm.mfg_apply_cad_import($1)`, [ids.import])).toMatch(/PM_CAD_IMPORT_STATE/);
  });
});

describe('routings by run basis + release gates (MFG-25/26)', () => {
  it('standards follow the BOM: parts, edgeband LF and boxes', async () => {
    expect(await call<number>(f, 'pm', `pm.mfg_restandard_operations($1)`, [ids.wo])).toBe(3);
    const ops = await q<{ seq: number; std_minutes: number }>(f.db, `select seq, std_minutes from pm.wo_operations where work_order_id = $1 order by seq`, [ids.wo]);
    expect(ops.map((o) => o.std_minutes)).toEqual([50, 60, 40]);
  });
  it('the release check names each gate; a deposit / material gap needs a reason and the money capability', async () => {
    await call(f, 'pm', `pm.approve_drawings($1)`, [ids.wo]);
    const chk = await call<{ gates: Array<{ key: string; ok: boolean }> }>(f, 'pm', `pm.mfg_release_check($1)`, [ids.wo]);
    const g = Object.fromEntries(chk.gates.map((x) => [x.key, x.ok]));
    expect(g).toMatchObject({ drawings_approved: true, bom_present: true, operations_present: true, deposit_received: false, material_ready: false, cad_reconciled: true });
    const r1 = await call<{ released: boolean; overridable: boolean; failed: string[] }>(f, 'pm', `pm.mfg_release($1)`, [ids.wo]);
    expect(r1).toMatchObject({ released: false, overridable: true });
    expect(r1.failed).toEqual(expect.arrayContaining(['deposit_received', 'material_ready']));
    expect(await callErr(f, 'supervisor', `pm.mfg_release($1, 'Customer is good for it')`, [ids.wo])).toMatch(forbidden);
    const r2 = await call<{ released: boolean; overridden: string[] }>(f, 'pm', `pm.mfg_release($1, 'Deposit check in hand; sheets on the truck')`, [ids.wo]);
    expect(r2.released).toBe(true);
    expect((await one<{ status: string }>(f, `select status from pm.work_orders where id = $1`, [ids.wo])).status).toBe('RELEASED');
  });
});

describe('backlog in shop-hours vs capacity (MFG-27, make-or-break 2)', () => {
  it('booked hours by center against weekly capacity (base × efficiency), downtime removes days', async () => {
    const b = await call<{ centers: Array<{ code: string; booked_hours: number; weekly_capacity_hours: number; weeks: Array<{ load_hours: number }> }> }>(f, 'pm', `pm.mfg_backlog($1, 4)`, [L1]);
    const cnc = b.centers.find((c) => c.code === 'cnc')!;
    expect(Number(cnc.booked_hours)).toBeCloseTo(0.8, 1);
    expect(Number(cnc.weekly_capacity_hours)).toBe(34);
    expect(cnc.weeks).toHaveLength(4);
    await q(f.db, `insert into pm.mfg_center_downtime (org_id, location_id, work_center_id, starts_on, ends_on, reason) values ($1, $2, $3, date_trunc('week', current_date)::date, date_trunc('week', current_date)::date + 6, 'Spindle rebuild')`,
      [ORG_A, L1, ids.cnc]);
    const b2 = await call<{ centers: Array<{ code: string; weekly_capacity_hours: number }> }>(f, 'pm', `pm.mfg_backlog($1, 2)`, [L1]);
    expect(Number(b2.centers.find((c) => c.code === 'cnc')!.weekly_capacity_hours)).toBe(0);
    expect(await callErr(f, 'labor', `pm.mfg_backlog($1)`, [L1])).toMatch(forbidden);
  });
});

describe('shop-floor kiosk: badge + PIN, two jobs at once, offline replay (MFG-30/31, make-or-break 4)', () => {
  it('a badge with a PIN opens a session; a wrong PIN is refused; the worker sees operations, never money', async () => {
    await call(f, 'pm', `pm.mfg_set_badge($1, $2, 'b-1001', '4321')`, [L1, f.employee.labor]);
    expect(await call(f, 'pm', `pm.mfg_kiosk_identify($1, 'B-1001', '0000')`, [L1])).toMatchObject({ ok: false, code: 'PM_KIOSK_PIN' });
    const s = await call<{ session_token: string; operations: Array<Record<string, unknown>> }>(f, 'pm', `pm.mfg_kiosk_identify($1, 'B-1001', '4321')`, [L1]);
    ids.token = s.session_token;
    expect(s.operations.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.operations)).not.toMatch(/cents|rate|price|cost/);
    expect(await one<{ n: number }>(f, `select count(*)::int n from pm.mfg_badges where badge_hash like '%1001%'`)).toEqual({ n: 0 });
  });
  it('security review H2/R2: the station locks on failures (sliding, a success does not reset it); badges never hard-lock but alert the lead; every badge has a PIN', async () => {
    expect(await callErr(f, 'gm', `pm.mfg_set_badge($1, $2, 'B-2002', null)`, [L1, f.employee.supervisor])).toMatch(/needs a PIN/);
    await call(f, 'gm', `pm.mfg_set_badge($1, $2, 'B-2002', '2468')`, [L1, f.employee.supervisor]);
    // five wrong PINs on a coworker's badge do not lock that badge: its owner still signs in (from another station)
    for (let i = 0; i < 5; i++) expect(await call(f, 'gm', `pm.mfg_kiosk_identify($1, 'B-2002', '1111')`, [L1])).toMatchObject({ ok: false, code: 'PM_KIOSK_PIN' });
    expect(await call(f, 'owner', `pm.mfg_kiosk_identify($1, 'B-2002', '2468')`, [L1])).toMatchObject({ ok: true });
    const al = await call<{ badges: Array<{ employee_id: string; wrong_pins_24h: number }> }>(f, 'pm', `pm.mfg_badge_alerts($1)`, [L1]);
    expect(al.badges.find((b) => b.employee_id === f.employee.supervisor)!.wrong_pins_24h).toBe(5);
    expect(await callErr(f, 'labor', `pm.mfg_badge_alerts($1)`, [L1])).toMatch(forbidden);
    // a success on the guessing station does not clear its failures: four more unknown badges reach ten and lock the station
    expect((await call<{ ok: boolean }>(f, 'gm', `pm.mfg_kiosk_identify($1, 'B-2002', '2468')`, [L1])).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect((await call<{ ok: boolean }>(f, 'gm', `pm.mfg_kiosk_identify($1, $2, '0000')`, [L1, `NOPE-${i}`])).ok).toBe(false);
    expect(await call(f, 'gm', `pm.mfg_kiosk_identify($1, 'NOPE-9', '0000')`, [L1])).toMatchObject({ ok: false, code: 'PM_KIOSK_DEVICE_LOCKED' });
    expect(await call(f, 'gm', `pm.mfg_kiosk_identify($1, 'B-1001', '4321')`, [L1])).toMatchObject({ ok: false, code: 'PM_KIOSK_DEVICE_LOCKED' });
    // a PIN-less badge left from before cannot sign in
    await q(f.db, `update pm.mfg_badges set pin_hash = null where employee_id = $1`, [f.employee.supervisor]);
    expect(await call(f, 'owner', `pm.mfg_kiosk_identify($1, 'B-2002', null)`, [L1])).toMatchObject({ ok: false, code: 'PM_KIOSK_PIN_REQUIRED' });
    // more than 20 sign-ins a minute from one station are refused
    let last: { ok: boolean; code?: string } = { ok: true };
    for (let i = 0; i < 21; i++) last = await call(f, 'owner', `pm.mfg_kiosk_identify($1, 'B-1001', '4321')`, [L1]);
    expect(last).toMatchObject({ ok: false, code: 'PM_KIOSK_RATE_LIMIT' });
  });
  it('two operations at once split the clock; each stop is a SUBMITTED time entry on the operation; replays answer once', async () => {
    const ops = await q<{ id: string; seq: number }>(f.db, `select id, seq from pm.wo_operations where work_order_id = $1 order by seq`, [ids.wo]);
    ids.op1 = ops[0]!.id; ids.op2 = ops[1]!.id;
    const ev = (cid: string, action: string, op: string, sec: number, extra: Record<string, unknown> = {}) => ({ client_event_id: cid, session_token: ids.token, action, operation_id: op, at: at(sec), ...extra });
    const events = [ev('evt-0001-a', 'START', ids.op1, 0), ev('evt-0002-a', 'START', ids.op2, 30), ev('evt-0003-a', 'STOP', ids.op1, 90, { good_qty: 10 }), ev('evt-0004-a', 'STOP', ids.op2, 110)];
    const r = await call<{ results: Array<{ ok: boolean; minutes?: number; time_entry_id?: string }> }>(f, 'pm', `pm.mfg_kiosk_events($1, $2::jsonb)`, [L1, JSON.stringify(events)]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(r.results.filter((x) => x.time_entry_id).map((x) => x.minutes)).toEqual([1, 1]);
    const te = await q<{ approval_state: string; operation_id: string; employee_id: string }>(f.db, `select approval_state, operation_id, employee_id from pm.time_entries where source_ref like 'pm:kiosk:%' order by created_at`);
    expect(te).toHaveLength(2);
    expect(te.every((t) => t.approval_state === 'SUBMITTED' && t.employee_id === f.employee.labor)).toBe(true);
    const replay = await call<{ results: Array<{ replay?: boolean }> }>(f, 'pm', `pm.mfg_kiosk_events($1, $2::jsonb)`, [L1, JSON.stringify([events[0]])]);
    expect(replay.results[0]!.replay).toBe(true);
  });
  it('a stale or foreign session token is refused; labor never runs the kiosk RPC directly', async () => {
    const r = await call<{ results: Array<{ ok: boolean; error: string }> }>(f, 'pm', `pm.mfg_kiosk_events($1, $2::jsonb)`,
      [L1, JSON.stringify([{ client_event_id: 'evt-bad-0001', session_token: 'nope', action: 'START', operation_id: ids.op1 }])]);
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(r.results[0]!.error).toMatch(/PM_KIOSK_SESSION/);
    expect(await callErr(f, 'labor', `pm.mfg_kiosk_events($1, '[]'::jsonb)`, [L1])).toMatch(forbidden);
    const own = await as(f, 'labor', () => q(f.db, `select 1 from pm.mfg_kiosk_punches`));
    expect(own.length).toBe(2);
  });
});

describe('remakes and cost of quality (MFG-34)', () => {
  it('a station reports a remake; the reporter cannot approve it; approval opens a remake order tagged to the original', async () => {
    ids.remake = await call<string>(f, 'supervisor', `pm.mfg_request_remake($1, 'B24-SIDE', 'MACHINING', 1, 'Bore offset')`, [ids.wo]);
    expect(await callErr(f, 'supervisor', `pm.mfg_decide_remake($1, true)`, [ids.remake])).toMatch(/PM_SOD_VIOLATION/);
    const d = await call<{ status: string; remake_work_order_id: string }>(f, 'pm', `pm.mfg_decide_remake($1, true, 'Recut tonight', 4200)`, [ids.remake]);
    expect(d.status).toBe('APPROVED');
    const w = await one<{ is_remake: boolean; remake_of_id: string }>(f, `select is_remake, remake_of_id from pm.work_orders where id = $1`, [d.remake_work_order_id]);
    expect(w).toEqual({ is_remake: true, remake_of_id: ids.wo });
    const coq = await call<{ by_reason: Array<{ reason_code: string; remakes: number; material_cents: number | null }> }>(f, 'pm', `pm.mfg_cost_of_quality($1)`, [L1]);
    expect(coq.by_reason[0]).toMatchObject({ reason_code: 'MACHINING', remakes: 1, material_cents: 4200 });
    const masked = await as(f, 'supervisor', () => q<{ est_material_cents: string | null }>(f.db, `select est_material_cents from pm.v_mfg_remakes_masked where id = $1`, [ids.remake]));
    expect(masked[0]!.est_material_cents).toBeNull();
  });
});

describe('MRP-lite: demand → PO → receiving (MFG-36/37/39)', () => {
  it('demand nets on hand and open POs; a PO from demand clears the shortage; receiving stocks it', async () => {
    const item = await one<{ id: string }>(f, `select pm.ensure_part_item($1, 'BLUM-71B', 'Blum hinge') as id`, [ORG_A]);
    await q(f.db, `update pm.bom_lines set item_id = $1 where work_order_id = $2 and part_code = 'BLUM-HINGE'`, [item.id, ids.wo]);
    ids.stock = await stockLocation(f, 'SHOP');
    await call(f, 'pm', `pm.record_material_move('RECEIPT', $1, 10, null, $2)`, [item.id, ids.stock]);
    const d = await call<{ rows: Array<{ item_id: string | null; key: string; required_qty: number; on_hand_qty: number; short_qty: number }> }>(f, 'pm', `pm.mfg_material_demand($1)`, [L1]);
    const hinge = d.rows.find((r) => r.item_id === item.id)!;
    expect([Number(hinge.required_qty), Number(hinge.on_hand_qty), Number(hinge.short_qty)]).toEqual([24, 10, 14]);
    const sheet = d.rows.find((r) => r.key === 'MAPLE PLY|18.0')!;
    expect(Number(sheet.short_qty)).toBe(12);
    const supplier = await vendor(f, 'Richelieu');
    const po = await call<{ commitment_id: string; lines: number }>(f, 'pm', `pm.mfg_create_po_from_demand($1, $2, $3::jsonb)`,
      [J1, supplier, JSON.stringify([{ item_id: item.id, description: 'Blum hinge', qty: 14, uom: 'EA', unit_cost_cents: 500 }])]);
    expect(po.lines).toBe(1);
    const d2 = await call<{ rows: Array<{ item_id: string | null; short_qty: number }> }>(f, 'pm', `pm.mfg_material_demand($1)`, [L1]);
    expect(Number(d2.rows.find((r) => r.item_id === item.id)!.short_qty)).toBe(0);
    await q(f.db, `update pm.commitments set status = 'APPROVED', approved_at = now() where id = $1`, [po.commitment_id]);
    const line = await one<{ id: string }>(f, `select id from pm.commitment_lines where commitment_id = $1`, [po.commitment_id]);
    const rc = await call<{ receipt_id: string; move_id: string }>(f, 'pm', `pm.mfg_receive_po_line($1, 14, $2, 'All in')`, [line.id, ids.stock]);
    expect(rc.receipt_id).toBeTruthy();
    expect(rc.move_id).toBeTruthy();
    expect(await callErr(f, 'supervisor', `pm.mfg_create_po_from_demand($1, $2, '[{"qty":1}]'::jsonb)`, [J1, supplier])).toMatch(forbidden);
  });
});

describe('install scheduling (MFG-45)', () => {
  it('flags production not done in time and crew double-booking; the board shows both', async () => {
    const crew = await one<{ id: string }>(f, `insert into pm.crews (org_id, location_id, name, kind) values ($1, $2, 'Install A', 'INSTALL') returning id`, [ORG_A, L1]);
    const a = await call<{ conflicts: Array<{ code: string }> }>(f, 'pm', `pm.mfg_schedule_install($1, current_date + 10, current_date + 12, $2, current_date + 9)`, [J1, crew.id]);
    expect(a.conflicts.map((c) => c.code)).toContain('PRODUCTION_NOT_READY');
    const b = await call<{ conflicts: Array<{ code: string }> }>(f, 'owner', `pm.mfg_schedule_install($1, current_date + 11, current_date + 11, $2, current_date + 14)`, [J2, crew.id]);
    expect(b.conflicts.map((c) => c.code)).toEqual(expect.arrayContaining(['CREW_OVERLAP', 'SITE_NOT_READY']));
    const board = await call<{ installs: unknown[] }>(f, 'owner', `pm.mfg_install_board($1)`, [L1]);
    expect(board.installs).toHaveLength(2);
    expect(await callErr(f, 'labor', `pm.mfg_schedule_install($1, current_date, current_date)`, [J2])).toMatch(forbidden);
  });
});

describe('registry', () => {
  it('stays clean after the flows', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});
