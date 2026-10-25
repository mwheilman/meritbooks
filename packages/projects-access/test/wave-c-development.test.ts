/**
 * Wave C real-estate development completion (migration 1124): pursuit pipeline + due diligence
 * (dead deal → Books write-off request; go → key dates), entitlement conditions and incentive
 * agreements, covenants and the key-dates calendar, interest reserve, developer-fee schedule, the
 * lender-consent gate on change orders, vendor compliance, the central invoice inbox with
 * duplicates, the GC pay app review, two-step invoice routing with SoD, draw funding and
 * disbursement tracking, milestones, construction status events, the SPE document room,
 * affiliated GC billing, and the migration / pro forma import with its tie-out.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, q, errorOf, type Fixture, ORG_A, L1, L2, J1, J2, J3 } from './fixture';
import { call, callErr, costCode, documentRow, forbidden, one, vendor } from './industry';
import { setupWaveC } from './wave-c';

let f: Fixture;
const ids: Record<string, string> = {};
const M = 100_000_000;
const K = 10_000_000;

beforeAll(async () => {
  f = await setupWaveC('wave-c-development');
  for (const [k, code, name, t] of [['LAND', '10', 'Land', 'OTHER'], ['HARD', '20', 'Hard cost', 'SUBCONTRACTOR'], ['SOFT', '30', 'Soft cost', 'OTHER']] as const) {
    ids[k] = await costCode(f, code, name, t);
  }
  ids.schedule = (await one<{ id: string }>(f, `insert into pm.draw_schedules (org_id, job_id, lender_name, loan_commitment_cents, retainage_pct, status, activated_at, projected_monthly_interest_cents)
                 values ($1, $2, 'First Bank', $3, 0.10, 'ACTIVE', now(), 4000000) returning id`, [ORG_A, J1, 9 * M])).id;
  for (const [no, desc, cat, amt] of [[1, 'Land', 'LAND', 2 * M], [2, 'Hard costs', 'HARD', 6 * M], [3, 'Interest reserve', 'INTEREST_RESERVE', 50000000]] as const) {
    ids[`line${no}`] = (await one<{ id: string }>(f, `insert into pm.draw_budget_lines (org_id, draw_schedule_id, job_id, line_no, description, category, original_cents) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ORG_A, ids.schedule, J1, no, desc, cat, amt])).id;
  }
  ids.gc = await vendor(f, 'Summit Builders');
  ids.gmp = (await one<{ id: string }>(f, `insert into pm.commitments (org_id, job_id, vendor_id, commitment_type, title, status, approved_at, retainage_pct, number)
               values ($1, $2, $3, 'SUBCONTRACT', 'GMP', 'APPROVED', now(), 0.1, 'SC-100') returning id`, [ORG_A, J1, ids.gc])).id;
  await q(f.db, `insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, amount_cents) values ($1, $2, 1, $3, 'SUBCONTRACTOR', 'Site and shell', $4)`, [ORG_A, ids.gmp, ids.HARD, 7 * M]);
  await q(f.db, `insert into pm.dev_projects (org_id, job_id, stage) values ($1, $2, 'PRE_DEVELOPMENT')`, [ORG_A, J1]);
  await q(f.db, `update pm.contracts set status = 'ACTIVE' where job_id in ($1, $2)`, [J1, J2]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('pursuit pipeline + due diligence (RED-03/04)', () => {
  it('a site moves through the board with its DD checklist and open risks; a dead deal hands Books the write-off', async () => {
    await q(f.db, `insert into pm.job_costs (org_id, job_id, location_id, source_ref, cost_type, amount_cents, lifecycle, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
                   values ($1, $2, $3, 'test:pursuit', 'OTHER', 1850000, 'CLEARED', gen_random_uuid(), now(), 2, now())`, [ORG_A, J2, L1]);
    ids.p1 = await call<string>(f, 'owner', `pm.dev_save_pursuit($1, null, $2::jsonb)`, [L1, JSON.stringify({ name: '5th & Elm', earnest_money_cents: 10000000, earnest_refundable: false,
      dd_expires_on: new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10), earnest_hard_on: new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10),
      pursuit_job_id: J2, pursuit_budget_cents: 1000000 })]);
    expect(await call<number>(f, 'owner', `pm.dev_seed_dd($1)`, [ids.p1])).toBe(8);
    expect(await call<number>(f, 'owner', `pm.dev_seed_dd($1)`, [ids.p1])).toBe(0);
    await call(f, 'owner', `pm.dev_advance_pursuit($1, 'UNDER_CONTRACT')`, [ids.p1]);
    const geo = await one<{ id: string }>(f, `select id from pm.dev_dd_items where pursuit_id = $1 and kind = 'GEOTECH'`, [ids.p1]);
    await call(f, 'owner', `pm.dev_update_dd_item($1, '{"status":"ISSUE","finding":"Shallow rock at 4 ft"}'::jsonb)`, [geo.id]);
    const b = await call<{ pursuits: Array<{ id: string; stage: string; open_risks: string[]; pursuit_spent_cents: number }> }>(f, 'owner', `pm.dev_pursuit_board($1)`, [L1]);
    const p = b.pursuits.find((x) => x.id === ids.p1)!;
    expect(p.stage).toBe('UNDER_CONTRACT');
    expect(p.pursuit_spent_cents).toBe(1850000);
    expect(p.open_risks.join(' | ')).toMatch(/due-diligence issue.*Geotechnical/);
    expect(p.open_risks.join(' | ')).toMatch(/Earnest money goes hard in 5 day/);
    expect(p.open_risks.join(' | ')).toMatch(/over its budget/);
    expect(await callErr(f, 'supervisor', `pm.dev_pursuit_board($1)`, [L1])).toMatch(forbidden);
    const k = await call<{ stage: string; books_request_id: string; pursuit_cost_cents: number }>(f, 'owner', `pm.dev_kill_pursuit($1, 'Rock blew the budget')`, [ids.p1]);
    expect(k).toMatchObject({ stage: 'DEAD', pursuit_cost_cents: 1850000 });
    const r = await one<{ kind: string; payload: { earnest_at_risk: boolean } }>(f, `select kind, payload from pm.wc_books_requests where id = $1`, [k.books_request_id]);
    expect(r).toMatchObject({ kind: 'DEAD_DEAL_WRITE_OFF', payload: { earnest_at_risk: true } });
    expect(await callErr(f, 'owner', `pm.dev_advance_pursuit($1, 'LOI')`, [ids.p1])).toMatch(/closed/);
  });
  it('M6: the pursuit job is at the sponsor company and needs financials:edit on it', async () => {
    expect(await callErr(f, 'owner', `pm.dev_save_pursuit($1, null, $2::jsonb)`, [L1, JSON.stringify({ name: 'Cross-company', pursuit_job_id: J3 })])).toMatch(/must be at this company/);
    // pm holds financials:edit at L1 but is not on J2's team (it has no PM of record)
    expect(await callErr(f, 'pm', `pm.dev_save_pursuit($1, null, $2::jsonb)`, [L1, JSON.stringify({ name: 'Not my job', pursuit_job_id: J2 })])).toMatch(forbidden);
    expect(await callErr(f, 'pm', `pm.dev_save_pursuit($1, null, $2::jsonb)`, [L1, JSON.stringify({ name: 'Own job', pursuit_job_id: J1 })])).toBeNull();
  });
  it('go: the pursuit becomes the development project and its dates become key dates', async () => {
    const p2 = await call<string>(f, 'owner', `pm.dev_save_pursuit($1, null, '{"name":"Riverfront","dd_expires_on":"2027-03-01","closing_on":"2027-04-15"}'::jsonb)`, [L1]);
    const g = await call<{ key_dates_added: number }>(f, 'owner', `pm.dev_go_pursuit($1, $2)`, [p2, J1]);
    expect(g.key_dates_added).toBe(2);
    expect((await one<{ pursuit_id: string; stage: string }>(f, `select pursuit_id, stage from pm.dev_projects where job_id = $1`, [J1])).pursuit_id).toBe(p2);
  });
});

describe('entitlements, covenants, the calendar (RED-05/06)', () => {
  it('conditions of approval and incentive amounts (financials only)', async () => {
    ids.ent = (await one<{ id: string }>(f, `insert into pm.entitlements (org_id, job_id, kind, name, status, hearing_on) values ($1, $2, 'ZONING', 'Rezone to R-4', 'HEARING_SCHEDULED', current_date + 9) returning id`, [ORG_A, J1])).id;
    await call(f, 'pm', `pm.dev_add_entitlement_condition($1, 'Dedicate 10 ft of right-of-way', current_date + 60, 'Civil')`, [ids.ent]);
    await as(f, 'owner', () => q(f.db, `insert into pm.dev_incentives (job_id, kind, name, amount_cents, status) values ($1, 'TIF', 'Downtown TIF', 150000000, 'APPLIED')`, [J1]));
    const o = await call<{ entitlements: Array<{ conditions: unknown[] }>; incentives: Array<{ amount_cents: number | null }>; open_conditions: number }>(f, 'owner', `pm.dev_entitlement_board($1)`, [J1]);
    expect(o.entitlements[0]!.conditions).toHaveLength(1);
    expect(o.incentives[0]!.amount_cents).toBe(150000000);
    const s = await call<{ incentives: Array<{ amount_cents: number | null; name: string }> }>(f, 'supervisor', `pm.dev_entitlement_board($1)`, [J1]);
    expect(s.incentives[0]).toMatchObject({ name: 'Downtown TIF', amount_cents: null });
    // L4: a condition's evidence document must be on the project (or the caller's upload)
    const cond = await one<{ id: string }>(f, `select id from pm.dev_entitlement_conditions where entitlement_id = $1`, [ids.ent]);
    const stray = await documentRow(f, 'stray.pdf');
    expect(await callErr(f, 'pm', `pm.dev_set_condition_status($1, 'MET', $2)`, [cond.id, stray])).toMatch(/not on this job/);
  });
  it('a covenant test that fails is a breach and rolls the next date; the calendar merges every source by who can see it', async () => {
    ids.cov = await call<string>(f, 'owner', `pm.dev_save_covenant($1, null, '{"kind":"DSCR","name":"DSCR at least 1.25","frequency":"QUARTERLY","comparator":">=","threshold":1.25}'::jsonb)`, [J1]);
    await q(f.db, `update pm.dev_covenants set next_due_on = current_date + 10 where id = $1`, [ids.cov]);
    const t = await call<{ passed: boolean; next_due_on: string }>(f, 'owner', `pm.dev_test_covenant($1, 1.1)`, [ids.cov]);
    expect(t.passed).toBe(false);
    expect((await one<{ status: string }>(f, `select status from pm.dev_covenants where id = $1`, [ids.cov])).status).toBe('BREACH');
    await q(f.db, `update pm.dev_covenants set next_due_on = current_date + 10 where id = $1`, [ids.cov]);
    const c = await call<{ items: Array<{ source: string; label: string; in_window: boolean }> }>(f, 'owner', `pm.dev_calendar($1, current_date - 7, current_date + 400)`, [L1]);
    const sources = new Set(c.items.map((x) => x.source));
    for (const s of ['KEY_DATE', 'COVENANT', 'ENTITLEMENT', 'CONDITION']) expect(sources.has(s), s).toBe(true);
    const sup = await call<{ items: Array<{ source: string }> }>(f, 'supervisor', `pm.dev_calendar($1, current_date - 7, current_date + 400)`, [L1]);
    expect(sup.items.some((x) => x.source === 'COVENANT')).toBe(false);
    expect(sup.items.some((x) => x.source === 'ENTITLEMENT')).toBe(true);
    const n = await call<number>(f, 'owner', `pm.dev_send_date_reminders($1)`, [L1]);
    expect(n).toBeGreaterThan(0);
    // L7: the title everyone sees is neutral; the covenant / loan label rides the money-gated text
    const nt = await q<{ title: string; money_masked: boolean }>(f.db, `select title, money_masked from core.notifications where event_type = 'development.key_date_due'`);
    expect(nt.length).toBeGreaterThan(0);
    expect(nt.filter((x) => x.money_masked).every((x) => /a development date/.test(x.title) && !/DSCR/.test(x.title))).toBe(true);
    expect(nt.filter((x) => /DSCR/.test(x.title)).every((x) => !x.money_masked)).toBe(true);
  });
});

describe('interest reserve, fees, change-order consent, compliance (RED-15/16/19/20)', () => {
  it('reserve remaining vs burn, capitalized interest by month', async () => {
    await call(f, 'owner', `pm.dev_record_interest($1, date_trunc('month', current_date)::date, 3800000, 'LENDER_STATEMENT')`, [J1]);
    await call(f, 'owner', `pm.dev_record_interest($1, date_trunc('month', current_date)::date, 4100000, 'ESTIMATE')`, [J1]);
    const r = await call<{ reserve_cents: number; remaining_cents: number; runway_months: number; capitalized_total_cents: number; capitalized_by_month: Array<{ source: string }> }>(f, 'pm', `pm.dev_interest_reserve($1)`, [J1]);
    expect(r).toMatchObject({ reserve_cents: 50000000, remaining_cents: 50000000, capitalized_total_cents: 3800000 });
    expect(Number(r.runway_months)).toBe(12.5);
    expect(r.capitalized_by_month[0]!.source).toBe('LENDER_STATEMENT');
    expect(await callErr(f, 'supervisor', `pm.dev_interest_reserve($1)`, [J1])).toMatch(forbidden);
  });
  it('a fee draws only what is earned; the sponsor invoice is handed to Books', async () => {
    ids.fee = await call<string>(f, 'owner', `pm.dev_set_fee_schedule($1, 'DEVELOPER_FEE', 30000000, 'MILESTONE', '[{"label":"Closing","pct":0.25,"earned_on":"2026-01-01"},{"label":"TCO","pct":0.75,"earned_on":"2030-01-01"}]'::jsonb, null, $2)`, [J1, L1]);
    const pos = await call<{ fees: Array<{ earned_cents: number; available_cents: number }> }>(f, 'owner', `pm.dev_fee_position($1)`, [J1]);
    expect(pos.fees[0]).toMatchObject({ earned_cents: 7500000, available_cents: 7500000 });
    expect(await callErr(f, 'owner', `pm.dev_request_fee_draw($1, 8000000)`, [ids.fee])).toMatch(/PM_DEV_FEE_NOT_EARNED/);
    const d = await call<{ books_request_id: string }>(f, 'owner', `pm.dev_request_fee_draw($1, 5000000)`, [ids.fee]);
    expect((await one<{ kind: string }>(f, `select kind from pm.wc_books_requests where id = $1`, [d.books_request_id])).kind).toBe('INTERCOMPANY_FEE_INVOICE');
    const pos2 = await call<{ fees: Array<{ available_cents: number }> }>(f, 'owner', `pm.dev_fee_position($1)`, [J1]);
    expect(pos2.fees[0]!.available_cents).toBe(2500000);
  });
  it('a change order over the lender threshold cannot be approved before consent', async () => {
    await q(f.db, `update pm.dev_projects set lender_consent_threshold_cents = 5000000 where job_id = $1`, [J1]);
    const co = await one<{ id: string }>(f, `insert into pm.change_orders (org_id, job_id, number, title, stage, amount_cents, cost_impact_cents) values ($1, $2, 'PCO-7', 'Rock removal', 'PCO', 0, 9000000) returning id`, [ORG_A, J1]);
    const r = await call<{ lender_consent_required: boolean }>(f, 'pm', `pm.dev_set_co_funding($1, 'CONTINGENCY', 'HARD')`, [co.id]);
    expect(r.lender_consent_required).toBe(true);
    expect(await errorOf(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co.id])).toMatch(/PM_DEV_LENDER_CONSENT_REQUIRED/);
    expect(await callErr(f, 'pm', `pm.dev_record_co_consent($1, '  ')`, [co.id])).toMatch(/record who/);
    await call(f, 'pm', `pm.dev_record_co_consent($1, 'First Bank, J. Ruiz, email 10/25')`, [co.id]);
    expect(await errorOf(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co.id]) ?? '').not.toMatch(/LENDER_CONSENT/);
  });
  it('M4: the gate reads the CO amount with no funding line; the person who typed the consent does not approve on it', async () => {
    const co = await one<{ id: string }>(f, `insert into pm.change_orders (org_id, job_id, number, title, stage, amount_cents, cost_impact_cents) values ($1, $2, 'PCO-8', 'Steel price', 'PCO', 0, 8000000) returning id`, [ORG_A, J1]);
    expect(await errorOf(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co.id])).toMatch(/PM_DEV_LENDER_CONSENT_REQUIRED/);
    await call(f, 'pm', `pm.dev_record_co_consent($1, 'First Bank, J. Ruiz, phone 10/26')`, [co.id]);
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co.id]))).toMatch(/PM_SOD_VIOLATION|row-level security|permission denied/);
    // with the lender's letter attached the same person may approve
    const letter = await documentRow(f, 'consent.pdf');
    await q(f.db, `update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.pm, letter]);
    await call(f, 'pm', `pm.dev_record_co_consent($1, 'First Bank letter', $2)`, [co.id, letter]);
    expect((await one<{ lender_consent_document_id: string }>(f, `select lender_consent_document_id from pm.dev_co_funding where change_order_id = $1`, [co.id])).lender_consent_document_id).toBe(letter);
    // round 2: consent covers the amount it was given for; the CO growing needs consent again
    expect(Number((await one<{ c: string }>(f, `select consented_amount_cents as c from pm.dev_co_funding where change_order_id = $1`, [co.id])).c)).toBe(8000000);
    await q(f.db, `update pm.change_orders set cost_impact_cents = 9500000 where id = $1`, [co.id]);
    expect(await errorOf(f.db, `update pm.change_orders set stage = 'APPROVED' where id = $1`, [co.id])).toMatch(/grew past the amount/);
  });
  it('vendors with lapsed or missing COI / W-9 are on hold', async () => {
    const c = await call<{ vendors: Array<{ vendor: string; hold: boolean }>; on_hold: number }>(f, 'pm', `pm.dev_compliance($1)`, [J1]);
    expect(c.vendors.find((v) => v.vendor === 'Summit Builders')!.hold).toBe(true);
    await q(f.db, `insert into pm.compliance_docs (org_id, job_id, vendor_id, doc_type, status, expires_on) values ($1, $2, $3, 'COI', 'RECEIVED', current_date + 200), ($1, $2, $3, 'W9', 'RECEIVED', null)`, [ORG_A, J1, ids.gc]);
    const c2 = await call<{ vendors: Array<{ vendor: string; hold: boolean }> }>(f, 'pm', `pm.dev_compliance($1)`, [J1]);
    expect(c2.vendors.find((v) => v.vendor === 'Summit Builders')!.hold).toBe(false);
  });
});

describe('invoice inbox, pay app review, approval routing (RED-21/22/23)', () => {
  it('the inbox suggests the job / commitment / open draw and flags a duplicate; a person confirms into the draw', async () => {
    ids.draw = await call<string>(f, 'owner', `pm.create_draw($1, current_date)`, [ids.schedule]);
    const a = await call<{ id: string; suggested: { job_id: string; commitment_id: string; draw_id: string } }>(f, 'owner', `pm.dev_inbox_ingest($1, $2::jsonb)`, [L1,
      JSON.stringify({ vendor_name: 'Summit Builders', invoice_number: 'PA-04', amount_cents: 3 * K, invoice_on: '2026-10-20', subject: 'Pay app 4 SC-100' })]);
    expect(a.suggested).toMatchObject({ job_id: J1, commitment_id: ids.gmp, draw_id: ids.draw });
    const dup = await call<{ id: string; duplicate_of: string | null }>(f, 'owner', `pm.dev_inbox_ingest($1, '{"vendor_name":"Summit Builders","invoice_number":"PA-04","amount_cents":30000000}'::jsonb)`, [L1]);
    expect(dup.duplicate_of).toBe(a.id);
    const c = await call<{ draw_invoice_id: string }>(f, 'owner', `pm.dev_inbox_confirm($1, $2)`, [a.id, ids.draw]);
    ids.inv = c.draw_invoice_id;
    expect(await callErr(f, 'owner', `pm.dev_inbox_confirm($1, $2)`, [dup.id, ids.draw])).toMatch(/PM_DEV_DUPLICATE_INVOICE/);
    await call(f, 'owner', `pm.dev_inbox_dismiss($1)`, [dup.id]);
    expect(await callErr(f, 'supervisor', `pm.dev_inbox_ingest($1, '{}'::jsonb)`, [L1])).toMatch(forbidden);
  });
  it('the G702 / G703 check: a clean application, then over-billing, wrong retainage, a stray line, duplicates and the inspector', async () => {
    const clean = await call<{ clean: boolean; issues: unknown[]; pct_complete: number }>(f, 'pm', `pm.dev_review_pay_app($1, 1, $2::jsonb)`, [ids.gmp,
      JSON.stringify([{ line_no: 1, description: 'Site and shell', scheduled_value_cents: 7 * M, previous_cents: 0, this_period_cents: 2 * M, stored_cents: 0, retainage_cents: 20000000 }])]);
    expect(clean.clean).toBe(true);
    await q(f.db, `update pm.draws set inspector_pct_complete = 0.4 where id = $1`, [ids.draw]);
    const bad = await call<{ clean: boolean; issues: Array<{ check: string }> }>(f, 'pm', `pm.dev_review_pay_app($1, 2, $2::jsonb)`, [ids.gmp, JSON.stringify([
      { line_no: 1, description: 'Site and shell', scheduled_value_cents: 7 * M, previous_cents: 2 * M, this_period_cents: 6 * M, stored_cents: 0, retainage_cents: 100 },
      { line_no: 9, description: 'Extra', scheduled_value_cents: 100, previous_cents: 0, this_period_cents: 100, retainage_cents: 0 },
      { line_no: 9, description: 'Extra', scheduled_value_cents: 100, previous_cents: 0, this_period_cents: 100, retainage_cents: 0 }])]);
    expect(bad.clean).toBe(false);
    expect(new Set(bad.issues.map((i) => i.check))).toEqual(new Set(['OVER_BILLED', 'RETAINAGE', 'NOT_ON_SOV', 'DUPLICATE', 'INSPECTOR']));
    expect(await callErr(f, 'supervisor', `pm.dev_review_pay_app($1, 3, '[{"line_no":1}]'::jsonb)`, [ids.gmp])).toMatch(forbidden);
    // L6: a viewer (financials view only) gets the check but no saved review
    const before = (await one<{ n: number }>(f, `select count(*)::int n from pm.dev_pay_app_reviews where commitment_id = $1`, [ids.gmp])).n;
    const v = await call<{ review_id: string | null; saved: boolean }>(f, 'accountant', `pm.dev_review_pay_app($1, 3, '[{"line_no":1,"scheduled_value_cents":1}]'::jsonb)`, [ids.gmp]);
    expect(v).toMatchObject({ review_id: null, saved: false });
    expect((await one<{ n: number }>(f, `select count(*)::int n from pm.dev_pay_app_reviews where commitment_id = $1`, [ids.gmp])).n).toBe(before);
  });
  it('$30,000 routes dev manager → principal; the preparer, a repeat approver and the wrong role are refused', async () => {
    const r = await call<{ steps: string[] }>(f, 'accountant', `pm.dev_route_invoice($1)`, [ids.inv]);
    expect(r.steps).toEqual(['DEV_MANAGER', 'PRINCIPAL']);
    expect(await callErr(f, 'owner', `pm.dev_decide_invoice_step($1, true)`, [ids.inv])).toMatch(/PM_SOD_VIOLATION/);
    const s1 = await call<{ steps_left: number; status: string }>(f, 'accountant', `pm.dev_decide_invoice_step($1, true, 'ok', 'mobile')`, [ids.inv]);
    expect(s1).toMatchObject({ steps_left: 1, status: 'PENDING' });
    expect(await callErr(f, 'accountant', `pm.dev_decide_invoice_step($1, true)`, [ids.inv])).toMatch(/PM_FORBIDDEN|PM_SOD_VIOLATION/);
    const s2 = await call<{ steps_left: number; status: string }>(f, 'gm', `pm.dev_decide_invoice_step($1, true)`, [ids.inv]);
    expect(s2).toMatchObject({ steps_left: 0, status: 'APPROVED' });
    const steps = await q<{ channel: string; decided_by: string }>(f.db, `select channel, decided_by from pm.dev_invoice_approvals where invoice_id = $1 order by step_no`, [ids.inv]);
    expect(steps.map((x) => x.channel)).toEqual(['mobile', 'web']);
  });
  it('round 2: the 1122 direct decision cannot skip the chain; every chain has the dev manager', async () => {
    const inv = await call<string>(f, 'pm', `pm.dev_add_draw_invoice($1, $2, 'INV-CHAIN', 500000, current_date, null, $3)`, [ids.draw, ids.gc, ids.SOFT]);
    expect(await callErr(f, 'gm', `pm.dev_decide_draw_invoice($1, true)`, [inv])).toMatch(/PM_DEV_INVOICE_CHAIN/);
    // excluding stays direct
    expect(await callErr(f, 'gm', `pm.dev_decide_draw_invoice($1, false)`, [inv])).toBeNull();
    expect(await errorOf(f.db, `insert into pm.dev_invoice_routes (org_id, location_id, min_cents, steps) values ($1, $2, 0, '{PRINCIPAL}')`, [ORG_A, L1])).toMatch(/dev_manager_chk/);
    // the preparer falls back to whoever confirmed it from the inbox
    const inv2 = await call<string>(f, 'pm', `pm.dev_add_draw_invoice($1, $2, 'INV-INBOX', 400000, current_date, null, $3)`, [ids.draw, ids.gc, ids.SOFT]);
    await q(f.db, `update pm.dev_draw_invoices set created_by = null where id = $1`, [inv2]);
    await q(f.db, `insert into pm.dev_invoice_inbox (org_id, location_id, vendor_name, invoice_number, amount_cents, status, draw_invoice_id, decided_by, decided_at)
                   values ($1, $2, 'Summit Builders', 'INV-INBOX', 400000, 'CONFIRMED', $3, $4, now())`, [ORG_A, L1, inv2, f.clerk.gm]);
    expect(await callErr(f, 'gm', `pm.dev_decide_invoice_step($1, true)`, [inv2])).toMatch(/PM_SOD_VIOLATION/);
  });
});

describe('migration import + funding tracking (RED-08/29/44)', () => {
  it('a pro forma maps to cost codes, lender lines and CIP only after a person confirms the map', async () => {
    const st = await call<{ import_id: string; mapping: Array<{ cost_code_id: string | null; draw_budget_line_id: string | null; category: string }> }>(f, 'owner',
      `pm.dev_stage_import($1, 'PRO_FORMA', 'model.csv', $2::jsonb)`, [J1, JSON.stringify([{ name: 'Hard cost', code: '20', category: 'HARD', amount_cents: 6 * M }, { name: 'Land', category: 'LAND', amount_cents: 2 * M }])]);
    expect(st.mapping.map((m) => [m.cost_code_id, m.draw_budget_line_id])).toEqual([[ids.HARD, ids.line2], [ids.LAND, ids.line1]]);
    expect(await callErr(f, 'owner', `pm.dev_apply_import($1)`, [st.import_id])).toMatch(/PM_DEV_IMPORT_UNCONFIRMED/);
    await call(f, 'owner', `pm.dev_set_import_map($1, $2::jsonb)`, [st.import_id, JSON.stringify(st.mapping)]);
    const ap = await call<{ applied: number; tieout: { projects_cost_cents: number } }>(f, 'owner', `pm.dev_apply_import($1)`, [st.import_id]);
    expect(ap.applied).toBe(2);
    expect(ap.tieout).toHaveProperty('projects_cost_cents');
    const m = await one<{ cip_account_ref: string; draw_budget_line_id: string }>(f, `select cip_account_ref, draw_budget_line_id from pm.dev_budget_lines where job_id = $1 and cost_code_id = $2`, [J1, ids.HARD]);
    expect(m).toEqual({ cip_account_ref: '1500-HARD', draw_budget_line_id: ids.line2 });
  });
  it('prior draws and waiver status import; funding per source and disbursements give cycle days and first-pass', async () => {
    await q(f.db, `delete from pm.draws where id = $1`, [ids.draw]).catch(() => undefined);
    await q(f.db, `delete from pm.dev_draw_invoices where draw_id = $1`, [ids.draw]);
    await q(f.db, `delete from pm.draws where id = $1`, [ids.draw]);
    const d = await call<{ import_id: string }>(f, 'owner', `pm.dev_stage_import($1, 'DRAWS', 'draws.csv', '[{"draw_number":1,"period_end":"2026-06-30","approved_cents":40000000,"funded_cents":40000000,"funded_on":"2026-07-12","lines":[{"line_no":1,"approved_cents":40000000}]}]'::jsonb)`, [J1]);
    expect((await call<{ applied: number }>(f, 'owner', `pm.dev_apply_import($1)`, [d.import_id])).applied).toBe(1);
    const w = await call<{ import_id: string }>(f, 'owner', `pm.dev_stage_import($1, 'WAIVERS', 'w.csv', '[{"vendor_name":"Summit Builders","doc_type":"LIEN_WAIVER_UNCONDITIONAL","status":"RECEIVED","covers_through":"2026-06-30"}]'::jsonb)`, [J1]);
    expect((await call<{ applied: number }>(f, 'owner', `pm.dev_apply_import($1)`, [w.import_id])).applied).toBe(1);
    const dr = await one<{ id: string; status: string }>(f, `select id, status from pm.draws where draw_schedule_id = $1 and draw_number = 1`, [ids.schedule]);
    expect(dr.status).toBe('FUNDED');
    const src = await as(f, 'owner', () => q<{ id: string }>(f.db, `insert into pm.dev_sources (job_id, kind, name, commitment_cents, rank, funding_rule) values ($1, 'SENIOR_LOAN', 'First Bank', $2, 1, 'SEQUENCED') returning id`, [J1, 9 * M]));
    expect(await callErr(f, 'owner', `pm.dev_record_funding($1, $2, 40000000, 39500000)`, [dr.id, src[0]!.id])).toMatch(/say why/);
    await call(f, 'owner', `pm.dev_record_funding($1, $2, 40000000, 39500000, '2026-07-12', '2026-07-10', 'Lender held back title fee')`, [dr.id, src[0]!.id]);
    await call(f, 'owner', `pm.dev_record_disbursement($1, $2, 39500000, 'DIRECT_VIA_TITLE', '2026-07-13', 'Title #88')`, [dr.id, ids.gc]);
    const t = await call<{ draws: Array<{ disbursed_cents: number; direct_via_title_cents: number; cycle_days: number; first_pass: boolean; by_source: unknown[] }>; first_pass_rate: number }>(f, 'pm', `pm.dev_draw_tracking($1)`, [J1]);
    expect(t.draws[0]).toMatchObject({ disbursed_cents: 39500000, direct_via_title_cents: 39500000, cycle_days: 12, first_pass: true });
    expect(t.draws[0]!.by_source).toHaveLength(1);
  });
});

describe('milestones, status events, the document room, affiliated GC billing (RED-30/31/41/42)', () => {
  it('milestones seed once; status events run in order and stop capitalized interest at substantial completion', async () => {
    expect(await call<number>(f, 'pm', `pm.dev_seed_milestones($1)`, [J1])).toBe(10);
    expect(await call<number>(f, 'pm', `pm.dev_seed_milestones($1)`, [J1])).toBe(0);
    expect(await callErr(f, 'pm', `pm.dev_record_status_event($1, 'RESUME', current_date)`, [J1])).toMatch(/cannot follow/);
    await call(f, 'pm', `pm.dev_record_status_event($1, 'START', '2026-08-01')`, [J1]);
    await call(f, 'pm', `pm.dev_record_status_event($1, 'SUBSTANTIAL_COMPLETION', '2026-10-01')`, [J1]);
    const d = await one<{ stage: string; construction_status: string; cap_interest_start_on: string; cap_interest_stop_on: string }>(f,
      `select stage, construction_status, cap_interest_start_on::text, cap_interest_stop_on::text from pm.dev_projects where job_id = $1`, [J1]);
    expect(d).toEqual({ stage: 'SUBSTANTIAL_COMPLETION', construction_status: 'SUBSTANTIALLY_COMPLETE', cap_interest_start_on: '2026-08-01', cap_interest_stop_on: '2026-10-01' });
    expect(await callErr(f, 'labor', `pm.dev_record_status_event($1, 'FINAL_COMPLETION', current_date)`, [J1])).toMatch(forbidden);
  });
  it('the SPE document room has its folders; sharing a folder counts what each file allowed', async () => {
    expect(await call<number>(f, 'pm', `pm.dev_seed_doc_room($1)`, [J1])).toBe(10);
    expect(await call<number>(f, 'pm', `pm.dev_seed_doc_room($1)`, [J1])).toBe(0);
    const fo = await one<{ id: string; money_cap: string | null }>(f, `select id, money_cap from pm.doc_folders where job_id = $1 and key = 'loan_docs'`, [J1]);
    expect(fo.money_cap).toBe('projects.financials');
    const s = await call<{ shared: number }>(f, 'pm', `pm.dev_share_folder($1, '{lender}')`, [fo.id]);
    expect(s.shared).toBe(0);
  });
  it('one approval: the affiliated GC\'s billing request and the SPE\'s payable', async () => {
    const spe = await one<{ id: string }>(f, `insert into core.customers (org_id, name) values ($1, 'Elm Street SPE LLC') returning id`, [ORG_A]);
    await q(f.db, `update core.jobs set customer_id = $2 where id = $1`, [J2, spe.id]);
    const b = await call<{ affiliate_bill_id: string; billing_request_id: string }>(f, 'owner', `pm.dev_affiliate_bill($1, $2, 2000000, 'September work')`, [J1, J2]);
    expect((await one<{ status: string; job_id: string }>(f, `select status, job_id from pm.billing_requests where id = $1`, [b.billing_request_id]))).toEqual({ status: 'DRAFT', job_id: J2 });
    const a = await call<{ status: string; books_request_id?: string }>(f, 'gm', `pm.dev_approve_affiliate_bill($1)`, [b.affiliate_bill_id]);
    expect(['approved', 'submitted', 'pending']).toContain(a.status);
    if (a.status === 'approved') {
      expect((await one<{ kind: string }>(f, `select kind from pm.wc_books_requests where id = $1`, [a.books_request_id])).kind).toBe('AFFILIATE_PAYABLE');
      expect((await one<{ status: string }>(f, `select status from pm.billing_requests where id = $1`, [b.billing_request_id])).status).not.toBe('DRAFT');
    }
    expect(await callErr(f, 'supervisor', `pm.dev_affiliate_bill($1, $2, 100)`, [J1, J2])).toMatch(forbidden);
  });
  it('H1: with no approval chain, approving needs billing approve + post on the GC job, and the preparer does not approve', async () => {
    await q(f.db, `delete from pm.approval_settings where location_id = $1`, [L1]);
    await q(f.db, `insert into pm.job_members (org_id, job_id, membership_id, slot) values ($1, $2, $4, 'pm'), ($1, $3, $4, 'pm') on conflict do nothing`, [ORG_A, J1, J2, f.membership.pm]);
    const b = await call<{ affiliate_bill_id: string; billing_request_id: string }>(f, 'owner', `pm.dev_affiliate_bill($1, $2, 100000, 'October work')`, [J1, J2]);
    expect(await callErr(f, 'pm', `pm.dev_approve_affiliate_bill($1)`, [b.affiliate_bill_id])).toMatch(/billing:approve and post/);
    expect(await callErr(f, 'owner', `pm.dev_approve_affiliate_bill($1)`, [b.affiliate_bill_id])).toMatch(/PM_SOD_VIOLATION/);
    const ok = await call<{ status: string }>(f, 'gm', `pm.dev_approve_affiliate_bill($1)`, [b.affiliate_bill_id]);
    expect(ok.status).toBe('approved');
  });
  it('H2: the tie-out reads only CIP asset accounts for an entity the caller sees; no error text; the SPE entity is one of the caller\'s companies', async () => {
    await q(f.db, `update pm.dev_budget_lines set cip_account_ref = '1000-CASH' where job_id = $1`, [J1]);
    const t = await call<Record<string, unknown>>(f, 'owner', `pm.dev_tieout($1)`, [J1]);
    expect(JSON.stringify(t)).not.toMatch(/relation|column|does not exist|ERROR/i);
    if (t.available === true) expect(t.ignored_refs).toEqual(expect.arrayContaining(['1000-CASH']));
    else expect(['books_not_connected', 'books_read_failed']).toContain(t.reason);
    // pm is a member at L1 only: pointing the SPE at L2 is refused
    expect(await callErr(f, 'pm', `pm.dev_set_project($1, $2::jsonb)`, [J1, JSON.stringify({ spe_location_id: L2 })])).toMatch(/one of your companies|PM_FORBIDDEN/);
    expect(await callErr(f, 'supervisor', `pm.dev_tieout($1)`, [J1])).toMatch(forbidden);
  });
});
