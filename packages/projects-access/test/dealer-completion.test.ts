/**
 * Equipment dealer completion (migration 1125) against a PGlite replay of every migration: OEM
 * shipment receiving with serial scans, lot count + floor-plan audit, trade recon and the listing
 * lock, payment menu, incentive library + claims, contracts in transit, unwind with the deposit
 * choice, special-order texts, stock suggestions (parity with lib/dealer/stocking.ts), electronic
 * order records + acks, inter-store transfers + locator, service capacity / check-in / findings /
 * fees / close / pay link / WIP, rentals (quote, blocks, paperwork, re-rent hold, fleet PM, cycle
 * billing), customer 360, drawer close, price limits + overrides + PIN, store close, and access.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, q, type Fixture, ORG_A, L1, L2, J1, J2, J3 } from './fixture';
import { call, callErr, customer, forbidden, one, registryClean, setupIndustry, stockLocation, vendor } from './industry';
import { applyMigration } from './pg';
import { stocking } from '../../../apps/projects/src/lib/dealer/stocking';

let f: Fixture;
const ids: Record<string, string> = {};
const J = (v: unknown) => JSON.stringify(v);
/** A file the persona uploaded (public.documents row like lib/dealer/upload.ts writes), not linked yet. */
const upload = (persona: string, name = 'signature.png') => one<{ id: string }>(f,
  `insert into public.documents (org_id, storage_path, file_name, mime_type, uploaded_by_user, entity_type) values ($1, $4 || '/dealer/1125/' || gen_random_uuid()::text || '.png', $2, 'image/png', $3, 'pm.dealer_upload') returning id`,
  [ORG_A, name, `user_${persona}`, String(ORG_A)]).then((r) => r.id);

