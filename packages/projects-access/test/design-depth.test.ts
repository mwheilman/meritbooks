/**
 * Interior design depth (migration 1122): items with components and sidemarks, per-item client
 * approval with deposits and reallocation, POs grouped by vendor, the vendor inbox agent hook
 * (rules-only parse → proposals → apply), the eight-date procurement hub, receiving / inspection,
 * fee invoicing (time, phase, procurement fee) with the billed-time lock, and money masking.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, errorOf, q, type Fixture, ORG_A, L1, J1 } from './fixture';
import { call, callErr, documentRow, forbidden, one, registryClean, setupIndustry, vendor } from './industry';

let f: Fixture;
const ids: Record<string, string> = {};

beforeAll(async () => {
  f = await setupIndustry('design-depth');
  ids.vA = await vendor(f, 'Lee Industries');
  ids.vB = await vendor(f, 'Kravet');
  ids.vC = await vendor(f, 'Visual Comfort');
  await as(f, 'pm', async () => {
    const add = async (room: string, name: string, price: number, deposit = 0.5) =>
      (await q<{ id: string }>(f.db, `insert into pm.dsn_items (job_id, room, doc_code, name, client_unit_price_cents, deposit_pct) values ($1, $2, $3, $4, $5, $6) returning id`,
        [J1, room, name.slice(0, 3).toUpperCase(), name, price, deposit]))[0]!.id;
    ids.sofa = await add('Living room', 'Sofa', 480000);
    ids.lamp = await add('Living room', 'Floor lamp', 32000);
    ids.rug = await add('Living room', 'Rug', 150000);
  });
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('items with components and sidemarks (ID-10)', () => {
  it('a sofa has a frame from one vendor and COM fabric from another, each with its own line and sidemark', async () => {
    ids.frame = await call<string>(f, 'pm', `pm.dsn_add_component($1, 'FRAME', $2, 'Lee 3-cushion sofa frame', 1, 'EA', 200000, 0.4, 'LEE-1296')`, [ids.sofa, ids.vA]);
    ids.fabric = await call<string>(f, 'pm', `pm.dsn_add_component($1, 'COM_FABRIC', $2, 'Kravet linen COM', 14, 'YD', 6000, 0.4, 'KRV-3346')`, [ids.sofa, ids.vB]);
    ids.lampC = await call<string>(f, 'pm', `pm.dsn_add_component($1, 'ITEM', $2, 'Floor lamp', 1, 'EA', 16000, 0.5)`, [ids.lamp, ids.vC]);
    ids.rugC = await call<string>(f, 'pm', `pm.dsn_add_component($1, 'ITEM', $2, 'Wool rug 9x12', 1, 'EA', 70000, 0.4)`, [ids.rug, ids.vA]);
    const c = await one<{ sidemark: string; unit_sell_cents: string; status: string }>(f, `select sidemark, unit_sell_cents, status from pm.procurement_items where id = $1`, [ids.frame]);
    expect(c.sidemark).toContain('LIVING ROOM');
    expect(Number(c.unit_sell_cents)).toBe(280000);
    expect(c.status).toBe('SPECIFIED');
    expect(await callErr(f, 'supervisor', `pm.dsn_add_component($1, 'ITEM', null, 'x', 1, 'EA', null)`, [ids.sofa])).toMatch(forbidden);
  });
});

describe('per-item approval + deposits with reallocation (ID-15/17, make-or-break 8/9)', () => {
  it('the client approves, rejects or comments item by item; approval requests the item deposit', async () => {
    const p = await call<{ proposal_id: string; items: number }>(f, 'pm', `pm.dsn_send_proposal($1, $2::uuid[])`, [J1, [ids.sofa, ids.lamp, ids.rug]]);
    expect(p.items).toBe(3);
    const lines = await q<{ id: string; item_id: string }>(f.db, `select id, item_id from pm.dsn_proposal_items where proposal_id = $1`, [p.proposal_id]);
    const line = (item: string) => lines.find((l) => l.item_id === item)!.id;
    const a = await call<{ deposit: { requested_cents: number; deposit_request_id: string } }>(f, 'pm', `pm.dsn_record_decision($1, 'APPROVED', 'Jane Client', null, 'PORTAL')`, [line(ids.sofa)]);
    expect(a.deposit.requested_cents).toBe(240000);
    await call(f, 'pm', `pm.dsn_record_decision($1, 'REJECTED', 'Jane Client', 'Too tall')`, [line(ids.lamp)]);
    const c = await call<{ open_items: number }>(f, 'pm', `pm.dsn_record_decision($1, 'COMMENTED', 'Jane Client', 'Can it come in grey?')`, [line(ids.rug)]);
    expect(c.open_items).toBe(1);
    expect((await one<{ status: string }>(f, `select status from pm.dsn_proposals where id = $1`, [p.proposal_id])).status).toBe('PARTIAL');
    await call(f, 'pm', `pm.dsn_record_decision($1, 'APPROVED', 'Jane Client')`, [line(ids.rug)]);
    const st = await q<{ id: string; status: string }>(f.db, `select id, status from pm.procurement_items where dsn_item_id = any($1::uuid[]) order by id`, [[ids.sofa, ids.rug]]);
    expect(st.every((x) => x.status === 'APPROVED')).toBe(true);
    const dr = await one<{ n: number; total: string }>(f, `select count(*)::int n, sum(amount_cents) total from pm.deposit_requests where job_id = $1 and source_ref like 'pm:deposit:%'`, [J1]);
    expect(dr).toEqual({ n: 2, total: '315000' });
  });
  it('an approved item is price-locked for members', async () => {
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.dsn_items set client_unit_price_cents = 1 where id = $1`, [ids.sofa]))).toMatch(/PM_DSN_ITEM_LOCKED/);
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.dsn_items set internal_notes = 'Fabric 2 week delay' where id = $1`, [ids.sofa]))).toBeNull();
  });
  it('deposit money moves from one item to another with a reason; never more than it holds', async () => {
    const m = await call<{ move_id: string; from_held_cents: number }>(f, 'pm', `pm.dsn_reallocate_deposit($1, $2, 50000, 'Sofa back-ordered; client wants the rug first')`, [ids.sofa, ids.rug]);
    expect(m.from_held_cents).toBe(190000);
    expect(await callErr(f, 'pm', `pm.dsn_reallocate_deposit($1, $2, 999999, 'too much money')`, [ids.sofa, ids.rug])).toMatch(/PM_DSN_DEPOSIT_SHORT/);
    const v = await as(f, 'pm', () => q<{ item_id: string; held_cents: string }>(f.db, `select item_id, sum(held_cents)::bigint as held_cents from pm.v_dsn_item_deposits where job_id = $1 group by 1`, [J1]));
    const held = Object.fromEntries(v.map((x) => [x.item_id, Number(x.held_cents)]));
    expect([held[ids.sofa], held[ids.rug]]).toEqual([190000, 125000]);
    expect(await callErr(f, 'supervisor', `pm.dsn_reallocate_deposit($1, $2, 1, 'x reason')`, [ids.sofa, ids.rug])).toMatch(forbidden);
  });
});

describe('POs grouped by vendor + the vendor inbox agent hook (ID-19/21)', () => {
  it('approved components become one PO per vendor, every line carrying its sidemark', async () => {
    const r = await call<{ purchase_orders: Array<{ commitment_id: string; number: string; vendor_id: string; lines: number }> }>(f, 'pm', `pm.dsn_create_pos($1)`, [J1]);
    expect(r.purchase_orders).toHaveLength(2);
    const a = r.purchase_orders.find((p) => p.vendor_id === ids.vA)!;
    expect(a.lines).toBe(2);
    ids.poA = a.number;
    const l = await q<{ description: string }>(f.db, `select description from pm.commitment_lines where commitment_id = $1`, [a.commitment_id]);
    expect(l.every((x) => x.description.includes('SIDEMARK'))).toBe(true);
    expect((await one<{ po_number: string }>(f, `select po_number from pm.procurement_items where id = $1`, [ids.frame])).po_number).toBe(ids.poA);
  });
  it('a forwarded ship notice proposes status, ship date, tracking; a price change waits for an approver', async () => {
    await call(f, 'pm', `pm.advance_procurement_item($1, 'ORDERED')`, [ids.frame]);
    const parsed = { kind: 'SHIP_NOTICE', po_numbers: [ids.poA], dates: { ship_on: new Date().toISOString().slice(0, 10) }, tracking: ['1Z999AA10123456784'],
                     line_prices: [{ sku: 'LEE-1296', unit_cents: 210000 }] };
    const r = await call<{ message_id: string; matched_lines: number; proposals: number }>(f, 'pm', `pm.vi_ingest($1, 'orders@leeindustries.com', 'Shipped: your PO', 'body', $2::jsonb)`, [L1, JSON.stringify(parsed)]);
    expect(r.matched_lines).toBe(2);
    expect(r.proposals).toBeGreaterThanOrEqual(4);
    const props = await q<{ id: string; target_id: string; field: string; needs_approval: boolean }>(f.db, `select id, target_id, field, needs_approval from pm.vendor_inbox_proposals where message_id = $1`, [r.message_id]);
    const frameStatus = props.find((p) => p.target_id === ids.frame && p.field === 'status')!;
    await call(f, 'pm', `pm.vi_decide($1, 'apply')`, [frameStatus.id]);
    expect((await one<{ status: string }>(f, `select status from pm.procurement_items where id = $1`, [ids.frame])).status).toBe('SHIPPED');
    const track = props.find((p) => p.target_id === ids.frame && p.field === 'tracking_ref')!;
    await call(f, 'pm', `pm.vi_decide($1, 'apply')`, [track.id]);
    const price = props.find((p) => p.field === 'unit_cost_cents')!;
    expect(price.needs_approval).toBe(true);
    // the rug line was never ordered: the state machine refuses the notice for it
    const rugStatus = props.find((p) => p.target_id === ids.rugC && p.field === 'status')!;
    expect(await callErr(f, 'pm', `pm.vi_decide($1, 'apply')`, [rugStatus.id])).toMatch(/PM_ITEM_TRANSITION_INVALID/);
    expect(await callErr(f, 'supervisor', `pm.vi_ingest($1, 'x', 'y', 'z', '{}'::jsonb)`, [L1])).toMatch(forbidden);
    // security review M2: vendor prices are cost; a selections viewer without financials sees neither the price proposal nor the parsed totals
    const sp = await as(f, 'supervisor', () => q<{ field: string; old_value: string | null; new_value: string | null }>(f.db, `select field, old_value, new_value from pm.v_vendor_inbox_proposals_masked where message_id = $1`, [r.message_id]));
    expect(sp.find((x) => x.field === 'unit_cost_cents')).toMatchObject({ old_value: null, new_value: null });
    expect(sp.find((x) => x.field === 'tracking_ref')!.new_value).toBe('1Z999AA10123456784');
    const sm = await as(f, 'supervisor', () => one<{ parsed: Record<string, unknown>; body_text: string | null }>(f, `select parsed, body_text from pm.v_vendor_inbox_messages_masked where id = $1`, [r.message_id]));
    expect(sm.parsed).not.toHaveProperty('line_prices');
    expect(sm.body_text).toBeNull();
    const subj = await as(f, 'supervisor', () => one<{ subject: string | null }>(f, `select subject from pm.v_vendor_inbox_messages_masked where id = $1`, [r.message_id]));
    expect(subj.subject).toBeNull();
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select parsed from pm.vendor_inbox_messages limit 1`))).toMatch(/permission denied/);
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select new_value from pm.vendor_inbox_proposals limit 1`))).toMatch(/permission denied/);
    const pp = await as(f, 'pm', () => q<{ new_value: string | null }>(f.db, `select new_value from pm.v_vendor_inbox_proposals_masked where message_id = $1 and field = 'unit_cost_cents'`, [r.message_id]));
    expect(pp[0]!.new_value).not.toBeNull();
    await call(f, 'pm', `pm.vi_dismiss($1)`, [r.message_id]);
    expect((await one<{ status: string }>(f, `select status from pm.vendor_inbox_messages where id = $1`, [r.message_id])).status).toBe('DISMISSED');
  });
});

describe('the eight-date procurement hub + receiving / inspection (ID-20/25)', () => {
  it('lines group by their next undone date: overdue, today, this week', async () => {
    await call(f, 'pm', `pm.dsn_set_component_date($1, 'vendor_deposit', current_date - 2)`, [ids.fabric]);
    await call(f, 'pm', `pm.dsn_set_component_date($1, 'install', current_date + 3)`, [ids.rugC]);
    const hub = await as(f, 'pm', () => q<{ component_id: string; bucket: string }>(f.db, `select component_id, bucket from pm.v_dsn_procurement_hub where job_id = $1`, [J1]));
    const b = Object.fromEntries(hub.map((h) => [h.component_id, h.bucket]));
    expect(b[ids.fabric]).toBe('OVERDUE');
    expect(b[ids.rugC]).toBe('THIS_WEEK');
    await call(f, 'pm', `pm.dsn_set_component_date($1, 'vendor_deposit', current_date - 2, true)`, [ids.fabric]);
    const again = await as(f, 'pm', () => q<{ bucket: string }>(f.db, `select bucket from pm.v_dsn_procurement_hub where component_id = $1`, [ids.fabric]));
    expect(again[0]!.bucket).not.toBe('OVERDUE');
  });
  it('damage needs a photo; a damaged receipt opens the freight claim', async () => {
    expect(await callErr(f, 'pm', `pm.dsn_receive_component($1, 'DAMAGED')`, [ids.frame])).toMatch(/photograph/);
    const doc = await documentRow(f);
    const r = await call<{ status: string; freight_claim: boolean }>(f, 'pm', `pm.dsn_receive_component($1, 'DAMAGED', 1, null, $2::uuid[], 'Arm torn')`, [ids.frame, [doc]]);
    expect(r).toEqual({ component_id: ids.frame, status: 'DAMAGED', freight_claim: true });
  });
});

describe('fee invoicing + time billing (ID-29/31)', () => {
  it('a hybrid agreement drafts time, phase and procurement-fee lines; billed hours lock; nothing bills twice', async () => {
    await call(f, 'pm', `pm.dsn_set_fee_agreement($1, $2::jsonb)`, [J1, JSON.stringify({
      fee_model: 'HYBRID', hourly_rate_cents: 15000, phases: [{ key: 'DESIGN', label: 'Design development', fee_cents: 500000, pct_complete: 0.4 }], procurement_fee_pct: 0.1,
    })]);
    const te = await one<{ id: string }>(f, `insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, billable, approval_state, cost_rate_cents, bill_rate_cents, approved_at, approved_by)
                    values ($1, $2, $3, current_date - 1, 3, true, 'APPROVED', 4000, 20000, now(), 'user_pm') returning id`, [ORG_A, J1, f.employee.supervisor]);
    const r = await call<{ billing_request_id: string; lines: number; total_cents: number }>(f, 'pm', `pm.dsn_draft_fee_invoice($1)`, [J1]);
    expect(r.lines).toBe(3);
    expect(r.total_cents).toBe(60000 + 200000 + 63000);
    const br = await one<{ status: string; billing_type: string; net_cents: string }>(f, `select status, billing_type, net_cents from pm.billing_requests where id = $1`, [r.billing_request_id]);
    expect({ ...br, net_cents: Number(br.net_cents) }).toEqual({ status: 'DRAFT', billing_type: 'TIME_MATERIALS', net_cents: 323000 });
    expect(await errOf(`update pm.time_entries set hours = 4 where id = '${te.id}'`)).toMatch(/PM_TIME_BILLED/);
    expect((await call<{ billing_request_id: string | null }>(f, 'pm', `pm.dsn_draft_fee_invoice($1)`, [J1])).billing_request_id).toBeNull();
    expect(await callErr(f, 'supervisor', `pm.dsn_draft_fee_invoice($1)`, [J1])).toMatch(forbidden);
  });
  it('client prices are masked for seats without contract value', async () => {
    const sup = await as(f, 'supervisor', () => q<{ client_unit_price_cents: string | null; name: string }>(f.db, `select name, client_unit_price_cents from pm.v_dsn_items_masked where id = $1`, [ids.sofa]));
    expect(sup[0]).toEqual({ name: 'Sofa', client_unit_price_cents: null });
    const pm = await as(f, 'pm', () => q<{ client_unit_price_cents: string }>(f.db, `select client_unit_price_cents from pm.v_dsn_items_masked where id = $1`, [ids.sofa]));
    expect(Number(pm[0]!.client_unit_price_cents)).toBe(480000);
  });
});

async function errOf(sql: string): Promise<string | null> {
  try { await f.db.query(sql); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

describe('registry', () => {
  it('stays clean after the flows', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});
