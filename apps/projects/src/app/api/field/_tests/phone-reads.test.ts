import { describe, expect, it, vi } from 'vitest';
import { buildAccess } from '@/lib/access/derive';
import type { ReadyTenant } from '@/lib/api';
import { fakeDb } from './fake-db';

vi.mock('server-only', () => ({}));
const { loadDrawings, loadExtras, loadPayWeek, loadRo, loadSell } = await import('../_lib/phone-reads');
const { tokenFromLink } = await import('../_lib/phone-sign');

const L1 = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';
const ME = 'eeeeeeee-0000-4000-8000-000000000001';
const OTHER = 'eeeeeeee-0000-4000-8000-000000000002';
const WO = '88888888-8888-4888-8888-888888888888';
const employees = [{ id: ME, clerk_user_id: 'user_inst', is_active: true }];
const tenant = { orgId: 'org-1', companies: [{ id: L1, name: 'Heritage Interiors' }] } as unknown as ReadyTenant;

describe('GET /api/field/pay — my pay this week', () => {
  it('only the installer’s OWN tickets, even when the view would show more (a supervisor seat)', async () => {
    const { db } = fakeDb({
      tables: {
        employees,
        v_flr_pay_tickets_masked: [
          { id: 't1', number: 'PT-1', job_id: JOB, employee_id: ME, completed_on: '2026-10-20', split_pct: 1, status: 'APPROVED', gross_cents: 64000, chargeback_cents: 4000, net_cents: 60000 },
          { id: 't2', number: 'PT-2', job_id: JOB, employee_id: ME, completed_on: '2026-10-22', split_pct: 0.5, status: 'FINALIZED', gross_cents: 30000, chargeback_cents: 0, net_cents: 30000 },
          { id: 't3', number: 'PT-3', job_id: JOB, employee_id: OTHER, completed_on: '2026-10-21', split_pct: 1, status: 'APPROVED', gross_cents: 99900, chargeback_cents: 0, net_cents: 99900 },
          { id: 't4', number: 'PT-4', job_id: JOB, employee_id: ME, completed_on: '2026-10-13', split_pct: 1, status: 'APPROVED', gross_cents: 10000, chargeback_cents: 0, net_cents: 10000 },
        ],
        v_flr_pay_ticket_lines_masked: [{ ticket_id: 't1', line_no: 1, labor_code: 'LVP-SF', description: 'LVP install', unit: 'SF', qty: 800, amount_cents: 64000, over_measured: false }],
        v_flr_chargebacks_masked: [
          { id: 'c1', employee_id: ME, reason: 'CALLBACK', description: 'Seam lifted', amount_cents: 4000, status: 'ACKNOWLEDGED', created_at: '2026-10-21T10:00:00Z' },
          { id: 'c2', employee_id: OTHER, reason: 'DAMAGE', description: 'x', amount_cents: 9999, status: 'PROPOSED', created_at: '2026-10-21T10:00:00Z' },
        ],
        v_project_list: [{ job_id: JOB, job_number: 'J-1001', name: 'Hall bath' }],
      },
    });
    const w = await loadPayWeek(db, 'user_inst', '2026-10-22');
    expect(w.weekStart).toBe('2026-10-19');
    expect(w.tickets.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(w.chargebacks.map((c) => c.id)).toEqual(['c1']);
    expect(w.totals).toEqual({ grossCents: 94000, chargebackCents: 4000, netCents: 90000, approvedNetCents: 60000 });
    expect(w.tickets[0]!.lines[0]).toMatchObject({ laborCode: 'LVP-SF', qty: 800 });
    expect(w.tickets[0]!.job).toBe('J-1001 · Hall bath');
  });

  it('someone who is not an employee gets no pay card', async () => {
    const { db } = fakeDb({ tables: { employees: [] } });
    expect((await loadPayWeek(db, 'user_x', null)).installer).toBe(false);
  });
});

describe('GET /api/field/sell — the sell bundle', () => {
  it('sends customer prices, member prices, rebates and plan terms; never item cost or dealer fee', async () => {
    const { db, state } = fakeDb({
      tables: {
        work_orders: [{ id: WO, job_id: JOB, location_id: L1 }],
        fs_estimates: [{ id: 'e1', location_id: L1, job_id: JOB, work_order_id: WO, number: 'EST-7', title: 'Furnace replacement', status: 'PRESENTED', member_pricing: false, sold_option_ids: [], signed_name: null, signed_at: null, deposit_cents: 0, created_at: '2026-10-24' }],
        fs_estimate_options: [{ id: 'o1', estimate_id: 'e1', tier: 'GOOD', sort: 1, name: '80% furnace', description: null, rebate_cents: 0, rebate_note: null, financing_plan_id: null, recommended: false, status: 'OPEN' },
          { id: 'o2', estimate_id: 'e1', tier: 'BEST', sort: 3, name: '96% two-stage', description: 'Quiet', rebate_cents: 30000, rebate_note: 'Utility rebate', financing_plan_id: 'p1', recommended: true, status: 'OPEN' }],
        v_fs_estimate_option_items_masked: [{ id: 'i1', option_id: 'o2', sort: 1, price_book_item_id: null, kind: 'EQUIPMENT', description: 'Furnace', qty: 1, unit_price_cents: 640000, member_unit_price_cents: 590000, unit_cost_cents: 310000, is_optional: false, is_selected: true }],
        v_fs_option_totals: [{ option_id: 'o2', estimate_id: 'e1', regular_cents: 640000, member_cents: 590000, rebate_cents: 30000 }],
        v_financing_plans_masked: [{ id: 'p1', location_id: L1, provider: 'GreenSky', code: 'GS60', name: '60 months 9.99%', apr: 9.99, term_months: 60, promo: null, dealer_fee_pct: 0.08, min_cents: 100000, max_cents: null, is_default: true, is_active: true }],
        agreement_templates: [{ id: 'm1', location_id: L1, key: 'club', label: 'MEMBERSHIP', plan_name: 'Comfort Club', tier: 'Gold', term_months: 12, cadence: 'SEMI', visits_per_term: 2, price_cents: 18900, billing_frequency: 'ANNUAL', member_discount_pct: 0.15, perks: {}, revenue_policy: 'PER_VISIT', renewal_uplift_pct: 0, is_active: true, sort: 1 }],
      },
      rpc: { fs_prejob_brief: () => ({ is_member: false, customer: { id: 'c', name: 'Pat Homeowner' } }) },
    });
    const b = (await loadSell(db, WO))!;
    expect(b.customer).toBe('Pat Homeowner');
    expect(b.options.find((o) => o.id === 'o2')).toMatchObject({ regularCents: 640000, memberCents: 590000, rebateCents: 30000, recommended: true });
    expect(JSON.stringify(b)).not.toMatch(/unit_cost|unitCost|310000|dealer_fee|dealerFee/);
    expect(b.plans[0]).toMatchObject({ apr: 9.99, termMonths: 60 });
    expect(b.memberships[0]).toMatchObject({ planName: 'Comfort Club', priceCents: 18900 });
    expect(state.selected.v_financing_plans_masked).toBeDefined();
  });

  it('a visit the caller cannot see is null (route answers 404)', async () => {
    const { db } = fakeDb({ tables: { work_orders: [] } });
    expect(await loadSell(db, WO)).toBeNull();
  });
});

describe('GET /api/field/drawings — the current set', () => {
  it('one row per sheet at its CURRENT revision with a signed link; sheets without a current revision are skipped', async () => {
    const { db } = fakeDb({
      tables: {
        drawing_sheets: [
          { id: 's1', job_id: JOB, sheet_number: 'A-101', title: 'Floor plan', discipline: 'A', current_revision_id: 'r2' },
          { id: 's2', job_id: JOB, sheet_number: 'A-102', title: null, discipline: 'A', current_revision_id: null },
        ],
        drawing_revisions: [{ id: 'r1', set_id: 'set1', document_id: 'd1', revision_label: '0', title: 'Floor plan' }, { id: 'r2', set_id: 'set2', document_id: 'd2', revision_label: '1', title: 'Floor plan' }],
        drawing_sets: [{ id: 'set2', name: 'IFC rev 1', issued_on: '2026-10-01' }],
        documents: [{ id: 'd2', storage_path: 'org-1/drawings/a101-r1.pdf', size_bytes: 123456 }],
      },
    });
    const r = await loadDrawings(db, [JOB]);
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets[0]).toMatchObject({ number: 'A-101', revisionId: 'r2', revisionLabel: '1', setName: 'IFC rev 1', bytes: 123456 });
    expect(r.sheets[0]!.url).toContain('a101-r1.pdf');
    expect((await loadDrawings(db, [])).sheets).toEqual([]);
  });
});

