/**
 * Wave C flooring and interior design completion (migration 1124).
 * Flooring: setup plan + labor price list, salesperson rotation, price-file diff with the margin
 * impact on open quotes, deposit terms, counter sale with remnant relief, on-site change orders
 * signed on the device flowing to installer pay, special orders → POs → receiving with
 * inspection, shade lots with the lot-mix warning, installer compliance blocking dispatch, the
 * installer day + sign-off, the completion invoice, callbacks and the reports.
 * Design: firm setup, discovery, letter of agreement → retainer, rooms with budgets and the
 * over-budget alert, clipper + pricing rules (SQL ≡ lib/design/pricing.ts), boards presented to
 * the portal, the FF&E schedule, cancel with restocking, freight claims, install day, product and
 * reimbursable invoicing, the deposit statement and the reports.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, q, errorOf, type Fixture, ORG_A, L1, L2, J1, J2, J3 } from './fixture';
import { call, callErr, documentRow, forbidden, one, stockLocation, vendor } from './industry';
import { setupWaveC } from './wave-c';
import { buildFlooringPlan } from '../../../apps/projects/src/lib/flooring/setup';
import { buildDesignPlan } from '../../../apps/projects/src/lib/design/setup';
import { priceUnit } from '../../../apps/projects/src/lib/design/pricing';

let f: Fixture;
const ids: Record<string, string> = {};

beforeAll(async () => {
  f = await setupWaveC('wave-c-flooring-design');
  await q(f.db, `update pm.contracts set status = 'ACTIVE' where job_id in ($1, $2)`, [J2, J3]);
  ids.acme = (await one<{ id: string }>(f, `select customer_id as id from core.jobs where id = $1`, [J2])).id ?? '';
  if (!ids.acme) {
    ids.acme = (await one<{ id: string }>(f, `insert into core.customers (org_id, name) values ($1, 'Acme') returning id`, [ORG_A])).id;
    await q(f.db, `update core.jobs set customer_id = $2 where id = $1`, [J2, ids.acme]);
  }
  ids.acmeContact = (await one<{ id: string }>(f, `insert into core.contacts (org_id, customer_id, first_name, email, phone, sms_consent, is_primary) values ($1, $2, 'Ann', 'ann@acme.test', '515-555-0177', true, true) returning id`,
    [ORG_A, ids.acme])).id;
  ids.client = (await one<{ id: string }>(f, `insert into core.customers (org_id, name) values ($1, 'The Parkers') returning id`, [ORG_A])).id;
  await q(f.db, `update core.jobs set customer_id = $2 where id = $1`, [J3, ids.client]);
  ids.mill = await vendor(f, 'Shaw Mills');
  ids.sl = await stockLocation(f, 'DEPOT');
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('flooring setup, rotation, price files, deposit, counter (FLR-01/03/14/17/19)', () => {
  it('the setup plan writes settings and a starter labor price list (settings holders only)', async () => {
    const plan = buildFlooringPlan({ mix: ['RETAIL_INSTALLED', 'CASH_AND_CARRY'], installerPay: 'PIECE_RATE', depositPct: 0.5, taxStates: ['ia'], replacing: 'RFMS', measureFeeCents: 7500 });
    expect(await callErr(f, 'gm', `pm.wc_apply_setup($1, 'FLOORING', '{}'::jsonb, $2::jsonb)`, [L1, JSON.stringify(plan)])).toMatch(forbidden);
    await call(f, 'owner', `pm.wc_apply_setup($1, 'FLOORING', '{}'::jsonb, $2::jsonb)`, [L1, JSON.stringify(plan)]);
    const s = await one<{ business_mix: string[]; tax_states: string[]; measure_fee_cents: string }>(f, `select business_mix, tax_states, measure_fee_cents from pm.flr_settings where location_id = $1`, [L1]);
    expect(s.business_mix).toEqual(['RETAIL_INSTALLED', 'CASH_AND_CARRY']);
    expect(s.tax_states).toEqual(['IA']);
    expect(Number(s.measure_fee_cents)).toBe(7500);
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.flr_labor_rates where location_id = $1`, [L1])).n).toBe(8);
  });
  it('walk-in "ups" rotate between salespeople with a follow-up', async () => {
    await as(f, 'owner', () => q(f.db, `insert into pm.flr_lead_rotation (location_id, members) values ($1, $2::uuid[])`, [L1, [f.membership.dispatcher, f.membership.gm]]));
    const pipe = await one<{ p: string; s: string }>(f, `select p.id as p, s.id as s from crm.pipelines p join crm.pipeline_stages s on s.pipeline_id = p.id where p.location_id = $1 order by s.sort limit 1`, [L1]);
    const lead = async (t: string) => (await one<{ id: string }>(f, `insert into crm.leads (org_id, location_id, pipeline_id, stage_id, title, source) values ($1, $2, $3, $4, $5, 'walk-in') returning id`, [ORG_A, L1, pipe.p, pipe.s, t])).id;
    ids.lead1 = await lead('Walk-in: living room carpet');
    const l2 = await lead('Walk-in: LVP kitchen');
    expect((await call<{ owner_membership_id: string }>(f, 'dispatcher', `pm.flr_assign_lead($1)`, [ids.lead1])).owner_membership_id).toBe(f.membership.dispatcher);
    expect((await call<{ owner_membership_id: string }>(f, 'dispatcher', `pm.flr_assign_lead($1)`, [l2])).owner_membership_id).toBe(f.membership.gm);
    expect((await one<{ n: number }>(f, `select count(*)::int n from crm.followups where lead_id in ($1, $2)`, [ids.lead1, l2])).n).toBe(2);
    expect(await callErr(f, 'labor', `pm.flr_assign_lead($1)`, [l2])).toMatch(forbidden);
  });
  it('a price file diffs against the product file and shows the margin hit on open quotes', async () => {
    ids.carpet = (await one<{ id: string }>(f, `insert into pm.flr_products (org_id, location_id, sku, style, color, vendor_id, category, sell_uom, roll_width_ft, cost_cents, price_retail_cents)
                    values ($1, $2, 'SH-100', 'Plush', 'Oat', $3, 'CARPET', 'SY', 12, 1000, 2600) returning id`, [ORG_A, L1, ids.mill])).id;
    const est = await one<{ id: string }>(f, `select id from pm.estimates where job_id = $1`, [J2]);
    const el = await one<{ id: string }>(f, `insert into pm.estimate_lines (org_id, estimate_id, description, qty, unit_cost_cents, unit_price_cents, amount_cents) values ($1, $2, 'Plush carpet', 50, 1000, 2600, 130000) returning id`, [ORG_A, est.id]);
    await q(f.db, `insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, line_class, tax_class, product_id, measured_qty, uom) values ($1, $2, $3, 'MATERIAL', 'MATERIAL', $4, 50, 'SY')`, [ORG_A, est.id, el.id, ids.carpet]);
    const st = await call<{ import_id: string; changed: number; new: number; open_quote_margin_impact_cents: number }>(f, 'owner', `pm.flr_stage_price_import($1, $2, 'FCB2B_832', 'shaw.832', $3::jsonb)`,
      [L1, ids.mill, JSON.stringify([{ sku: 'SH-100', cost_cents: 1100, retail_cents: 2800 }, { sku: 'SH-200', style: 'Berber', cost_cents: 900 }])]);
    expect(st).toMatchObject({ changed: 1, new: 1, open_quote_margin_impact_cents: -5000 });
    const masked = await as(f, 'dispatcher', () => q<{ new_cost_cents: string | null }>(f.db, `select new_cost_cents from pm.v_flr_price_import_lines_masked where import_id = $1`, [st.import_id]));
    expect(masked.every((x) => x.new_cost_cents === null)).toBe(true);
    expect(await callErr(f, 'dispatcher', `pm.flr_apply_price_import($1)`, [st.import_id])).toMatch(forbidden);
    expect((await call<{ updated: number; new_skus: number }>(f, 'owner', `pm.flr_apply_price_import($1)`, [st.import_id]))).toMatchObject({ updated: 1, new_skus: 1 });
    expect(Number((await one<{ c: string }>(f, `select cost_cents as c from pm.flr_products where id = $1`, [ids.carpet])).c)).toBe(1100);
  });
  it('deposit as a percent with the refundable flag; a counter sale relieves the remnant and hands Books the sale', async () => {
    const d = await call<{ amount_cents: number; refundable: boolean; deposit_request_id: string }>(f, 'owner', `pm.flr_request_deposit($1, 0.4, null, true)`, [J2]);
    expect(d).toMatchObject({ amount_cents: 1000000, refundable: true });
    ids.remnant = (await one<{ id: string }>(f, `insert into pm.flr_rolls (org_id, location_id, product_id, roll_number, dye_lot, width_in, original_len_in, remaining_len_in, status)
                     values ($1, $2, $3, 'R-9', 'D44', 144, 1200, 96, 'REMNANT') returning id`, [ORG_A, L1, ids.carpet])).id;
    const s = await call<{ subtotal_cents: number; tax_cents: number; total_cents: number }>(f, 'owner', `pm.flr_counter_sale($1, $2::jsonb, 0.07, null, 'Walk-in', 'CARD')`, [L1,
      JSON.stringify([{ kind: 'REMNANT', roll_id: ids.remnant, description: '12x8 remnant', qty: 1, unit_price_cents: 9900 }, { kind: 'SUNDRY', description: 'Seam tape', qty: 2, unit_price_cents: 650, taxable: true }])]);
    expect(s).toEqual({ ...s, subtotal_cents: 11200, tax_cents: 784, total_cents: 11984 });
    expect((await one<{ status: string }>(f, `select status from pm.flr_rolls where id = $1`, [ids.remnant])).status).toBe('DEPLETED');
    expect(await callErr(f, 'owner', `pm.flr_counter_sale($1, $2::jsonb)`, [L1, JSON.stringify([{ kind: 'REMNANT', roll_id: ids.remnant, description: 'again', qty: 1, unit_price_cents: 1 }])])).toMatch(/not available/);
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.wc_books_requests where kind = 'COUNTER_SALE'`)).n).toBe(1);
  });
});

describe('field changes, special orders, receiving, lots (FLR-20/21/23/26/28)', () => {
  it('an on-site change priced from the labor list, signed on the device, flows to the installer\'s pay ticket', async () => {
    const r = await call<{ change_order_id: string; sell_cents: number; pay_cents: number }>(f, 'owner', `pm.flr_field_change($1, '[{"labor_code":"FLOOR_PREP","qty":120},{"labor_code":"MOISTURE","qty":40}]'::jsonb, 'Ann Acme')`, [J2]);
    expect(r).toMatchObject({ sell_cents: 26000, pay_cents: 15200 });
    expect((await one<{ stage: string; signer_name: string }>(f, `select stage, signer_name from pm.change_orders where id = $1`, [r.change_order_id]))).toMatchObject({ signer_name: 'Ann Acme' });
    const seen = await as(f, 'dispatcher', () => q<{ pay_cents: string | null; lines: Array<Record<string, unknown>> }>(f.db, `select pay_cents, sell_cents, lines from pm.v_flr_field_changes_masked where job_id = $1`, [J2]));
    expect(seen[0]!.pay_cents).toBeNull();
    expect((seen[0] as unknown as { sell_cents: string | null }).sell_cents ?? null).toBeNull();   // L9: dispatcher has no contract_value
    expect(Object.keys(seen[0]!.lines[0]!)).not.toContain('pay_cents');
    const t = await one<{ id: string }>(f, `insert into pm.flr_pay_tickets (org_id, location_id, job_id, number, worker_type, employee_id, completed_on, status, gross_cents) values ($1, $2, $3, 'PT-1', 'W2', $4, current_date, 'DRAFT', 50000) returning id`,
      [ORG_A, L1, J2, f.employee.labor]);
    // M3: only an approved change pays — a signed-but-unapproved one waits
    const co = await one<{ stage: string }>(f, `select stage from pm.change_orders where id = $1`, [r.change_order_id]);
    if (co.stage !== 'APPROVED') {
      expect((await call<{ lines_added: number }>(f, 'owner', `pm.flr_add_field_changes_to_ticket($1)`, [t.id])).lines_added).toBe(0);
      await call(f, 'gm', `pm.approval_decide('change_order', $1, 'approve', null, null, null, 'web')`, [r.change_order_id]);   // an approver who is not the preparer
      expect((await one<{ stage: string }>(f, `select stage from pm.change_orders where id = $1`, [r.change_order_id])).stage).toBe('APPROVED');
    }
    const a = await call<{ lines_added: number; added_cents: number }>(f, 'owner', `pm.flr_add_field_changes_to_ticket($1)`, [t.id]);
    expect(a).toMatchObject({ lines_added: 2, added_cents: 15200 });
    expect((await call<{ lines_added: number }>(f, 'owner', `pm.flr_add_field_changes_to_ticket($1)`, [t.id])).lines_added).toBe(0);
    expect(Number((await one<{ g: string }>(f, `select gross_cents as g from pm.flr_pay_tickets where id = $1`, [t.id])).g)).toBe(65200);
  });
  it('a re-sent phone command returns the first change order (lasting ledger), never a second one', async () => {
    const cmd = '0f9e8d7c-6b5a-4949-8838-271615141312';
    const sql = `pm.flr_field_change($1, '[{"labor_code":"STAIRS","qty":3}]'::jsonb, null, null, 'Three extra steps', $2::uuid)`;
    const before = (await one<{ n: number }>(f, `select count(*)::int n from pm.change_orders where job_id = $1`, [J2])).n;
    const a = await call<{ change_order_id: string; replayed: boolean }>(f, 'owner', sql, [J2, cmd]);
    const b = await call<{ change_order_id: string; replayed: boolean }>(f, 'owner', sql, [J2, cmd]);
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ change_order_id: a.change_order_id, replayed: true });
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.change_orders where job_id = $1`, [J2])).n).toBe(before + 1);
    expect((await one<{ kind: string; subject_id: string }>(f, `select kind, subject_id from pm.wc_field_commands where command_id = $1`, [cmd]))).toEqual({ kind: 'flr.field_change', subject_id: a.change_order_id });
    // a failed command leaves no claim behind, so the corrected re-send goes through
    const bad = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
    expect(await callErr(f, 'owner', `pm.flr_field_change($1, '[{"labor_code":"NOPE","qty":1}]'::jsonb, null, null, null, $2::uuid)`, [J2, bad])).toMatch(/labor price list/);
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.wc_field_commands where command_id = $1`, [bad])).n).toBe(0);
    // L1: the same command id from another person (or for another job) is refused, never replayed
    expect(await callErr(f, 'gm', sql, [J2, cmd])).toMatch(/already used/);
    expect(await callErr(f, 'owner', `pm.flr_field_change($1, '[{"labor_code":"STAIRS","qty":3}]'::jsonb, null, null, null, $2::uuid)`, [J3, cmd])).toMatch(/already used/);
  });
  it('M3: without change_orders:edit an installer records a signature only with their own signature image', async () => {
    const lines = '[{"labor_code":"FLOOR_PREP","qty":10}]';
    expect(await callErr(f, 'supervisor', `pm.flr_field_change($1, $2::jsonb, 'Ann Acme')`, [J1, lines])).toMatch(/capture the customer/);
    const notMine = await documentRow(f, 'sig-other.png');
    await q(f.db, `update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.owner, notMine]);
    expect(await callErr(f, 'supervisor', `pm.flr_field_change($1, $2::jsonb, 'Ann Acme', $3)`, [J1, lines, notMine])).toMatch(/capture the customer/);
    const sig = await documentRow(f, 'sig.png');
    await q(f.db, `update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.supervisor, sig]);
    const r = await call<{ change_order_id: string; signature: unknown }>(f, 'supervisor', `pm.flr_field_change($1, $2::jsonb, 'Ann Acme', $3)`, [J1, lines, sig]);
    expect(r.signature).not.toBeNull();
    // unsigned changes are fine without a signature (they wait for the office)
    expect((await call<{ change_order_id: string }>(f, 'supervisor', `pm.flr_field_change($1, $2::jsonb)`, [J1, lines])).change_order_id).toBeTruthy();
  });
  it('special order → PO by vendor → receive: damage needs photos; a good receipt tells the customer', async () => {
    ids.so = await call<string>(f, 'owner', `pm.flr_special_order($1, $2, 40, 'STORE')`, [J2, ids.carpet]);
    const pos = await call<{ purchase_orders: Array<{ commitment_id: string }> }>(f, 'owner', `pm.flr_create_special_order_pos($1)`, [J2]);
    expect(pos.purchase_orders).toHaveLength(1);
    expect((await one<{ title: string }>(f, `select title from pm.commitments where id = $1`, [pos.purchase_orders[0]!.commitment_id])).title).toBe('Special order');
    const tr = await call<{ items: Array<{ id: string; bucket: string }> }>(f, 'dispatcher', `pm.flr_special_order_tracker($1)`, [L1]);
    expect(tr.items.some((x) => x.id === ids.so)).toBe(true);
    expect(await callErr(f, 'owner', `pm.flr_receive_special_order($1, 40, 'DAMAGED')`, [ids.so])).toMatch(/photograph/);
    const r = await call<{ condition: string; landed_cost_cents: number }>(f, 'owner', `pm.flr_receive_special_order($1, 40, 'GOOD', '{}', 2500, 'D51')`, [ids.so]);
    expect(r).toMatchObject({ condition: 'GOOD', landed_cost_cents: 46500 });
    expect((await one<{ n: number }>(f, `select count(*)::int n from core.outbound_messages where dispatch_key = $1`, [`flr.arrived:${ids.so}`])).n).toBe(1);
    const u = await call<string>(f, 'owner', `pm.flr_log_unmatched_receipt($1, '3 rolls of pad, no paperwork', 'Shaw Mills', 'PO-??', 3)`, [L1]);
    const tr2 = await call<{ unmatched: Array<{ id: string }> }>(f, 'owner', `pm.flr_special_order_tracker($1)`, [L1]);
    expect(tr2.unmatched.map((x) => x.id)).toContain(u);
    // M2: a dock receipt at one store cannot receive another store's order line
    const other = await call<string>(f, 'owner', `pm.flr_log_unmatched_receipt($1, 'Pallet at the other store', 'Shaw Mills', null, 1)`, [L2]);
    const so2 = await call<string>(f, 'owner', `pm.flr_special_order($1, $2, 5, 'STORE')`, [J2, ids.carpet]);
    await call(f, 'owner', `pm.flr_create_special_order_pos($1)`, [J2]);
    expect(await callErr(f, 'owner', `pm.flr_match_receipt($1, $2)`, [other, so2])).toMatch(/another store/);
    expect(await callErr(f, 'labor', `pm.flr_match_receipt($1, $2)`, [u, so2])).toMatch(forbidden);
  });
  it('shade lots: receive with a barcode, reserve, the lot-mix warning, counts never below what is reserved', async () => {
    ids.lvp = (await one<{ id: string }>(f, `insert into pm.flr_products (org_id, location_id, sku, style, category, sell_uom, carton_sf, cost_cents) values ($1, $2, 'LV-1', 'Oak', 'LVP', 'CARTON', 23.68, 5500) returning id`, [ORG_A, L1])).id;
    const a = await call<{ lot_id: string; barcode: string }>(f, 'owner', `pm.flr_receive_lot($1, $2, 'sh-01', 20, $3, 'P1')`, [L1, ids.lvp, ids.sl]);
    expect(a.barcode).toMatch(/^FL[0-9A-F]{10}$/);
    const b = await call<{ lot_id: string }>(f, 'owner', `pm.flr_receive_lot($1, $2, 'SH-02', 10)`, [L1, ids.lvp]);
    expect((await call<{ warning: string | null }>(f, 'owner', `pm.flr_move_lot($1, 'RESERVE', 12, null, $2)`, [a.lot_id, J2])).warning).toBeNull();
    expect((await call<{ warning: string | null }>(f, 'owner', `pm.flr_move_lot($1, 'RESERVE', 2, null, $2)`, [b.lot_id, J2])).warning).toMatch(/another shade lot/);
    expect(await callErr(f, 'owner', `pm.flr_move_lot($1, 'COUNT', 10)`, [a.lot_id])).toMatch(/below what is reserved/);
    await call(f, 'owner', `pm.flr_move_lot($1, 'COUNT', 19)`, [a.lot_id]);
    expect((await one<{ c: number }>(f, `select cartons_on_hand as c from pm.flr_lots where id = $1`, [a.lot_id])).c).toBe(19);
    expect(await callErr(f, 'labor', `pm.flr_move_lot($1, 'ISSUE', 1)`, [a.lot_id])).toMatch(forbidden);
    // L10: a transfer only to a stock location at the same store; an on-account sale only for a customer of this store
    const away = await stockLocation(f, 'AWAY', 'WAREHOUSE', L2);
    expect(await callErr(f, 'owner', `pm.flr_move_lot($1, 'TRANSFER', null, $2)`, [a.lot_id, away])).toMatch(/at this store/);
    const c2 = (await one<{ id: string }>(f, `insert into core.customers (org_id, name, location_id) values ($1, 'Other store account', $2) returning id`, [ORG_A, L2])).id;
    expect(await callErr(f, 'owner', `pm.flr_counter_sale($1, '[{"kind":"SUNDRY","description":"Tack strip","qty":1,"unit_price_cents":500}]'::jsonb, 0, $2, null, 'ON_ACCOUNT')`, [L1, c2])).toMatch(/no account at this store/);
  });
});

describe('installers, confirmations, the installer day, completion, callbacks, reports (FLR-31/32/33/36/37/44)', () => {
  it('an installer with an expired COI cannot be dispatched until the documents are current', async () => {
    ids.crew = (await one<{ id: string }>(f, `insert into pm.crews (org_id, location_id, name, kind) values ($1, $2, 'Crew A', 'INSTALL') returning id`, [ORG_A, L1])).id;
    ids.sub = await vendor(f, 'Rivera Installs LLC');
    ids.installer = await call<string>(f, 'dispatcher', `pm.flr_save_installer($1, null, $2::jsonb)`, [L1, JSON.stringify({ name: 'Luis Rivera', worker_type: '1099', vendor_id: ids.sub, crew_id: ids.crew,
      coi_expires_on: '2026-01-01', workers_comp_expires_on: '2030-01-01', w9_on_file: true })]);
    const c = await call<{ installers: Array<{ blockers: string[] }> }>(f, 'dispatcher', `pm.flr_installer_compliance($1)`, [L1]);
    expect(c.installers[0]!.blockers).toEqual(['Certificate of insurance missing or expired']);
    expect(await errorOf(f.db, `insert into pm.flr_install_bookings (org_id, job_id, crew_id, install_on, sf) values ($1, $2, $3, current_date + 2, 400)`, [ORG_A, J2, ids.crew])).toMatch(/PM_FLR_INSTALLER_NONCOMPLIANT/);
    await call(f, 'dispatcher', `pm.flr_save_installer($1, $2, '{"coi_expires_on":"2030-01-01"}'::jsonb)`, [L1, ids.installer]);
    ids.booking = (await one<{ id: string }>(f, `insert into pm.flr_install_bookings (org_id, job_id, crew_id, install_on, sf) values ($1, $2, $3, current_date + 2, 400) returning id`, [ORG_A, J2, ids.crew])).id;
  });
  it('confirmations go out N days ahead once; "on my way" from the crew', async () => {
    expect(await call<number>(f, 'dispatcher', `pm.flr_send_install_confirmations($1, 2)`, [L1])).toBe(1);
    expect(await call<number>(f, 'dispatcher', `pm.flr_send_install_confirmations($1, 2)`, [L1])).toBe(1);
    expect((await one<{ n: number }>(f, `select count(*)::int n from core.outbound_messages where event_type = 'customer.install_confirmation'`)).n).toBe(1);
    await call(f, 'dispatcher', `pm.flr_booking_status($1, 'CONFIRMED')`, [ids.booking]);
    expect((await one<{ status: string }>(f, `select status from pm.flr_install_bookings where id = $1`, [ids.booking])).status).toBe('CONFIRMED');
  });
  it('the installer day lists the booking with its areas; sign-off closes it and returns leftover roll goods', async () => {
    const day = await call<{ bookings: Array<{ booking_id: string; site_checks_needed: string[] }>; my_pay_this_week_cents: number }>(f, 'dispatcher', `pm.flr_installer_day(current_date + 2)`);
    expect(day.bookings.map((b) => b.booking_id)).toContain(ids.booking);
    expect(day.bookings[0]!.site_checks_needed).toEqual(expect.arrayContaining(['MOISTURE']));
    const roll = await one<{ id: string }>(f, `insert into pm.flr_rolls (org_id, location_id, product_id, roll_number, dye_lot, width_in, original_len_in, remaining_len_in, status) values ($1, $2, $3, 'R-10', 'D51', 144, 1200, 0, 'DEPLETED') returning id`, [ORG_A, L1, ids.carpet]);
    const tk = await one<{ id: string }>(f, `insert into pm.flr_cut_tickets (org_id, job_id, number) values ($1, $2, 'CT-1') returning id`, [ORG_A, J2]);
    await f.db.query(`insert into pm.flr_cuts (org_id, ticket_id, roll_id, seq, room, planned_len_in) values ($1, $2, $3, 1, 'Living', 180)`, [ORG_A, tk.id, roll.id]);
    const d2 = await call<{ bookings: Array<{ booking_id: string; cuts: Array<{ roll_id: string; roll: string }>; labor_codes: Array<Record<string, unknown>> }> }>(f, 'dispatcher', `pm.flr_installer_day(current_date + 2)`);
    const bk = d2.bookings.find((x) => x.booking_id === ids.booking)!;
    expect(bk.cuts).toEqual([expect.objectContaining({ roll_id: roll.id, roll: 'R-10' })]);
    expect(bk.labor_codes.map((x) => x.code)).toEqual(expect.arrayContaining(['FLOOR_PREP', 'MOISTURE', 'STAIRS']));
    expect(JSON.stringify(bk.labor_codes)).not.toMatch(/_cents/);
    const stray = await one<{ id: string }>(f, `insert into pm.flr_rolls (org_id, location_id, product_id, roll_number, dye_lot, width_in, original_len_in, remaining_len_in, status) values ($1, $2, $3, 'R-99', 'D51', 144, 1200, 0, 'DEPLETED') returning id`, [ORG_A, L1, ids.carpet]);
    expect(await callErr(f, 'dispatcher', `pm.flr_record_signoff($1, 'Ann Acme', null, '{}', $2::jsonb)`, [ids.booking, JSON.stringify([{ roll_id: stray.id, len_in: 60 }])])).toMatch(/not cut for this job/);
    await call(f, 'dispatcher', `pm.flr_record_signoff($1, 'Ann Acme', null, '{}', $2::jsonb)`, [ids.booking, JSON.stringify([{ roll_id: roll.id, len_in: 60 }])]);
    expect((await one<{ status: string; remaining_len_in: string }>(f, `select status, remaining_len_in from pm.flr_rolls where id = $1`, [roll.id]))).toMatchObject({ status: 'REMNANT' });
    expect((await one<{ status: string }>(f, `select status from pm.flr_install_bookings where id = $1`, [ids.booking])).status).toBe('DONE');
    expect(await callErr(f, 'dispatcher', `pm.flr_record_signoff($1, 'Ann')`, [ids.booking])).toMatch(/done/);
    // round 2: the leftover cap is cumulative per job + roll (180 in planned, 60 already back → at most 120 more)
    const before = Number((await one<{ r: string }>(f, `select remaining_len_in as r from pm.flr_rolls where id = $1`, [roll.id])).r);
    const b2 = (await one<{ id: string }>(f, `insert into pm.flr_install_bookings (org_id, job_id, crew_id, install_on, sf) values ($1, $2, $3, current_date + 3, 50) returning id`, [ORG_A, J2, ids.crew])).id;
    await call(f, 'dispatcher', `pm.flr_record_signoff($1, 'Ann Acme', null, '{}', $2::jsonb)`, [b2, JSON.stringify([{ roll_id: roll.id, len_in: 500 }])]);
    expect(Number((await one<{ r: string }>(f, `select remaining_len_in as r from pm.flr_rolls where id = $1`, [roll.id])).r) - before).toBe(120);
    await q(f.db, `delete from pm.flr_signoffs where booking_id = $1`, [b2]);
    await q(f.db, `delete from pm.flr_install_bookings where id = $1`, [b2]);   // keep the later report totals to the one install
  });
  it('completion invoice for the balance; a callback tied to roll, installer and mill; reports', async () => {
    const ci = await call<{ billing_request_id: string; balance_cents: number; deposits_on_file_cents: number }>(f, 'owner', `pm.flr_completion_invoice($1)`, [J2]);
    expect(ci.balance_cents).toBeGreaterThan(0);
    expect((await one<{ status: string; billing_type: string }>(f, `select status, billing_type from pm.billing_requests where id = $1`, [ci.billing_request_id]))).toEqual({ status: 'DRAFT', billing_type: 'MILESTONE' });
    const cb = await call<{ callback_id: string; punch_item_id: string }>(f, 'owner', `pm.flr_open_callback($1, 'SEAM', 'Seam peaking in hall', $2, $3)`, [J2, ids.remnant, ids.installer]);
    expect((await one<{ kind: string }>(f, `select kind from pm.punch_items where id = $1`, [cb.punch_item_id])).kind).toBe('CALLBACK');
    await call(f, 'owner', `pm.flr_close_callback($1, 'INSTALLER', 18000)`, [cb.callback_id]);
    const r = await call<{ callbacks: { by_installer: Array<{ installer: string; callbacks: number }>; by_mill: Array<{ mill: string }> }; installer_productivity: Array<{ sf: number }>; completed_unbilled: unknown[] }>(
      f, 'owner', `pm.flr_reports($1, current_date - 30, current_date + 30)`, [L1]);
    expect(r.callbacks.by_installer).toEqual([{ installer: 'Luis Rivera', callbacks: 1 }]);
    expect(r.callbacks.by_mill[0]!.mill).toBe('Shaw Mills');
    expect(Number(r.installer_productivity[0]!.sf)).toBe(400);
    expect(await callErr(f, 'labor', `pm.flr_reports($1)`, [L1])).toMatch(forbidden);
  });
});

describe('interior design (ID-01/03/04/05/06/07/08/11/13/14)', () => {
  it('firm setup at the design company', async () => {
    const plan = buildDesignPlan({ firmType: 'RESIDENTIAL_FULL_SERVICE', feeModels: ['HOURLY', 'PROCUREMENT_FEE'], markupPct: 0.4, productDepositPct: 0.5, retainerCents: 500000,
      retainerEvergreen: true, showCostToClients: false, receivers: [{ name: 'Metro Receiving', address: '100 Dock St' }], taxStates: ['IA'], replacing: 'Studio Designer' });
    await call(f, 'owner', `pm.wc_apply_setup($1, 'DESIGN', '{}'::jsonb, $2::jsonb)`, [L2, JSON.stringify(plan)]);
    const s = await one<{ default_markup_pct: string; fee_models: string[]; receivers: unknown[] }>(f, `select default_markup_pct, fee_models, receivers from pm.dsn_settings where location_id = $1`, [L2]);
    expect(Number(s.default_markup_pct)).toBe(0.4);
    expect(s.fee_models).toEqual(['HOURLY', 'PROCUREMENT_FEE']);
    expect(s.receivers).toHaveLength(1);
  });
  it('discovery notes on an inquiry (leads holders only)', async () => {
    const d = await call<string>(f, 'dispatcher', `pm.dsn_save_discovery($1, '{"rooms":["Living","Primary bedroom"],"budget_low_cents":5000000,"budget_high_cents":8000000,"fit":"GOOD"}'::jsonb)`, [ids.lead1]);
    expect((await one<{ rooms: string[]; fit: string }>(f, `select rooms, fit from pm.dsn_discovery where id = $1`, [d]))).toEqual({ rooms: ['Living', 'Primary bedroom'], fit: 'GOOD' });
    expect(await callErr(f, 'labor', `pm.dsn_save_discovery($1, '{}'::jsonb)`, [ids.lead1])).toMatch(forbidden);
  });
  it('letter of agreement from the fee agreement; signing requests the retainer invoice', async () => {
    await call(f, 'owner', `pm.dsn_set_fee_agreement($1, '{"fee_model":"HOURLY","hourly_rate_cents":17500,"retainer_cents":500000,"retainer_evergreen":true,"procurement_fee_pct":0.15}'::jsonb)`, [J3]);
    ids.agr = await call<string>(f, 'owner', `pm.dsn_draft_agreement($1, 'Site visits within 30 miles are included.')`, [J3]);
    const a = await one<{ letter: string; retainer_cents: string }>(f, `select letter, retainer_cents from pm.dsn_agreements where id = $1`, [ids.agr]);
    expect(a.letter).toMatch(/billed hourly/);
    expect(a.letter).toMatch(/procurement fee of 15/);
    expect(a.letter).toMatch(/replenished/);
    await call(f, 'owner', `pm.dsn_mark_agreement_sent($1)`, [ids.agr]);
    const s = await call<{ retainer_deposit_id: string; retainer_cents: number }>(f, 'owner', `pm.dsn_mark_agreement_signed($1, 'Jamie Parker')`, [ids.agr]);
    expect(s.retainer_cents).toBe(500000);
    expect(Number((await one<{ amount_cents: string }>(f, `select amount_cents from pm.deposit_requests where id = $1`, [s.retainer_deposit_id])).amount_cents)).toBe(500000);
    expect(await callErr(f, 'pm', `pm.dsn_draft_agreement($1)`, [J3])).toMatch(forbidden);
  });
  it('pricing rules: client > vendor > default; SQL and lib/design/pricing.ts agree', async () => {
    ids.dvendor = await vendor(f, 'Lee Industries');
    await as(f, 'owner', () => q(f.db, `insert into pm.dsn_pricing_rules (location_id, name, vendor_id, method, pct) values ($1, 'Lee at 25%', $2, 'COST_PLUS', 0.25)`, [L2, ids.dvendor]));
    await as(f, 'owner', () => q(f.db, `insert into pm.dsn_pricing_rules (location_id, name, category, method, tiers) values ($1, 'Lighting tiers', 'Lighting', 'TIERED', '[{"up_to_cents":50000,"pct":0.5},{"up_to_cents":null,"pct":0.3}]'::jsonb)`, [L2]));
    const v = await call<{ client_unit_price_cents: number; rule: string }>(f, 'owner', `pm.dsn_price($1, 800000, null, $2)`, [L2, ids.dvendor]);
    expect(v).toMatchObject({ client_unit_price_cents: priceUnit({ method: 'COST_PLUS', pct: 0.25 }, 800000, null), rule: 'Lee at 25%' });
    for (const cost of [12345, 50000, 50001, 999999]) {
      const t = await call<{ client_unit_price_cents: number }>(f, 'owner', `pm.dsn_price($1, $2, null, null, 'Lighting')`, [L2, cost]);
      expect(t.client_unit_price_cents, String(cost)).toBe(priceUnit({ method: 'TIERED', pct: null, tiers: [{ up_to_cents: 50000, pct: 0.5 }, { up_to_cents: null, pct: 0.3 }] }, cost, null));
    }
    const d = await call<{ client_unit_price_cents: number }>(f, 'owner', `pm.dsn_price($1, 10001, null)`, [L2]);
    expect(d.client_unit_price_cents).toBe(priceUnit(null, 10001, null, 0.4));
  });
  it('the clipper files a product once; a room budget goes over and alerts once; a placeholder is replaced keeping its budget', async () => {
    const c = await call<{ product_id: string; duplicate: boolean; vendor_matched: boolean }>(f, 'owner', `pm.dsn_clip($1, $2::jsonb)`, [L2, JSON.stringify({ name: 'Lee 1296 sofa', vendor_name: 'Lee Industries', sku: '1296-03',
      width_in: 84, depth_in: 40, height_in: 34, trade_cost_cents: 800000, retail_cents: 1600000, vendor_url: 'https://leeindustries.com/1296', lead_time_days: 70 })]);
    expect(c).toMatchObject({ duplicate: false, vendor_matched: true });
    expect((await call<{ duplicate: boolean }>(f, 'owner', `pm.dsn_clip($1, '{"name":"Lee 1296 sofa again","vendor_name":"Lee Industries","sku":"1296-03"}'::jsonb)`, [L2])).duplicate).toBe(true);
    ids.product = c.product_id;
    await call(f, 'owner', `pm.dsn_save_room($1, 'Living', 'CONCEPT', 900000)`, [J3]);
    ids.ph = (await one<{ id: string }>(f, `insert into pm.dsn_items (org_id, job_id, room, name, qty, is_placeholder, budget_cents, status) values ($1, $2, 'Living', 'Sofa TBD', 1, true, 950000, 'PLACEHOLDER') returning id`, [ORG_A, J3])).id;
    const r1 = await call<{ rooms: Array<{ room: string; over: boolean; specified_cents: number; placeholders: number }> }>(f, 'owner', `pm.dsn_room_budgets($1)`, [J3]);
    expect(r1.rooms[0]).toMatchObject({ room: 'Living', over: true, specified_cents: 950000, placeholders: 1 });
    await call(f, 'owner', `pm.dsn_room_budgets($1)`, [J3]);
    expect((await one<{ n: number }>(f, `select count(*)::int n from core.notifications where event_type = 'design.room_over_budget'`)).n).toBeLessThanOrEqual(1);
    const item = await call<string>(f, 'owner', `pm.dsn_add_product_item($1, $2, 'Living', 1, $3)`, [J3, ids.product, ids.ph]);
    expect(item).toBe(ids.ph);
    const it2 = await one<{ is_placeholder: boolean; client_unit_price_cents: string; budget_cents: string }>(f, `select is_placeholder, client_unit_price_cents, budget_cents from pm.dsn_items where id = $1`, [ids.ph]);
    expect([it2.is_placeholder, Number(it2.client_unit_price_cents), Number(it2.budget_cents)]).toEqual([false, 1000000, 950000]);
    const masked = await as(f, 'pm', () => q(f.db, `select trade_cost_cents from pm.v_dsn_products_masked`));
    expect(masked).toEqual([]);
  });
  it('a board presented to the client; the FF&E schedule carries financial columns only for money holders', async () => {
    ids.board = await call<string>(f, 'owner', `pm.dsn_save_board($1, 'Living — concept', 'Living', $2::jsonb)`, [J3, JSON.stringify([{ kind: 'ITEM', dsn_item_id: ids.ph, x: 10, y: 10 }, { kind: 'NOTE', caption: 'Warm whites' }])]);
    const p = await call<{ status: string }>(f, 'owner', `pm.dsn_present_board($1)`, [ids.board]);
    expect(p.status).toBe('PRESENTED');
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.portal_messages where job_id = $1`, [J3])).n).toBe(1);
    const s = await call<{ items: Array<{ name: string; client_unit_price_cents: number | null }>; financial_columns: boolean }>(f, 'owner', `pm.dsn_ffe_schedule($1)`, [J3]);
    expect(s.financial_columns).toBe(true);
    expect(s.items[0]!.client_unit_price_cents).toBe(1000000);
  });
});

describe('interior design (ID-24/25/28/33/34/36)', () => {
  it('cancel an ordered item: restocking at the vendor rule, components returned', async () => {
    await q(f.db, `update pm.dsn_items set status = 'ORDERED' where id = $1`, [ids.ph]);
    ids.comp = (await one<{ id: string }>(f, `insert into pm.procurement_items (org_id, job_id, vendor_id, description, qty, unit_cost_cents, status, approved_at, dsn_item_id, component_kind, ordered_on)
                   values ($1, $2, $3, 'Lee 1296 frame', 1, 800000, 'ORDERED', now(), $4, 'FRAME', current_date) returning id`, [ORG_A, J3, ids.dvendor, ids.ph])).id;
    await as(f, 'owner', () => q(f.db, `insert into pm.dsn_vendor_terms (location_id, vendor_id, restocking_fee_pct) values ($1, $2, 0.2)`, [L2, ids.dvendor]));
    const fc = await call<string>(f, 'owner', `pm.dsn_open_freight_claim($1, 'Arm torn in transit', 'Estes', 'PRO123')`, [ids.comp]);
    expect((await one<{ freight_claim_open: boolean }>(f, `select freight_claim_open from pm.procurement_items where id = $1`, [ids.comp])).freight_claim_open).toBe(true);
    await call(f, 'owner', `pm.dsn_update_freight_claim($1, 'PAID', 30000)`, [fc]);
    expect((await one<{ freight_claim_open: boolean }>(f, `select freight_claim_open from pm.procurement_items where id = $1`, [ids.comp])).freight_claim_open).toBe(false);
    const ch = await call<{ components: number; restocking_fee_cents: number }>(f, 'owner', `pm.dsn_change_item($1, 'CANCEL', 'Client changed direction')`, [ids.ph]);
    expect(ch).toMatchObject({ components: 1, restocking_fee_cents: 160000 });
    expect((await one<{ status: string }>(f, `select status from pm.procurement_items where id = $1`, [ids.comp])).status).toBe('RETURNED');
    expect(await callErr(f, 'owner', `pm.dsn_change_item($1, 'CANCEL', 'again')`, [ids.ph])).toMatch(/already cancelled/);
  });
  it('install day sheet + checklist; product deposit invoice; reimbursables billed with markup; statement; reports', async () => {
    const it3 = (await one<{ id: string }>(f, `insert into pm.dsn_items (org_id, job_id, room, name, qty, client_unit_price_cents, deposit_pct, status) values ($1, $2, 'Living', 'Floor lamp', 2, 45000, 0.5, 'APPROVED') returning id`, [ORG_A, J3])).id;
    const d = await call<{ checklist: { id: string; items: unknown[] }; items: Array<{ item_id: string; ready: boolean }> }>(f, 'owner', `pm.dsn_install_day($1, current_date + 7, 'Living')`, [J3]);
    expect(d.checklist.items.length).toBe(7);
    expect(d.items.map((x) => x.item_id)).toContain(it3);
    const done = await call<{ punch_created: number; installed: number }>(f, 'owner', `pm.dsn_complete_install($1, '{walk,place}', '{}', '[{"title":"Touch up wall by window"}]'::jsonb, $2::uuid[])`, [d.checklist.id, [it3]]);
    expect(done).toEqual({ checklist_id: d.checklist.id, punch_created: 1, installed: 1 });
    const it4 = (await one<{ id: string }>(f, `insert into pm.dsn_items (org_id, job_id, room, name, qty, client_unit_price_cents, deposit_pct, status) values ($1, $2, 'Living', 'Side table', 1, 120000, 0.5, 'APPROVED') returning id`, [ORG_A, J3])).id;
    const inv = await call<{ billing_request_id: string; lines: number; amount_cents: number; tax_cents: number }>(f, 'owner', `pm.dsn_draft_product_invoice($1, 'DEPOSIT', $2::uuid[], 0.07, 'IA')`, [J3, [it4]]);
    expect(inv).toMatchObject({ lines: 1, amount_cents: 60000, tax_cents: 4200 });
    expect((await one<{ kind: string }>(f, `select kind from pm.wc_books_requests where source_id = $1`, [inv.billing_request_id])).kind).toBe('PRODUCT_INVOICE');
    await call(f, 'owner', `pm.dsn_add_reimbursable($1, '{"kind":"SAMPLES","description":"Fabric samples","cost_cents":8000}'::jsonb)`, [J3]);
    const rb = await call<{ lines: number; amount_cents: number }>(f, 'owner', `pm.dsn_bill_reimbursables($1)`, [J3]);
    expect(rb).toMatchObject({ lines: 1, amount_cents: 8000 });
    expect(await callErr(f, 'owner', `pm.dsn_bill_reimbursables($1)`, [J3])).toMatch(/no open billable/);
    const st = await call<{ items: unknown[]; held_cents: number }>(f, 'owner', `pm.dsn_deposit_statement($1)`, [J3]);
    expect(st.items.length).toBeGreaterThan(0);
    const rep = await call<{ items_by_status: Record<string, number>; product_margin: { target_markup_pct: number } }>(f, 'owner', `pm.dsn_reports($1, current_date - 30, current_date + 1)`, [L2]);
    expect(rep.items_by_status.CANCELLED).toBe(1);
    expect(Number(rep.product_margin.target_markup_pct)).toBe(0.4);
    expect(await callErr(f, 'pm', `pm.dsn_reports($1)`, [L2])).toMatch(forbidden);
    const doc = await documentRow(f, 'x.jpg');
    expect(doc).toBeTruthy();
  });
});
