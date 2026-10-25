/**
 * Equipment dealer depth (migration 1122) against a PGlite replay of every migration: counter
 * pick lists + speed + lost sales, OEM price files with supersessions, the warranty claim builder →
 * portal-assist packet → submission → credit memo match / rejection paths, one-scan resolver and
 * unit timeline, deal-desk programs / fees / payment scenarios / worksheet, sold-out-of-trust list,
 * rental damage compare, tech clock per RO line + productivity board, KPIs, and access per persona.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, q, type Fixture, ORG_A, L1, J1, J2 } from './fixture';
import { call, callErr, customer, forbidden, one, reapply1122, registryClean, setupIndustry, stockLocation, vendor } from './industry';

let f: Fixture;
const ids: Record<string, string> = {};

beforeAll(async () => {
  f = await setupIndustry('dealer-depth');
  ids.sl = await stockLocation(f, 'MAIN');
  ids.kubota = await vendor(f, 'Kubota Tractor');
  ids.oemPayer = await customer(f, 'Kubota Warranty');
  ids.buyer = await customer(f, 'Pat Buyer');
  await as(f, 'owner', async () => {
    ids.newPart = (await q<{ id: string }>(f.db, `select pm.upsert_part($1, 'AM125172', 'Air filter', '{"manufacturer":"KUBOTA","list_price_cents":4500,"cost_cents":2800}') as id`, [L1]))[0]!.id;
    ids.oldPart = (await q<{ id: string }>(f.db, `select pm.upsert_part($1, 'AM100', 'Air filter (old)', '{"manufacturer":"KUBOTA","list_price_cents":4000,"cost_cents":2500}') as id`, [L1]))[0]!.id;
    await q(f.db, `select pm.supersede_part($1, $2)`, [ids.oldPart, ids.newPart]);
    const item = (await q<{ item_id: string }>(f.db, `select item_id from pm.parts where id = $1`, [ids.newPart]))[0]!.item_id;
    await q(f.db, `select pm.record_material_move('RECEIPT', $1, 3, null, $2)`, [item, ids.sl]);
  });
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('1122 registers with the 1110 access foundation', () => {
  it('every pm table classified, every member definer RPC guarded, nothing for anon, no unprotected Books table', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});

describe('counter: pick list, speed, lost sales (DLR-29/30/37, make-or-break 1)', () => {
  it('a PartSmart pick list follows supersession, fills from on-hand and returns unknown numbers', async () => {
    ids.ticket = await call<string>(f, 'owner', `pm.open_parts_ticket($1, null, $2)`, [L1, ids.sl]);
    const r = await call<{ added: Array<{ part_number: string; superseded: boolean; filled: number; short: number }>; unknown: Array<{ part_number: string }> }>(
      f, 'owner', `pm.dlr_add_pick_list($1, $2::jsonb)`, [ids.ticket, JSON.stringify([{ part_number: 'am100', qty: 5 }, { part_number: 'ZZZ-1', qty: 1 }])]);
    expect(r.added).toHaveLength(1);
    expect(r.added[0]).toMatchObject({ part_number: 'AM125172', superseded: true, filled: 3, short: 2 });
    expect(r.unknown.map((u) => u.part_number)).toEqual(['ZZZ-1']);
    const line = await one<{ requested_part_id: string; unit_price_cents: string }>(f, `select requested_part_id, unit_price_cents from pm.parts_ticket_lines where ticket_id = $1`, [ids.ticket]);
    expect(line.requested_part_id).toBe(ids.oldPart);
    expect(Number(line.unit_price_cents)).toBe(4500);
  });
  it('a closed ticket shows on the counter-speed view (seconds open → close, % under 60 s)', async () => {
    await as(f, 'owner', () => q(f.db, `update pm.parts_ticket_lines set qty_requested = 3 where ticket_id = $1`, [ids.ticket]));
    await call(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [ids.ticket]);
    const v = await as(f, 'owner', () => q<{ tickets: number; pct_under_60s: string }>(f.db, `select tickets, pct_under_60s from pm.v_dlr_counter_speed where location_id = $1`, [L1]));
    expect(v[0]!.tickets).toBeGreaterThanOrEqual(1);
    expect(Number(v[0]!.pct_under_60s)).toBe(1);
  });
  it('lost sales are one call; a seat without the store cannot log them', async () => {
    const id = await call<string>(f, 'owner', `pm.dlr_log_lost_sale($1, 'am999', 2, 'COMMERCIAL', 'NOT_STOCKED')`, [L1]);
    expect(id).toBeTruthy();
    expect(await callErr(f, 'pm', `pm.dlr_log_lost_sale($1, 'X1')`, [L1])).toMatch(forbidden);
    expect(await callErr(f, 'bOwner', `pm.dlr_log_lost_sale($1, 'X1')`, [L1])).toMatch(forbidden);
  });
});

describe('OEM price files + supersessions (DLR-28, make-or-break 3)', () => {
  it('staging diffs the catalog: new, changed, superseded, invalid, and margin under the matrix floor', async () => {
    await as(f, 'owner', () => q(f.db, `insert into pm.dlr_price_rules (location_id, manufacturer, basis, pct, min_margin_pct) values ($1, 'KUBOTA', 'COST', 0.25, 0.30)`, [L1]));
    const rows = [
      { part_number: 'AM125172', list_price_cents: 4800, cost_cents: 3000 },
      { part_number: 'NEW1', description: 'Mower belt', list_price_cents: 2000, cost_cents: 1000 },
      { part_number: 'OLD9', description: 'Old belt', supersedes_to: 'NEW1' },
      { part_number: '', description: 'blank' },
    ];
    const s = await call<Record<string, unknown>>(f, 'owner', `pm.dlr_stage_price_file($1, 'kubota', 'KUBOTA', 'kubota-2026-11.csv', current_date, $2::jsonb, $3)`,
      [L1, JSON.stringify(rows), ids.kubota]);
    expect(s).toMatchObject({ rows: 4, new: 1, changed: 1, superseded: 1, invalid: 1, below_floor: 2 });
    ids.file = s.file_id as string;
    const l = await one<{ new_price_cents: string; below_floor: boolean }>(f, `select new_price_cents, below_floor from pm.dlr_price_file_lines where file_id = $1 and part_number = 'AM125172'`, [ids.file]);
    expect(Number(l.new_price_cents)).toBe(3750);
    expect(l.below_floor).toBe(true);
  });
  it('a seat without the store cannot stage; another tenant cannot apply', async () => {
    expect(await callErr(f, 'dispatcher', `pm.dlr_stage_price_file($1, 'KUBOTA', 'KUBOTA', 'x', current_date, '[]'::jsonb)`, [L1])).toMatch(forbidden);
    expect(await callErr(f, 'bOwner', `pm.dlr_apply_price_file($1)`, [ids.file])).toMatch(forbidden);
  });
  it('applying updates list / cost / matrix price, creates new parts and chains supersessions', async () => {
    const r = await call<{ applied: number; failed: number }>(f, 'owner', `pm.dlr_apply_price_file($1)`, [ids.file]);
    expect(r).toMatchObject({ applied: 3, failed: 0 });
    const p = await one<{ cost_cents: string; list_price_cents: string; price_cents: string }>(f, `select cost_cents, list_price_cents, price_cents from pm.parts where id = $1`, [ids.newPart]);
    expect([Number(p.cost_cents), Number(p.list_price_cents), Number(p.price_cents)]).toEqual([3000, 4800, 3750]);
    const chain = await one<{ old: string; new: string }>(f,
      `select (select id from pm.parts where part_number = 'OLD9') as old, (select id from pm.parts where part_number = 'NEW1') as new`);
    expect(await call<string>(f, 'owner', `pm.resolve_part($1)`, [chain.old])).toBe(chain.new);
    expect(await callErr(f, 'owner', `pm.dlr_apply_price_file($1)`, [ids.file])).toMatch(/PM_PRICE_FILE_STATE/);
  });
});

describe('warranty claim builder → submission → adjudication → credit match (DLR-58/59/60/61, make-or-break 2)', () => {
  async function ro(serial: string): Promise<{ wo: string; claim: string }> {
    const unit = await call<string>(f, 'owner', `pm.receive_unit($1, $2, 'KUBOTA', 'Z421KW', 500000, jsonb_build_object('stock_location_id', $3::text, 'mfr_vendor_id', $4::text))`,
      [L1, serial, ids.sl, ids.kubota]);
    const wo = await call<string>(f, 'owner', `pm.create_work_order(p_job => $1, p_kind => 'REPAIR_ORDER', p_summary => 'Will not start', p_asset => $2, p_payer_type => 'OEM', p_payer_customer => $3)`,
      [J1, unit, ids.oemPayer]);
    await q(f.db, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents, flag_hours, pay_type)
                   values ($1, $2, $3, 'LABOR', 'Diagnose + replace starter', 1, 18000, 1.5, 'WARRANTY'),
                          ($1, $2, $3, 'PART', 'Starter', 1, 32000, null, 'WARRANTY')`, [ORG_A, J1, wo]);
    const claim = await call<string>(f, 'owner', `pm.create_warranty_claim_from_ro($1)`, [wo]);
    return { wo, claim };
  }
  const kubotaFields = {
    oem_brand: 'KUBOTA', symptom_code: 'NS01', defect_code: 'D44', remedy_code: 'R2', machine_hours: 212, failure_on: '2026-10-01', repair_on: '2026-10-20',
    purchase_on: '2025-04-01', complaint: 'Will not crank', cause: 'Starter solenoid failed', correction: 'Replaced starter', requested_hours: 1.5,
  };

  it('readiness lists the Kubota fields; an incomplete claim cannot be prepared', async () => {
    const a = await ro('KU-W1');
    ids.claim = a.claim;
    ids.unit = (await one<{ asset_id: string }>(f, `select asset_id from pm.warranty_claims where id = $1`, [a.claim])).asset_id;
    ids.wo = a.wo;
    const rd = await call<{ ready: boolean; missing: string[]; channel: string }>(f, 'owner', `pm.dlr_claim_readiness($1)`, [a.claim]);
    expect(rd.ready).toBe(false);
    expect(rd.channel).toBe('DIRECT');
    expect(rd.missing).toEqual(expect.arrayContaining(['symptom_code', 'defect_code', 'remedy_code', 'machine_hours', 'causal_part_number']));
    expect(await callErr(f, 'owner', `pm.dlr_prepare_claim_submission($1)`, [a.claim])).toMatch(/PM_CLAIM_INCOMPLETE/);
  });
  it('the builder fills the claim; the packet carries portal copy fields (the brand is not connected) and the submit-by date', async () => {
    await call(f, 'owner', `pm.dlr_update_claim($1, $2::jsonb)`, [ids.claim, JSON.stringify(kubotaFields)]);
    expect(await call<number>(f, 'owner', `pm.dlr_set_claim_parts($1, $2::jsonb)`, [ids.claim, JSON.stringify([{ part_number: '1G311-63010', description: 'Starter', qty: 1, unit_price_cents: 32000, is_causal: true, return_required: true }])])).toBe(1);
    const rd = await call<{ ready: boolean; submit_by: string }>(f, 'owner', `pm.dlr_claim_readiness($1)`, [ids.claim]);
    expect(rd.ready).toBe(true);
    expect(rd.submit_by).toBe('2026-11-19');
    const p = await call<{ submission_id: string; channel: string; packet: { copy_fields: unknown[]; failure: { defect_code: string } } }>(f, 'owner', `pm.dlr_prepare_claim_submission($1)`, [ids.claim]);
    expect(p.channel).toBe('PORTAL_ASSIST');
    expect(p.packet.copy_fields.length).toBeGreaterThanOrEqual(12);
    expect(p.packet.failure.defect_code).toBe('D44');
    ids.submission = p.submission_id;
  });
  it('filing on the portal moves the claim to SUBMITTED with the OEM claim number and a response date', async () => {
    const r = await call<{ claim_status: string }>(f, 'owner', `pm.dlr_record_claim_submitted($1, 'FILED_ON_PORTAL', 'KC-777', 'KC-777')`, [ids.submission]);
    expect(r.claim_status).toBe('SUBMITTED');
    const c = await one<{ claim_number: string; submission_channel: string; response_due_on: string | null }>(f, `select claim_number, submission_channel, response_due_on::text from pm.warranty_claims where id = $1`, [ids.claim]);
    expect(c).toMatchObject({ claim_number: 'KC-777', submission_channel: 'PORTAL_ASSIST' });
    expect(c.response_due_on).toBeTruthy();
  });
  it('a credit memo line is proposed by claim number; confirming approves the claim and records the credit', async () => {
    const claimed = Number((await one<{ claimed_cents: string }>(f, `select claimed_cents from pm.warranty_claims where id = $1`, [ids.claim])).claimed_cents);
    const m = await call<{ memo_id: string; proposed: number }>(f, 'owner', `pm.dlr_import_credit_memo($1, 'CM-1001', current_date, $2::jsonb)`,
      [L1, JSON.stringify([{ claim_number: 'kc-777', amount_cents: claimed - 2000 }, { reference: 'misc', amount_cents: 500 }])]);
    expect(m.proposed).toBe(1);
    const line = await one<{ id: string }>(f, `select id from pm.dlr_credit_memo_lines where memo_id = $1 and match_status = 'PROPOSED'`, [m.memo_id]);
    await call(f, 'owner', `pm.dlr_confirm_credit_match($1)`, [line.id]);
    const c = await one<{ status: string; credited_cents: string; adjudication: string; approved_cents: string }>(f, `select status, credited_cents, adjudication, approved_cents from pm.warranty_claims where id = $1`, [ids.claim]);
    expect(c).toMatchObject({ status: 'APPROVED', adjudication: 'ADJUSTED' });
    expect(Number(c.credited_cents)).toBe(claimed - 2000);
    expect(await callErr(f, 'owner', `pm.dlr_import_credit_memo($1, 'CM-1001', current_date, '[{"amount_cents":1}]'::jsonb)`, [L1])).toMatch(/PM_DUPLICATE/);
  });
  it('a rejected claim is rebilled to the customer (written off with the rebill flag)', async () => {
    const b = await ro('KU-W2');
    await call(f, 'owner', `pm.dlr_update_claim($1, $2::jsonb)`, [b.claim, JSON.stringify({ ...kubotaFields, causal_part_number: '1G311-63010' })]);
    const p = await call<{ submission_id: string }>(f, 'owner', `pm.dlr_prepare_claim_submission($1)`, [b.claim]);
    await call(f, 'owner', `pm.dlr_record_claim_submitted($1, 'FILED_ON_PORTAL', 'KC-778', 'KC-778')`, [p.submission_id]);
    expect(await callErr(f, 'owner', `pm.dlr_record_claim_response($1, 'REJECTED')`, [b.claim])).toMatch(/reason/);
    await call(f, 'owner', `pm.dlr_record_claim_response($1, 'REJECTED', null, 'Outside warranty hours')`, [b.claim]);
    await call(f, 'owner', `pm.dlr_resolve_rejected_claim($1, 'REBILL', 'Customer pays')`, [b.claim]);
    const c = await one<{ status: string; adjudication: string; rebill: boolean }>(f, `select status, adjudication, rebill_requested_at is not null as rebill from pm.warranty_claims where id = $1`, [b.claim]);
    expect(c).toEqual({ status: 'WRITTEN_OFF', adjudication: 'REBILLED', rebill: true });
  });
  it('the deadline view flags a draft near its submit-by date', async () => {
    const c = await ro('KU-W3');
    await call(f, 'owner', `pm.dlr_update_claim($1, jsonb_build_object('oem_brand', 'KUBOTA', 'repair_on', (current_date - 27)::text))`, [c.claim]);
    const v = await as(f, 'owner', () => q<{ submit_at_risk: boolean; days_to_submit: number }>(f.db, `select submit_at_risk, days_to_submit from pm.v_dlr_claim_deadlines where claim_id = $1`, [c.claim]));
    expect(v[0]).toEqual({ submit_at_risk: true, days_to_submit: 3 });
  });
});

describe('one scan + unit timeline (DLR-02, make-or-break 4)', () => {
  it('a serial, a superseded part number and an RO number each land on their record', async () => {
    expect(await call<{ kind: string; id: string }>(f, 'owner', `pm.dlr_scan($1, 'ku-w1')`, [L1])).toMatchObject({ kind: 'unit', id: ids.unit });
    expect(await call<{ kind: string; id: string; superseded: boolean }>(f, 'owner', `pm.dlr_scan($1, 'AM100')`, [L1])).toMatchObject({ kind: 'part', id: ids.newPart, superseded: true });
    const wo = await one<{ number: string }>(f, `select number from pm.work_orders where id = $1`, [ids.wo]);
    expect(await call<{ kind: string }>(f, 'owner', `pm.dlr_scan($1, $2)`, [L1, wo.number])).toMatchObject({ kind: 'work_order', id: ids.wo });
    expect(await call<{ kind: string }>(f, 'owner', `pm.dlr_scan($1, 'NOPE-0')`, [L1])).toMatchObject({ kind: 'none' });
    expect(await callErr(f, 'labor', `pm.dlr_scan($1, 'AM100')`, [L1])).toMatch(forbidden);
  });
  it('the timeline joins receipt, cost, service and warranty for the serial', async () => {
    const t = await call<{ events: Array<{ kind: string }>; unit: { serial_number: string } }>(f, 'owner', `pm.dlr_unit_timeline($1)`, [ids.unit]);
    expect(t.unit.serial_number).toBe('KU-W1');
    expect(new Set(t.events.map((e) => e.kind))).toEqual(expect.objectContaining({}));
    const kinds = t.events.map((e) => e.kind);
    for (const k of ['received', 'service', 'warranty']) expect(kinds).toContain(k);
  });
});

describe('deal desk: programs, fees, payment scenarios, worksheet (DLR-12/13/14/16, make-or-break 5)', () => {
  beforeAll(async () => {
    ids.unit2 = await call<string>(f, 'owner', `pm.receive_unit($1, 'KU-BX1', 'KUBOTA', 'BX2380', 1500000, jsonb_build_object('stock_location_id', $2::text, 'category', 'COMPACT_TRACTOR'))`, [L1, ids.sl]);
    await q(f.db, `update pm.assets set category = 'COMPACT_TRACTOR' where id = $1`, [ids.unit2]);
    ids.deal = await call<string>(f, 'owner', `pm.create_deal($1, $2)`, [L1, ids.buyer]);
    await q(f.db, `insert into pm.dealer_deal_lines (org_id, deal_id, line_no, line_type, asset_id, unit_price_cents) values ($1, $2, 1, 'UNIT', $3, 2500000)`, [ORG_A, ids.deal, ids.unit2]);
    await as(f, 'owner', async () => {
      await q(f.db, `insert into pm.dlr_finance_programs (location_id, code, name, kind, brand, apr, term_months, subvention_pct, categories)
                     values ($1, 'KC-0-48', 'Kubota Credit 0% / 48', 'PROMO_RATE', 'KUBOTA', 0, 48, 0.03, '{COMPACT_TRACTOR}'),
                            ($1, 'STD-60', 'Standard 6.9% / 60', 'STANDARD_RATE', null, 0.069, 60, 0, '{}')`, [L1]);
      await q(f.db, `insert into pm.dlr_finance_programs (location_id, code, name, kind, brand, rebate_cents, categories) values ($1, 'REB-1000', '$1,000 cash rebate', 'CASH_REBATE', 'KUBOTA', 100000, '{}')`, [L1]);
      await q(f.db, `insert into pm.dlr_fee_schedule (location_id, code, label, kind, amount_cents, cost_cents, categories)
                     values ($1, 'DOC', 'Documentation fee', 'DOC', 49900, 0, '{}'), ($1, 'SETUP', 'Setup and PDI', 'SETUP', 25000, 12000, '{COMPACT_TRACTOR}')`, [L1]);
    });
  });
  it('standard fees apply once per code', async () => {
    expect(await call<number>(f, 'owner', `pm.dlr_apply_standard_fees($1)`, [ids.deal])).toBe(2);
    expect(await call<number>(f, 'owner', `pm.dlr_apply_standard_fees($1)`, [ids.deal])).toBe(0);
  });
  it('payment scenarios: cash, the 0%/48 promo (exact level payment, subvention cost), standard rate and the rebate', async () => {
    const s = await call<{ balance_due_cents: number; scenarios: Array<Record<string, unknown>>; amounts_visible: boolean }>(f, 'owner', `pm.dlr_payment_scenarios($1, 0)`, [ids.deal]);
    expect(s.amounts_visible).toBe(true);
    const promo = s.scenarios.find((x) => x.code === 'KC-0-48')!;
    const bal = s.balance_due_cents;
    expect(promo.amount_financed_cents).toBe(bal);
    expect(promo.monthly_cents).toBe(Math.floor((bal + 24) / 48));
    expect(promo.subvention_cents).toBe(Math.round(bal * 0.03));
    expect(s.scenarios.map((x) => x.code)).toEqual(expect.arrayContaining(['CASH', 'STD-60', 'REB-1000']));
  });
  it('applying the promo sets the finance terms and subvention; the worksheet shows gross after subvention and the delivery blockers', async () => {
    const promo = await one<{ id: string }>(f, `select id from pm.dlr_finance_programs where code = 'KC-0-48'`);
    await call(f, 'owner', `pm.dlr_apply_program($1, $2, 0)`, [ids.deal, promo.id]);
    const d = await one<{ finance_type: string; subvention_cents: string; amount_financed_cents: string }>(f, `select finance_type, subvention_cents, amount_financed_cents from pm.dealer_deals where id = $1`, [ids.deal]);
    expect(d.finance_type).toBe('RETAIL_FINANCE');
    expect(Number(d.subvention_cents)).toBe(Math.round(Number(d.amount_financed_cents) * 0.03));
    const w = await call<{ totals: { subvention_cents: number; back_gross_cents: number }; delivery: { can_deliver: boolean; blockers: Array<{ code: string }> }; amounts_visible: boolean }>(
      f, 'owner', `pm.dlr_deal_worksheet($1)`, [ids.deal]);
    expect(w.totals.subvention_cents).toBe(Number(d.subvention_cents));
    expect(w.delivery.can_deliver).toBe(false);
    expect(w.delivery.blockers.map((b) => b.code)).toContain('NOT_FUNDED');
    const reb = await one<{ id: string }>(f, `select id from pm.dlr_finance_programs where code = 'REB-1000'`);
    await call(f, 'owner', `pm.dlr_apply_program($1, $2)`, [ids.deal, reb.id]);
    expect(await callErr(f, 'owner', `pm.dlr_apply_program($1, $2)`, [ids.deal, reb.id])).toMatch(/PM_DUPLICATE/);
    expect(await callErr(f, 'pm', `pm.dlr_deal_worksheet($1)`, [ids.deal])).toMatch(forbidden);
  });
  it('sold-out-of-trust: a sold, floored unit with no scheduled payoff is on the GM list', async () => {
    await q(f.db, `update pm.assets set unit_status = 'SOLD', floored = true, floor_status = 'SOLD_UNPAID', payoff_cents = 1200000, payoff_scheduled = false, unit_sold_on = current_date - 3 where id = $1`, [ids.unit2]);
    const r = await as(f, 'owner', () => q<{ unit_id: string; days_unpaid: number }>(f.db, `select unit_id, days_unpaid from pm.v_dlr_sold_unpaid where location_id = $1`, [L1]));
    expect(r).toEqual([{ unit_id: ids.unit2, days_unpaid: 3 }]);
  });
});

describe('rental check-in damage compare (DLR-65/66)', () => {
  it('in vs out photos and zones → new damage, fuel and cleaning charges, applied before the final bill', async () => {
    const unit = await call<string>(f, 'owner', `pm.receive_unit($1, 'RNT-1', 'BOBCAT', 'S70', 2000000, jsonb_build_object('condition', 'RENTAL'))`, [L1]);
    ids.rental = (await one<{ id: string }>(f, `insert into pm.rental_contracts (org_id, location_id, number, asset_id, customer_id, status, reserved, rate_day_cents, checked_out_at, meter_out)
                 values ($1, $2, 'RC-1', $3, $4, 'OUT', tstzrange(now() - interval '2 days', now() + interval '1 day'), 25000, now() - interval '2 days', 100) returning id`,
      [ORG_A, L1, unit, ids.buyer])).id;
    await call(f, 'owner', `pm.dlr_record_rental_inspection($1, 'OUT', 100, 8, true, '[{"zone":"FRONT","condition":"OK"},{"zone":"BUCKET","condition":"SCRATCH"}]'::jsonb)`, [ids.rental]);
    await call(f, 'owner', `pm.check_in_rental($1, 130, 'used')`, [ids.rental]);
    await call(f, 'owner', `pm.dlr_record_rental_inspection($1, 'IN', 130, 5, false, '[{"zone":"FRONT","condition":"DENT"},{"zone":"REAR","condition":"SCRATCH"},{"zone":"BUCKET","condition":"SCRATCH"}]'::jsonb)`, [ids.rental]);
    const c = await call<{ new_damage: Array<{ zone: string }>; damage_cents: number; fuel_cents: number; cleaning_cents: number; suggested_total_cents: number }>(
      f, 'owner', `pm.dlr_rental_damage_compare($1)`, [ids.rental]);
    expect(c.new_damage.map((d) => d.zone).sort()).toEqual(['FRONT', 'REAR']);
    expect([c.damage_cents, c.fuel_cents, c.cleaning_cents]).toEqual([10000, 4500, 7500]);
    expect(c.suggested_total_cents).toBe(22000);
    await call(f, 'owner', `pm.dlr_apply_rental_charges($1, $2, $3, $4, 'Front dent, rear scratch')`, [ids.rental, c.damage_cents, c.fuel_cents, c.cleaning_cents]);
    const r = await one<{ damage_cents: string; fuel_cents: string }>(f, `select damage_cents, fuel_cents from pm.rental_contracts where id = $1`, [ids.rental]);
    expect([Number(r.damage_cents), Number(r.fuel_cents)]).toEqual([10000, 4500]);
    expect(await callErr(f, 'labor', `pm.dlr_rental_damage_compare($1)`, [ids.rental])).toMatch(forbidden);
  });
});

describe('tech clock per RO line + productivity board (DLR-47/56, make-or-break 6)', () => {
  beforeAll(async () => {
    const wo2 = f.ids[`wo:${J2}`]!;
    const wo1 = f.ids[`wo:${J1}`]!;
    ids.l1 = (await one<{ id: string }>(f, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents) values ($1, $2, $3, 'LABOR', 'Blade sharpen', 1, 9000) returning id`, [ORG_A, J2, wo2])).id;
    ids.l2 = (await one<{ id: string }>(f, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents) values ($1, $2, $3, 'LABOR', 'Deck level', 1, 9000) returning id`, [ORG_A, J2, wo2])).id;
    ids.lOther = (await one<{ id: string }>(f, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents) values ($1, $2, $3, 'LABOR', 'Other job', 1, 9000) returning id`, [ORG_A, J1, wo1])).id;
  });
  it('a tech clocks on their RO line; moving to the next line closes the first into a SUBMITTED time entry', async () => {
    const a = await call<{ punch_id: string }>(f, 'labor', `pm.dlr_clock_on($1)`, [ids.l1]);
    await q(f.db, `update pm.dlr_tech_punches set started_at = now() - interval '90 minutes' where id = $1`, [a.punch_id]);
    const b = await call<{ closed: { hours: number; time_entry_id: string } }>(f, 'labor', `pm.dlr_clock_on($1)`, [ids.l2]);
    expect(Number(b.closed.hours)).toBeCloseTo(1.5, 2);
    const te = await one<{ job_id: string; approval_state: string; work_order_id: string; employee_id: string }>(f, `select job_id, approval_state, work_order_id, employee_id from pm.time_entries where id = $1`, [b.closed.time_entry_id]);
    expect(te).toEqual({ job_id: J2, approval_state: 'SUBMITTED', work_order_id: f.ids[`wo:${J2}`], employee_id: f.employee.labor });
  });
  it('a tech cannot clock on to somebody else\'s RO', async () => {
    expect(await callErr(f, 'labor', `pm.dlr_clock_on($1)`, [ids.lOther])).toMatch(forbidden);
  });
  it('flagged vs clocked on the board: efficiency and the live punch; a tech sees only their own row', async () => {
    await call(f, 'labor', `pm.dlr_flag_line($1, 2.0)`, [ids.l1]);
    const loc = (await one<{ location_id: string }>(f, `select location_id from core.jobs where id = $1`, [J2])).location_id;
    const all = await call<{ all_techs: boolean; techs: Array<{ employee_id: string; clocked_hours: number; flagged_hours: number; efficiency: number; open_punch: unknown }> }>(
      f, 'owner', `pm.dlr_tech_board($1, current_date, current_date)`, [loc]);
    expect(all.all_techs).toBe(true);
    const me = all.techs.find((t) => t.employee_id === f.employee.labor)!;
    expect(Number(me.flagged_hours)).toBeCloseTo(2, 1);
    expect(Number(me.clocked_hours)).toBeGreaterThanOrEqual(1.5);
    expect(me.open_punch).toBeTruthy();
    const mine = await call<{ all_techs: boolean; techs: unknown[] }>(f, 'labor', `pm.dlr_tech_board($1)`, [loc]);
    expect(mine.all_techs).toBe(false);
    expect(mine.techs).toHaveLength(1);
  });
  it('clock off and indirect time', async () => {
    // security review L1: naming yourself does not skip the corrected-end-time check
    expect(await callErr(f, 'labor', `pm.dlr_clock_off($1, $2, now() - interval '3 hours')`, [L1, f.employee.labor])).toMatch(forbidden);
    expect(await call<{ open: boolean }>(f, 'labor', `pm.dlr_clock_off($1)`, [L1])).toMatchObject({ open: true });
    expect(await call<{ punch_id: string }>(f, 'labor', `pm.dlr_clock_indirect($1, 'SHOP')`, [L1])).toHaveProperty('punch_id');
    const n = await one<{ n: number }>(f, `select count(*)::int n from pm.dlr_tech_punches where employee_id = $1 and ended_at is null`, [f.employee.labor]);
    expect(n.n).toBe(1);
    // the punch table is personal: a tech never sees another tech's punches; the service manager does
    await q(f.db, `insert into pm.dlr_tech_punches (org_id, location_id, employee_id, kind, started_at, ended_at) values ($1, $2, $3, 'SHOP', now() - interval '1 hour', now())`,
      [ORG_A, L1, f.employee.supervisor]);
    const seen = await as(f, 'labor', () => q<{ employee_id: string }>(f.db, `select distinct employee_id from pm.dlr_tech_punches`));
    expect(seen).toEqual([{ employee_id: f.employee.labor }]);
    expect((await as(f, 'owner', () => q(f.db, `select distinct employee_id from pm.dlr_tech_punches`))).length).toBe(2);
  });
});

describe('dealer KPI dashboard (DLR-75)', () => {
  it('counter, service, warranty, units and rental figures in one call; absorption needs Books', async () => {
    const k = await call<Record<string, Record<string, unknown>>>(f, 'owner', `pm.dlr_kpis($1)`, [L1]);
    expect(k.counter!.tickets).toBeGreaterThanOrEqual(1);
    expect(Number(k.counter!.fill_rate)).toBeGreaterThan(0);
    expect(k.counter!.lost_sales).toBeGreaterThanOrEqual(1);
    expect(k.warranty!.outstanding).toBeGreaterThanOrEqual(1);
    expect(k.units!.sold_unpaid).toBe(1);
    expect(k.absorption!.available).toBe(false);
    expect(await callErr(f, 'dispatcher', `pm.dlr_kpis($1)`, [L1])).toMatch(forbidden);
  });
});

describe('idempotency', () => {
  it('1122 applies a second time and the registries stay clean', async () => {
    const before = await one<{ n: number }>(f, `select count(*)::int n from pm.dlr_price_file_lines`);
    await reapply1122(f);
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.dlr_price_file_lines`)).n).toBe(before.n);
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});