beforeAll(async () => {
  f = await setupIndustry('dealer-completion');
  ids.sl = await stockLocation(f, 'MAIN');
  ids.sl2 = await stockLocation(f, 'NORTH', 'WAREHOUSE', L2);
  ids.kubota = await vendor(f, 'Kubota Tractor');
  ids.lender = await vendor(f, 'Ag Floorplan Credit');
  ids.buyer = await customer(f, 'Pat Buyer');
  await q(f.db, `insert into core.contacts (org_id, customer_id, first_name, last_name, phone, is_primary, sms_consent) values ($1, $2, 'Pat', 'Buyer', '+15155550101', true, true)`, [ORG_A, ids.buyer]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('1125 registers with the 1110 access foundation', () => {
  it('every pm table classified, every member definer RPC guarded, nothing for anon, no unprotected Books table', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
  it('1125 re-applies cleanly (idempotent)', async () => {
    await applyMigration(f.db, '1125_pm_dealer_mfg_completion.sql');
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});

describe('OEM shipment receiving (DLR-03)', () => {
  it('scans match, fill a serial-less line and record extras; receive creates units with the floor-plan hint; unscanned are short', async () => {
    const s = await call<{ shipment_id: string; lines: number }>(f, 'owner', `pm.dlr_create_shipment($1, $2::jsonb, $3::jsonb)`, [L1,
      J({ vendor_id: ids.kubota, floor_lender_vendor_id: ids.lender, floor_program: '180-DAY FREE', stock_location_id: ids.sl, invoice_ref: 'INV-77', source: 'EDI_856' }),
      J([
        { make: 'KUBOTA', model: 'BX2380', serial_number: 'kbx-001', cost_cents: 1500000 },
        { make: 'KUBOTA', model: 'BX2380', serial_number: 'KBX-002', cost_cents: 1500000 },
        { make: 'KUBOTA', model: 'Z421', cost_cents: 600000 },
        { make: 'KUBOTA', model: 'L3301', serial_number: 'KL-9', cost_cents: 2500000 },
      ])]);
    expect(s.lines).toBe(4);
    ids.shp = s.shipment_id;
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_scan_shipment($1, 'KBX-001')`, [ids.shp])).result).toBe('MATCHED');
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_scan_shipment($1, 'kbx-001')`, [ids.shp])).result).toBe('DUPLICATE');
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_scan_shipment($1, 'KBX-002', '{"damaged":true,"damage_note":"Hood cracked"}')`, [ids.shp])).result).toBe('DAMAGED');
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_scan_shipment($1, 'KZ-55', '{"model":"Z421"}')`, [ids.shp])).result).toBe('FILLED');
    const extra = await call<{ result: string; remaining: number }>(f, 'owner', `pm.dlr_scan_shipment($1, 'KX-EXTRA', '{"model":"RTV"}')`, [ids.shp]);
    expect(extra).toMatchObject({ result: 'EXTRA', remaining: 1 });
    expect(await callErr(f, 'pm', `pm.dlr_scan_shipment($1, 'X')`, [ids.shp])).toMatch(forbidden);
    expect(await callErr(f, 'bOwner', `pm.dlr_scan_shipment($1, 'X')`, [ids.shp])).toMatch(forbidden);
    const r = await call<Record<string, number>>(f, 'owner', `pm.dlr_receive_shipment($1)`, [ids.shp]);
    expect(r).toMatchObject({ received: 4, short: 1, damaged: 1, extra: 1, failed: 0 });
    const u = await one<{ unit_status: string; floor_lender_vendor_id: string | null; cnt: string }>(f,
      `select a.unit_status, a.floor_lender_vendor_id, (select count(*) from pm.assets x where x.org_id = a.org_id and x.serial_number in ('KBX-001','KBX-002','KZ-55','KX-EXTRA'))::text as cnt
         from pm.assets a where a.serial_number = 'KBX-002'`);
    expect(u.unit_status).toBe('ON_HOLD');
    expect(u.cnt).toBe('4');
    const d = await call<{ lines: Array<{ status: string }>; amounts_visible: boolean }>(f, 'owner', `pm.dlr_shipment_detail($1)`, [ids.shp]);
    expect(d.lines.map((l) => l.status).sort()).toEqual(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED', 'SHORT']);
    expect(await callErr(f, 'owner', `pm.dlr_receive_shipment($1)`, [ids.shp])).toMatch(/PM_INVALID/);
  });
});

describe('lot count + floor-plan audit (DLR-09)', () => {
  it('found / unknown / duplicate scans, a GPS flag off the lot, and the missing list on close', async () => {
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"lot_lat":41.6,"lot_lng":-93.6,"lot_radius_m":300,"service_job_type_key":"build"}')`, [L1]);
    expect(await callErr(f, 'owner', `pm.dlr_set_store_settings($1, '{"bogus":1}')`, [L1])).toMatch(/PM_INVALID/);
    ids.audit = await call<string>(f, 'owner', `pm.dlr_start_lot_audit($1)`, [L1]);
    expect(await callErr(f, 'owner', `pm.dlr_start_lot_audit($1)`, [L1])).toMatch(/PM_DUPLICATE/);
    expect((await call<{ result: string; gps_flag: boolean }>(f, 'owner', `pm.dlr_lot_scan($1, 'KBX-001', 41.6, -93.6)`, [ids.audit]))).toMatchObject({ result: 'FOUND', gps_flag: false });
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_lot_scan($1, 'KBX-001')`, [ids.audit])).result).toBe('DUPLICATE');
    expect((await call<{ result: string }>(f, 'owner', `pm.dlr_lot_scan($1, 'NOPE-1')`, [ids.audit])).result).toBe('UNKNOWN');
    expect((await call<{ gps_flag: boolean }>(f, 'owner', `pm.dlr_lot_scan($1, 'KZ-55', 41.7, -93.6)`, [ids.audit])).gps_flag).toBe(true);
    const r = await call<{ expected: number; found: number; missing: Array<{ serial_number: string }>; gps_flags: unknown[]; exceptions: unknown[] }>(
      f, 'owner', `pm.dlr_close_lot_audit($1)`, [ids.audit]);
    expect(r.found).toBe(2);
    expect(r.expected).toBeGreaterThanOrEqual(r.found);
    expect(r.gps_flags).toHaveLength(1);
    expect(r.exceptions).toHaveLength(1);
    expect(await callErr(f, 'labor', `pm.dlr_lot_audit_report($1)`, [ids.audit])).toMatch(forbidden);
  });
});

describe('trade recon + listing lock (DLR-10)', () => {
  it('a received trade opens recon; the unit cannot go on a deal or be advertised until recon is done', async () => {
    ids.used = await call<string>(f, 'owner', `pm.receive_unit($1, 'USED-7', 'JOHN DEERE', '1025R', 900000, jsonb_build_object('stock_location_id', $2::text, 'condition', 'USED'))`, [L1, ids.sl]);
    ids.tradeDeal = await call<string>(f, 'owner', `pm.create_deal($1, $2)`, [L1, ids.buyer]);
    ids.trade = (await one<{ id: string }>(f, `insert into pm.dealer_trades (org_id, deal_id, serial_number, make, model, acv_cents, allowance_cents)
                                               values ($1, $2, 'USED-7', 'JOHN DEERE', '1025R', 900000, 900000) returning id`, [ORG_A, ids.tradeDeal])).id;
    await q(f.db, `update pm.dealer_trades set status = 'RECEIVED', received_at = now(), received_asset_id = $2 where id = $1`, [ids.trade, ids.used]);
    const rec = await one<{ id: string; status: string }>(f, `select id, status from pm.dlr_recons where asset_id = $1`, [ids.used]);
    expect(rec.status).toBe('OPEN');
    ids.recon = rec.id;
    const deal = await call<string>(f, 'owner', `pm.create_deal($1, $2)`, [L1, ids.buyer]);
    const err = await (async () => {
      try {
        await q(f.db, `insert into pm.dealer_deal_lines (org_id, deal_id, line_no, line_type, asset_id, unit_price_cents) values ($1, $2, 1, 'UNIT', $3, 1200000)`, [ORG_A, deal, ids.used]);
        return null;
      } catch (e) { return String(e); }
    })();
    expect(err).toMatch(/PM_RECON_OPEN/);
    const err2 = await (async () => {
      try { await q(f.db, `update pm.assets set advertised_price_cents = 1250000 where id = $1`, [ids.used]); return null; } catch (e) { return String(e); }
    })();
    expect(err2).toMatch(/PM_RECON_OPEN/);
    expect(await callErr(f, 'owner', `pm.dlr_complete_recon($1)`, [ids.recon])).toMatch(/PM_RECON_OPEN/);
    expect(await callErr(f, 'pm', `pm.dlr_complete_recon($1, 'sold as-is')`, [ids.recon])).toMatch(forbidden);
    expect((await call<{ status: string }>(f, 'owner', `pm.dlr_complete_recon($1, 'Sold as-is to a wholesaler')`, [ids.recon])).status).toBe('WAIVED');
    await q(f.db, `update pm.assets set advertised_price_cents = 1250000 where id = $1`, [ids.used]);
    const board = await call<Array<{ status: string }>>(f, 'owner', `pm.dlr_recon_board($1)`, [L1]);
    expect(board.some((b) => b.status === 'WAIVED')).toBe(true);
  });
  it('a recon RO on a unit in stock is routed RECON; completing the RO lets recon finish', async () => {
    const unit = await call<string>(f, 'owner', `pm.receive_unit($1, 'USED-8', 'KUBOTA', 'B2650', 700000, jsonb_build_object('stock_location_id', $2::text, 'condition', 'USED'))`, [L1, ids.sl]);
    const rid = await call<string>(f, 'owner', `pm.dlr_open_recon($1, $2, '[{"label":"Service + fluids","hours":1.5},"Detail"]'::jsonb)`, [unit, J1]);
    const r = await one<{ work_order_id: string }>(f, `select work_order_id from pm.dlr_recons where id = $1`, [rid]);
    expect(r.work_order_id).toBeTruthy();
    const lines = await q<{ internal_route: string; pay_type: string }>(f.db, `select internal_route, pay_type from pm.work_order_lines where work_order_id = $1`, [r.work_order_id]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.internal_route === 'RECON' && l.pay_type === 'INTERNAL')).toBe(true);
    await q(f.db, `update pm.work_orders set status = 'COMPLETE', completed_at = now() where id = $1`, [r.work_order_id]);
    expect((await call<{ status: string }>(f, 'owner', `pm.dlr_complete_recon($1)`, [rid])).status).toBe('DONE');
  });
});

describe('payment menu, incentives + claims, contracts in transit, unwind (DLR-13/14/24/25)', () => {
  it('the menu lists every scenario per down payment with the lowest payment; dealer net only with financials', async () => {
    ids.unitDeal = await call<string>(f, 'owner', `pm.receive_unit($1, 'KU-MENU', 'KUBOTA', 'BX2680', 1500000, jsonb_build_object('stock_location_id', $2::text, 'category', 'COMPACT_TRACTOR'))`, [L1, ids.sl]);
    ids.deal = await call<string>(f, 'owner', `pm.create_deal($1, $2)`, [L1, ids.buyer]);
    await q(f.db, `insert into pm.dealer_deal_lines (org_id, deal_id, line_no, line_type, asset_id, unit_price_cents) values ($1, $2, 1, 'UNIT', $3, 2500000)`, [ORG_A, ids.deal, ids.unitDeal]);
    await q(f.db, `insert into pm.dlr_finance_programs (org_id, location_id, code, name, kind, brand, apr, term_months, subvention_pct) values
                     ($1, $2, 'K0-60', '0% for 60', 'PROMO_RATE', 'KUBOTA', 0, 60, 0.04),
                     ($1, $2, 'STD-60', 'Standard 60', 'STANDARD_RATE', null, 0.0799, 60, 0)`, [ORG_A, L1]);
    await q(f.db, `insert into pm.dlr_finance_programs (org_id, location_id, code, name, kind, brand, apr, rebate_cents, claim_deadline_days) values
                     ($1, $2, 'REB-1500', '$1,500 cash back', 'CASH_REBATE', 'KUBOTA', 0, 150000, 30)`, [ORG_A, L1]);
    const m = await call<{ downs: Array<{ down_cents: number; lowest_monthly_code: string | null; best_dealer_net_code: string | null; scenarios: unknown[] }>; amounts_visible: boolean }>(
      f, 'owner', `pm.dlr_payment_menu($1, '{0,250000}')`, [ids.deal]);
    expect(m.downs).toHaveLength(2);
    expect(m.downs[0]!.scenarios.length).toBeGreaterThan(0);
    expect(m.downs[0]!.lowest_monthly_code).toBeTruthy();
    expect(m.amounts_visible).toBe(true);
    expect(await callErr(f, 'owner', `pm.dlr_payment_menu($1, '{}')`, [ids.deal])).toMatch(/PM_INVALID/);
    expect(await callErr(f, 'bOwner', `pm.dlr_payment_menu($1)`, [ids.deal])).toMatch(forbidden);
  });
  it('incentives: eligible by brand / model, applied once, a claim opens at delivery with the claim-by date, tracked to paid', async () => {
    expect((await call<{ saved: number }>(f, 'owner', `pm.dlr_save_incentives($1, $2::jsonb)`, [L1, J([
      { code: 'KDC-500', name: 'Kubota dealer cash', kind: 'DEALER_CASH', brand: 'KUBOTA', model_pattern: 'BX*', amount_cents: 50000, claim_deadline_days: 45, oem_vendor_id: ids.kubota },
      { code: 'JD-SPIFF', name: 'Deere spiff', kind: 'SPIFF', brand: 'JOHN DEERE', amount_cents: 10000 },
    ])])).saved).toBe(2);
    const el = await call<Array<{ code: string; incentive_id: string; amount_cents: number }>>(f, 'owner', `pm.dlr_eligible_incentives($1)`, [ids.deal]);
    expect(el.map((e) => e.code)).toEqual(['KDC-500']);
    expect(el[0]!.amount_cents).toBe(50000);
    await call(f, 'owner', `pm.dlr_apply_incentive($1, $2)`, [ids.deal, el[0]!.incentive_id]);
    const jd = await one<{ id: string }>(f, `select id from pm.dlr_incentives where code = 'JD-SPIFF'`);
    expect(await callErr(f, 'owner', `pm.dlr_apply_incentive($1, $2)`, [ids.deal, jd.id])).toMatch(/PM_PROGRAM_NOT_ELIGIBLE/);
    // delivery (stage moved directly: the 1109 delivery path is covered by its own suite)
    await q(f.db, `update pm.dealer_deals set stage = 'DELIVERED', approved_at = now(), delivered_on = current_date, delivered_at = now() where id = $1`, [ids.deal]);
    const c = await one<{ id: string; status: string; claim_by: string; amount_cents: string }>(f, `select id, status, claim_by::text, amount_cents from pm.dlr_incentive_claims where deal_id = $1 and program_code = 'KDC-500'`, [ids.deal]);
    expect(c.status).toBe('DUE');
    expect(Number(c.amount_cents)).toBe(50000);
    const due = new Date(); due.setUTCDate(due.getUTCDate() + 45);
    expect(c.claim_by).toBe(due.toISOString().slice(0, 10));
    expect(await callErr(f, 'owner', `pm.dlr_update_incentive_claim($1, 'PAID')`, [c.id])).toMatch(/PM_CLAIM_TRANSITION_INVALID/);
    await call(f, 'owner', `pm.dlr_update_incentive_claim($1, 'SUBMITTED', '{"claim_ref":"KC-1"}')`, [c.id]);
    // security review M1: the deal's salesperson (owner created it) cannot mark it paid; labor cannot; paid ≤ claimed
    expect(await callErr(f, 'owner', `pm.dlr_update_incentive_claim($1, 'PAID', '{"paid_cents":50000}')`, [c.id])).toMatch(/PM_SOD_VIOLATION/);
    expect(await callErr(f, 'labor', `pm.dlr_update_incentive_claim($1, 'PAID', '{"paid_cents":50000}')`, [c.id])).toMatch(forbidden);
    expect(await callErr(f, 'gm', `pm.dlr_update_incentive_claim($1, 'PAID', '{"paid_cents":60000}')`, [c.id])).toMatch(/PM_INVALID: the amount paid/);
    expect(await callErr(f, 'gm', `pm.dlr_update_incentive_claim($1, 'PAID', '{"paid_cents":-1}')`, [c.id])).toMatch(/PM_INVALID: the amount paid/);
    await call(f, 'gm', `pm.dlr_update_incentive_claim($1, 'PAID', '{"paid_cents":50000}')`, [c.id]);
    const b = await call<{ claims: Array<{ status: string }>; library: unknown[]; amounts_visible: boolean }>(f, 'owner', `pm.dlr_incentive_board($1)`, [L1]);
    expect(b.library).toHaveLength(2);
    expect(b.claims.some((x) => x.status === 'PAID')).toBe(true);
    const pmBoard = await call<{ amounts_visible: boolean; outstanding_by_oem: unknown }>(f, 'gm', `pm.dlr_incentive_board($1)`, [L1]);
    expect(pmBoard).toBeTruthy();
  });
  it('contracts in transit: a financed deal shows days out and missing stips until the lender funds', async () => {
    const deal = await call<string>(f, 'owner', `pm.create_deal($1, $2)`, [L1, ids.buyer]);
    await q(f.db, `update pm.dealer_deals set finance_type = 'RETAIL_FINANCE', finance_vendor_id = $2, amount_financed_cents = 2000000, stage = 'APPROVED', approved_at = now() - interval '12 days' where id = $1`, [deal, ids.lender]);
    await call(f, 'owner', `pm.dlr_set_stip($1, 'signed_contract', true)`, [deal]);
    await call(f, 'owner', `pm.dlr_set_lender_status($1, 'CONDITIONED', '{"conditions":"Need proof of income"}')`, [deal]);
    let b = await call<Array<{ deal_id: string; stale: boolean; days_out: number; missing_stips: Array<{ key: string }>; lender_status: string }>>(f, 'owner', `pm.dlr_cit_board($1)`, [L1]);
    const row = b.find((x) => x.deal_id === deal)!;
    expect(row.stale).toBe(true);
    expect(row.lender_status).toBe('CONDITIONED');
    expect(row.missing_stips.map((s) => s.key)).toEqual(expect.arrayContaining(['drivers_license', 'proof_of_insurance', 'credit_app']));
    expect(row.missing_stips.map((s) => s.key)).not.toContain('signed_contract');
    // security review M1: funding is not the salesperson's; it names the Books receipt; 0 ≤ funded ≤ financed
    expect(await callErr(f, 'owner', `pm.dlr_set_lender_status($1, 'FUNDED', '{"books_receipt_ref":"RCPT-9"}')`, [deal])).toMatch(/PM_SOD_VIOLATION/);
    expect(await callErr(f, 'gm', `pm.dlr_set_lender_status($1, 'FUNDED')`, [deal])).toMatch(/PM_INVALID: funding needs the Books receipt/);
    expect(await callErr(f, 'gm', `pm.dlr_set_lender_status($1, 'FUNDED', '{"books_receipt_ref":"RCPT-9","funded_cents":2500000}')`, [deal])).toMatch(/PM_INVALID: the amount funded/);
    await call(f, 'gm', `pm.dlr_set_lender_status($1, 'FUNDED', '{"books_receipt_ref":"RCPT-9"}')`, [deal]);
    expect(await callErr(f, 'owner', `pm.dlr_set_lender_status($1, 'CONDITIONED')`, [deal])).toMatch(/PM_SOD_VIOLATION/);
    b = await call(f, 'owner', `pm.dlr_cit_board($1)`, [L1]);
    expect(b.find((x) => x.deal_id === deal)).toBeUndefined();
    expect(await callErr(f, 'owner', `pm.dlr_set_lender_status($1, 'FUNDED')`, [ids.tradeDeal])).toMatch(/PM_INVALID/);
  });
  it('unwind records the deposit choice and voids open claims', async () => {
    const dep = await q(f.db, `select 1 from information_schema.tables where table_schema = 'pm' and table_name = 'dealer_deposits'`);
    expect(dep).toHaveLength(1);
    expect(await callErr(f, 'owner', `pm.dlr_unwind_deal($1, 'Buyer changed mind', 'NOPE')`, [ids.deal])).toMatch(/PM_INVALID/);
    const emp = await q(f.db, `update core.employees set role = 'ops_manager' where org_id = $1 and clerk_user_id = 'user_owner' returning id`, [ORG_A]);
    if (!emp.length) await q(f.db, `insert into core.employees (org_id, clerk_user_id, first_name, last_name, role, is_active) values ($1, 'user_owner', 'Olive', 'Owner', 'ops_manager', true)`, [ORG_A]);
    const r = await call<{ deposit_action: string; outbox_id: string }>(f, 'owner', `pm.dlr_unwind_deal($1, 'Financing fell through', 'FINANCING_DECLINED', 'REFUND')`, [ids.deal]);
    expect(r.deposit_action).toBe('REFUND');
    const u = await one<{ reason_code: string }>(f, `select reason_code from pm.dlr_unwinds where deal_id = $1`, [ids.deal]);
    expect(u.reason_code).toBe('FINANCING_DECLINED');
    const st = await one<{ stage: string }>(f, `select stage from pm.dealer_deals where id = $1`, [ids.deal]);
    expect(st.stage).toBe('UNWOUND');
  });
});

describe('parts: special-order text, stock suggestions, ordering records, transfers (DLR-32/33/34/39)', () => {
  it('a received special order texts the customer and becomes NOTIFIED', async () => {
    ids.part = await call<string>(f, 'owner', `pm.upsert_part($1, 'BLADE-42', 'Mower blade 42in', '{"manufacturer":"KUBOTA","list_price_cents":3500,"cost_cents":2000}')`, [L1]);
    const soId = (await one<{ id: string }>(f, `insert into pm.parts_special_orders (org_id, location_id, number, part_id, qty, customer_id, status, ordered_at) values ($1, $2, 'SO-T1', $3, 2, $4, 'ORDERED', now()) returning id`,
      [ORG_A, L1, ids.part, ids.buyer])).id;
    ids.so = soId;
    await q(f.db, `update pm.parts_special_orders set status = 'RECEIVED', received_at = now() where id = $1`, [soId]);
    const o = await one<{ status: string }>(f, `select status from pm.parts_special_orders where id = $1`, [soId]);
    expect(o.status).toBe('NOTIFIED');
    const t = await one<{ kind: string; status: string; body: string }>(f, `select kind, status, body from pm.dlr_customer_texts where subject_id = $1`, [soId]);
    expect(t.kind).toBe('SPECIAL_ORDER');
    expect(['queued', 'held']).toContain(t.status);
    expect(t.body).toMatch(/BLADE-42/);
    const b = await call<Array<{ id: string; last_text: { status: string } | null }>>(f, 'owner', `pm.dlr_special_order_board($1)`, [L1]);
    expect(b.find((x) => x.id === soId)?.last_text).toBeTruthy();
  });
  it('stock suggestions: demand + lost sales → min / max / order, identical to lib/dealer/stocking.ts', async () => {
    const item = (await one<{ item_id: string }>(f, `select item_id from pm.parts where id = $1`, [ids.part])).item_id;
    await as(f, 'owner', () => q(f.db, `select pm.record_material_move('RECEIPT', $1, 40, null, $2)`, [item, ids.sl]));
    for (const [mAgo, qty] of [[1, 6], [2, 4], [3, 5], [5, 8], [8, 3]] as const) {
      await q(f.db, `insert into pm.material_moves (org_id, location_id, item_id, kind, qty, from_stock_location_id, job_id, moved_at, uom, source_ref)
                     values ($1, $7, $2, 'ISSUE', $3, $4, $6, date_trunc('month', now()) - make_interval(months => $5) + interval '3 days', 'EA', 'test:' || gen_random_uuid())`, [ORG_A, item, qty, ids.sl, mAgo, J2, L1]);
    }
    await call(f, 'owner', `pm.dlr_log_lost_sale($1, 'BLADE-42', 3, 'RETAIL', 'OUT_OF_STOCK')`, [L1]);
    const r = await call<{ rows: Array<{ part_id: string; avg_monthly: number; sd_monthly: number; season_index: number; on_hand: number; on_order: number; min_qty: number; max_qty: number; order_qty: number }>; lead_days: number; review_days: number; service_z: number }>(
      f, 'owner', `pm.dlr_stock_suggestions($1, '{"lead_days":10,"review_days":20}')`, [ids.sl]);
    const row = r.rows.find((x) => x.part_id === ids.part)!;
    expect(row).toBeTruthy();
    expect(Number(row.avg_monthly)).toBeGreaterThan(0);
    const mirror = stocking({ avgMonthly: Number(row.avg_monthly), sdMonthly: Number(row.sd_monthly), season: Number(row.season_index), leadDays: r.lead_days, reviewDays: r.review_days, z: Number(r.service_z), onHand: Number(row.on_hand), onOrder: Number(row.on_order) });
    expect({ min: Number(row.min_qty), max: Number(row.max_qty) }).toEqual({ min: mirror.min, max: mirror.max });
    expect(await call<number>(f, 'owner', `pm.dlr_apply_stocking($1, $2::jsonb)`, [ids.sl, J([{ part_id: ids.part, min_qty: row.min_qty, max_qty: row.max_qty + 5 }])])).toBe(1);
    const o = await call<{ order_id: string; lines: number }>(f, 'owner', `pm.dlr_create_stock_order($1, $2, $3::jsonb)`, [ids.sl, ids.kubota, J([{ part_id: ids.part, qty: 12 }, { part_id: ids.part, qty: 0 }])]);
    expect(o.lines).toBe(1);
    ids.order = o.order_id;
    expect(await callErr(f, 'labor', `pm.dlr_stock_suggestions($1)`, [ids.sl])).toMatch(forbidden);
  });
  it('a sent X12 850 submits the draft order; an 855 ack with a backorder opens the backorder board', async () => {
    const t = await call<{ transmission_id: string; status: string; order_status: string }>(f, 'owner',
      `pm.dlr_record_order_transmission($1, 'KUBOTA', 'EDI_FILE', 'X12_850', 'PO.edi', 'ISA*00~ST*850*0001~SE*2*0001~')`, [ids.order]);
    expect(t.status).toBe('SENT');
    expect(t.order_status).not.toBe('DRAFT');
    const a = await call<{ status: string; backorders: number }>(f, 'owner', `pm.dlr_record_order_ack($1, '{"vendor_ref":"KUB-SO-9","lines":[{"line_no":1,"qty_ack":8,"qty_backorder":4,"eta":"2026-12-01"}]}')`, [t.transmission_id]);
    expect(a).toMatchObject({ status: 'PARTIAL', backorders: 1 });
    const b = await call<{ backorders: Array<{ qty: number; part_number: string }>; transmissions: unknown[] }>(f, 'owner', `pm.dlr_backorder_board($1)`, [L1]);
    expect(b.backorders[0]).toMatchObject({ part_number: 'BLADE-42' });
    expect(b.transmissions).toHaveLength(1);
  });
  it('locator across stores; a cross-company transfer adjusts out at the sender and in at the receiver', async () => {
    const loc = await call<Array<{ location_id: string; on_hand: number }>>(f, 'owner', `pm.dlr_part_locator('blade-42')`);
    expect(loc).toHaveLength(1);
    expect(Number(loc[0]!.on_hand)).toBeGreaterThan(0);
    const x = await call<string>(f, 'owner', `pm.dlr_request_transfer($1, $2, $3, 2, 'Customer at North')`, [ids.part, ids.sl, ids.sl2]);
    expect(await callErr(f, 'owner', `pm.dlr_advance_transfer($1, 'RECEIVED')`, [x])).toMatch(/PM_INVALID/);
    await call(f, 'owner', `pm.dlr_advance_transfer($1, 'SHIPPED')`, [x]);
    expect((await call<{ status: string }>(f, 'owner', `pm.dlr_advance_transfer($1, 'RECEIVED')`, [x])).status).toBe('RECEIVED');
    // security review L7: requesting stock needs a view of the sending store (gm works at L1 only)
    const northPart = (await one<{ to_part_id: string }>(f, `select to_part_id from pm.dlr_part_transfers where id = $1`, [x])).to_part_id;
    expect(await callErr(f, 'gm', `pm.dlr_request_transfer($1, $2, $3, 1)`, [northPart, ids.sl2, ids.sl])).toMatch(/PM_FORBIDDEN/);
    const dest = await one<{ to_part_id: string; in_move_id: string; out_move_id: string }>(f, `select to_part_id, in_move_id, out_move_id from pm.dlr_part_transfers where id = $1`, [x]);
    expect(dest.to_part_id).not.toBe(ids.part);
    expect(dest.in_move_id && dest.out_move_id).toBeTruthy();
    const keys = await q<{ source_ref: string }>(f.db, `select source_ref from pm.material_moves where id in ($1, $2) order by source_ref`, [dest.in_move_id, dest.out_move_id]).catch(() => []);
    if (keys.length) expect(keys.map((k) => k.source_ref)).toEqual([`pm:xfer:${x}:in`, `pm:xfer:${x}:out`]);
    const loc2 = await call<Array<{ location_id: string }>>(f, 'owner', `pm.dlr_part_locator('BLADE-42')`);
    expect(loc2.map((l) => l.location_id).sort()).toEqual([L1, L2].sort());
    const tb = await call<Array<{ direction: string }>>(f, 'owner', `pm.dlr_transfer_board($1)`, [L2]);
    expect(tb[0]!.direction).toBe('INBOUND');
  });
});

describe('service: capacity, check-in, findings → approval, fees, sublets, QC, close, pay link, WIP (DLR-41..57)', () => {
  it('capacity by weekday; a booking past the day\'s hours says so; a pickup adds a truck stop; the route saves its order', async () => {
    await call(f, 'owner', `pm.dlr_set_service_capacity($1, '{"1":16,"2":16,"3":16,"4":16,"5":16}'::jsonb)`, [L1]);
    const day = new Date(); day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7)); // next Monday
    const d = day.toISOString().slice(0, 10);
    ids.apptDay = d;
    const a1 = await call<{ appointment_id: string; over_capacity: boolean }>(f, 'owner', `pm.dlr_book_service($1, $2::jsonb)`, [L1, J({ appt_on: d, est_hours: 10, customer_id: ids.buyer, complaint: 'Annual service' })]);
    expect(a1.over_capacity).toBe(false);
    const a2 = await call<{ appointment_id: string; over_capacity: boolean; quoted_ready_on: string }>(f, 'owner', `pm.dlr_book_service($1, $2::jsonb)`,
      [L1, J({ appt_on: d, est_hours: 8, customer_id: ids.buyer, pickup: true, address_line1: '1 Farm Rd', lat: 41.7, lng: -93.5 })]);
    expect(a2.over_capacity).toBe(true);
    expect(a2.quoted_ready_on >= d).toBe(true);
    ids.appt = a2.appointment_id;
    const stop2 = await call<string>(f, 'owner', `pm.dlr_add_stop($1, $2::jsonb)`, [L1, J({ kind: 'DELIVERY', stop_on: d, customer_id: ids.buyer, lat: 41.65, lng: -93.55 })]);
    const plan = await call<{ stops: Array<{ id: string; kind: string }> }>(f, 'owner', `pm.dlr_route_plan($1, $2::date)`, [L1, d]);
    expect(plan.stops).toHaveLength(2);
    const pickup = plan.stops.find((s) => s.kind === 'PICKUP')!.id;
    expect(await call<number>(f, 'owner', `pm.dlr_set_route_order($1, $2::date, $3::uuid[])`, [L1, d, [stop2, pickup]])).toBe(2);
    await call(f, 'owner', `pm.dlr_finish_stop($1)`, [pickup]);
    expect((await one<{ status: string }>(f, `select status from pm.dlr_service_appointments where id = $1`, [ids.appt])).status).toBe('ARRIVED');
    const cal = await call<{ days: Array<{ day: string; capacity_hours: number; booked_hours: number }> }>(f, 'owner', `pm.dlr_service_calendar($1, $2::date, $2::date)`, [L1, d]);
    expect(cal.days[0]).toMatchObject({ capacity_hours: 16 });
    expect(Number(cal.days[0]!.booked_hours)).toBe(18);
    expect(await callErr(f, 'labor', `pm.dlr_service_calendar($1)`, [L1])).toMatch(forbidden);
  });
  it('check-in opens the RO with complaint lines, meter, tag, the CHECKED_IN text; counter signature', async () => {
    await q(f.db, `update core.jobs set customer_id = $2 where id = $1`, [J1, ids.buyer]);
    ids.svcUnit = await call<string>(f, 'owner', `pm.receive_unit($1, 'CUST-1', 'KUBOTA', 'ZD1211', 0, jsonb_build_object('stock_location_id', $2::text))`, [L1, ids.sl]);
    const c = await call<{ checkin_id: string; work_order_id: string; lines: number; text: { status: string } | null }>(f, 'owner', `pm.dlr_check_in($1, $2, $3::jsonb)`, [L1, ids.svcUnit,
      J({ job_id: J1, customer_id: ids.buyer, appointment_id: ids.appt, complaints: [{ text: 'Deck vibrates' }, 'Annual service'], meter: 412.5, tag_number: 'T-17', auth_limit_cents: 20000 })]);
    expect(c.lines).toBe(2);
    expect(['queued', 'held']).toContain(c.text?.status);
    ids.ro = c.work_order_id;
    ids.checkin = c.checkin_id;
    expect((await one<{ status: string; work_order_id: string }>(f, `select status, work_order_id from pm.dlr_service_appointments where id = $1`, [ids.appt]))).toMatchObject({ status: 'CHECKED_IN', work_order_id: ids.ro });
    expect(await callErr(f, 'owner', `pm.dlr_check_in($1, $2, '{"complaints":[]}')`, [L1, ids.svcUnit])).toMatch(/PM_INVALID/);
    expect(await callErr(f, 'owner', `pm.dlr_record_checkin_signature($1, 'COUNTER')`, [ids.checkin])).toMatch(/PM_INVALID/);
    await call(f, 'owner', `pm.dlr_record_checkin_signature($1, 'COUNTER', 'Pat Buyer')`, [ids.checkin]);
    const board = await call<Array<{ work_order_id: string; signed: boolean; tag: string; stage: string }>>(f, 'owner', `pm.dlr_service_board($1)`, [L1]);
    expect(board.find((b) => b.work_order_id === ids.ro)).toMatchObject({ signed: true, tag: 'T-17', stage: 'CHECKED_IN' });
  });
  it('a finding becomes PROPOSED lines over the authorization limit; close is blocked until it is decided and QC passes', async () => {
    const fd = await call<{ finding_id: string; amount_cents: number }>(f, 'owner', `pm.dlr_add_finding($1, $2::jsonb)`, [ids.ro,
      J({ description: 'Spindle bearing worn', labor_hours: 1.5, labor_rate_cents: 12000, parts: [{ part_id: ids.part, qty: 2 }] })]);
    expect(Number(fd.amount_cents)).toBe(18000 + 2 * 3500);
    expect(await callErr(f, 'owner', `pm.dlr_add_finding($1, '{"description":"x","labor_hours":1}')`, [ids.ro])).toMatch(/PM_INVALID/);
    const e = await call<{ estimate_id: string; total_cents: number; over_auth_limit: boolean }>(f, 'owner', `pm.dlr_send_estimate($1, $2::uuid[])`, [ids.ro, [fd.finding_id]]);
    expect(e).toMatchObject({ over_auth_limit: true });
    ids.est = e.estimate_id;
    expect((await q<{ status: string }>(f.db, `select status from pm.work_order_lines where work_order_id = $1 and option_group = $2`, [ids.ro, fd.finding_id])).map((l) => l.status)).toEqual(['PROPOSED', 'PROPOSED']);
    const chk = await call<{ blockers: Array<{ code: string }>; can_close: boolean }>(f, 'owner', `pm.dlr_ro_close_check($1)`, [ids.ro]);
    expect(chk.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['UNDECIDED', 'QC']));
    expect(await callErr(f, 'owner', `pm.dlr_close_ro($1)`, [ids.ro])).toMatch(/PM_RO_NOT_READY/);
    const reply = await call<{ reply: string }>(f, 'owner', `pm.dlr_ro_status_reply($1)`, [ids.ro]);
    expect(reply.reply).toMatch(/waiting on your OK/);
    const dec = await call<{ status: string; approved_lines: number }>(f, 'owner', `pm.dlr_decide_findings($1, $2::jsonb, 'Pat Buyer', 'PHONE')`, [ids.est, J([{ finding_id: fd.finding_id, decision: 'APPROVED' }])]);
    expect(dec).toMatchObject({ status: 'APPROVED', approved_lines: 2 });
    expect((await one<{ stage: string }>(f, `select stage from pm.dlr_ro_state where work_order_id = $1`, [ids.ro])).stage).toBe('IN_PROGRESS');
  });
  it('shop supplies at 10% of labor with a cap; a sublet warns until it is back; internal lines need a route', async () => {
    await call(f, 'owner', `pm.dlr_save_shop_fee_rule($1, '{"code":"SHOP","label":"Shop supplies","kind":"SHOP_SUPPLIES","basis":"PCT_LABOR","pct":0.1,"min_cents":500,"cap_cents":3500}')`, [L1]);
    const fees = await call<{ fees: Array<{ code: string; amount_cents: number }> }>(f, 'owner', `pm.dlr_apply_shop_fees($1)`, [ids.ro]);
    expect(fees.fees).toEqual([expect.objectContaining({ code: 'SHOP', amount_cents: 1800 })]);
    const again = await call<{ fees: Array<{ amount_cents: number; line_id: string }> }>(f, 'owner', `pm.dlr_apply_shop_fees($1)`, [ids.ro]);
    expect(again.fees[0]!.line_id).toBe(fees.fees[0]!.line_id as unknown as string);
    const sub = await call<{ sublet_id: string }>(f, 'owner', `pm.dlr_add_sublet($1, $2::jsonb)`, [ids.ro, J({ vendor_id: ids.kubota, description: 'Machine shop: resurface spindle', cost_cents: 10000, price_cents: 15000 })]);
    let chk = await call<{ warnings: Array<{ code: string }> }>(f, 'owner', `pm.dlr_ro_close_check($1)`, [ids.ro]);
    expect(chk.warnings.map((w) => w.code)).toContain('SUBLET_OPEN');
    await call(f, 'owner', `pm.dlr_update_sublet($1, 'RECEIVED', 'MS-881')`, [sub.sublet_id]);
    const line = await one<{ id: string }>(f, `insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, pay_type) values ($1, $2, $3, 99, 'LABOR', 'Shop clean-up', 1, 'INTERNAL') returning id`, [ORG_A, J1, ids.ro]);
    chk = await call(f, 'owner', `pm.dlr_ro_close_check($1)`, [ids.ro]);
    expect((chk as unknown as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain('INTERNAL_ROUTE');
    await call(f, 'owner', `pm.dlr_set_internal_route($1, 'SHOP')`, [line.id]);
    expect(await callErr(f, 'owner', `pm.dlr_set_internal_route($1, 'RECON')`, [fees.fees[0]!.line_id])).toMatch(/PM_INVALID/);
  });
  it('QC gates READY (texted), close completes + closes the RO, pay link needs an https Books origin and an issued invoice, pickup is recorded', async () => {
    expect(await callErr(f, 'owner', `pm.dlr_set_ro_stage($1, 'READY')`, [ids.ro])).toMatch(/PM_QC_REQUIRED/);
    expect(await callErr(f, 'owner', `pm.dlr_qc_signoff($1, '[{"item":"Test cut","ok":false}]')`, [ids.ro])).toMatch(/PM_INVALID/);
    const qc = await call<{ passed: boolean; text: { status: string } | null }>(f, 'owner', `pm.dlr_qc_signoff($1, '[{"item":"Test cut","ok":true}]')`, [ids.ro]);
    expect(qc.passed).toBe(true);
    expect((await one<{ stage: string }>(f, `select stage from pm.dlr_ro_state where work_order_id = $1`, [ids.ro])).stage).toBe('READY');
    const wip = await call<{ rows: Array<{ work_order_id: string; must_close: boolean }>; must_close: number }>(f, 'owner', `pm.dlr_wip_report($1)`, [L1]);
    expect(wip.rows.find((r) => r.work_order_id === ids.ro)?.must_close).toBe(true);
    const desk = await call<{ findings: unknown[]; estimates: unknown[]; sublets: unknown[]; close_check: { can_close: boolean } }>(f, 'owner', `pm.dlr_ro_desk($1)`, [ids.ro]);
    expect(desk.close_check.can_close).toBe(true);
    const closed = await call<{ status: string }>(f, 'owner', `pm.dlr_close_ro($1)`, [ids.ro]);
    expect(closed.status).toBe('CLOSED');
    const inv = await call<{ available: boolean; reason: string }>(f, 'owner', `pm.dlr_ro_invoice($1)`, [ids.ro]);
    expect(inv.available).toBe(false);
    // security review L1: the pay-link origin is the store's setting, not a parameter
    expect(await callErr(f, 'owner', `pm.dlr_text_pay_link($1, 'https://evil.example.com')`, [ids.ro])).toMatch(/does not exist|function/);
    // R8: the origin is the platform allowlist (pm._fs_app_url), not a store setting
    expect(await callErr(f, 'owner', `pm.dlr_set_store_settings($1, '{"pay_link_origin":"https://evil.example.com"}')`, [L1])).toMatch(/unknown store setting/);
    expect(await callErr(f, 'owner', `pm.dlr_set_store_settings($1, '{"drawer_variance_cents":60000}')`, [L1])).toMatch(/\$0 to \$500/);
    expect(await callErr(f, 'owner', `pm.dlr_text_pay_link($1)`, [ids.ro])).toMatch(/PM_INVALID: (?!the Books payment address)/);
    // security review M5: the pickup signature is the caller's own upload (or already on this job), never another job's file
    const other = await upload('gm');
    expect(await callErr(f, 'owner', `pm.dlr_record_pickup($1, 'Pat Buyer', $2)`, [ids.ro, other])).toMatch(/PM_INVALID: that pickup signature is not a file/);
    const foreign = await upload('owner');
    await q(f.db, `insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id) values ($1, $2, $3, 'projects', $3)`, [ORG_A, foreign, J1]);
    const roJob = (await one<{ job_id: string }>(f, `select job_id from pm.work_orders where id = $1`, [ids.ro])).job_id;
    if (roJob !== J1) expect(await callErr(f, 'owner', `pm.dlr_record_pickup($1, 'Pat Buyer', $2)`, [ids.ro, foreign])).toMatch(/PM_INVALID/);
    const sig = await upload('owner');
    await call(f, 'owner', `pm.dlr_record_pickup($1, 'Pat Buyer', $2)`, [ids.ro, sig]);
    expect((await q(f.db, `select 1 from pm.document_links where document_id = $1 and job_id = $2`, [sig, roJob]))).toHaveLength(1);
    expect((await one<{ stage: string; pickup_signer: string }>(f, `select stage, pickup_signer from pm.dlr_ro_state where work_order_id = $1`, [ids.ro]))).toMatchObject({ stage: 'PICKED_UP', pickup_signer: 'Pat Buyer' });
    const texts = await q<{ kind: string }>(f.db, `select kind from pm.dlr_customer_texts where work_order_id = $1 order by created_at`, [ids.ro]);
    expect(texts.map((t) => t.kind)).toEqual(expect.arrayContaining(['STATUS', 'PICKUP']));
  });
});

describe('rentals: rate extensions, blocks, paperwork + re-rent gate, fleet PM, damage RO, cycle billing (DLR-63..68)', () => {
  const H = 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  it('hour / half-day / day / minimum hours / accessories pick the cheapest charge', async () => {
    ids.rUnit = await call<string>(f, 'owner', `pm.receive_unit($1, 'RNT-E35', 'BOBCAT', 'E35', 4000000, jsonb_build_object('condition', 'RENTAL', 'category', 'EXCAVATOR'))`, [L1]);
    ids.rRate = (await one<{ id: string }>(f, `insert into pm.rental_rates (org_id, location_id, category, label, day_cents, week_cents, month_cents, damage_waiver_pct) values ($1, $2, 'EXCAVATOR', 'Mini ex', 30000, 90000, 240000, 0.12) returning id`, [ORG_A, L1])).id;
    await call(f, 'owner', `pm.dlr_set_rate_ext($1, '{"hour_cents":6000,"half_day_cents":18000,"min_hours":2,"accessories":[{"code":"BKT","label":"Ditch bucket","day_cents":2500}]}')`, [ids.rRate]);
    const t0 = Date.now() + 48 * H;
    const quote = (hours: number, acc: string[] = []) => call<{ basis: string; rental_cents: number; total_cents: number }>(f, 'owner', `pm.dlr_rental_quote($1, $2::timestamptz, $3::timestamptz, $4::text[])`, [ids.rUnit, iso(t0), iso(t0 + hours * H), acc]);
    expect(await quote(1)).toMatchObject({ basis: 'HOURS', rental_cents: 12000 });
    expect(await quote(3)).toMatchObject({ basis: 'HOURS', rental_cents: 18000 });
    expect(await quote(6)).toMatchObject({ basis: 'DAY', rental_cents: 30000 });
    expect(await quote(6, ['BKT'])).toMatchObject({ total_cents: 32500 });
    expect((await quote(72)).basis).toBe('DAYS');
  });
  it('a maintenance block refuses an overlapping reservation; availability shows it; releasing frees the unit', async () => {
    const t0 = Date.now() + 72 * H;
    const blk = await call<string>(f, 'owner', `pm.dlr_block_rental_unit($1, 'MAINTENANCE', $2::timestamptz, $3::timestamptz, '250-hour service')`, [ids.rUnit, iso(t0), iso(t0 + 8 * H)]);
    expect(await callErr(f, 'owner', `pm.reserve_rental($1, $2, $3::timestamptz, $4::timestamptz)`, [ids.rUnit, ids.buyer, iso(t0 + 2 * H), iso(t0 + 26 * H)])).toMatch(/PM_RENTAL_BLOCKED/);
    const av = await call<{ units: Array<{ unit_id: string; free: boolean }>; free: number }>(f, 'owner', `pm.dlr_rental_availability($1, 'EXCAVATOR', $2::timestamptz, $3::timestamptz)`, [L1, iso(t0), iso(t0 + 4 * H)]);
    expect(av.units.find((u) => u.unit_id === ids.rUnit)?.free).toBe(false);
    await call(f, 'owner', `pm.dlr_release_block($1)`, [blk]);
    const id = await call<string>(f, 'owner', `pm.reserve_rental($1, $2, $3::timestamptz, $4::timestamptz)`, [ids.rUnit, ids.buyer, iso(t0 + 2 * H), iso(t0 + 26 * H)]);
    expect(id).toBeTruthy();
    await call(f, 'owner', `pm.cancel_rental($1, 'test')`, [id]).catch(() => q(f.db, `update pm.rental_contracts set status = 'CANCELLED' where id = $1`, [id]));
  });
  it('the store\'s paperwork list gates check-out; a return opens a re-rent hold that blocks the next check-out until cleared', async () => {
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"rental_out_requires":["license","signature"],"rerent_inspection_required":true}')`, [L1]);
    const c1 = await call<string>(f, 'owner', `pm.reserve_rental($1, $2, $3::timestamptz, $4::timestamptz)`, [ids.rUnit, ids.buyer, iso(Date.now() - H), iso(Date.now() + 24 * H)]);
    expect(await callErr(f, 'owner', `pm.dlr_check_out_rental($1, 200)`, [c1])).toMatch(/PM_RENTAL_PAPERWORK: still needed: license, signature/);
    expect(await callErr(f, 'owner', `pm.check_out_rental($1, 200)`, [c1])).toMatch(/PM_RENTAL_PAPERWORK/);
    expect(await callErr(f, 'owner', `pm.dlr_set_rental_paperwork($1, '{"license_last4":"1234","license_expires_on":"2020-01-01"}')`, [c1])).toMatch(/expired/);
    const chk = await call<{ missing: string[]; ready: boolean }>(f, 'owner', `pm.dlr_set_rental_paperwork($1, $2::jsonb)`, [c1,
      J({ license_last4: '1234', license_state: 'IA', license_expires_on: '2030-01-01', signer_name: 'Pat Buyer', signature_document_id: await upload('owner'), waiver_choice: 'ACCEPTED' })]);
    expect(chk).toMatchObject({ missing: [], ready: true });
    await call(f, 'owner', `pm.dlr_check_out_rental($1, 200)`, [c1]);
    await call(f, 'owner', `pm.check_in_rental($1, 240)`, [c1]);
    const hold = await one<{ id: string }>(f, `select id from pm.dlr_rerent_holds where contract_id = $1 and status = 'OPEN'`, [c1]);
    const c2 = await call<string>(f, 'owner', `pm.reserve_rental($1, $2, $3::timestamptz, $4::timestamptz)`, [ids.rUnit, ids.buyer, iso(Date.now() + 30 * H), iso(Date.now() + 40 * H)]);
    await call(f, 'owner', `pm.dlr_set_rental_paperwork($1, $2::jsonb)`, [c2, J({ license_last4: '1234', license_expires_on: '2030-01-01', signer_name: 'Pat Buyer', signature_document_id: await upload('owner') })]);
    expect(await callErr(f, 'owner', `pm.dlr_set_rental_paperwork($1, $2::jsonb)`, [c2, J({ signature_document_id: '00000000-0000-4000-8000-0000000000ab' })])).toMatch(/PM_INVALID: that signature/);
    // R11: files are tied to their contract — c1's signature cannot be reused on c2
    const c1sig = (await one<{ document_id: string }>(f, `select document_id from pm.document_links where subject_table = 'rental_contracts' and subject_id = $1 limit 1`, [c1])).document_id;
    expect(await callErr(f, 'owner', `pm.dlr_set_rental_paperwork($1, $2::jsonb)`, [c2, J({ signature_document_id: c1sig })])).toMatch(/not a file on this rental contract/);
    expect((await call<{ re_rent_hold: boolean; ready: boolean }>(f, 'owner', `pm.dlr_rental_out_check($1)`, [c2]))).toMatchObject({ re_rent_hold: true, ready: false });
    expect(await callErr(f, 'owner', `pm.dlr_clear_rerent($1, '[{"item":"Tracks","ok":false}]')`, [hold.id])).toMatch(/PM_INVALID/);
    await call(f, 'owner', `pm.dlr_clear_rerent($1, '[{"item":"Tracks","ok":true},{"item":"Greased","ok":true}]')`, [hold.id]);
    expect((await call<{ ready: boolean }>(f, 'owner', `pm.dlr_rental_out_check($1)`, [c2])).ready).toBe(true);
    ids.c1 = c1;
    ids.c2 = c2;
  });
  it('fleet PM: due by hours, scheduled into a gap as a blocked internal RO routed RENTAL, completion releases the block', async () => {
    const rule = await call<string>(f, 'owner', `pm.dlr_save_fleet_pm_rule($1, '{"label":"250-hour service","model":"E35","every_hours":250,"est_hours":3,"checklist":["Change oil","Grease pins"]}')`, [L1]);
    const due = await call<Array<{ unit_id: string; rule_id: string; due: boolean; hours_since: number; next_gap: { from: string; to: string } | null }>>(f, 'owner', `pm.dlr_fleet_due($1)`, [L1]);
    const row = due.find((d) => d.unit_id === ids.rUnit && d.rule_id === rule)!;
    expect(row.due).toBe(true);
    expect(Number(row.hours_since)).toBe(240);
    expect(row.next_gap).toBeTruthy();
    const s = await call<{ work_order_id: string; block_id: string }>(f, 'owner', `pm.dlr_schedule_fleet_pm($1, $2, $3::timestamptz, $4::timestamptz, $5)`, [ids.rUnit, rule, row.next_gap!.from, row.next_gap!.to, J2]);
    const lines = await q<{ internal_route: string }>(f.db, `select internal_route from pm.work_order_lines where work_order_id = $1`, [s.work_order_id]);
    expect(lines.map((l) => l.internal_route)).toEqual(['RENTAL', 'RENTAL']);
    await call(f, 'owner', `pm.dlr_complete_fleet_pm($1, $2, 241, $3)`, [ids.rUnit, rule, s.work_order_id]);
    expect((await one<{ released_at: string | null }>(f, `select released_at from pm.dlr_rental_blocks where id = $1`, [s.block_id])).released_at).toBeTruthy();
    const after = await call<Array<{ unit_id: string; rule_id: string; due: boolean }>>(f, 'owner', `pm.dlr_fleet_due($1)`, [L1]);
    expect(after.find((d) => d.unit_id === ids.rUnit && d.rule_id === rule)?.due).toBe(false);
  });
  it('a damage RO from the returned rental bills the renter; cycle billing bills contracts out past the cycle', async () => {
    const r = await call<{ work_order_id: string; lines: number }>(f, 'owner', `pm.dlr_rental_damage_ro($1, $2::jsonb)`, [ids.c1, J({ job_id: J2, lines: [{ description: 'Replace cracked bucket tooth', flag_hours: 1, unit_price_cents: 9500 }] })]);
    expect(r.lines).toBe(1);
    const pay = await one<{ pay_type: string }>(f, `select pay_type from pm.work_order_lines where work_order_id = $1`, [r.work_order_id]);
    expect(pay.pay_type).toBe('CUSTOMER');
    expect(await callErr(f, 'owner', `pm.dlr_rental_damage_ro($1, '{}')`, [ids.c2])).toMatch(/PM_RENTAL_TRANSITION_INVALID/);
    const u2 = await call<string>(f, 'owner', `pm.receive_unit($1, 'RNT-LT1', 'BOBCAT', 'T770', 6000000, jsonb_build_object('condition', 'RENTAL', 'category', 'EXCAVATOR'))`, [L1]);
    const long = (await one<{ id: string }>(f, `insert into pm.rental_contracts (org_id, location_id, number, asset_id, customer_id, status, reserved, rate_day_cents, rate_week_cents, rate_month_cents, checked_out_at, meter_out)
       values ($1, $2, 'RC-LONG', $3, $4, 'OUT', tstzrange(now() - interval '30 days', now() + interval '60 days'), 30000, 90000, 240000, now() - interval '30 days', 10) returning id`, [ORG_A, L1, u2, ids.buyer])).id;
    const b = await call<{ cycle_days: number; billed: Array<{ contract_id: string; billing_id?: string; error?: string }> }>(f, 'owner', `pm.dlr_run_cycle_billing($1)`, [L1]);
    const mine = b.billed.find((x) => x.contract_id === long)!;
    expect(mine).toBeTruthy();
    expect(mine.error).toBeUndefined();
    expect(mine.billing_id).toBeTruthy();
  });
});