describe('GET /api/field/extras and /api/field/ro', () => {
  it('visit access notes, the occupied-home rules, drawing counts and the station list', async () => {
    const { db } = fakeDb({
      tables: {
        employees,
        work_orders: [{ id: WO, kind: 'SERVICE', number: 'WO-1', status: 'DISPATCHED', summary: 'No heat' }],
        fs_estimates: [{ work_order_id: WO, status: 'PRESENTED' }],
        res_home_profiles: [{ job_id: JOB, occupied: true, lockbox_code: '4471', gate_code: null, garage_code: null, alarm_code: '9090', pets: 'Dog in back room', children: null, work_hours: '8–4', parking: 'Street', off_limits: 'Nursery', utility_notice: null, temp_kitchen: null, bathroom_for_crew: 'Basement', notes: null, rrp_required: true }],
        drawing_sheets: [{ job_id: JOB, current_revision_id: 'r1' }, { job_id: JOB, current_revision_id: 'r2' }],
        v_flr_pay_tickets_masked: [{ id: 't9', employee_id: ME }],
      },
      rpc: {
        fs_prejob_brief: () => ({ is_member: true, work_order: { complaint: 'No heat upstairs' }, site: { gate_code: '#1234', pets: 'Cat', access_notes: 'Side door' } }),
        res_field_sites: () => [{ job_id: JOB, rrp: true, deliveries: [{ description: 'Cabinets (12 boxes)', expected_on: '2026-10-24', status: 'SHIPPED' }], checks_open: [{ id: 'c' }] }],
      },
    });
    const station = buildAccess([{ location_id: L1, capability: 'projects.production', actions: ['edit'], role_key: 'x', role_name: null }]);
    const x = await loadExtras(db, tenant, station, 'user_inst', [WO], [JOB]);
    expect(x.visits[WO]).toMatchObject({ gateCode: '#1234', member: true, complaint: 'No heat upstairs', estimates: { open: 1, sold: 0 } });
    expect(x.homes[JOB]).toMatchObject({ lockboxCode: '4471', pets: 'Dog in back room', rrpRequired: true });
    expect(x.drawings[JOB]).toBe(2);
    expect(x.sites[JOB]).toEqual({ deliveries: [{ description: 'Cabinets (12 boxes)', expectedOn: '2026-10-24', status: 'SHIPPED' }], checksOpen: 1, rrpOpen: true });
    expect(x.stations).toEqual([{ companyId: L1, name: 'Heritage Interiors' }]);
    expect(x.features.kiosk).toBe(true);
    expect(x.features.installerPay).toBe(true);
  });

  it('RO lines at my stores, mine first, my open punch; nothing without a time grant', async () => {
    const tables = {
      employees,
      work_orders: [
        { id: 'ro1', number: 'RO-1', summary: 'PDI', status: 'SCHEDULED', job_id: JOB, location_id: L1, kind: 'PDI' },
        { id: 'ro2', number: 'RO-2', summary: 'Stalls', status: 'IN_PROGRESS', job_id: JOB, location_id: L1, kind: 'REPAIR_ORDER' },
      ],
      dispatch_assignments: [{ work_order_id: 'ro2', employee_id: ME, status: 'DISPATCHED' }],
      work_order_lines: [{ id: 'l1', work_order_id: 'ro2', description: 'Diagnose', labor_op: 'D01', flag_hours: '1.5', status: 'APPROVED', kind: 'LABOR' }],
      dlr_tech_punches: [{ location_id: L1, work_order_line_id: 'l1', kind: 'LINE', started_at: '2026-10-24T14:00:00Z', employee_id: ME, ended_at: null }],
    };
    const { db } = fakeDb({ tables });
    const tech = buildAccess([{ location_id: L1, capability: 'projects.time', actions: ['view', 'create'], role_key: 'x', role_name: null }]);
    const r = await loadRo(db, tenant, tech, 'user_inst');
    expect(r.ros[0]).toMatchObject({ id: 'ro2', mine: true });
    expect(r.lines[0]).toMatchObject({ flagHours: 1.5, laborOp: 'D01' });
    expect(r.open).toMatchObject({ lineId: 'l1', kind: 'LINE' });
    expect(JSON.stringify(r)).not.toMatch(/_cents|Cents/);
    expect((await loadRo(db, tenant, buildAccess([]), 'user_inst')).ros).toEqual([]);
  });
});

describe('in-person e-sign', () => {
  it('reads the one-time token out of the signing link', () => {
    expect(tokenFromLink('https://projects.test/sign/abcDEF_ghi-0123456789xyz')).toBe('abcDEF_ghi-0123456789xyz');
    expect(tokenFromLink('https://projects.test/sign/short')).toBeNull();
    expect(tokenFromLink(null)).toBeNull();
  });
});
