/**
 * Projects seam — Books side, part 2 (migration 194). Real Postgres (PGlite replay of every Books
 * migration + the pm chain 1100–1103 via seam-fixture), real consumers, real GL triggers.
 * Criteria ids S2-* are from docs/projects/BOOKS-PROJECTS-INTERACTION.md "Part 2 — testable criteria".
 *
 *   commitments   S2-1..S2-6   upsert / version / supersede / retire / lines removed / acks
 *   bill match    S2-7..S2-11  auto-match, explicit pick, default retainage, payment hold + release, 3-way
 *   JOB_COST      S2-12        enrichment keys (commitment_line_id, vendor_id) on bill-line JOB_COST
 *   G14           S2-13        no job-tagged Books PO for a Projects org (DB trigger); Books-only unaffected
 *   time          S2-14..S2-15 JOB_TIME recorded once per revision; UNAPPROVED withdraws
 *   labor         S2-16..S2-19 payroll post allocates actual cost by hours, ties to the payroll JE,
 *                              idempotent per run, JOB_COST back; standard-rate accrual trued up
 *   A4 / A6       S2-20..S2-22 inputs from GL as-of, pinned snapshots (dup / historical / unpin),
 *                              negative delta relieves 1180 then 2410, loss provision
 *   A7            S2-23        job re-tag refused once HARD_CLOSE
 *   A8            S2-24        hard close blocked by the seam backlog; Books-only passes
 *   off           S2-25        Projects off → every consumer is a no-op
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processCommitmentEvents } from '@/lib/projects-seam/commitments';
import { planCommitmentMatches, recordCommitmentMatches, matchBillLine, scoreThreeWay } from '@/lib/projects-seam/commitment-match';
import { processJobTimeEvents } from '@/lib/projects-seam/job-time';
import { allocateLaborForRun } from '@/lib/projects-seam/labor-allocation';
import { runLaborAccrual } from '@/lib/projects-seam/labor-accrual';
import { processProgressEvents } from '@/lib/services/job-progress';
import { createAttribution } from '@/lib/services/cost-approval';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { postRun } from '@/lib/payroll/run';
import { loadJobInputsAsOf } from '@/lib/rev-rec/as-of-inputs';
import { loadSeamCloseSignals } from '@/lib/close/seam-close-signal';
import { evaluateCloseGraph, type CloseSignals } from '@/lib/close/orchestration';
import { addAccount, balance, count, enqueue, eventRow, seamDb, seedTenant, type Tenant } from './seam-fixture';
import { applyMigrationFile } from './pg';

let db: PGlite;
let sb: SupabaseClient;

// The service-role client the app would mint (events writer, scoped writers) IS the PGlite client here.
const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => holder.sb }));

beforeAll(async () => {
  ({ db, sb } = await seamDb());
  holder.sb = sb;
  // seam-fixture replays the 3-digit Books chain; 194 is part of it (asserted below).
}, 300_000);

afterAll(async () => {
  await db?.close();
});

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

async function vendor(org: string, name = 'Steel Supply Co'): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(`insert into core.vendors (id, org_id, name) values ($1, $2, $3)`, [id, org, name]);
  return id;
}

async function employee(org: string, first: string, hourlyCents: number | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(`insert into core.employees (id, org_id, first_name, last_name, hourly_rate_cents) values ($1, $2, $3, 'Worker', $4)`,
    [id, org, first, hourlyCents]);
  return id;
}

async function job(t: Tenant, number: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into core.jobs (id, org_id, location_id, customer_id, job_number, name, contract_amount_cents, estimated_cost_cents, rev_rec_method_override)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::rev_rec_method_enum)`,
    [id, t.org, t.loc, t.cust, number, `Job ${number}`, extra.contract ?? 0, extra.estimate ?? null, extra.method ?? null]);
  return id;
}

const commitmentPayload = (t: Tenant, jobId: string, vendorId: string, over: Record<string, unknown> = {}) => {
  const cid = (over.commitment_id as string) ?? crypto.randomUUID();
  const version = (over.version as number) ?? 1;
  return {
    schema_version: 1, event_type: 'JOB_COMMITMENT', source_module: 'PROJECTS', org_id: t.org, location_id: t.loc, job_id: jobId,
    occurred_on: '2026-06-10', source_ref: `pm:commit:${cid}:v${version}`, trigger: 'APPROVE', commitment_id: cid, version,
    commitment_type: 'PO', vendor_id: vendorId, number: 'PO-T-2026-0001', status: 'APPROVED', retainage_pct: 0.1,
    payment_hold: false, hold_reason: null, executed_on: null, total_amount_cents: 500_000, memo: 'Rebar',
    lines: [{ commitment_line_id: (over.line_id as string) ?? crypto.randomUUID(), line_no: 1, cost_code_id: crypto.randomUUID(), cost_code: '03-200',
      cost_type: 'MATERIALS', account_hint: null, description: 'Rebar', qty: 1, uom: 'LS', unit_cost_cents: 500_000, amount_cents: 500_000,
      received_to_date_cents: 0, tax_code: null }],
    ...over,
  };
};

it('194 is in the replay (tables + functions exist)', async () => {
  expect(await count(db, `select count(*) n from pg_tables where schemaname = 'public' and tablename in
    ('ap_commitments','ap_commitment_lines','ap_commitment_versions','bill_commitment_matches','job_labor_hours','job_labor_allocations',
     'job_labor_allocation_lines','job_labor_accruals','job_labor_settings','job_progress_snapshots')`)).toBe(10);
  expect(await count(db, `select count(*) n from pg_proc where proname in ('pin_job_progress_snapshot','unpin_job_progress_snapshot','job_inputs_as_of','guard_job_tag_hard_close','guard_job_po_projects')`)).toBe(5);
});

it('194 is idempotent (re-apply changes nothing and does not fail)', async () => {
  await applyMigrationFile(db, '194_projects_seam_commitments_labor.sql');
  expect(await count(db, `select count(*) n from pg_policies where schemaname = 'public' and tablename = 'ap_commitments' and policyname in ('member_read','service_all')`)).toBe(2);
});

// ── Commitments ─────────────────────────────────────────────────────────────
describe('JOB_COMMITMENT → AP match target', () => {
  let t: Tenant; let j: string; let v: string;
  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'CM1' });
    j = await job(t, 'CM1-1');
    v = await vendor(t.org);
  });

  it('S2-1 a snapshot creates the target (header + lines + version row) and acks processed', async () => {
    const p = commitmentPayload(t, j, v);
    const id = await enqueue(db, t.org, 'JOB_COMMITMENT', p);
    const r = await processCommitmentEvents(sb, t.org);
    expect(r).toMatchObject({ processed: 1, rejected: 0 });
    const ev = await eventRow(db, id);
    expect(ev.status).toBe('processed');
    expect(ev.ack_meta).toMatchObject({ version: 1, bills_held: 0 });
    expect(ev.invoice_id).toBeNull();
    const c = await one<{ id: string; version: number; active: boolean; retainage_pct: string; total_amount_cents: string }>(
      `select id, version, active, retainage_pct, total_amount_cents from public.ap_commitments where org_id = $1 and pm_commitment_id = $2`, [t.org, p.commitment_id]);
    expect(c).toMatchObject({ version: 1, active: true });
    expect(Number(c.retainage_pct)).toBe(0.1);
    expect(await count(db, `select count(*) n from public.ap_commitment_lines where commitment_id = $1`, [c.id])).toBe(1);
    expect(await count(db, `select count(*) n from public.ap_commitment_versions where commitment_id = $1`, [c.id])).toBe(1);
    expect(await count(db, `select count(*) n from public.purchase_orders where org_id = $1`, [t.org])).toBe(0); // one master
  });

  it('S2-2 a higher version replaces; an equal / lower version is acknowledged as superseded', async () => {
    const cid = crypto.randomUUID(); const line = crypto.randomUUID(); const line2 = crypto.randomUUID();
    await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { commitment_id: cid, version: 1, line_id: line }));
    await processCommitmentEvents(sb, t.org);
    const v3 = commitmentPayload(t, j, v, { commitment_id: cid, version: 3, line_id: line });
    v3.lines = [{ ...v3.lines[0], commitment_line_id: line2, amount_cents: 700_000 }];
    await enqueue(db, t.org, 'JOB_COMMITMENT', v3);
    await processCommitmentEvents(sb, t.org);
    const stale = await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { commitment_id: cid, version: 2, line_id: line }));
    await processCommitmentEvents(sb, t.org);
    expect((await eventRow(db, stale)).ack_meta).toMatchObject({ superseded: true, version: 3 });
    const c = await one<{ id: string; version: number }>(`select id, version from public.ap_commitments where org_id = $1 and pm_commitment_id = $2`, [t.org, cid]);
    expect(c.version).toBe(3);
    // S2-5 the line missing from v3 is kept (bills may be matched) but marked removed
    const lines = (await db.query<{ pm_commitment_line_id: string; removed: boolean; amount_cents: string }>(
      `select pm_commitment_line_id, removed, amount_cents from public.ap_commitment_lines where commitment_id = $1 order by created_at`, [c.id])).rows;
    expect(lines.find((l) => l.pm_commitment_line_id === line)?.removed).toBe(true);
    expect(lines.find((l) => l.pm_commitment_line_id === line2)).toMatchObject({ removed: false });
  });

  it('S2-3 CLOSED / VOID retire the target (inactive, no new matches)', async () => {
    const cid = crypto.randomUUID();
    await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { commitment_id: cid, version: 1 }));
    await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { commitment_id: cid, version: 2, status: 'VOID' }));
    await processCommitmentEvents(sb, t.org);
    const c = await one<{ active: boolean; status: string; retired_at: string | null }>(`select active, status, retired_at from public.ap_commitments where pm_commitment_id = $1`, [cid]);
    expect(c).toMatchObject({ active: false, status: 'VOID' });
    expect(c.retired_at).not.toBeNull();
  });

  it('S2-4 an invalid snapshot is rejected with an error_code; nothing is written', async () => {
    const bad = await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { retainage_pct: 5 }));
    const wrongJob = await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, crypto.randomUUID(), v));
    const v9 = await enqueue(db, t.org, 'JOB_COMMITMENT', { ...commitmentPayload(t, j, v), schema_version: 9 });
    await processCommitmentEvents(sb, t.org);
    expect(await eventRow(db, bad)).toMatchObject({ status: 'rejected', error_code: 'INVALID_PAYLOAD' });
    expect(await eventRow(db, wrongJob)).toMatchObject({ status: 'rejected', error_code: 'JOB_NOT_FOUND' });
    expect(await eventRow(db, v9)).toMatchObject({ status: 'rejected', error_code: 'UNSUPPORTED_SCHEMA_VERSION' });
  });
});

// ── Bill matching ───────────────────────────────────────────────────────────
describe('bills ↔ commitments', () => {
  let t: Tenant; let j: string; let v: string; let cid: string; let lineId: string; let expense: string;
  let books: Tenant;

  async function bill(status = 'PENDING', amount = 100_000): Promise<{ billId: string; lineId: string }> {
    const billId = crypto.randomUUID(); const bl = crypto.randomUUID();
    await db.query(`insert into public.bills (id, org_id, location_id, vendor_id, bill_number, bill_date, due_date, subtotal_cents, total_cents, status)
                    values ($1, $2, $3, $4, $5, '2026-06-20', '2026-07-20', $6, $6, $7)`, [billId, t.org, t.loc, v, `B-${billId.slice(0, 6)}`, amount, status]);
    await db.query(`insert into public.bill_lines (id, org_id, bill_id, line_number, account_id, amount_cents, job_id) values ($1, $2, $3, 1, $4, $5, $6)`,
      [bl, t.org, billId, expense, amount, j]);
    return { billId, lineId: bl };
  }

  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'BM1' });
    books = await seedTenant(db, { projects: false, shortCode: 'BM2' });
    expense = await addAccount(db, t.org, '5100', 'Materials', 'COGS', 'COST_OF_GOODS_SOLD');
    j = await job(t, 'BM1-1');
    v = await vendor(t.org);
    cid = crypto.randomUUID();
    await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, j, v, { commitment_id: cid }));
    await processCommitmentEvents(sb, t.org);
    lineId = (await one<{ id: string }>(`select l.id from public.ap_commitment_lines l join public.ap_commitments c on c.id = l.commitment_id where c.pm_commitment_id = $1`, [cid])).id;
  });

  it('S2-7 one open line for vendor + job → AUTO match; S2-9 default retainage 10%', async () => {
    const plan = await planCommitmentMatches(sb, t.org, { vendorId: v, locationId: t.loc, lines: [{ index: 0, jobId: j, amountCents: 100_000 }] });
    expect(plan.applies).toBe(true);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({ commitmentLineId: lineId, source: 'AUTO' });
    expect(plan.defaultRetainagePct).toBe(10);
    expect(plan.holdReason).toBeNull();
  });

  it('S2-8 an explicit pick for another vendor / job is refused', async () => {
    const other = await vendor(t.org, 'Other Vendor');
    const plan = await planCommitmentMatches(sb, t.org, { vendorId: other, locationId: t.loc, lines: [{ index: 0, jobId: j, amountCents: 1, commitmentLineId: lineId }] });
    expect(plan.errors[0]).toMatch(/not an open commitment for this vendor/);
  });

  it('S2-11 3-way: billed over the commitment → OVER_COMMITTED; receipts in use → BILLED_OVER_RECEIVED', async () => {
    const b1 = await bill('PENDING', 300_000);
    const plan = await planCommitmentMatches(sb, t.org, { vendorId: v, locationId: t.loc, lines: [{ index: 0, jobId: j, amountCents: 300_000 }] });
    await recordCommitmentMatches(sb, t.org, { billId: b1.billId, locationId: t.loc, lines: [{ id: b1.lineId, amount_cents: 300_000 }], plan, matchedBy: 'u1' });
    expect((await one<{ three_way_status: string }>(`select three_way_status from public.bill_commitment_matches where bill_line_id = $1`, [b1.lineId])).three_way_status).toBe('OK');
    const b2 = await bill('PENDING', 250_000);
    const r = await matchBillLine(sb, t.org, { billLineId: b2.lineId, commitmentLineId: lineId, matchedBy: 'u1' });
    expect(r.status).toBe('OVER_COMMITTED'); // 550k billed on a 500k line
    // Projects records a receipt of 200k (new version) → the line is billed over received
    const p2 = commitmentPayload(t, j, v, { commitment_id: cid, version: 2 });
    const pmLine = (await one<{ pm_commitment_line_id: string }>(`select pm_commitment_line_id from public.ap_commitment_lines where id = $1`, [lineId])).pm_commitment_line_id;
    p2.lines = [{ ...p2.lines[0], commitment_line_id: pmLine, amount_cents: 600_000, received_to_date_cents: 200_000 }];
    await enqueue(db, t.org, 'JOB_COMMITMENT', p2);
    await processCommitmentEvents(sb, t.org);
    const s = await one<{ three_way_status: string; variance_cents: string }>(`select three_way_status, variance_cents from public.bill_commitment_matches where bill_line_id = $1`, [b2.lineId]);
    expect(s.three_way_status).toBe('BILLED_OVER_RECEIVED');
    expect(Number(s.variance_cents)).toBe(350_000);
    expect(scoreThreeWay({ commitmentType: 'SUBCONTRACT', amountCents: 10, receivedCents: 0, billedCents: 5, receivingInUse: true }).status).toBe('OK');
  });

  it('S2-10 payment_hold puts matched open bills ON_HOLD; releasing the hold restores their status', async () => {
    const b = await bill('APPROVED', 10_000);
    await matchBillLine(sb, t.org, { billLineId: b.lineId, commitmentLineId: lineId, matchedBy: 'u1' });
    const pmLine = (await one<{ pm_commitment_line_id: string }>(`select pm_commitment_line_id from public.ap_commitment_lines where id = $1`, [lineId])).pm_commitment_line_id;
    const hold = commitmentPayload(t, j, v, { commitment_id: cid, version: 3, payment_hold: true, hold_reason: 'COMPLIANCE: COI expired' });
    hold.lines = [{ ...hold.lines[0], commitment_line_id: pmLine, amount_cents: 600_000, received_to_date_cents: 200_000 }];
    const hid = await enqueue(db, t.org, 'JOB_COMMITMENT', hold);
    await processCommitmentEvents(sb, t.org);
    expect((await eventRow(db, hid)).ack_meta).toMatchObject({ bills_held: expect.any(Number) });
    const held = await one<{ status: string; payment_hold_reason: string }>(`select status, payment_hold_reason from public.bills where id = $1`, [b.billId]);
    expect(held.status).toBe('ON_HOLD');
    expect(held.payment_hold_reason).toMatch(/^Projects commitment PO-T-2026-0001 is on payment hold: COMPLIANCE: COI expired/);
    // a NEW bill entered while on hold lands ON_HOLD at entry
    const plan = await planCommitmentMatches(sb, t.org, { vendorId: v, locationId: t.loc, lines: [{ index: 0, jobId: j, amountCents: 1 }] });
    expect(plan.holdReason).toMatch(/on payment hold/);
    const release = { ...hold, version: 4, source_ref: `pm:commit:${cid}:v4`, payment_hold: false, hold_reason: null };
    await enqueue(db, t.org, 'JOB_COMMITMENT', release);
    await processCommitmentEvents(sb, t.org);
    expect((await one<{ status: string }>(`select status from public.bills where id = $1`, [b.billId])).status).toBe('APPROVED');
  });

  it('S2-12 JOB_COST for a matched bill line carries commitment_line_id + vendor_id (additive keys)', async () => {
    const b = await bill('PENDING', 5_000);
    const pmLine = (await one<{ pm_commitment_line_id: string }>(`select pm_commitment_line_id from public.ap_commitment_lines where id = $1`, [lineId])).pm_commitment_line_id;
    await createAttribution(sb, {
      orgId: t.org, locationId: t.loc, jobId: j, costType: 'MATERIALS', amountCents: 5_000, occurredOn: '2026-06-20', gate: 'PAYABLE_APPROVAL',
      sourceType: 'BILL', sourceRef: b.lineId, billId: b.billId, commitmentLineRef: pmLine, costCodeRef: '03-200', vendorId: v,
    });
    const ev = await one<{ payload: Record<string, unknown> }>(`select payload from core.events where org_id = $1 and event_type = 'JOB_COST' and payload->>'source_ref' = $2`, [t.org, b.lineId]);
    expect(ev.payload).toMatchObject({ commitment_line_id: pmLine, vendor_id: v, cost_code: '03-200', lifecycle: 'PENDING' });
  });

  it('S2-13 G14: a job-tagged Books PO line is refused for a Projects org; non-job and Books-only POs are fine', async () => {
    const po = crypto.randomUUID();
    await db.query(`insert into public.purchase_orders (id, org_id, vendor_id, po_number) values ($1, $2, $3, 'PO-X-1')`, [po, t.org, v]);
    await expect(db.query(`insert into public.purchase_order_lines (org_id, po_id, line_number, job_id) values ($1, $2, 1, $3)`, [t.org, po, j]))
      .rejects.toThrow(/JOB_PO_OWNED_BY_PROJECTS/);
    await db.query(`insert into public.purchase_order_lines (org_id, po_id, line_number) values ($1, $2, 2)`, [t.org, po]);
    const bv = await vendor(books.org);
    const bpo = crypto.randomUUID();
    await db.query(`insert into public.purchase_orders (id, org_id, vendor_id, po_number) values ($1, $2, $3, 'PO-Y-1')`, [bpo, books.org, bv]);
    await db.query(`insert into public.purchase_order_lines (org_id, po_id, line_number, job_id) values ($1, $2, 1, $3)`, [books.org, bpo, books.job]);
  });

  it('S2-25 Books-only org: planning is a no-op (applies = false)', async () => {
    const bv = await vendor(books.org);
    const plan = await planCommitmentMatches(sb, books.org, { vendorId: bv, locationId: books.loc, lines: [{ index: 0, jobId: books.job, amountCents: 1 }] });
    expect(plan).toMatchObject({ applies: false, matches: [] });
  });
});

// ── Time + labor ────────────────────────────────────────────────────────────
interface LaborTenant extends Tenant { labor: string; wages: string; tax: string; accrued: string; job2: string }

async function laborTenant(code: string): Promise<LaborTenant> {
  const t = await seedTenant(db, { projects: true, shortCode: code });
  const labor = await addAccount(db, t.org, '5000', 'Direct Labor', 'COGS', 'COST_OF_GOODS_SOLD');
  const wages = await addAccount(db, t.org, '6000', 'Wages', 'OPEX', 'OPERATING_EXPENSE');
  const tax = await addAccount(db, t.org, '6010', 'Payroll Taxes', 'OPEX', 'OPERATING_EXPENSE');
  const accrued = await addAccount(db, t.org, '2400', 'Accrued Expenses', 'LIABILITY', 'CURRENT_LIABILITY');
  for (const [n, name] of [['1096', 'Payments in Transit'], ['2200', 'Federal Tax Payable'], ['2220', 'FICA Payable'], ['2230', 'Health Ins Payable'], ['2270', 'Garnishments']] as const) {
    await addAccount(db, t.org, n, name, n === '1096' ? 'ASSET' : 'LIABILITY', n === '1096' ? 'CURRENT_ASSET' : 'CURRENT_LIABILITY');
  }
  const job2 = await job(t, `${code}-2`);
  return { ...t, labor, wages, tax, accrued, job2 };
}

const timePayload = (t: Tenant, jobId: string, emp: string | null, hours: number, over: Record<string, unknown> = {}) => {
  const te = (over.time_entry_id as string) ?? crypto.randomUUID();
  return {
    schema_version: 1, event_type: 'JOB_TIME', source_module: 'PROJECTS', org_id: t.org, location_id: t.loc, job_id: jobId,
    occurred_on: '2026-06-18', source_ref: `pm:time:${te}`, action: 'APPROVED', revision: 1, time_entry_id: te, employee_id: emp,
    hours, pay_type: 'REG', cost_code_id: crypto.randomUUID(), cost_code: '01-100', billable: true, cost_rate_cents: 5_000, cost_rate_basis: 'PAY_PLUS_BURDEN',
    ...over,
  };
};

async function payrollRun(t: Tenant, lines: Array<{ emp: string; gross: number; tax: number; hours: number }>, period = ['2026-06-16', '2026-06-30'], payDate = '2026-07-03'): Promise<string> {
  const id = crypto.randomUUID();
  const gross = lines.reduce((s, l) => s + l.gross, 0);
  const tax = lines.reduce((s, l) => s + l.tax, 0);
  await db.query(`insert into public.payroll_runs (id, org_id, location_id, period_start, period_end, pay_date, status, gross_cents, net_cents, employer_tax_cents)
                  values ($1, $2, $3, $4, $5, $6, 'PAID', $7, $7, $8)`, [id, t.org, t.loc, period[0], period[1], payDate, gross, tax]);
  for (const l of lines) {
    await db.query(`insert into public.payroll_run_employees (org_id, payroll_run_id, employee_id, gross_cents, net_cents, employer_tax_cents, hours)
                    values ($1, $2, $3, $4, $4, $5, $6)`, [t.org, id, l.emp, l.gross, l.tax, l.hours]);
  }
  return id;
}

describe('JOB_TIME + labor from payroll', () => {
  let t: LaborTenant; let a: string; let b: string; let c: string;

  beforeAll(async () => {
    t = await laborTenant('LB1');
    a = await employee(t.org, 'Ann'); b = await employee(t.org, 'Bo'); c = await employee(t.org, 'Cy');
  });

  it('S2-14 approved time is recorded once per revision (re-delivery is a no-op); no posting', async () => {
    // Ann: 30 h on job 1 + 50 h on job 2 (10 h days); Bo: 10 h on job 1; Cy: 8 h (not on the payroll run).
    const cc1 = crypto.randomUUID(); const cc2 = crypto.randomUUID();
    const first = timePayload(t, t.job, a, 10, { cost_code_id: cc1, occurred_on: '2026-06-16' });
    await enqueue(db, t.org, 'JOB_TIME', first);
    await enqueue(db, t.org, 'JOB_TIME', first); // duplicate delivery, new event id
    for (let d = 17; d <= 18; d++) await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, a, 10, { cost_code_id: cc1, occurred_on: `2026-06-${d}` }));
    for (let d = 22; d <= 26; d++) await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job2, a, 10, { cost_code_id: cc2, occurred_on: `2026-06-${d}` }));
    await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, b, 10, { cost_code_id: cc1 }));
    await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, c, 8, { cost_code_id: cc1 }));
    const r = await processJobTimeEvents(sb, t.org);
    expect(r).toMatchObject({ processed: 11, rejected: 0 });
    expect(await count(db, `select count(*) n from public.job_labor_hours where org_id = $1`, [t.org])).toBe(10);
    expect(await count(db, `select count(*) n from public.gl_entries where org_id = $1`, [t.org])).toBe(0);
    const bad = await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, a, 25));
    await processJobTimeEvents(sb, t.org);
    expect(await eventRow(db, bad)).toMatchObject({ status: 'rejected', error_code: 'INVALID_HOURS' });
  });

  it('S2-15 UNAPPROVED withdraws that revision', async () => {
    const p = timePayload(t, t.job, a, 2, { occurred_on: '2026-06-19' });
    await enqueue(db, t.org, 'JOB_TIME', p);
    await processJobTimeEvents(sb, t.org);
    await enqueue(db, t.org, 'JOB_TIME', { ...p, action: 'UNAPPROVED' });
    await processJobTimeEvents(sb, t.org);
    expect((await one<{ status: string }>(`select status from public.job_labor_hours where source_ref = $1`, [p.source_ref])).status).toBe('WITHDRAWN');
  });

  it('S2-16/17 payroll post allocates ACTUAL cost by hours, to the cent, and ties to the payroll entry', async () => {
    const runId = await payrollRun(t, [{ emp: a, gross: 200_000, tax: 15_300, hours: 80 }, { emp: b, gross: 100_000, tax: 7_650, hours: 40 }]);
    const posted = await postRun(sb, t.org, runId); // the real payroll post — allocation runs from its hook
    expect(posted.alreadyPosted).toBe(false);
    const alloc = await one<{ status: string; allocated_cents: string; unallocated_cost_cents: string; unallocated_hours: string; gl_entry_id: string; payroll_cost_cents: string }>(
      `select status, allocated_cents, unallocated_cost_cents, unallocated_hours, gl_entry_id, payroll_cost_cents from public.job_labor_allocations where payroll_run_id = $1`, [runId]);
    expect(alloc.status).toBe('POSTED');
    // Ann: all 80 paid hours on jobs (30 + 50) → all 215,300; Bo: 10 of 40 hours → 25,000 + 1,913 (largest remainder).
    expect(Number(alloc.payroll_cost_cents)).toBe(322_950);
    expect(Number(alloc.allocated_cents)).toBe(215_300 + 26_913);
    expect(Number(alloc.unallocated_cost_cents)).toBe(75_000 + 5_737);
    expect(Number(alloc.unallocated_hours)).toBe(8); // Cy is not on this run
    // Ties to the payroll JE: wages 6000 keeps only Bo's 30 off-job hours; tax 6010 likewise.
    expect(await balance(db, t.wages)).toBe(300_000 - 225_000);
    expect(await balance(db, t.tax)).toBe(22_950 - 17_213);
    expect(await balance(db, t.labor)).toBe(242_213);
    const byJob = (await db.query<{ job_id: string; n: string }>(
      `select l.job_id, sum(l.debit_cents - l.credit_cents) n from public.gl_entry_lines l where l.account_id = $1 group by l.job_id`, [t.labor])).rows;
    const j1 = Number(byJob.find((r) => r.job_id === t.job)?.n);
    const j2 = Number(byJob.find((r) => r.job_id === t.job2)?.n);
    expect(j1 + j2).toBe(242_213);
    expect(j2).toBeGreaterThanOrEqual(125_000 + 9_562);
    // JOB_COST back to Projects per job × cost code, CLEARED LABOR, gate TIMESHEET_PAYROLL
    const evs = (await db.query<{ payload: Record<string, unknown> }>(
      `select payload from core.events where org_id = $1 and event_type = 'JOB_COST' and payload->>'source_ref' like $2`, [t.org, `payroll_labor:${runId}:%`])).rows;
    expect(evs.length).toBe(2); // job 1 × cost code 1, job 2 × cost code 2
    expect(evs.reduce((s, e) => s + Number(e.payload.amount_cents), 0)).toBe(242_213);
    expect(evs.every((e) => e.payload.cost_type === 'LABOR' && e.payload.lifecycle === 'CLEARED' && e.payload.gate === 'TIMESHEET_PAYROLL')).toBe(true);
  });

  it('S2-18 idempotent per payroll run: a second allocation (or re-post) changes nothing', async () => {
    const { rows } = await db.query<{ payroll_run_id: string }>(`select payroll_run_id from public.job_labor_allocations where org_id = $1`, [t.org]);
    const before = await count(db, `select count(*) n from public.gl_entries where org_id = $1`, [t.org]);
    const r = await allocateLaborForRun(sb, t.org, rows[0].payroll_run_id);
    expect(r).toMatchObject({ status: 'POSTED', already: true });
    expect(await count(db, `select count(*) n from public.gl_entries where org_id = $1`, [t.org])).toBe(before);
  });
});

describe('Direct Labor requires a department', () => {
  it('the worker\'s department is used when the job has none; with neither, the allocation FAILS with a clear message (retryable)', async () => {
    const t = await laborTenant('LB3');
    await db.query(`update public.accounts set require_department = true where id = $1`, [t.labor]);
    const dept = crypto.randomUUID();
    await db.query(`insert into core.departments (id, org_id, name, code) values ($1, $2, 'Field', 'FLD')`, [dept, t.org]);
    const withDept = await employee(t.org, 'Eve');
    await db.query(`update core.employees set department_id = $2 where id = $1`, [withDept, dept]);
    const noDept = await employee(t.org, 'Fay');
    await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, withDept, 8));
    await processJobTimeEvents(sb, t.org);
    expect((await one<{ department_id: string }>(`select department_id from public.job_labor_hours where org_id = $1`, [t.org])).department_id).toBe(dept);
    const ok = await payrollRun(t, [{ emp: withDept, gross: 20_000, tax: 1_530, hours: 8 }]);
    await postRun(sb, t.org, ok);
    expect(await allocateLaborForRun(sb, t.org, ok)).toMatchObject({ status: 'POSTED', already: true });

    await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job2, noDept, 8, { occurred_on: '2026-07-20' }));
    await processJobTimeEvents(sb, t.org);
    const bad = await payrollRun(t, [{ emp: noDept, gross: 20_000, tax: 1_530, hours: 8 }], ['2026-07-16', '2026-07-31'], '2026-08-03');
    await postRun(sb, t.org, bad); // the payroll post itself succeeds; the labor allocation is recorded FAILED
    expect((await one<{ status: string }>(`select status from public.job_labor_allocations where payroll_run_id = $1`, [bad])).status).toBe('FAILED');
    const r = await allocateLaborForRun(sb, t.org, bad); // retry
    expect(r.status).toBe('FAILED');
    expect(r.status === 'FAILED' && r.error).toMatch(/5000 Direct Labor needs a department .* LB3-2/);
  });
});

describe('standard-rate accrual, trued up at payroll', () => {
  it('S2-19 accrue mid-period at the standard rate; payroll replaces it with actual (job = actual, accrual = 0)', async () => {
    const t = await laborTenant('LB2');
    const d = await employee(t.org, 'Dee', 4_000);
    await db.query(`insert into public.job_labor_settings (org_id, location_id, accrue_standard_rate) values ($1, $2, true)`, [t.org, t.loc]);
    const p = timePayload(t, t.job, d, 10, { occurred_on: '2026-06-25', cost_rate_cents: 5_000 });
    await enqueue(db, t.org, 'JOB_TIME', p);
    await processJobTimeEvents(sb, t.org);
    const acc = await runLaborAccrual(sb, t.org, { locationId: t.loc, asOf: '2026-06-30', actor: 'test' });
    expect(acc).toMatchObject({ status: 'POSTED', amountCents: 50_000 });
    expect(await balance(db, t.labor)).toBe(50_000);
    expect(await balance(db, t.accrued)).toBe(-50_000);
    expect(await runLaborAccrual(sb, t.org, { locationId: t.loc, asOf: '2026-06-30', actor: 'test' })).toMatchObject({ status: 'POSTED', already: true });

    const runId = await payrollRun(t, [{ emp: d, gross: 60_000, tax: 4_590, hours: 10 }]);
    await postRun(sb, t.org, runId);
    expect(await balance(db, t.labor)).toBe(64_590); // actual
    expect(await balance(db, t.accrued)).toBe(0);
    const accrual = await one<{ status: string; trued_up_cents: string }>(`select status, trued_up_cents from public.job_labor_accruals where org_id = $1`, [t.org]);
    expect(accrual).toMatchObject({ status: 'TRUED_UP' });
    expect(await count(db, `select count(*) n from core.events where org_id = $1 and event_type = 'JOB_COST' and payload->>'lifecycle' = 'VOIDED'`, [t.org])).toBe(1);
  });
});

// ── A4 / A6 ─────────────────────────────────────────────────────────────────
describe('rev-rec inputs from the books + JOB_PROGRESS v2', () => {
  let t: Tenant; let j: string; let cogs: string; let ap: string; let unbilled: string;

  const progress = (version: number, over: Record<string, unknown> = {}) => ({
    schema_version: 2, event_type: 'JOB_PROGRESS', source_module: 'PROJECTS', org_id: t.org, location_id: t.loc, job_id: j,
    trigger: 'PROGRESS_UPDATE', contract_value_cents: 1_000_000, cost_estimate_cents: 600_000, pct_complete: null,
    occurred_on: '2026-06-30', as_of_date: '2026-06-30', snapshot_version: version, pending_co_value_cents: 50_000,
    source_ref: `pm:progress:${j}:v${version}`, memo: 'snap', ...over,
  });

  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'RR1' });
    cogs = await addAccount(db, t.org, '5100', 'Materials', 'COGS', 'COST_OF_GOODS_SOLD');
    ap = await addAccount(db, t.org, '2000', 'Accounts Payable', 'LIABILITY', 'CURRENT_LIABILITY');
    unbilled = await addAccount(db, t.org, '1180', 'Unbilled Receivable', 'ASSET', 'CURRENT_ASSET');
    await addAccount(db, t.org, '2450', 'Loss Provision', 'LIABILITY', 'CURRENT_LIABILITY');
    await addAccount(db, t.org, '5250', 'Contract Losses', 'COGS', 'COST_OF_GOODS_SOLD');
    j = await job(t, 'RR1-1', { contract: 1_000_000, estimate: 600_000, method: 'PCT_COSTS_INCURRED' });
    const je = await postJournalEntry(sb, {
      org_id: t.org, location_id: t.loc, entry_date: '2026-06-12', entry_type: 'STANDARD', memo: 'Job cost', created_by: null,
      lines: [
        { account_id: cogs, debit_cents: 150_000, credit_cents: 0, location_id: t.loc, job_id: j },
        { account_id: ap, debit_cents: 0, credit_cents: 150_000, location_id: t.loc },
      ],
    });
    expect(je.success).toBe(true);
  });

  it('S2-20 A4: actual cost comes from posted job-tagged GL lines as of the date (not the stale job column)', async () => {
    const r = await loadJobInputsAsOf(sb, t.org, [j], '2026-06-30');
    expect(r.source).toBe('BOOKS_AS_OF');
    expect(r.byJob.get(j)).toMatchObject({ actualCostCents: 150_000, glCostCents: 150_000, billedToDateCents: 0 });
    expect((await loadJobInputsAsOf(sb, t.org, [j], '2026-06-01')).byJob.get(j)?.actualCostCents).toBe(0);
  });

  it('S2-21 v2 pins (job, version), recognizes from GL cost; a re-delivery is a no-op; an older version is history only', async () => {
    const e1 = await enqueue(db, t.org, 'JOB_PROGRESS', progress(1), '2026-06-30');
    await processProgressEvents(sb, t.org, 'test');
    const ev = await eventRow(db, e1);
    expect(ev.status).toBe('processed');
    expect(ev.ack_meta).toMatchObject({ snapshot_version: 1, recognized_delta_cents: 250_000 }); // 150k / 600k × 1,000k
    expect(await balance(db, unbilled)).toBe(250_000);
    const dup = await enqueue(db, t.org, 'JOB_PROGRESS', progress(1), '2026-06-30');
    await processProgressEvents(sb, t.org, 'test');
    expect((await eventRow(db, dup)).ack_meta).toMatchObject({ duplicate: true });
    expect(await count(db, `select count(*) n from public.job_progress_snapshots where job_id = $1`, [j])).toBe(1);
  });

  it('S2-22 a negative delta relieves 1180 first, then books 2410; the anticipated loss is provided', async () => {
    // Billing moved 200k of the contract asset to AR (the job's 1180 is now 50k).
    const ar = (await one<{ id: string }>(`select id from public.accounts where org_id = $1 and account_number = '1100'`, [t.org])).id;
    await postJournalEntry(sb, { org_id: t.org, location_id: t.loc, entry_date: '2026-06-28', entry_type: 'STANDARD', memo: 'reclass', created_by: null,
      lines: [{ account_id: ar, debit_cents: 200_000, credit_cents: 0, location_id: t.loc, job_id: j }, { account_id: unbilled, debit_cents: 0, credit_cents: 200_000, location_id: t.loc, job_id: j }] });
    const e2 = await enqueue(db, t.org, 'JOB_PROGRESS', progress(2, { cost_estimate_cents: 1_200_000 }), '2026-06-30');
    await processProgressEvents(sb, t.org, 'test');
    const ev = await eventRow(db, e2);
    expect(ev.status).toBe('processed');
    // earned 150k / 1.2M × 1M = 125k → delta −125k: 50k off 1180, 75k to 2410
    expect(ev.ack_meta).toMatchObject({ recognized_delta_cents: -125_000, loss_provision_cents: 175_000 });
    expect(await balance(db, unbilled)).toBe(0);
    expect(await balance(db, t.acct.DEF)).toBe(-75_000);
    const loss = (await one<{ id: string }>(`select id from public.accounts where org_id = $1 and account_number = '2450'`, [t.org])).id;
    expect(await balance(db, loss)).toBe(-175_000); // 200k anticipated − 25k already in P&L (cost 150k − earned 125k)
    // an OLDER snapshot arriving late is kept as history and never overwrites the job
    const old = await enqueue(db, t.org, 'JOB_PROGRESS', progress(1, { snapshot_version: 1, source_ref: 'x' }), '2026-06-30');
    await processProgressEvents(sb, t.org, 'test');
    expect((await eventRow(db, old)).ack_meta).toMatchObject({ duplicate: true });
    expect(Number((await one<{ estimated_cost_cents: string }>(`select estimated_cost_cents from core.jobs where id = $1`, [j])).estimated_cost_cents)).toBe(1_200_000);
  });

  it('G9: a rejected v2 event leaves no pin (closed period rejects before pinning)', async () => {
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and period_year = 2026 and period_month = 5`, [t.org]);
    const e = await enqueue(db, t.org, 'JOB_PROGRESS', progress(7, { as_of_date: '2026-05-31', occurred_on: '2026-05-31' }), '2026-05-31');
    await processProgressEvents(sb, t.org, 'test');
    expect(await eventRow(db, e)).toMatchObject({ status: 'rejected', error_code: 'PERIOD_CLOSED' });
    expect(await count(db, `select count(*) n from public.job_progress_snapshots where job_id = $1 and snapshot_version = 7`, [j])).toBe(0);
  });

  it('unpin restores the job inputs of a PENDING pin', async () => {
    const pin = (await db.query<{ snapshot_id: string; applied: boolean }>(
      `select * from public.pin_job_progress_snapshot($1, $2, 99, '2026-06-30', 2000000, 900000, null, null, null, null, null)`, [t.org, j])).rows[0];
    expect(pin.applied).toBe(true);
    expect(Number((await one<{ contract_amount_cents: string }>(`select contract_amount_cents from core.jobs where id = $1`, [j])).contract_amount_cents)).toBe(2_000_000);
    await db.query(`select public.unpin_job_progress_snapshot($1, $2)`, [t.org, pin.snapshot_id]);
    const after = await one<{ contract_amount_cents: string; estimated_cost_cents: string }>(`select contract_amount_cents, estimated_cost_cents from core.jobs where id = $1`, [j]);
    expect(Number(after.contract_amount_cents)).toBe(1_000_000);
    expect(Number(after.estimated_cost_cents)).toBe(1_200_000);
  });
});

// ── A7 / A8 ─────────────────────────────────────────────────────────────────
describe('close: re-tag lock and the seam backlog gate', () => {
  it('S2-23 A7: job_id on a posted GL line cannot change once the period is HARD_CLOSE', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'HC1' });
    const cogs = await addAccount(db, t.org, '5100', 'Materials', 'COGS', 'COST_OF_GOODS_SOLD');
    const j2 = await job(t, 'HC1-2');
    const je = await postJournalEntry(sb, { org_id: t.org, location_id: t.loc, entry_date: '2026-03-10', entry_type: 'STANDARD', memo: 'c', created_by: null,
      lines: [{ account_id: cogs, debit_cents: 1_000, credit_cents: 0, location_id: t.loc, job_id: t.job }, { account_id: t.acct.BANK, debit_cents: 0, credit_cents: 1_000, location_id: t.loc }] });
    const lineId = (await one<{ id: string }>(`select id from public.gl_entry_lines where gl_entry_id = $1 and job_id is not null`, [je.entry_id])).id;
    await db.query(`update public.gl_entry_lines set job_id = $2 where id = $1`, [lineId, j2]); // open period: allowed (dimension tagging)
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and period_year = 2026 and period_month = 3`, [t.org]);
    await expect(db.query(`update public.gl_entry_lines set job_id = $2 where id = $1`, [lineId, t.job])).rejects.toThrow(/JOB_TAG_LOCKED/);
  });

  it('S2-24 A8: a pending / rejected Projects message dated in the period blocks hard close; a later fix clears it; Books-only passes', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'HC2' });
    const ref = `pm:bill:${crypto.randomUUID()}`;
    await enqueue(db, t.org, 'JOB_BILLING', { job_id: t.job, location_id: t.loc, source_ref: ref, lines: [] }, '2026-06-15');
    let sig = (await loadSeamCloseSignals(sb, t.org, '2026-06-30', [t.loc])).get(t.loc)!;
    expect(sig).toMatchObject({ applicable: true, status: 'BLOCKED', pending: 1 });
    const base: CloseSignals = {
      uncodedBankCents: 0, reconciliationBlockers: 0, arVarianceCents: 0, apVarianceCents: 0, blockingLeakageCents: 0, leakageItems: 0,
      openExceptions: 0, unpostedDraftCount: 0, billsOnHoldCount: 0, unappliedPaymentCount: 0, unappliedPaymentCents: 0, pendingApprovalCount: 0,
    };
    const task = (s: CloseSignals) => evaluateCloseGraph(s, new Set()).tasks.find((x) => x.key === 'projects_seam_settled')!;
    expect(task({ ...base, projectsSeam: sig }).status).toBe('blocked');
    // next month's message does not block June
    expect((await loadSeamCloseSignals(sb, t.org, '2026-05-31', [t.loc])).get(t.loc)).toMatchObject({ status: 'OK', pending: 0 });
    // rejected, then the same business key processed later → settled
    await db.query(`update core.events set status = 'rejected', error = 'X', error_code = 'NO_CUSTOMER' where org_id = $1`, [t.org]);
    sig = (await loadSeamCloseSignals(sb, t.org, '2026-06-30', [t.loc])).get(t.loc)!;
    expect(sig).toMatchObject({ status: 'BLOCKED', rejected: 1 });
    const fixed = await enqueue(db, t.org, 'JOB_BILLING', { job_id: t.job, location_id: t.loc, source_ref: ref, lines: [] }, '2026-06-15');
    await db.query(`update core.events set status = 'processed', processed_at = now(), created_at = now() + interval '1 second' where id = $1`, [fixed]);
    sig = (await loadSeamCloseSignals(sb, t.org, '2026-06-30', [t.loc])).get(t.loc)!;
    expect(sig).toMatchObject({ status: 'OK', pending: 0, rejected: 0 });
    expect(task({ ...base, projectsSeam: sig }).status).toBe('pass');
    // Books-only org
    const books = await seedTenant(db, { projects: false, shortCode: 'HC3' });
    const bsig = (await loadSeamCloseSignals(sb, books.org, '2026-06-30', [books.loc])).get(books.loc)!;
    expect(bsig.applicable).toBe(false);
    expect(task({ ...base, projectsSeam: bsig }).status).toBe('pass');
  });
});

// ── Projects off ────────────────────────────────────────────────────────────
describe('S2-25 Projects off → no-op', () => {
  it('commitment and time events are released untouched; labor allocation is NOT_APPLICABLE', async () => {
    const t = await seedTenant(db, { projects: false, shortCode: 'OFF' });
    const v = await vendor(t.org);
    const c = await enqueue(db, t.org, 'JOB_COMMITMENT', commitmentPayload(t, t.job, v));
    const tm = await enqueue(db, t.org, 'JOB_TIME', timePayload(t, t.job, null, 4));
    const rc = await processCommitmentEvents(sb, t.org);
    const rt = await processJobTimeEvents(sb, t.org);
    expect(rc).toMatchObject({ processed: 0, skipped: 1 });
    expect(rt).toMatchObject({ processed: 0, skipped: 1 });
    expect((await eventRow(db, c)).status).toBe('pending');
    expect((await eventRow(db, tm)).status).toBe('pending');
    expect(await count(db, `select count(*) n from public.ap_commitments where org_id = $1`, [t.org])).toBe(0);
    const runId = crypto.randomUUID();
    expect(await allocateLaborForRun(sb, t.org, runId)).toMatchObject({ status: 'NOT_APPLICABLE' });
  });
});