describe('store: customer 360, drawer close, price limits + overrides + PIN, store close (DLR-70/71/77/80)', () => {
  it('customer 360 shows units, ROs, deals, rentals, special orders and texts', async () => {
    const c = await call<{ repair_orders: unknown[]; deals: unknown[]; rentals: unknown[]; special_orders: unknown[]; texts: unknown[]; ar: { available: boolean } }>(f, 'owner', `pm.dlr_customer_360($1, $2)`, [L1, ids.buyer]);
    expect(c.repair_orders.length).toBeGreaterThan(0);
    expect(c.deals.length).toBeGreaterThan(0);
    expect(c.rentals.length).toBeGreaterThan(0);
    expect(c.texts.length).toBeGreaterThan(0);
    expect(await callErr(f, 'labor', `pm.dlr_customer_360($1, $2)`, [L1, ids.buyer])).toMatch(forbidden);
  });
  it('a drawer balances to the count; the deposit batch keeps the float; a variance needs a note; a closed counter ticket lands in the drawer', async () => {
    const reg = await call<string>(f, 'owner', `pm.dlr_save_register($1, 'r1', 'Front counter')`, [L1]);
    const s = await call<string>(f, 'owner', `pm.dlr_open_drawer($1, 20000)`, [reg]);
    expect(await callErr(f, 'owner', `pm.dlr_open_drawer($1, 0)`, [reg])).toMatch(/PM_DUPLICATE/);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CASH', 15000, 'RO', 'Old RO balance')`, [s]);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CARD', 5000, null, 'Old RO balance')`, [s]);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'PAYOUT', null, 'CASH', -1000)`, [s])).toMatch(/PM_INVALID/);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'PAYOUT', null, 'CASH', -1000, null, 'Coffee for the shop')`, [s]);
    const t = await call<string>(f, 'owner', `pm.open_parts_ticket($1, null, $2)`, [L1, ids.sl]);
    await call(f, 'owner', `pm.dlr_add_pick_list($1, '[{"part_number":"BLADE-42","qty":1}]'::jsonb)`, [t]);
    await call(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [t]);
    const entry = await q<{ amount_cents: string }>(f.db, `select amount_cents from pm.dlr_drawer_entries where session_id = $1 and source_kind = 'PARTS_TICKET'`, [s]);
    expect(entry).toHaveLength(1);
    const ticketCash = Number(entry[0]!.amount_cents);
    const r = await call<{ variance_cents: number; flagged: boolean; deposit_cash_cents: number; kept_float_cents: number }>(f, 'owner', `pm.dlr_close_drawer($1, $2::jsonb)`, [s, J({ cash_cents: 34000 + ticketCash, card_cents: 5000 })]);
    expect(r).toMatchObject({ variance_cents: 0, flagged: false, deposit_cash_cents: 14000 + ticketCash, kept_float_cents: 20000 });
    const s2 = await call<string>(f, 'owner', `pm.dlr_open_drawer($1, 20000)`, [reg]);
    // security review R4: the first count is binding — a flagged drawer closes, the note comes after
    expect(await call<{ flagged: boolean; note_required: boolean }>(f, 'owner', `pm.dlr_close_drawer($1, '{"cash_cents":18000}')`, [s2])).toMatchObject({ flagged: true, note_required: true });
    expect(await callErr(f, 'owner', `pm.dlr_close_drawer($1, '{"cash_cents":20000}')`, [s2])).toMatch(/already closed/);
    expect(await callErr(f, 'owner', `pm.dlr_sign_store_close($1, 'DAY', null, 'try')`, [L1])).toMatch(/explain every flagged drawer variance/);
    await call(f, 'owner', `pm.dlr_note_drawer_variance($1, 'Short $20, recounted twice')`, [s2]);
    expect(await callErr(f, 'owner', `pm.dlr_note_drawer_variance($1, 'again please')`, [s2])).toMatch(/already explained/);
    const board = await call<{ closed: unknown[]; registers: unknown[] }>(f, 'owner', `pm.dlr_drawer_board($1)`, [L1]);
    expect(board.closed).toHaveLength(2);
    expect(await callErr(f, 'pm', `pm.dlr_drawer_board($1)`, [L1])).toMatch(forbidden);
  });
  it('price limits by role: over the limit queues for another approver (never the requester); within the limit auto-approves; the PIN approves at the counter', async () => {
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[{"role_key":"default","max_discount_pct":0.05},{"role_key":"projects_gm","max_discount_pct":0.2}]')`, [L1]);
    const mkLine = async () => {
      const t = await call<string>(f, 'owner', `pm.open_parts_ticket($1, null, $2)`, [L1, ids.sl]);
      await call(f, 'owner', `pm.dlr_add_pick_list($1, '[{"part_number":"BLADE-42","qty":1}]'::jsonb)`, [t]);
      return (await one<{ id: string }>(f, `select id from pm.parts_ticket_lines where ticket_id = $1`, [t])).id;
    };
    const l1 = await mkLine();
    const chk = await call<{ controls: boolean; allowed: boolean }>(f, 'owner', `pm.dlr_price_check($1, 3500, 3150)`, [L1]);
    expect(chk).toMatchObject({ controls: true, allowed: false });
    const err = await as(f, 'owner', async () => { try { await q(f.db, `update pm.parts_ticket_lines set unit_price_cents = 3150 where id = $1`, [l1]); return null; } catch (e) { return String(e); } });
    expect(err).toMatch(/PM_PRICE_OVERRIDE_REQUIRED/);
    const o = await call<{ override_id: string; status: string }>(f, 'owner', `pm.dlr_request_price_override('PARTS_TICKET_LINE', $1, 3150, 'Matching the farm store price')`, [l1]);
    expect(o.status).toBe('PENDING');
    expect(await callErr(f, 'owner', `pm.dlr_decide_price_override($1, 'APPROVE')`, [o.override_id])).toMatch(/PM_SOD_VIOLATION/);
    expect((await call<{ status: string }>(f, 'gm', `pm.dlr_decide_price_override($1, 'APPROVE')`, [o.override_id])).status).toBe('APPROVED');
    expect(Number((await one<{ unit_price_cents: string }>(f, `select unit_price_cents from pm.parts_ticket_lines where id = $1`, [l1])).unit_price_cents)).toBe(3150);
    const l2 = await mkLine();
    expect((await call<{ status: string }>(f, 'gm', `pm.dlr_request_price_override('PARTS_TICKET_LINE', $1, 3000, 'Fleet customer')`, [l2])).status).toBe('AUTO_APPROVED');
    // security review M2: 6–12 digits, no runs / repeats, bcrypt at rest
    expect(await callErr(f, 'gm', `pm.dlr_set_manager_pin('4321')`)).toMatch(/6 to 12 digits/);
    expect(await callErr(f, 'gm', `pm.dlr_set_manager_pin('111111')`)).toMatch(/run or a repeat/);
    expect(await callErr(f, 'gm', `pm.dlr_set_manager_pin('234567')`)).toMatch(/run or a repeat/);
    await call(f, 'gm', `pm.dlr_set_manager_pin('482913')`);
    expect((await one<{ h: string }>(f, `select pin_hash h from pm.dlr_manager_pins where membership_id = $1`, [f.membership.gm])).h).toMatch(/^\$2[abxy]?\$10\$/);
    expect(await callErr(f, 'pm', `pm.dlr_set_manager_pin('905172')`)).toMatch(forbidden);
    const l3 = await mkLine();
    const o3 = await call<{ override_id: string }>(f, 'owner', `pm.dlr_request_price_override('PARTS_TICKET_LINE', $1, 3100, 'Loyal customer')`, [l3]);
    const notesBefore = (await one<{ n: number }>(f, `select count(*)::int n from core.notifications where membership_id = $1 and title = 'Wrong manager PIN at the counter'`, [f.membership.gm])).n;
    expect((await call<{ error?: string }>(f, 'owner', `pm.dlr_approve_override_pin($1, $2, '000000')`, [o3.override_id, f.membership.gm])).error).toBe('PIN_MISMATCH');
    expect((await one<{ n: number }>(f, `select count(*)::int n from core.notifications where membership_id = $1 and title = 'Wrong manager PIN at the counter'`, [f.membership.gm])).n).toBe(notesBefore + 1);
    expect((await call<{ status: string }>(f, 'owner', `pm.dlr_approve_override_pin($1, $2, '482913')`, [o3.override_id, f.membership.gm])).status).toBe('APPROVED');
    const b = await call<{ overrides: Array<{ status: string; method: string }>; limits: unknown[] }>(f, 'owner', `pm.dlr_price_override_board($1)`, [L1]);
    expect(b.overrides.map((x) => x.method).sort()).toEqual(['LIMIT', 'PIN', 'QUEUE']);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[]')`, [L1]);
  });
  it('the day close lists what is open; signing needs every drawer closed and a note when items remain', async () => {
    const c = await call<{ items: Array<{ key: string; ok: boolean; count: number }>; open: number; books_period: { available: boolean } }>(f, 'owner', `pm.dlr_store_close_checklist($1, 'DAY')`, [L1]);
    expect(c.items.map((i) => i.key)).toEqual(expect.arrayContaining(['open_tickets', 'drawers_open', 'unposted_deals', 'ros_to_close', 'claims_due', 'incentives_due', 'contracts_in_transit', 'rental_cycle_billing', 'price_overrides']));
    const m = await call<{ kind: string }>(f, 'owner', `pm.dlr_store_close_checklist($1, 'MONTH')`, [L1]);
    expect(m.kind).toBe('MONTH');
    if (c.open > 0) expect(await callErr(f, 'owner', `pm.dlr_sign_store_close($1, 'DAY')`, [L1])).toMatch(/PM_INVALID/);
    const s = await call<{ signed: { open_count: number } | null }>(f, 'owner', `pm.dlr_sign_store_close($1, 'DAY', null, 'Two tickets left open for a fleet customer')`, [L1]);
    expect(s.signed).toBeTruthy();
    expect(await callErr(f, 'labor', `pm.dlr_store_close_checklist($1)`, [L1])).toMatch(forbidden);
  });
});

