/**
 * Real-estate development depth (migration 1122): the SPE request to Books, the deterministic pro
 * forma (SQL ≡ lib/development/returns.ts), the seven-column budget mapped to lender lines and CIP,
 * contingency reallocations through a REVISED budget with lender consent, the in-balance test and
 * its draw-submission block, the draw builder in the lender's read order with the pre-submission
 * check and lien waivers, the cross-project overview, and the investor view read from Books only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, errorOf, q, type Fixture, ORG_A, L1, J1 } from './fixture';
import { call, callErr, costCode, documentRow, forbidden, one, registryClean, setupIndustry, vendor } from './industry';
import { computeProForma } from '../../../apps/projects/src/lib/development/returns';

let f: Fixture;
const ids: Record<string, string> = {};
const M = 100_000_000; // $1,000,000 in cents
const K = 10_000_000; // $100,000 in cents (keeps fractional millions integral)

async function jobCost(code: string, cents: number): Promise<void> {
  await q(f.db, `insert into pm.job_costs (org_id, job_id, location_id, source_ref, cost_type, amount_cents, lifecycle, cost_code_id, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
                 values ($1, $2, $3, $4, 'SUBCONTRACTOR', $5, 'CLEARED', $6, gen_random_uuid(), now(), 2, now())`, [ORG_A, J1, L1, `test:${code}:${cents}`, cents, ids[code]]);
}

beforeAll(async () => {
  f = await setupIndustry('development-depth');
  for (const [k, code, name, t] of [['LAND', '10', 'Land', 'OTHER'], ['HARD', '20', 'Hard cost', 'SUBCONTRACTOR'], ['SOFT', '30', 'Soft cost', 'OTHER'], ['CONT', '40', 'Hard contingency', 'OTHER']] as const) {
    ids[k] = await costCode(f, code, name, t);
  }
  const bud = await one<{ id: string }>(f, `select id from pm.budgets where job_id = $1 and kind = 'ORIGINAL'`, [J1]);
  await q(f.db, `delete from pm.budget_lines where budget_id = $1`, [bud.id]);
  for (const [k, amt] of [['LAND', 2 * M], ['HARD', 8 * M], ['SOFT', 1 * M], ['CONT', M / 2]] as const) {
    await q(f.db, `insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values ($1, $2, $3, $4)`, [ORG_A, bud.id, ids[k], amt]);
  }
  await q(f.db, `update pm.budgets set status = 'APPROVED' where id = $1`, [bud.id]);
  ids.schedule = (await one<{ id: string }>(f, `insert into pm.draw_schedules (org_id, job_id, lender_name, loan_number, loan_commitment_cents, equity_required_cents, retainage_pct, status, activated_at)
                 values ($1, $2, 'First Bank', 'L-55', $3, $4, 0.10, 'ACTIVE', now()) returning id`, [ORG_A, J1, 9 * M, 35 * K])).id;
  for (const [no, desc, cat, amt] of [[1, 'Land', 'LAND', 2 * M], [2, 'Hard costs incl. contingency', 'HARD', 85 * K], [3, 'Soft costs', 'SOFT', 1 * M]] as const) {
    ids[`line${no}`] = (await one<{ id: string }>(f, `insert into pm.draw_budget_lines (org_id, draw_schedule_id, job_id, line_no, description, category, original_cents) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ORG_A, ids.schedule, J1, no, desc, cat, amt])).id;
  }
  ids.gc = await vendor(f, 'Summit Builders');
  ids.arch = await vendor(f, 'Studio Arch');
  const c = await one<{ id: string }>(f, `insert into pm.commitments (org_id, job_id, vendor_id, commitment_type, title, status, approved_at, retainage_pct) values ($1, $2, $3, 'SUBCONTRACT', 'GMP', 'APPROVED', now(), 0.1) returning id`, [ORG_A, J1, ids.gc]);
  ids.gmp = c.id;
  await q(f.db, `insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, amount_cents) values ($1, $2, 1, $3, 'SUBCONTRACTOR', 'GMP', $4)`, [ORG_A, c.id, ids.HARD, 7 * M]);
  await jobCost('LAND', 2 * M);
  await jobCost('HARD', 2 * M);
  await q(f.db, `insert into pm.change_orders (org_id, job_id, number, title, stage, amount_cents, cost_impact_cents, ext) values ($1, $2, 'PCO-1', 'Rock excavation', 'PCO', 0, $3, jsonb_build_object('cost_code_id', $4::text))`,
    [ORG_A, J1, 3 * K, ids.HARD]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('SPE = project = Books company (RED-01/02)', () => {
  it('the wizard files one documented request to Books; only Books (service) answers it', async () => {
    await call(f, 'pm', `pm.dev_set_project($1, '{"stage":"CONSTRUCTION","product_type":"FOR_RENT","contract_type":"GMP"}'::jsonb)`, [J1]);
    ids.spe = await call<string>(f, 'pm', `pm.dev_request_spe($1, '{"entity_name":"Elm Street SPE LLC","state_of_formation":"IA"}'::jsonb)`, [J1]);
    const r = await one<{ payload: { request: string; intercompany: { kind: string }; coa_template: string } }>(f, `select payload from pm.dev_spe_requests where id = $1`, [ids.spe]);
    expect(r.payload).toMatchObject({ request: 'PROVISION_SPE_ENTITY', coa_template: 'REAL_ESTATE_DEVELOPMENT', intercompany: { kind: 'SPONSOR_SPE' } });
    expect(await callErr(f, 'pm', `pm.dev_request_spe($1, '{"entity_name":"Again LLC"}'::jsonb)`, [J1])).toMatch(/PM_DUPLICATE/);
    expect(await callErr(f, 'pm', `pm.dev_mark_spe_provisioned($1, $2)`, [ids.spe, L1])).toMatch(/permission denied/);
    await q(f.db, `select pm.dev_mark_spe_provisioned($1, $2, 'Formed 2026-10-25')`, [ids.spe, L1]);
    const p = await one<{ spe_location_id: string; spe_request_status: string }>(f, `select spe_location_id, spe_request_status from pm.dev_projects where job_id = $1`, [J1]);
    expect(p).toEqual({ spe_location_id: L1, spe_request_status: 'PROVISIONED' });
  });
});

describe('pro forma: deterministic returns (RED-07)', () => {
  const inputs = { total_cost_cents: 1250 * M / 100, loan_cents: 9 * M, interest_rate: 0.07, noi_annual_cents: 0.875 * M, equity_cash_flows_cents: [-35 * K, 0, 0, 0, 0, 7 * M], periods_per_year: 1 };
  it('yield on cost, LTC, DSCR, equity multiple and IRR — SQL and the browser agree', async () => {
    const r = await call<{ pro_forma_id: string; results: Record<string, number> }>(f, 'pm', `pm.dev_save_pro_forma($1, 'Underwritten', 'UNDERWRITTEN', $2::jsonb)`, [J1, JSON.stringify(inputs)]);
    ids.pf = r.pro_forma_id;
    const res = r.results;
    expect(Number(res.yield_on_cost)).toBe(0.07);
    expect(Number(res.ltc)).toBe(0.72);
    expect(Number(res.dscr)).toBe(1.389);
    expect(Number(res.equity_multiple)).toBe(2);
    expect(Number(res.irr_period)).toBeCloseTo(0.148698, 5);
    const ts = computeProForma({ totalCostCents: inputs.total_cost_cents, loanCents: inputs.loan_cents, interestRate: 0.07, noiAnnualCents: inputs.noi_annual_cents, equityCashFlowsCents: inputs.equity_cash_flows_cents });
    expect(ts.irrPeriod).toBeCloseTo(Number(res.irr_period), 6);
    expect([ts.dscr, ts.ltc, ts.yieldOnCost, ts.equityMultiple]).toEqual([1.389, 0.72, 0.07, 2]);
  });
  it('a locked version does not change', async () => {
    await call(f, 'pm', `pm.dev_lock_pro_forma($1)`, [ids.pf]);
    expect(await callErr(f, 'pm', `pm.dev_save_pro_forma($1, 'x', 'CURRENT', $2::jsonb, $3)`, [J1, JSON.stringify(inputs), ids.pf])).toMatch(/PM_DEV_LOCKED/);
    expect(await callErr(f, 'supervisor', `pm.dev_save_pro_forma($1, 'x', 'CURRENT', '{}'::jsonb)`, [J1])).toMatch(forbidden);
  });
});

describe('budget columns + lender / CIP mapping (RED-11/12, make-or-break 3)', () => {
  it('original, revised, committed, pending CO, ECAC, paid, drawn, remaining to fund, variance per line', async () => {
    for (const [k, line, cat, pool] of [['LAND', 'line1', 'LAND', null], ['HARD', 'line2', 'HARD', null], ['CONT', 'line2', 'CONTINGENCY', 'HARD'], ['SOFT', 'line3', 'SOFT', null]] as const) {
      await call(f, 'pm', `pm.dev_map_budget_line($1, $2, $3, $4, $5, $6)`, [J1, ids[k], cat, pool, ids[line], `1500-${k}`]);
    }
    const g = await call<{ rows: Array<Record<string, number | string>>; totals: Record<string, number>; unmapped_lines: number }>(f, 'pm', `pm.dev_budget_grid($1)`, [J1]);
    const hard = g.rows.find((r) => r.code === '20')!;
    expect(hard).toMatchObject({ original_cents: 8 * M, revised_cents: 8 * M, committed_cents: 7 * M, pending_co_cents: 3 * K, ecac_cents: 93 * K, paid_cents: 2 * M,
                                 variance_cents: -13 * K, lender_line_no: 2, cip_account_ref: '1500-HARD' });
    expect(g.totals).toMatchObject({ ecac_cents: 128 * K, paid_cents: 4 * M });
    expect(g.unmapped_lines).toBe(0);
    expect(await callErr(f, 'supervisor', `pm.dev_budget_grid($1)`, [J1])).toMatch(forbidden);
  });
});

describe('in-balance test + the draw block (RED-14, make-or-break 7)', () => {
  it('remaining sources vs cost to complete; out of balance blocks submitting a draw', async () => {
    await as(f, 'pm', async () => {
      await q(f.db, `insert into pm.dev_sources (job_id, kind, name, commitment_cents, rank, funding_rule, draw_schedule_id) values ($1, 'SENIOR_LOAN', 'First Bank construction loan', $2, 2, 'SEQUENCED', $3)`, [J1, 9 * M, ids.schedule]);
      await q(f.db, `insert into pm.dev_sources (job_id, kind, name, commitment_cents, funded_cents, rank, funding_rule) values ($1, 'SPONSOR_EQUITY', 'Sponsor equity', $2, $3, 1, 'EQUITY_FIRST')`, [J1, 35 * K, 3 * M]);
    });
    const b = await call<{ in_balance: boolean; gap_cents: number; cost_to_complete_cents: number; remaining_sources_cents: number }>(f, 'pm', `pm.dev_in_balance($1)`, [J1]);
    expect(b).toMatchObject({ in_balance: true, cost_to_complete_cents: 88 * K, remaining_sources_cents: 95 * K, gap_cents: -7 * K });
    await q(f.db, `insert into pm.change_orders (org_id, job_id, number, title, stage, amount_cents, cost_impact_cents, ext) values ($1, $2, 'PCO-2', 'Utility relocation', 'PCO', 0, $3, jsonb_build_object('cost_code_id', $4::text))`,
      [ORG_A, J1, 12 * K, ids.HARD]);
    const b2 = await call<{ in_balance: boolean; gap_cents: number }>(f, 'pm', `pm.dev_in_balance($1)`, [J1]);
    expect(b2).toMatchObject({ in_balance: false, gap_cents: 5 * K });
    ids.draw = await call<string>(f, 'owner', `pm.create_draw($1, current_date)`, [ids.schedule]);
    expect(await errorOf(f.db, `update pm.draws set status = 'SUBMITTED', submitted_at = now() where id = $1`, [ids.draw])).toMatch(/PM_DEV_OUT_OF_BALANCE/);
  });
});

describe('contingency reallocation with lender consent (RED-12/13, make-or-break 4)', () => {
  it('a move out of contingency is a REVISED budget draft that cannot be approved before the lender consents', async () => {
    const r = await call<{ reallocation_id: string; budget_id: string; lender_consent_required: boolean }>(f, 'pm', `pm.dev_propose_reallocation($1, $2, $3, $4, 'Rock excavation PCO-1 funded from contingency')`,
      [J1, ids.CONT, ids.HARD, 3 * K]);
    expect(r.lender_consent_required).toBe(true);
    ids.realloc = r.reallocation_id; ids.rev = r.budget_id;
    expect(await callErr(f, 'pm', `pm.dev_propose_reallocation($1, $2, $3, 1, 'second while open')`, [J1, ids.SOFT, ids.HARD])).toMatch(/PM_DEV_REALLOCATION_OPEN/);
    expect(await as(f, 'gm', () => errorOf(f.db, `update pm.budgets set status = 'APPROVED' where id = $1`, [ids.rev]))).toMatch(/PM_DEV_LENDER_CONSENT_REQUIRED/);
    await call(f, 'pm', `pm.dev_record_lender_consent($1, 'First Bank email 10/24, J. Ruiz')`, [ids.realloc]);
    const d = await call<{ status: string }>(f, 'owner', `pm.approval_decide('budget_transfer', $1)`, [ids.rev]);
    if (d.status === 'not_needed') {
      expect(await as(f, 'gm', () => errorOf(f.db, `update pm.budgets set status = 'APPROVED' where id = $1`, [ids.rev]))).toBeNull();
    } else {
      expect(d.status).toBe('approved');
    }
    expect((await one<{ status: string }>(f, `select status from pm.dev_reallocations where id = $1`, [ids.realloc])).status).toBe('APPROVED');
    const c = await call<{ pools: Array<{ pool: string; original_cents: number; current_cents: number; used_cents: number }>; log: unknown[] }>(f, 'pm', `pm.dev_contingency($1)`, [J1]);
    expect(c.pools[0]).toMatchObject({ pool: 'HARD', original_cents: 5 * K, current_cents: 2 * K, used_cents: 3 * K });
    expect(c.log).toHaveLength(1);
    // security review M1: the proposer cannot switch lender consent off for a move out of contingency
    const r2 = await call<{ reallocation_id: string; lender_consent_required: boolean }>(f, 'pm', `pm.dev_propose_reallocation($1, $2, $3, 1000, 'try without consent', false)`, [J1, ids.CONT, ids.HARD]);
    expect(r2.lender_consent_required).toBe(true);
    await call(f, 'pm', `pm.dev_cancel_reallocation($1)`, [r2.reallocation_id]);
  });
});

describe('draw builder, pre-submission check, waivers, package in the lender read order (RED-24/25/26/27, make-or-break 1/2/5)', () => {
  it('approved invoices fill the lender lines; the preparer never approves their own invoice', async () => {
    const doc = await documentRow(f, 'gc-payapp.pdf');
    ids.inv1 = await call<string>(f, 'pm', `pm.dev_add_draw_invoice($1, $2, 'PA-03', $3, current_date, $4, $5, null, 0, $6)`, [ids.draw, ids.gc, 15 * K, ids.gmp, ids.HARD, doc]);
    ids.inv2 = await call<string>(f, 'pm', `pm.dev_add_draw_invoice($1, $2, 'INV-88', $3, current_date, null, $4)`, [ids.draw, ids.arch, 2 * K, ids.SOFT]);
    expect(await callErr(f, 'pm', `pm.dev_decide_draw_invoice($1, true)`, [ids.inv1])).toMatch(forbidden);
    const own = await call<string>(f, 'owner', `pm.dev_add_draw_invoice($1, $2, 'PA-X', 100, current_date, null, $3)`, [ids.draw, ids.arch, ids.SOFT]);
    expect(await callErr(f, 'owner', `pm.dev_decide_draw_invoice($1, true)`, [own])).toMatch(/PM_SOD_VIOLATION/);
    await q(f.db, `delete from pm.dev_draw_invoices where id = $1`, [own]);
    await call(f, 'owner', `pm.dev_decide_draw_invoice($1, true)`, [ids.inv1]);
    const b = await call<{ lines_with_amounts: number; requested_cents: number }>(f, 'pm', `pm.dev_build_draw($1)`, [ids.draw]);
    expect(b).toMatchObject({ lines_with_amounts: 1, requested_cents: 15 * K });
  });
  it('the pre-check lists every missing waiver, invoice, approval, COI and the balance gap', async () => {
    const pc = await call<{ ready: boolean; issues: Array<{ code: string; severity: string }> }>(f, 'pm', `pm.dev_draw_precheck($1)`, [ids.draw]);
    expect(pc.ready).toBe(false);
    expect(pc.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['WAIVER_NOT_REQUESTED', 'UNAPPROVED_INVOICE', 'MISSING_INVOICE_DOC', 'COI_MISSING_OR_EXPIRED', 'OUT_OF_BALANCE', 'INSPECTION_PENDING']));
  });
  it('requesting waivers ties a required conditional waiver to the GC commitment (the payment hold) and narrows the check', async () => {
    const w = await call<{ requested: number; waivers: Array<{ compliance_doc_id: string; kind: string }> }>(f, 'pm', `pm.dev_request_draw_waivers($1)`, [ids.draw]);
    expect(w.requested).toBe(1);
    expect(w.waivers[0]!.kind).toBe('CONDITIONAL_CURRENT');
    const cd = await one<{ doc_type: string; status: string; required: boolean; commitment_id: string; amount_cents: string }>(f,
      `select doc_type, status, required, commitment_id, amount_cents from pm.compliance_docs where id = $1`, [w.waivers[0]!.compliance_doc_id]);
    expect(cd).toMatchObject({ doc_type: 'LIEN_WAIVER_CONDITIONAL', status: 'MISSING', required: true, commitment_id: ids.gmp });
    const pc = await call<{ issues: Array<{ code: string }> }>(f, 'pm', `pm.dev_draw_precheck($1)`, [ids.draw]);
    const codes = pc.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_CONDITIONAL_WAIVER');
    expect(codes).not.toContain('WAIVER_NOT_REQUESTED');
  });
  it('the package follows the lender template order with deterministic G702 / G703 numbers', async () => {
    const def = await call<{ sections: Array<{ key: string }>; continuation: Array<{ line_no: number; scheduled_cents: number; this_period_cents: number; balance_cents: number }>; summary: { this_period_cents: number } }>(
      f, 'pm', `pm.dev_draw_package($1)`, [ids.draw]);
    expect(def.sections[0]!.key).toBe('cover_letter');
    expect(def.summary.this_period_cents).toBe(15 * K);
    expect(def.continuation.find((l) => l.line_no === 2)).toMatchObject({ scheduled_cents: 85 * K, this_period_cents: 15 * K, balance_cents: 7 * M });
    await call(f, 'owner', `pm.dev_set_lender_template($1, '[{"key":"draw_summary","label":"Summary","required":true},{"key":"lien_waivers","label":"Waivers","required":true},{"key":"invoices","label":"Invoices","required":true}]'::jsonb)`, [ids.schedule]);
    const t = await call<{ sections: Array<{ key: string; present: boolean }> }>(f, 'pm', `pm.dev_draw_package($1)`, [ids.draw]);
    expect(t.sections.map((s) => s.key)).toEqual(['draw_summary', 'lien_waivers', 'invoices']);
    expect(t.sections.find((s) => s.key === 'lien_waivers')!.present).toBe(false);
    expect(await callErr(f, 'supervisor', `pm.dev_draw_package($1)`, [ids.draw])).toMatch(forbidden);
  });
});

describe('the cross-project overview, capital plan, key dates, investor view (RED-06/37/40, make-or-break 9/10)', () => {
  it('every SPE the caller reaches with job financials, with capital needs by month and dates due', async () => {
    await as(f, 'pm', () => q(f.db, `insert into pm.dev_key_dates (job_id, kind, label, due_on) values ($1, 'RATE_LOCK', 'Rate lock expires', current_date + 20)`, [J1]));
    await call(f, 'pm', `pm.dev_generate_capital_plan($1, current_date, 6)`, [J1]);
    const o = await call<{ projects: Array<{ job_id: string; in_balance: boolean; key_dates: unknown[]; contingency_remaining_cents: number }>; capital_needs: Record<string, { uses_cents: number }> }>(f, 'owner', `pm.dev_overview($1)`, [L1]);
    const p = o.projects.find((x) => x.job_id === J1)!;
    expect(p.in_balance).toBe(false);
    expect(p.key_dates).toHaveLength(1);
    expect(p.contingency_remaining_cents).toBe(2 * K);
    expect(Object.keys(o.capital_needs)).toHaveLength(6);
    const sup = await call<{ projects: unknown[] }>(f, 'supervisor', `pm.dev_overview($1)`, [L1]);
    expect(sup.projects).toEqual([]);
  });
  it('the investor view reads the SPE cap table from Books and keeps no ledger of its own', async () => {
    await q(f.db, `insert into core.equity_holders (org_id, entity_id, name, ownership_pct, capital_contributed_cents, equity_class) values ($1, $2, 'Merit Fund III', 80, $3, 'LLC_UNIT'), ($1, $2, 'Sponsor', 20, $4, 'LLC_UNIT')`,
      [ORG_A, L1, 24 * K, 6 * K]);
    const v = await call<{ available: boolean; source: string; holders: Array<{ name: string }>; contributed_cents: number }>(f, 'pm', `pm.dev_investor_view($1)`, [J1]);
    expect(v).toMatchObject({ available: true, source: 'BOOKS', contributed_cents: 3 * M });
    expect(v.holders.map((h) => h.name)).toEqual(['Merit Fund III', 'Sponsor']);
    expect(await callErr(f, 'labor', `pm.dev_investor_view($1)`, [J1])).toMatch(forbidden);
  });
});

describe('registry', () => {
  it('stays clean after the flows', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});