describe('phone follow-ups: device-time punches + the 3C story on RO lines', () => {
  const min = (sql: string, args: unknown[]) => one<{ m: number }>(f, sql, args).then((r) => Number(r.m));
  beforeAll(async () => {
    const wo = await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Phone RO') returning id`, [ORG_A, L1, J2]);
    ids.pwo = wo.id;
    await q(f.db, `insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot) values ($1, $2, $3, $4, tstzrange(now() + interval '3 days', now() + interval '3 days 2 hours'))`, [ORG_A, J2, wo.id, f.employee.labor]);
    const line = (d: string, w: string, j: string) => one<{ id: string }>(f, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents, created_at) values ($1, $2, $3, 'LABOR', $4, 1, 9000, now() - interval '8 hours') returning id`, [ORG_A, j, w, d]).then((r) => r.id);
    ids.pA = await line('No start', wo.id, J2);
    ids.pB = await line('Deck belt', wo.id, J2);
    const other = await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Desk RO') returning id`, [ORG_A, L1, J1]);
    ids.pOther = await line('Other tech', other.id, J1);
  });

  it('H1 late taps: an own tap > 15 min old is ADJUSTED + late_tap on the punch and its time entry; approval needs an individual acknowledgment; > 72 h is refused; a late tap into an approved week is refused', async () => {
    await q(f.db, `update core.employees set hourly_rate_cents = 3000 where id = $1`, [f.employee.labor]);
    const a = await call<{ punch_id: string; late_tap: boolean; late_minutes: number }>(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '5 hours')`, [ids.pA]);
    expect(a.late_tap).toBe(true);
    expect(a.late_minutes).toBeGreaterThanOrEqual(299);
    const b = await call<{ punch_id: string; closed: { time_entry_id: string; late_tap: boolean } }>(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '270 minutes')`, [ids.pB]);
    expect(b.closed.late_tap).toBe(true);
    const off = await call<{ time_entry_id: string; late_tap: boolean }>(f, 'labor', `pm.dlr_clock_off($1, null, now() - interval '4 hours')`, [L1]);
    expect(off.late_tap).toBe(true);
    const p1 = await one<{ source: string; late_tap: boolean; dev: boolean; rec: boolean }>(f,
      `select source, late_tap, end_device_at is not null dev, end_received_at > ended_at rec from pm.dlr_tech_punches where id = $1`, [a.punch_id]);
    expect(p1).toEqual({ source: 'ADJUSTED', late_tap: true, dev: true, rec: true });
    const te1 = b.closed.time_entry_id;
    const te2 = off.time_entry_id;
    const t = await one<{ late_tap: boolean; m: number; approval_state: string }>(f, `select late_tap, late_tap_minutes m, approval_state from pm.time_entries where id = $1`, [te1]);
    expect(t).toMatchObject({ late_tap: true, approval_state: 'SUBMITTED' });
    expect(Number(t.m)).toBeGreaterThanOrEqual(299);
    const list = await call<Array<{ id: string; late_label: string }>>(f, 'owner', `pm.dlr_late_time($1)`, [L1]);
    expect(list.find((x) => x.id === te1)?.late_label).toMatch(/^entered 5\.0 h late$/);
    // (this company routes time through Approvals (1113); the direct approval path is exercised with it off, then it is restored)
    await q(f.db, `create temp table if not exists _appr_l1 as select * from pm.approval_settings where false`);
    await q(f.db, `insert into _appr_l1 select * from pm.approval_settings where location_id = $1`, [L1]);
    await q(f.db, `delete from pm.approval_settings where location_id = $1`, [L1]);
    // plain approval refuses a late tap; acknowledging it individually approves it
    expect(await callErr(f, 'owner', `pm.approve_time_entries($1::uuid[])`, [[te1]])).toMatch(/PM_LATE_TAP: this time was entered 5\.0 h late/);
    expect(await callErr(f, 'owner', `pm.approve_time_entries_ack($1::uuid[], '{}')`, [[te1]])).toMatch(/does not exist/);
    expect(await call<{ acknowledged: number }>(f, 'owner', `pm.dlr_ack_late_time($1::uuid[])`, [[te1]])).toEqual({ acknowledged: 1 });
    expect(await call<number>(f, 'owner', `pm.approve_time_entries($1::uuid[])`, [[te1]])).toBe(1);
    expect((await one<{ by: string | null }>(f, `select late_ack_by by from pm.time_entries where id = $1`, [te1])).by).toBe('user_owner');
    // ahead of approval: the worker cannot acknowledge their own late time; an approver can, then the normal path approves
    expect(await callErr(f, 'labor', `pm.dlr_ack_late_time($1::uuid[])`, [[te2]])).toMatch(/PM_FORBIDDEN|PM_SOD_VIOLATION/);
    await call(f, 'owner', `pm.dlr_ack_late_time($1::uuid[])`, [[te2]]);
    expect(await call<number>(f, 'owner', `pm.approve_time_entries($1::uuid[])`, [[te2]])).toBe(1);
    await q(f.db, `insert into pm.approval_settings select * from _appr_l1 on conflict do nothing`);
    // the week now has approved time: another late tap into it is refused
    expect(await callErr(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '3 hours')`, [ids.pA])).toMatch(/PM_TIME_WEEK_LOCKED/);
    // own taps older than 72 h are the manager's to enter
    expect(await callErr(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '73 hours')`, [ids.pA])).toMatch(/PM_PUNCH_STALE: .*72 hours/);
    // members cannot pre-stamp an acknowledgment
    const ins = await as(f, 'labor', () => q<{ late_ack_at: string | null }>(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours, late_tap, late_ack_at) values ($1, $2, current_date, 1, true, now()) returning late_ack_at`, [J2, f.employee.labor]));
    expect(ins[0]!.late_ack_at).toBeNull();
  });

  it('on-time taps (within 15 minutes) keep PHONE; the next tap closes the first at its time and keeps device + received times', async () => {
    const a = await call<{ punch_id: string; late_tap: boolean }>(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '12 minutes')`, [ids.pA]);
    expect(a.late_tap).toBe(false);
    expect(await min(`select extract(epoch from (now() - started_at)) / 60 m from pm.dlr_tech_punches where id = $1`, [a.punch_id])).toBeCloseTo(12, 0);
    const b = await call<{ punch_id: string; closed: { hours: number } }>(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '6 minutes')`, [ids.pB]);
    expect(Number(b.closed.hours)).toBeCloseTo(0.1, 2);
    const p1 = await one<{ source: string; late_tap: boolean; dev: boolean; rec: boolean; start_rec: boolean }>(f,
      `select source, late_tap, end_device_at is not null dev, end_received_at > ended_at rec, start_received_at > started_at start_rec from pm.dlr_tech_punches where id = $1`, [a.punch_id]);
    expect(p1).toEqual({ source: 'PHONE', late_tap: false, dev: true, rec: true, start_rec: true });
    ids.pPunch2 = b.punch_id;
  });

  it('bounds: ahead of the skew or overlapping a later punch is refused', async () => {
    expect(await callErr(f, 'labor', `pm.dlr_clock_on($1, null, now() + interval '1 hour')`, [ids.pA])).toMatch(/PM_CLOCK_AHEAD/);
    expect(await callErr(f, 'labor', `pm.dlr_clock_on($1, null, now() - interval '9 minutes')`, [ids.pA])).toMatch(/PM_PUNCH_OVERLAP/);
    expect(await callErr(f, 'labor', `pm.dlr_clock_off($1, null, now() + interval '1 hour')`, [L1])).toMatch(/PM_CLOCK_AHEAD/);
  });

  it('a tech ends their own punch at the tap time without dispatch:edit; another tech\'s end time still needs it; a manager correction is ADJUSTED', async () => {
    const off = await call<{ open: boolean; hours: number }>(f, 'labor', `pm.dlr_clock_off($1, null, now() - interval '3 minutes')`, [L1]);
    expect(off.open).toBe(true);
    expect(Number(off.hours)).toBeCloseTo(0.05, 2);
    const p2 = await one<{ source: string; dev: boolean }>(f, `select source, end_device_at is not null dev from pm.dlr_tech_punches where id = $1`, [ids.pPunch2]);
    expect(p2).toEqual({ source: 'PHONE', dev: true });
    expect(await callErr(f, 'labor', `pm.dlr_clock_off($1, $2, now() - interval '1 minute')`, [L1, f.employee.supervisor])).toMatch(forbidden);
    // R7: a manager-entered tap older than 15 minutes is late too; the person who entered it cannot acknowledge it
    const mp = await call<{ punch_id: string; late_tap: boolean }>(f, 'owner', `pm.dlr_clock_on($1, $2, now() - interval '40 minutes')`, [ids.pA, f.employee.supervisor]);
    expect(mp.late_tap).toBe(true);
    const moff = await call<{ time_entry_id: string; late_tap: boolean }>(f, 'owner', `pm.dlr_clock_off($1, $2, now() - interval '33 minutes')`, [L1, f.employee.supervisor]);
    expect(moff.late_tap).toBe(true);
    expect((await one<{ late_tap: boolean; source: string }>(f, `select t.late_tap, p.source from pm.time_entries t join pm.dlr_tech_punches p on p.time_entry_id = t.id where t.id = $1`, [moff.time_entry_id]))).toEqual({ late_tap: true, source: 'ADJUSTED' });
    expect(await callErr(f, 'owner', `pm.dlr_ack_late_time($1::uuid[])`, [[moff.time_entry_id]])).toMatch(/PM_SOD_VIOLATION/);
    const ind = await call<{ punch_id: string }>(f, 'owner', `pm.dlr_clock_indirect($1, 'SHOP', $2, now() - interval '15 minutes')`, [L1, f.employee.supervisor]);
    await call(f, 'owner', `pm.dlr_clock_off($1, $2, now() - interval '8 minutes')`, [L1, f.employee.supervisor]);
    const p3 = await one<{ source: string; m: number; late: boolean }>(f, `select source, late_tap late, extract(epoch from (ended_at - started_at)) / 60 m from pm.dlr_tech_punches where id = $1`, [ind.punch_id]);
    expect(p3.source).toBe('ADJUSTED');
    expect(p3.late).toBe(false);
    expect(Number(p3.m)).toBeCloseTo(7, 0);
  });

  it('the 3C story: the tech on the RO writes it, a replay of the command returns the first result, null keeps and "" clears', async () => {
    const cmd = '7d6f0c55-2b1e-4c1a-9f3e-111111111111';
    const s1 = await call<{ story_id: string; complaint: string; cause: string | null; replayed: boolean }>(f, 'labor',
      `pm.dlr_set_line_story($1, 'Will not start', 'Stale fuel', null, $2)`, [ids.pA, cmd]);
    expect(s1).toMatchObject({ complaint: 'Will not start', cause: 'Stale fuel', replayed: false });
    const again = await call<{ story_id: string; replayed: boolean }>(f, 'labor', `pm.dlr_set_line_story($1, 'Different', null, null, $2)`, [ids.pA, cmd]);
    expect(again).toMatchObject({ story_id: s1.story_id, replayed: true });
    expect(await callErr(f, 'labor', `pm.dlr_set_line_story($1, 'x', null, null, $2)`, [ids.pB, cmd])).toMatch(/PM_DUPLICATE/);
    const s2 = await call<{ complaint: string; cause: string | null; correction: string }>(f, 'labor',
      `pm.dlr_set_line_story($1, null, '', 'Drained tank, new plug, ran 15 min', '7d6f0c55-2b1e-4c1a-9f3e-222222222222')`, [ids.pA]);
    expect(s2).toMatchObject({ complaint: 'Will not start', cause: null, correction: 'Drained tank, new plug, ran 15 min' });
    expect(await callErr(f, 'labor', `pm.dlr_set_line_story($1, null, null, null, null)`, [ids.pB])).toMatch(/PM_INVALID/);
    const seen = await as(f, 'labor', () => q<{ correction: string }>(f.db, `select correction from pm.dlr_line_stories where work_order_line_id = $1`, [ids.pA]));
    expect(seen).toEqual([{ correction: 'Drained tank, new plug, ran 15 min' }]);
  });

  it('a tech not on the RO is refused; the service desk (store edit) writes any line; a closed RO is locked', async () => {
    expect(await callErr(f, 'labor', `pm.dlr_set_line_story($1, 'x', null, null, null)`, [ids.pOther])).toMatch(forbidden);
    expect((await call<{ complaint: string }>(f, 'owner', `pm.dlr_set_line_story($1, 'Customer says it smokes', null, null, null)`, [ids.pOther])).complaint).toBe('Customer says it smokes');
    await q(f.db, `update pm.work_orders set status = 'CANCELLED', cancelled_at = now() where id = (select work_order_id from pm.work_order_lines where id = $1)`, [ids.pOther]);
    expect(await callErr(f, 'owner', `pm.dlr_set_line_story($1, 'x', null, null, null)`, [ids.pOther])).toMatch(/PM_WO_LOCKED/);
  });
});

describe('security review round 1 (1125): drawer, price guard, store close history, masked check-in money', () => {
  beforeAll(async () => {
    if ((await q(f.db, `select 1 from pm.parts where location_id = $1 and part_number = 'BLADE-42'`, [L1])).length === 0) {
      await call(f, 'owner', `pm.upsert_part($1, 'BLADE-42', 'Mower blade 42 in', '{"list_price_cents":3500,"cost_cents":2000}'::jsonb)`, [L1]);
    }
    await q(f.db, `insert into pm.dealer_settings (org_id, location_id, allow_negative_parts) values ($1, $2, true)
                   on conflict (org_id, location_id) do update set allow_negative_parts = true`, [ORG_A, L1]).catch(() => undefined);
  });
  it('H2 drawer: sources must exist at the store, tickets only through the trigger, negatives only as cash payouts, blind count, per-tender variance', async () => {
    const reg = await call<string>(f, 'owner', `pm.dlr_save_register($1, 'r2', 'Parts counter')`, [L1]);
    const s = await call<string>(f, 'owner', `pm.dlr_open_drawer($1, 10000)`, [reg]);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'PARTS_TICKET', null, 'CASH', 1000)`, [s])).toMatch(/counter tickets land in the drawer/);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', null, 'CASH', 1000)`, [s])).toMatch(/pick the repair order/);
    const far = (await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'North RO') returning id`, [ORG_A, L2, J3])).id;
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', $2, 'CASH', 1000)`, [s, far])).toMatch(/not at this store/);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', $2, 'CASH', 1000)`, [s, '00000000-0000-4000-8000-0000000000cc'])).toMatch(/not at this store/);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CASH', -500, null, 'refund')`, [s])).toMatch(/payout with a note/);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'PAYOUT', null, 'CHECK', -500, null, 'refund')`, [s])).toMatch(/out of the cash/);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CASH', 500)`, [s])).toMatch(/say what the payment was for/);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CASH', 1000, null, 'Shop rag sale')`, [s]);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'OTHER', null, 'CHECK', 2000, null, 'Old invoice paid by check')`, [s]);
    // blind count: no expected totals and no amounts while the drawer is open
    const open = await call<{ blind_count: boolean; registers: Array<{ id: string; open_session: Record<string, unknown> | null }>; entries: Array<{ session_id: string; amount_cents: number | null; blind: boolean }> }>(f, 'owner', `pm.dlr_drawer_board($1)`, [L1]);
    const os = open.registers.find((r) => r.id === reg)!.open_session!;
    expect(os).not.toHaveProperty('expected');
    expect(os.entries).toBe(2);
    expect(open.entries.filter((e) => e.session_id === s).every((e) => e.amount_cents === null && e.blind)).toBe(true);
    // cash over by $6 and checks short by $6: the totals net to zero but each tender is flagged
    const r = await call<{ variance_cents: number; flagged: boolean; note_required: boolean; by_tender: { cash: { flagged: boolean }; check: { flagged: boolean }; card: { flagged: boolean } } }>(f, 'owner',
      `pm.dlr_close_drawer($1, '{"cash_cents":11600,"check_cents":1400}')`, [s]);
    expect(r).toMatchObject({ variance_cents: 0, flagged: true, note_required: true, by_tender: { cash: { flagged: true }, check: { flagged: true }, card: { flagged: false } } });
    await call(f, 'owner', `pm.dlr_note_drawer_variance($1, 'Check entered as cash')`, [s]);
    const closed = await call<{ entries: Array<{ session_id: string; amount_cents: number | null }> }>(f, 'owner', `pm.dlr_drawer_board($1)`, [L1]);
    expect(closed.entries.filter((e) => e.session_id === s).map((e) => Number(e.amount_cents)).sort()).toEqual([1000, 2000]);
  });

  it('H2 ticket trigger: cash with active registers needs the closer\'s open drawer; a different amount for a ticket already in a drawer is refused; cash outside a drawer is on the close list', async () => {
    const mk = async () => {
      const t = await call<string>(f, 'owner', `pm.open_parts_ticket($1, null, $2)`, [L1, ids.sl]);
      const pl = await call<{ added: unknown[]; unknown: unknown[] }>(f, 'owner', `pm.dlr_add_pick_list($1, '[{"part_number":"BLADE-42","qty":1}]'::jsonb)`, [t]);
      if (pl.added.length === 0) throw new Error('pick list: ' + JSON.stringify(pl));
      return t;
    };
    const t1 = await mk();
    expect(await callErr(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [t1])).toMatch(/PM_DRAWER_REQUIRED/);
    await call(f, 'owner', `pm.close_parts_ticket($1, 'CARD')`, [t1]);
    const reg = (await one<{ id: string }>(f, `select id from pm.dlr_registers where code = 'R2'`)).id;
    const s = await call<string>(f, 'owner', `pm.dlr_open_drawer($1, 0)`, [reg]);
    const t2 = await mk();
    await q(f.db, `insert into pm.dlr_drawer_entries (org_id, session_id, source_kind, source_id, tender, amount_cents) values ($1, $2, 'PARTS_TICKET', $3, 'CASH', 1)`, [ORG_A, s, t2]);
    expect(await callErr(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [t2])).toMatch(/PM_DRAWER_MISMATCH/);
    await q(f.db, `delete from pm.dlr_drawer_entries where source_id = $1`, [t2]);
    await call(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [t2]);
    await call(f, 'owner', `pm.dlr_close_drawer($1, $2::jsonb, 0)`, [s, J({ cash_cents: Number((await one<{ a: string }>(f, `select coalesce(sum(amount_cents), 0) a from pm.dlr_drawer_entries where session_id = $1 and tender = 'CASH'`, [s])).a) })]);
    // with every register retired a cash ticket closes, and the close list counts it as cash outside a drawer
    await q(f.db, `update pm.dlr_registers set is_active = false where org_id = $1 and location_id = $2`, [ORG_A, L1]);
    const t3 = await mk();
    await call(f, 'owner', `pm.close_parts_ticket($1, 'CASH')`, [t3]);
    await q(f.db, `update pm.dlr_registers set is_active = true where org_id = $1 and location_id = $2`, [ORG_A, L1]);
    const c = await call<{ items: Array<{ key: string; count: number; ok: boolean }> }>(f, 'owner', `pm.dlr_store_close_checklist($1, 'DAY')`, [L1]);
    expect(c.items.find((i) => i.key === 'cash_outside_drawer')).toMatchObject({ ok: false });
    expect(c.items.find((i) => i.key === 'cash_outside_drawer')!.count).toBeGreaterThanOrEqual(1);
    expect(c.items.find((i) => i.key === 'drawer_variances')!.count).toBeGreaterThanOrEqual(1);
  });

  it('L7: every store-close sign-off is kept', async () => {
    await call(f, 'owner', `pm.dlr_sign_store_close($1, 'DAY', null, 'Second look after the late ticket')`, [L1]);
    const c = await call<{ signed: { note: string }; history: unknown[] }>(f, 'owner', `pm.dlr_store_close_checklist($1, 'DAY')`, [L1]);
    expect(c.history.length).toBeGreaterThanOrEqual(2);
    expect(c.signed.note).toBe('Second look after the late ticket');
  });

  it('H3: definer RPCs that take a price apply the caller\'s limit (part price, posted labor rate, sublet cost); trusted overrides still apply', async () => {
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[{"role_key":"default","max_discount_pct":0.05},{"role_key":"projects_gm","max_discount_pct":0.2}]')`, [L1]);
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"labor_rate_cents":12000}')`, [L1]);
    expect(await callErr(f, 'owner', `pm.dlr_set_store_settings($1, '{"labor_rate_cents":0}')`, [L1])).toMatch(/PM_INVALID/);
    const wo = (await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Price RO') returning id`, [ORG_A, L1, J1])).id;
    const part = (await one<{ id: string; price: string }>(f, `select id, coalesce(price_cents, list_price_cents)::text price from pm.parts where location_id = $1 and part_number = 'BLADE-42'`, [L1]));
    const low = Math.round(Number(part.price) * 0.8);
    expect(await callErr(f, 'owner', `pm.dlr_add_finding($1, $2::jsonb)`, [wo, J({ description: 'Blades worn', parts: [{ part_id: part.id, qty: 1, unit_price_cents: low }] })])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED/);
    expect(await callErr(f, 'owner', `pm.dlr_add_finding($1, $2::jsonb)`, [wo, J({ description: 'Deck', labor_hours: 1, labor_rate_cents: 10000 })])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED: a labor rate under the posted rate/);
    await call(f, 'owner', `pm.dlr_add_finding($1, $2::jsonb)`, [wo, J({ description: 'Deck', labor_hours: 1, labor_rate_cents: 11500 })]);
    await call(f, 'gm', `pm.dlr_add_finding($1, $2::jsonb)`, [wo, J({ description: 'Blades', parts: [{ part_id: part.id, qty: 1, unit_price_cents: low }] })]);
    expect(await callErr(f, 'owner', `pm.dlr_add_sublet($1, $2::jsonb)`, [wo, J({ vendor_id: ids.kubota, description: 'Machine shop', cost_cents: 10000, price_cents: 9000 })])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED: that sublet/);
    await call(f, 'owner', `pm.dlr_add_sublet($1, $2::jsonb)`, [wo, J({ vendor_id: ids.kubota, description: 'Machine shop', cost_cents: 10000, price_cents: 13000 })]);
    // the guard trigger now applies inside definer paths too: a labor line written by a definer RPC under the posted rate
    expect(await callErr(f, 'owner', `pm.dlr_check_in($1, $2, $3::jsonb)`, [L1, ids.rUnit ?? ids.unitDeal, J({ job_id: J1, complaints: [{ text: 'Tune up', flag_hours: 2, unit_price_cents: 20000 }] })])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED/);
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"labor_rate_cents":null}')`, [L1]);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[]')`, [L1]);
  });

  it('L3: the check-in authorization limit and deposit are masked money', async () => {
    const m = await q<{ table_name: string; column_name: string }>(f.db, `select table_name, column_name from pm.access_masked_columns where table_name = 'dlr_ro_checkins' order by column_name`);
    expect(m.map((x) => x.column_name)).toEqual(['auth_limit_cents', 'deposit_cents']);
    const direct = await as(f, 'labor', async () => { try { await q(f.db, `select auth_limit_cents from pm.dlr_ro_checkins limit 1`); return 'read'; } catch (e) { return String(e); } });
    expect(direct).toMatch(/permission denied/);
  });
});

describe('security review round 2 (1125): line writes, time-entry gate, partial payments, legacy PINs', () => {
  it('R2: members cannot write line money columns or insert lines; the guarded RPCs apply the price guard on the effective amount, discount sums, labor qty x rate and pay type moves', async () => {
    const priv = await one<{ ins: boolean; disc: boolean; price: boolean; descr: boolean }>(f,
      `select has_table_privilege('authenticated', 'pm.work_order_lines', 'INSERT') ins, has_column_privilege('authenticated', 'pm.work_order_lines', 'discount_pct', 'UPDATE') disc,
              has_column_privilege('authenticated', 'pm.work_order_lines', 'unit_price_cents', 'UPDATE') price, has_column_privilege('authenticated', 'pm.work_order_lines', 'description', 'UPDATE') descr`);
    expect(priv).toEqual({ ins: false, disc: false, price: false, descr: true });
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[{"role_key":"default","max_discount_pct":0.05}]')`, [L1]);
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"labor_rate_cents":12000}')`, [L1]);
    const wo = (await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Guard RO') returning id`, [ORG_A, L1, J1])).id;
    const part = (await one<{ id: string; price: string }>(f, `select id, coalesce(price_cents, list_price_cents)::text price from pm.parts where location_id = $1 and part_number = 'BLADE-42'`, [L1]));
    const P = Number(part.price);
    const direct = await as(f, 'owner', async () => { try { await q(f.db, `insert into pm.work_order_lines (job_id, work_order_id, kind, description, qty, unit_price_cents) values ($1, $2, 'PART', 'x', 1, 1)`, [J1, wo]); return 'ok'; } catch (e) { return String(e); } });
    expect(direct).toMatch(/permission denied/);
    // full price is fine; a 10% discount_pct on it is over the 5% limit (the effective amount counts)
    const line = await call<string>(f, 'owner', `pm.add_work_order_line($1, $2::jsonb)`, [wo, J({ kind: 'PART', part_id: part.id, description: 'Blade', qty: 1, unit_price_cents: P })]);
    expect(await callErr(f, 'owner', `pm.update_work_order_line($1, '{"discount_pct":0.1}')`, [line])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED/);
    const upd = await as(f, 'owner', async () => { try { await q(f.db, `update pm.work_order_lines set discount_pct = 0.5 where id = $1`, [line]); return 'ok'; } catch (e) { return String(e); } });
    expect(upd).toMatch(/permission denied/);
    // labor with no flag hours: qty x the posted rate is the base
    expect(await callErr(f, 'owner', `pm.add_work_order_line($1, $2::jsonb)`, [wo, J({ kind: 'LABOR', description: 'Diagnose', qty: 2, unit_price_cents: 9000 })])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED/);
    await call(f, 'owner', `pm.add_work_order_line($1, $2::jsonb)`, [wo, J({ kind: 'LABOR', description: 'Diagnose', qty: 2, unit_price_cents: 11500 })]);
    // discount lines count as their sum against the customer subtotal
    const sub = Number((await one<{ s: string }>(f, `select sum(amount_cents)::text s from pm.work_order_lines where work_order_id = $1`, [wo])).s);
    await call(f, 'owner', `pm.add_work_order_line($1, $2::jsonb)`, [wo, J({ kind: 'DISCOUNT', description: 'Loyalty', qty: 1, unit_price_cents: -Math.floor(sub * 0.03) })]);
    expect(await callErr(f, 'owner', `pm.add_work_order_line($1, $2::jsonb)`, [wo, J({ kind: 'DISCOUNT', description: 'More', qty: 1, unit_price_cents: -Math.floor(sub * 0.03) })])).toMatch(/discounts are .* of the customer total/);
    // moving a customer line to warranty needs Dealer store approve (owner has it); a member without it is refused
    const personas = ['pm', 'supervisor', 'dispatcher', 'gm'] as const;
    let editor: (typeof personas)[number] | null = null;
    for (const p of personas) {
      const r = await as(f, p, () => q<{ e: boolean; a: boolean }>(f.db, `select $1::uuid in (select pm.my_location_ids('projects.store', 'edit')) e, $1::uuid in (select pm.my_location_ids('projects.store', 'approve')) a`, [L1]));
      if (r[0]!.e && !r[0]!.a) { editor = p; break; }
    }
    if (editor) expect(await callErr(f, editor, `pm.update_work_order_line($1, '{"pay_type":"WARRANTY"}')`, [line])).toMatch(/needs Dealer store approve/);
    await call(f, 'owner', `pm.update_work_order_line($1, '{"pay_type":"WARRANTY"}')`, [line]);
    expect(await callErr(f, 'owner', `pm.update_work_order_line($1, '{"part_id":"x"}')`, [line])).toMatch(/is not changed here/);
    await call(f, 'owner', `pm.dlr_set_store_settings($1, '{"labor_rate_cents":null}')`, [L1]);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[]')`, [L1]);
  });

  it('R3: members cannot insert clock-origin time, past-day entries are flagged late, clock rows are not edited or deleted by members', async () => {
    expect(await as(f, 'labor', async () => { try { await q(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours, source_ref) values ($1, $2, current_date, 1, 'pm:punch:fake')`, [J2, f.employee.labor]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/comes from the clock/);
    expect(await as(f, 'labor', async () => { try { await q(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours, source_ref) values ($1, $2, current_date, 1, 'wf:seg:' || gen_random_uuid()::text)`, [J2, f.employee.labor]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/comes from the clock/);
    const past = await as(f, 'labor', () => q<{ id: string; late_tap: boolean; m: number }>(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours) values ($1, $2, current_date - 3, 2) returning id, late_tap, late_tap_minutes m`, [J2, f.employee.labor]));
    expect(past[0]!.late_tap).toBe(true);
    expect(Number(past[0]!.m)).toBeGreaterThanOrEqual(2 * 1440);
    const today = await as(f, 'labor', () => q<{ late_tap: boolean }>(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours) values ($1, $2, current_date, 2) returning late_tap`, [J2, f.employee.labor]));
    expect(today[0]!.late_tap).toBe(false);
    // the manual flow still works: a member edits and deletes their own on-time draft
    await as(f, 'labor', () => q(f.db, `update pm.time_entries set hours = 3 where id = (select id from pm.time_entries where employee_id = $1 and work_date = current_date and source_ref is null and not late_tap order by created_at desc limit 1)`, [f.employee.labor]));
    expect(await as(f, 'labor', async () => { try { await q(f.db, `delete from pm.time_entries where id = $1`, [past[0]!.id]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/voided, not deleted/);
    const clk = (await one<{ id: string }>(f, `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, source_ref, approval_state) values ($1, $2, $3, current_date, 1, 'pm:punch:' || gen_random_uuid()::text, 'DRAFT') returning id`, [ORG_A, J2, f.employee.labor])).id;
    expect(await as(f, 'labor', async () => { try { await q(f.db, `update pm.time_entries set hours = 5 where id = $1`, [clk]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/corrected by the service manager/);
    expect(await as(f, 'labor', async () => { try { await q(f.db, `delete from pm.time_entries where id = $1`, [clk]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/voided, not deleted/);
  });

  it('R5: several payments to one record up to what it owes; the close list shows the balance', async () => {
    const wo = (await one<{ id: string; number: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Pay RO') returning id, number`, [ORG_A, L1, J1]));
    await q(f.db, `insert into pm.work_order_lines (org_id, job_id, work_order_id, kind, description, qty, unit_price_cents, status) values ($1, $2, $3, 'LABOR', 'Repair', 1, 10000, 'APPROVED')`, [ORG_A, J1, wo.id]);
    const due = Number((await one<{ d: string }>(f, `select pm._d5_source_due($1, 'REPAIR_ORDER', $2)::text d`, [ORG_A, wo.id])).d);
    const reg = (await one<{ id: string }>(f, `select id from pm.dlr_registers where code = 'R2'`)).id;
    const s = await call<string>(f, 'owner', `pm.dlr_open_drawer($1, 0)`, [reg]);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', $2, 'CASH', $3)`, [s, wo.id, due - 4000]);
    await call(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', $2, 'CASH', 1000)`, [s, wo.id]);
    expect(await callErr(f, 'owner', `pm.dlr_record_payment($1, 'REPAIR_ORDER', $2, 'CARD', 3001)`, [s, wo.id])).toMatch(/more than the balance due/);
    const c = await call<{ partials: Array<{ source_id: string; paid_cents: number; due_cents: number; balance_cents: number }> }>(f, 'owner', `pm.dlr_store_close_checklist($1, 'DAY')`, [L1]);
    expect(c.partials.find((x) => x.source_id === wo.id)).toMatchObject({ paid_cents: due - 3000, due_cents: due, balance_cents: 3000 });
    await call(f, 'owner', `pm.dlr_close_drawer($1, $2::jsonb, 0)`, [s, J({ cash_cents: due - 3000 })]);
  });

  it('R9: a legacy (non-bcrypt) PIN never verifies', async () => {
    await q(f.db, `insert into pm.dlr_manager_pins (org_id, membership_id, pin_hash) values ($1, $2, pm._x_sha256($3 || ':' || '482913'))
                   on conflict (org_id, membership_id) do update set pin_hash = excluded.pin_hash, failed_count = 0, locked_until = null`, [ORG_A, f.membership.supervisor, String(f.membership.supervisor)]);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[{"role_key":"default","max_discount_pct":0.0}]')`, [L1]);
    const t = await call<string>(f, 'owner', `pm.open_parts_ticket($1, null, $2)`, [L1, ids.sl]);
    await call(f, 'owner', `pm.dlr_add_pick_list($1, '[{"part_number":"BLADE-42","qty":1}]'::jsonb)`, [t]);
    const l = (await one<{ id: string }>(f, `select id from pm.parts_ticket_lines where ticket_id = $1`, [t])).id;
    const o = await call<{ override_id: string }>(f, 'owner', `pm.dlr_request_price_override('PARTS_TICKET_LINE', $1, 100, 'Legacy PIN probe')`, [l]);
    expect((await call<{ error?: string }>(f, 'owner', `pm.dlr_approve_override_pin($1, $2, '482913')`, [o.override_id, f.membership.supervisor])).error).toBe('PIN_MISMATCH');
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[]')`, [L1]);
  });
});

describe('security review round 3 (1125): line removal, issued parts, time-entry edits, field sync path', () => {
  it('R2-b: members cannot delete lines directly; removing a charged line needs approve at a store with limits; issued parts lock delete and qty cuts', async () => {
    const wo = (await one<{ id: string }>(f, `insert into pm.work_orders (org_id, location_id, job_id, summary) values ($1, $2, $3, 'Remove RO') returning id`, [ORG_A, L1, J1])).id;
    const line = await call<string>(f, 'owner', `pm.add_work_order_line($1, '{"kind":"LABOR","description":"Tune","qty":1,"unit_price_cents":5000}')`, [wo]);
    expect(await as(f, 'owner', async () => { try { await q(f.db, `delete from pm.work_order_lines where id = $1`, [line]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/permission denied/);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[{"role_key":"default","max_discount_pct":0.05}]')`, [L1]);
    const personas = ['pm', 'supervisor', 'dispatcher', 'gm'] as const;
    for (const p of personas) {
      const r = await as(f, p, () => q<{ e: boolean; a: boolean }>(f.db, `select $1::uuid in (select pm.my_location_ids('projects.store', 'edit')) e, $1::uuid in (select pm.my_location_ids('projects.store', 'approve')) a`, [L1]));
      if (r[0]!.e && !r[0]!.a) { expect(await callErr(f, p, `pm.remove_work_order_line($1)`, [line])).toMatch(/PM_PRICE_OVERRIDE_REQUIRED: removing a charged line/); break; }
    }
    // low: a free-typed customer SERVICE price has no base at a store with limits
    expect(await callErr(f, 'owner', `pm.add_work_order_line($1, '{"kind":"SERVICE","description":"Misc service","qty":1,"unit_price_cents":100}')`, [wo])).toMatch(/price book/);
    await call(f, 'owner', `pm.remove_work_order_line($1, $2)`, [line, wo]);
    await call(f, 'owner', `pm.dlr_set_price_limits($1, '[]')`, [L1]);
    // issued parts: the line cannot be removed or cut below what was issued
    const part = await call<string>(f, 'owner', `pm.add_work_order_line($1, '{"kind":"PART","description":"Filter","qty":2,"unit_price_cents":1500}')`, [wo]);
    await q(f.db, `update pm.work_order_lines set issued_move_id = gen_random_uuid() where id = $1`, [part]);
    expect(await callErr(f, 'owner', `pm.remove_work_order_line($1)`, [part])).toMatch(/PM_PARTS_ISSUED/);
    expect(await callErr(f, 'owner', `pm.update_work_order_line($1, '{"qty":1}')`, [part])).toMatch(/PM_PARTS_ISSUED/);
    await call(f, 'owner', `pm.update_work_order_line($1, '{"qty":3}')`, [part]);
  });

  it('R3-b: a member change to hours / date clears an acknowledgment and re-flags a past day; field-sync rows are locked; the phone writes them through the field RPCs', async () => {
    const today = (await as(f, 'labor', () => q<{ id: string }>(f.db, `insert into pm.time_entries (job_id, employee_id, work_date, hours) values ($1, $2, current_date, 2) returning id`, [J2, f.employee.labor])))[0]!.id;
    await q(f.db, `update pm.time_entries set late_tap = true, late_tap_minutes = 30, late_ack_by = 'user_owner', late_ack_at = now() where id = $1`, [today]);
    await as(f, 'labor', () => q(f.db, `update pm.time_entries set work_date = current_date - 2 where id = $1`, [today]));
    const t = await one<{ late_tap: boolean; by: string | null; m: number }>(f, `select late_tap, late_ack_by by, late_tap_minutes m from pm.time_entries where id = $1`, [today]);
    expect(t.late_tap).toBe(true);
    expect(t.by).toBeNull();
    expect(Number(t.m)).toBeGreaterThanOrEqual(1440);
    // the company's local today is never late
    expect((await one<{ m: number | null }>(f, `select pm._d5_late_since($1, $2, (now() at time zone coalesce((select o.timezone from core.organizations o where o.id = $1), 'UTC'))::date) m`, [ORG_A, J2])).m).toBeNull();
    // the phone's path: own wf:seg row through the RPC, a replay is a duplicate, an update goes through the RPC
    const ref = `wf:seg:${'c0ffee00-0000-4000-8000-0000000000aa'}`;
    const id = await call<string>(f, 'labor', `pm.field_time_insert($1, $2, null, current_date - 1, 3, null, 'Set up', $3)`, [J2, f.employee.labor, ref]);
    expect((await one<{ late_tap: boolean }>(f, `select late_tap from pm.time_entries where id = $1`, [id])).late_tap).toBe(true);
    expect(await callErr(f, 'labor', `pm.field_time_insert($1, $2, null, current_date, 3, null, null, $3)`, [J2, f.employee.labor, ref])).toMatch(/duplicate key|unique/);
    expect(await callErr(f, 'labor', `pm.field_time_insert($1, $2, null, current_date, 3, null, null, 'pm:punch:x')`, [J2, f.employee.labor])).toMatch(/wf:seg key/);
    expect(await callErr(f, 'labor', `pm.field_time_insert($1, $2, null, current_date, 3, null, null, $3)`, [J2, f.employee.supervisor, 'wf:seg:c0ffee00-0000-4000-8000-0000000000bb'])).toMatch(/PM_FORBIDDEN/);
    expect(await call<string>(f, 'labor', `pm.field_time_update($1, '{"hours":4}')`, [id])).toBe(id);
    expect(await as(f, 'labor', async () => { try { await q(f.db, `update pm.time_entries set hours = 9 where id = $1`, [id]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/corrected by the service manager/);
    expect(await as(f, 'labor', async () => { try { await q(f.db, `delete from pm.time_entries where id = $1`, [id]); return 'ok'; } catch (e) { return String(e); } })).toMatch(/voided, not deleted/);
  });
});
