/**
 * Check processing against the REAL schema (PGlite replay of every migration incl. 182):
 * the atomic print run + sequence (AC-1), print + grouping (AC-5), print SoD (AC-6), spoil
 * + reprint (AC-7), void in an open period (AC-8), void after close → reversing entry +
 * idempotent retry (AC-9), cleared can't void (AC-10), positive pay (AC-11), auto-clear
 * from the bank feed (AC-12), register + gaps (AC-13), write lock / masks / guard (AC-14).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from '@/test/pg';
import { pgSupabase } from '@/test/pg-supabase';
import { recordBillPayment } from '@/lib/posting/lifecycle';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { loadReadyToPrint, markCheckSent, printChecks, spoilCheck, type PrintSod } from './print-service';
import { voidCheck } from './void-service';
import { matchClearedChecks } from './clearing';
import { loadRegister } from './register-service';
import { generatePositivePay, type PositivePayOutput } from './positive-pay-service';
import { loadPrintSetup, setMicrNumbers, setNextCheckNumber, setSignature, saveStockSettings } from './stock-service';
import { memoryCheckSecrets } from './secrets';
import { CheckError } from './db';
import { confirmSecurityChange, isTenantAdmin, printSecurityHold } from './stock-security';

let db: PGlite;
let sb: SupabaseClient;
const opts = () => ({ writer: sb });
const secrets = memoryCheckSecrets();

const ORG = crypto.randomUUID();
const A = crypto.randomUUID();
const PREP = 'user_prep';
const APPR = 'user_appr';
const REL = 'user_rel';
const PRINTER = 'user_print';
const SOD: PrintSod = { soleApproverMode: false, soleApproverMaxCents: null };
const acct: Record<string, string> = {};
let BA = '';
let BA2 = '';
let V1 = '';
let V2 = '';

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

async function group(type: string, subType: string): Promise<string> {
  const t = await one<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance)
     values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG, type, ['ASSET', 'OPEX'].includes(type) ? 'DEBIT' : 'CREDIT']);
  const st = await one<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
     values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [ORG, t.id, subType]);
  const g = await one<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
     values ($1, $2, $3, 1) on conflict (org_id, name) do update set display_order = 1 returning id`,
    [ORG, st.id, `G ${subType}`]);
  return g.id;
}

async function account(number: string, name: string, type: string, subType: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED')`,
    [id, ORG, await group(type, subType), number, name, type, subType]);
  return id;
}

async function balanceOf(accountId: string): Promise<number> {
  const r = await one<{ n: number | null }>(
    `select coalesce(sum(l.debit_cents - l.credit_cents), 0)::int as n
       from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
      where l.account_id = $1 and e.status = 'POSTED'`, [accountId]);
  return Number(r.n ?? 0);
}

async function setPeriod(month: number, status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE') {
  await db.query(`update public.fiscal_periods set status = $1 where org_id = $2 and location_id = $3 and period_year = 2026 and period_month = $4`, [status, ORG, A, month]);
}

/** A bill paid by CHECK from `bankGl` and released through the pay run (prepared → approved → released). */
async function released(vendor: string, amountCents: number, paymentDate = '2026-10-10', bankGl = acct.BANK, billNumber?: string) {
  const billId = crypto.randomUUID();
  await db.query(
    `insert into public.bills (id, org_id, location_id, vendor_id, bill_number, bill_date, due_date, total_cents, subtotal_cents, status)
     values ($1, $2, $3, $4, $5, $6, $6, $7, $7, 'APPROVED')`,
    [billId, ORG, A, vendor, billNumber ?? `INV-${billId.slice(0, 6)}`, paymentDate, amountCents]);
  const pay = await recordBillPayment(sb, { orgId: ORG, billId, amountCents, paymentDate, method: 'CHECK', cashAccountId: bankGl });
  const appr = await one<{ id: string }>(
    `insert into public.approvals (org_id, kind, subject_table, subject_id, amount_cents, status, prepared_by, approved_by)
     values ($1, 'AP_DISBURSEMENT', 'bills', $2, $3, 'APPROVED', $4, $5) returning id`,
    [ORG, billId, amountCents, PREP, APPR]);
  await db.query(`update public.approvals set status = 'RELEASED', released_by = $2, provider_correlation_id = $3 where id = $1`,
    [appr.id, REL, `bill_payment:${pay.payment_id}`]);
  return { billId, paymentId: pay.payment_id, approvalId: appr.id, glEntryId: pay.gl_entry_id as string };
}

async function printOne(paymentIds: string[], actor = PRINTER, extra: Partial<Parameters<typeof printChecks>[3]> = {}) {
  return printChecks(sb, ORG, actor, { bankAccountId: BA, billPaymentIds: paymentIds, checkDate: '2026-10-15', ...extra }, SOD, opts());
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  await db.query(`insert into core.organizations (id, name, slug) values ($1, 'Checks Org', $2)`, [ORG, `checks-${ORG.slice(0, 6)}`]);
  await db.query(`insert into core.locations (id, org_id, name, short_code) values ($1, $2, 'Heritage Interiors', 'HI')`, [A, ORG]);
  acct.BANK = await account('1000', 'Operating Bank', 'ASSET', 'CURRENT_ASSET');
  acct.BANK2 = await account('1010', 'Payroll Bank', 'ASSET', 'CURRENT_ASSET');
  acct.AP = await account('2000', 'Accounts Payable', 'LIABILITY', 'CURRENT_LIABILITY');
  for (let m = 1; m <= 12; m++) {
    const start = `2026-${String(m).padStart(2, '0')}-01`;
    await db.query(
      `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
       values ($1, $2, 2026, $3, $4::date, ($4::date + interval '1 month' - interval '1 day')::date, 'OPEN')`,
      [ORG, A, m, start]);
  }
  BA = crypto.randomUUID();
  BA2 = crypto.randomUUID();
  await db.query(
    `insert into public.bank_accounts (id, org_id, location_id, account_id, institution_name, account_name, account_type, account_mask)
     values ($1, $2, $3, $4, 'First Bank', 'Operating', 'CHECKING', '****6789'), ($5, $2, $3, $6, 'First Bank', 'Payroll', 'CHECKING', null)`,
    [BA, ORG, A, acct.BANK, BA2, acct.BANK2]);
  V1 = crypto.randomUUID();
  V2 = crypto.randomUUID();
  await db.query(
    `insert into core.vendors (id, org_id, name, address_line1, city, state, zip) values ($1, $3, 'Acme Supply', '1 Main St', 'Des Moines', 'IA', '50309'), ($2, $3, 'Beta Tools', null, null, null, null)`,
    [V1, V2, ORG]);
}, 150_000);

afterAll(async () => {
  await db?.close();
});

describe('AC-14 migration 182 — locks, masks, guard', () => {
  it('members can read but not write; RLS on; anon nothing', async () => {
    for (const t of ['ap_checks', 'ap_check_payments', 'bank_check_sequences', 'check_stock_profiles', 'check_print_runs', 'positive_pay_exports', 'check_sequence_events']) {
      const r = await one<{ ins: boolean; upd: boolean; del: boolean; rls: boolean; anon: boolean }>(
        `select has_table_privilege('authenticated', 'public.${t}', 'insert') ins,
                has_table_privilege('authenticated', 'public.${t}', 'update') upd,
                has_table_privilege('authenticated', 'public.${t}', 'delete') del,
                (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) rls,
                has_table_privilege('anon', 'public.${t}', 'select') anon`);
      expect(r, t).toEqual({ ins: false, upd: false, del: false, rls: true, anon: false });
    }
  });

  it('the Vault pointer and signature paths are not member-selectable; the rest is', async () => {
    const col = (c: string) => one<{ ok: boolean }>(`select has_column_privilege('authenticated', 'public.check_stock_profiles', $1, 'select') ok`, [c]);
    expect((await col('micr_secret_ref')).ok).toBe(false);
    expect((await col('signature_path')).ok).toBe(false);
    expect((await col('signature2_path')).ok).toBe(false);
    expect((await col('payer_name')).ok).toBe(true);
    expect((await col('account_mask')).ok).toBe(true);
  });

  it('print / sequence functions are service-role only', async () => {
    for (const f of ['public.issue_check_print_run(uuid, uuid, text, date, jsonb, bigint, text)', 'public.set_check_sequence(uuid, uuid, bigint, text, text)']) {
      const r = await one<{ auth: boolean; svc: boolean }>(`select has_function_privilege('authenticated', $1, 'execute') auth, has_function_privilege('service_role', $1, 'execute') svc`, [f]);
      expect(r, f).toEqual({ auth: false, svc: true });
    }
  });
});

describe('AC-1 atomic numbering', () => {
  it('20 concurrent print runs get 20 distinct consecutive numbers', async () => {
    const pays = [];
    for (let i = 0; i < 20; i++) pays.push(await released(V2, 1_000 + i, '2026-10-10', acct.BANK2));
    const results = await Promise.all(pays.map((p) =>
      sb.rpc('issue_check_print_run', {
        p_org: ORG, p_bank_account: BA2, p_actor: PRINTER, p_check_date: '2026-10-15',
        p_checks: [{ payee_vendor_id: V2, payee_name: 'Beta Tools', amount_cents: 0, payments: [{ bill_payment_id: p.paymentId }] }],
      })));
    // amount 0 is refused — every call must fail and consume nothing
    expect(results.every((r) => r.error)).toBe(true);
    expect((await one<{ n: number }>(`select count(*)::int n from public.ap_checks where bank_account_id = $1`, [BA2])).n).toBe(0);

    const ok = await Promise.all(pays.map((p, i) =>
      sb.rpc('issue_check_print_run', {
        p_org: ORG, p_bank_account: BA2, p_actor: PRINTER, p_check_date: '2026-10-15',
        p_checks: [{ payee_vendor_id: V2, payee_name: 'Beta Tools', amount_cents: 1_000 + i, payments: [{ bill_payment_id: p.paymentId }] }],
      })));
    expect(ok.map((r) => r.error)).toEqual(Array(20).fill(null));
    const nums = ok.map((r) => Number((r.data as { first_number: number }).first_number)).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => 1001 + i));
    const seq = await one<{ next_number: number }>(`select next_number from public.bank_check_sequences where bank_account_id = $1`, [BA2]);
    expect(Number(seq.next_number)).toBe(1021);
  });

  it('a stale expected-first is refused; the sequence only moves above issued numbers and the jump is logged', async () => {
    const p = await released(V2, 777, '2026-10-10', acct.BANK2);
    const stale = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA2, p_actor: PRINTER, p_check_date: '2026-10-15', p_expected_first: 1005,
      p_checks: [{ payee_vendor_id: V2, payee_name: 'Beta Tools', amount_cents: 777, payments: [{ bill_payment_id: p.paymentId }] }],
    });
    expect(stale.error?.message).toMatch(/STALE_SEQUENCE/);
    await expect(setNextCheckNumber(sb, ORG, PRINTER, BA2, 1010, 'oops', opts())).rejects.toThrow(/already used/);
    const res = await setNextCheckNumber(sb, ORG, PRINTER, BA2, 1100, 'New box of stock starts at 1100', opts());
    expect(res).toMatchObject({ status: 'applied', next_number: 1100 });
    const ev = await one<{ from_number: number; to_number: number }>(`select from_number, to_number from public.check_sequence_events where bank_account_id = $1`, [BA2]);
    expect([Number(ev.from_number), Number(ev.to_number)]).toEqual([1021, 1100]);
    const dup = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA2, p_actor: PRINTER, p_check_date: '2026-10-15', p_expected_first: 1100,
      p_checks: [{ payee_vendor_id: V2, payee_name: 'Beta Tools', amount_cents: 777, payments: [{ bill_payment_id: p.paymentId }] }],
    });
    expect(dup.error).toBeNull();
    expect(Number((dup.data as { first_number: number }).first_number)).toBe(1100);
  });

  it('AC-13 register: gaps exclude the declared skip', async () => {
    const reg = await loadRegister(sb, ORG, BA2, { filter: 'all', pageSize: 5 }, new Date('2026-10-20T12:00:00Z'));
    expect(reg.total).toBe(21);
    expect(reg.rows).toHaveLength(5);
    expect(reg.rows[0].checkNumber).toBe(1100);
    expect(reg.summary.gaps).toEqual([]);
    expect(reg.summary.outstandingCount).toBe(21);
    expect(reg.nextNumber).toBe(1101);
  });
});

describe('printing (AC-5) and SoD (AC-6)', () => {
  let p1: Awaited<ReturnType<typeof released>>;
  let p2: Awaited<ReturnType<typeof released>>;
  let p3: Awaited<ReturnType<typeof released>>;

  it('ready list groups one check per vendor and blocks the preparer / approver', async () => {
    p1 = await released(V1, 120_000, '2026-10-10', acct.BANK, 'A-100');
    p2 = await released(V1, 3_456, '2026-10-10', acct.BANK, 'A-101');
    p3 = await released(V2, 50_000, '2026-10-10', acct.BANK, 'B-200');
    const ready = await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD);
    expect(ready.checks.map((c) => [c.payeeName, c.amountCents, c.payments.length, c.printable])).toEqual([
      ['Acme Supply', 123_456, 2, true],
      ['Beta Tools', 50_000, 1, true],
    ]);
    expect(ready.checks[0].payeeAddress).toBe('1 Main St\nDes Moines, IA 50309');
    expect(ready.nextNumber).toBe(1001);
    const asPrep = await loadReadyToPrint(sb, ORG, BA, PREP, SOD);
    expect(asPrep.checks.every((c) => !c.printable && /prepared/.test(c.blockedReason ?? ''))).toBe(true);
    const asAppr = await loadReadyToPrint(sb, ORG, BA, APPR, SOD);
    expect(asAppr.checks.every((c) => !c.printable && /approved/.test(c.blockedReason ?? ''))).toBe(true);
    // the approver may print within the tenant's sole-approver threshold
    const asApprAllowed = await loadReadyToPrint(sb, ORG, BA, APPR, { soleApproverMode: true, soleApproverMaxCents: 60_000 });
    expect(asApprAllowed.checks.map((c) => c.printable)).toEqual([false, true]);
  });

  it('the preparer is refused by the app AND by the database function', async () => {
    await expect(printOne([p3.paymentId], PREP)).rejects.toMatchObject({ status: 403 });
    const r = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA, p_actor: APPR, p_check_date: '2026-10-15',
      p_checks: [{ payee_vendor_id: V2, payee_name: 'Beta Tools', amount_cents: 50_000, payments: [{ bill_payment_id: p3.paymentId }] }],
    });
    expect(r.error?.message).toMatch(/approved a payment cannot also print/);
    const n = await one<{ next_number: number }>(`select coalesce((select next_number from public.bank_check_sequences where bank_account_id = $1), 1001) as next_number`, [BA]);
    expect(Number(n.next_number)).toBe(1001); // nothing consumed
  });

  it('prints the selection: PRINTED checks, links, a run, the sequence advanced; no double print', async () => {
    const res = await printOne([p1.paymentId, p2.paymentId, p3.paymentId], PRINTER, { expectedFirstNumber: 1001 });
    expect([res.firstNumber, res.lastNumber]).toEqual([1001, 1002]);
    expect(res.checks.map((c) => [c.checkNumber, c.payeeName, c.amountCents, c.stubLines.length])).toEqual([
      [1001, 'Acme Supply', 123_456, 2],
      [1002, 'Beta Tools', 50_000, 1],
    ]);
    expect(res.checks[0].memo).toBe('Inv A-100, A-101');
    const run = await one<{ check_count: number; total_cents: number }>(`select check_count, total_cents from public.check_print_runs where id = $1`, [res.runId]);
    expect([run.check_count, Number(run.total_cents)]).toEqual([2, 173_456]);
    await expect(printOne([p1.paymentId])).rejects.toMatchObject({ status: 409 });
    const direct = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA, p_actor: PRINTER, p_check_date: '2026-10-15',
      p_checks: [{ payee_vendor_id: V1, payee_name: 'Acme', amount_cents: 120_000, payments: [{ bill_payment_id: p1.paymentId }] }],
    });
    expect(direct.error?.message).toMatch(/duplicate key|uq_ap_check_payments_current/);
    expect((await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD)).checks).toHaveLength(0);
  });

  it('refuses a payment from another bank account and mixed vendors on one check', async () => {
    const other = await released(V1, 999, '2026-10-10', acct.BANK2);
    const r = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA, p_actor: PRINTER, p_check_date: '2026-10-15',
      p_checks: [{ payee_vendor_id: V1, payee_name: 'Acme', amount_cents: 999, payments: [{ bill_payment_id: other.paymentId }] }],
    });
    expect(r.error?.message).toMatch(/different bank account/);
    const a = await released(V1, 100);
    const b = await released(V2, 200);
    const mixed = await sb.rpc('issue_check_print_run', {
      p_org: ORG, p_bank_account: BA, p_actor: PRINTER, p_check_date: '2026-10-15',
      p_checks: [{ payee_vendor_id: V1, payee_name: 'Acme', amount_cents: 300, payments: [{ bill_payment_id: a.paymentId }, { bill_payment_id: b.paymentId }] }],
    });
    expect(mixed.error?.message).toMatch(/same vendor/);
  });
});

describe('AC-7 spoil and reprint', () => {
  it('spoil consumes the number and returns the payments; the reprint gets a new number', async () => {
    const p = await released(V1, 4_200);
    const first = await printOne([p.paymentId]);
    const old = first.checks[0];
    await spoilCheck(sb, ORG, PRINTER, old.checkId, 'Printer jam', opts());
    const ready = await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD);
    const again = ready.checks.find((c) => c.payments.some((x) => x.billPaymentId === p.paymentId));
    expect(again).toBeTruthy();
    const reprint = await printOne([p.paymentId], PRINTER, { replacesCheckId: old.checkId });
    expect(reprint.checks[0].checkNumber).toBe(old.checkNumber + 1);
    const row = await one<{ replaces_check_id: string; status: string }>(`select replaces_check_id, status from public.ap_checks where id = $1`, [reprint.checks[0].checkId]);
    expect(row).toEqual({ replaces_check_id: old.checkId, status: 'PRINTED' });
    expect((await one<{ status: string }>(`select status from public.ap_checks where id = $1`, [old.checkId])).status).toBe('SPOILED');
    // an issued check can't be spoiled
    await markCheckSent(sb, ORG, PRINTER, reprint.checks[0].checkId, 'ISSUED', opts());
    await expect(spoilCheck(sb, ORG, PRINTER, reprint.checks[0].checkId, 'nope', opts())).rejects.toThrow(/Void it instead/);
  });

  it('the guard refuses edits, deletes and illegal transitions', async () => {
    const c = await one<{ id: string }>(`select id from public.ap_checks where status = 'SPOILED' limit 1`);
    await expect(db.query(`update public.ap_checks set status = 'PRINTED' where id = $1`, [c.id])).rejects.toThrow(/final/);
    const live = await one<{ id: string }>(`select id from public.ap_checks where status = 'PRINTED' limit 1`);
    await expect(db.query(`update public.ap_checks set amount_cents = amount_cents + 1 where id = $1`, [live.id])).rejects.toThrow(/never change/);
    await expect(db.query(`update public.ap_checks set check_number = 99999 where id = $1`, [live.id])).rejects.toThrow(/never change/);
    await expect(db.query(`delete from public.ap_checks where id = $1`, [live.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query(`update public.ap_checks set status = 'CLEARED' where id = $1`, [live.id])).rejects.toThrow(/cleared_chk|check constraint/);
  });
});

describe('voids', () => {
  it('AC-8 open period: payment JE voided, bill reopened, approval RETURNED, balances restored, bill can re-queue', async () => {
    const bankBefore = await balanceOf(acct.BANK);
    const apBefore = await balanceOf(acct.AP);
    const p = await released(V1, 25_000, '2026-10-12');
    expect(await balanceOf(acct.BANK)).toBe(bankBefore - 25_000);
    const printed = await printOne([p.paymentId]);
    const res = await voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'Vendor asked for ACH instead', voidDate: '2026-10-16' }, { ...opts(), now: new Date('2026-10-20T12:00:00Z') });
    expect(res.mode).toBe('VOID_IN_PLACE');
    expect(await balanceOf(acct.BANK)).toBe(bankBefore);
    expect(await balanceOf(acct.AP)).toBe(apBefore);
    expect((await one<{ status: string }>(`select status from public.gl_entries where id = $1`, [p.glEntryId])).status).toBe('VOIDED');
    const bill = await one<{ status: string; amount_paid_cents: number; paid_at: string | null }>(`select status, amount_paid_cents, paid_at from public.bills where id = $1`, [p.billId]);
    expect([bill.status, Number(bill.amount_paid_cents), bill.paid_at]).toEqual(['APPROVED', 0, null]);
    expect((await one<{ status: string }>(`select status from public.bill_payments where id = $1`, [p.paymentId])).status).toBe('VOIDED');
    expect((await one<{ status: string }>(`select status from public.approvals where id = $1`, [p.approvalId])).status).toBe('RETURNED');
    const chk = await one<{ status: string; void_kind: string; reversal_mode: string }>(`select status, void_kind, reversal_mode from public.ap_checks where id = $1`, [printed.checks[0].checkId]);
    expect(chk).toEqual({ status: 'VOIDED', void_kind: 'VOID', reversal_mode: 'VOID_IN_PLACE' });
    // the bill can be queued for payment again (one OPEN approval per bill)
    await db.query(`insert into public.approvals (org_id, kind, subject_table, subject_id, amount_cents, status, prepared_by) values ($1, 'AP_DISBURSEMENT', 'bills', $2, 25000, 'DRAFT', $3)`, [ORG, p.billId, PREP]);
    await expect(voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'again' }, opts())).rejects.toThrow(/already voided/);
  });

  it('AC-9 closed period: a REVERSING entry posts on the void date; the original stays POSTED', async () => {
    const p = await released(V2, 8_800, '2026-03-15');
    const printed = await printOne([p.paymentId], PRINTER, { checkDate: '2026-03-15' });
    await setPeriod(3, 'HARD_CLOSE');
    const bankBefore = await balanceOf(acct.BANK);
    const res = await voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'Lost in the mail', voidDate: '2026-10-16' }, { ...opts(), now: new Date('2026-10-20T12:00:00Z') });
    expect(res.mode).toBe('REVERSING_ENTRY');
    expect((await one<{ status: string }>(`select status from public.gl_entries where id = $1`, [p.glEntryId])).status).toBe('POSTED');
    const rev = await one<{ entry_type: string; entry_date: string; dr: number; cr: number }>(
      `select e.entry_type::text, e.entry_date::text, sum(l.debit_cents)::int dr, sum(l.credit_cents)::int cr
         from public.gl_entries e join public.gl_entry_lines l on l.gl_entry_id = e.id
        where e.source_ref = $1 group by e.id`, [`check_void:${p.paymentId}`]);
    expect(rev).toEqual({ entry_type: 'REVERSING', entry_date: '2026-10-16', dr: 8_800, cr: 8_800 });
    expect(await balanceOf(acct.BANK)).toBe(bankBefore + 8_800);
    expect((await one<{ status: string }>(`select status from public.bills where id = $1`, [p.billId])).status).toBe('APPROVED');
    await setPeriod(3, 'OPEN');
  });

  it('AC-9 a hard-closed void date refuses with nothing changed', async () => {
    const p = await released(V2, 6_100, '2026-04-10');
    const printed = await printOne([p.paymentId], PRINTER, { checkDate: '2026-04-10' });
    await setPeriod(4, 'HARD_CLOSE');
    await expect(voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'Wrong vendor', voidDate: '2026-04-30' }, { ...opts(), now: new Date('2026-10-20T12:00:00Z') }))
      .rejects.toThrow(/hard-closed/);
    expect((await one<{ status: string }>(`select status from public.ap_checks where id = $1`, [printed.checks[0].checkId])).status).toBe('PRINTED');
    expect((await one<{ status: string }>(`select status from public.bill_payments where id = $1`, [p.paymentId])).status).toBe('POSTED');
    await setPeriod(4, 'OPEN');
  });

  it('AC-9 retry: an existing reversing entry is reused, never posted twice', async () => {
    const p = await released(V2, 3_300, '2026-05-10');
    const printed = await printOne([p.paymentId], PRINTER, { checkDate: '2026-05-10' });
    await setPeriod(5, 'SOFT_CLOSE');
    // a previous attempt already posted the reversal, then failed before marking anything
    const pre = await postJournalEntry(sb, {
      org_id: ORG, location_id: A, entry_date: '2026-10-16', entry_type: 'REVERSING', source_module: 'BILL', source_id: p.billId,
      source_ref: `check_void:${p.paymentId}`, created_by: null, memo: 'earlier attempt',
      lines: [{ account_id: acct.BANK, debit_cents: 3_300, credit_cents: 0, location_id: A }, { account_id: acct.AP, debit_cents: 0, credit_cents: 3_300, location_id: A }],
    }, opts());
    expect(pre.success).toBe(true);
    const res = await voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'Retry', voidDate: '2026-10-16' }, { ...opts(), now: new Date('2026-10-20T12:00:00Z') });
    expect(res.reversedEntryIds).toEqual([pre.entry_id]);
    expect((await one<{ n: number }>(`select count(*)::int n from public.gl_entries where source_ref = $1`, [`check_void:${p.paymentId}`])).n).toBe(1);
    await setPeriod(5, 'OPEN');
  });
});

describe('AC-12 clearing from the bank feed + AC-10', () => {
  it('a matching bank line clears the check, links the payment, settles the approval; a cleared check cannot be voided', async () => {
    const p = await released(V1, 31_415);
    const printed = await printOne([p.paymentId]);
    const n = printed.checks[0].checkNumber;
    const wrongAmt = crypto.randomUUID();
    const right = crypto.randomUUID();
    await db.query(
      `insert into public.bank_transactions (id, org_id, bank_account_id, location_id, transaction_date, description, amount_cents, status)
       values ($1, $2, $3, $4, '2026-10-18', $5, -31416, 'PENDING'),
              ($6, $2, $7, $4, '2026-10-18', $5, -31415, 'PENDING'),
              ($8, $2, $3, $4, '2026-10-19', $5, -31415, 'PENDING')`,
      [wrongAmt, ORG, BA, A, `CHECK ${n}`, crypto.randomUUID(), BA2, right]);
    const r = await matchClearedChecks(sb, ORG, { bankAccountId: BA }, opts());
    expect(r.cleared).toBe(1);
    const chk = await one<{ status: string; cleared_bank_transaction_id: string }>(`select status, cleared_bank_transaction_id from public.ap_checks where id = $1`, [printed.checks[0].checkId]);
    expect(chk).toEqual({ status: 'CLEARED', cleared_bank_transaction_id: right });
    const line = await one<{ status: string; match_type: string; matched_bill_id: string; gl_entry_id: string }>(`select status::text, match_type, matched_bill_id, gl_entry_id from public.bank_transactions where id = $1`, [right]);
    expect(line).toEqual({ status: 'POSTED', match_type: 'BILL_PAYMENT', matched_bill_id: p.billId, gl_entry_id: p.glEntryId });
    expect((await one<{ status: string }>(`select status from public.approvals where id = $1`, [p.approvalId])).status).toBe('SETTLED');
    expect((await matchClearedChecks(sb, ORG, { bankAccountId: BA }, opts())).cleared).toBe(0); // idempotent
    await expect(voidCheck(sb, ORG, REL, printed.checks[0].checkId, { reason: 'too late' }, opts())).rejects.toThrow(/cleared the bank/);
  });
});

describe('check stock + AC-11 positive pay', () => {
  it('stores MICR numbers in the secret store with last-4 masks only; refuses a mismatched account', async () => {
    await expect(setMicrNumbers(sb, ORG, REL, BA, { routing: '021000021', account: '555501234' }, secrets, opts())).rejects.toThrow(/end in 6789/);
    await expect(setMicrNumbers(sb, ORG, REL, BA, { routing: '021000022', account: '123456789' }, secrets, opts())).rejects.toThrow(/checksum/);
    const m = await setMicrNumbers(sb, ORG, REL, BA, { routing: '021000021', account: '123456789' }, secrets, opts());
    expect(m).toEqual({ routingMask: '*****0021', accountMask: '*****6789' });
    const row = await one<{ routing_mask: string; account_mask: string; micr_secret_ref: string }>(`select routing_mask, account_mask, micr_secret_ref from public.check_stock_profiles where bank_account_id = $1`, [BA]);
    expect(JSON.stringify(row)).not.toContain('123456789');
    expect(secrets.micr.get(row.micr_secret_ref)).toEqual({ routing: '021000021', account: '123456789' });
    await expect(setSignature(sb, ORG, REL, BA, 1, new Uint8Array([1, 2, 3, 4]), secrets, opts())).rejects.toThrow(/PNG or JPEG/);
    await setSignature(sb, ORG, REL, BA, 1, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), secrets, opts());
    await saveStockSettings(sb, ORG, REL, BA, {
      layout: 'VOUCHER_MIDDLE', offsetXPt: 2.5, offsetYPt: -100, payerName: 'Heritage Interiors LLC', payerAddress: '9 Elm St\nAmes, IA 50010', logoUrl: null,
      bankName: 'First Bank', bankAddress: null, bankFraction: '12-3456/1234', secondSignatureOverCents: 1_000_000, maxCheckCents: null, voidAfterDays: 90,
      staleAfterDays: 180, oneCheckPerBill: false, auxOnUsDigits: 6, positivePayFormat: 'CHASE_STYLE_FIXED', positivePayMapping: null,
    }, opts());
    const setup = await loadPrintSetup(sb, sb, ORG, BA, secrets);
    expect(setup).toMatchObject({ layout: 'VOUCHER_MIDDLE', offsetXPt: 2.5, offsetYPt: -72, routing: '021000021', account: '123456789', payerName: 'Heritage Interiors LLC' });
    expect(setup.signature?.format).toBe('png');
    await expect(loadPrintSetup(sb, sb, ORG, BA2, secrets)).rejects.toThrow(/routing and account numbers/);
  });

  it('since-last file carries issues + voids with the full account number; logs the reveal; stamps; then nothing new', async () => {
    const reveals: string[][] = [];
    const log = async (e: { subjectIds: string[] }) => { reveals.push(e.subjectIds); return true; };
    const preview = await generatePositivePay(sb, ORG, REL, { bankAccountId: BA, mode: 'SINCE_LAST', preview: true }, secrets, log, opts());
    expect(reveals).toHaveLength(0);
    const out = (await generatePositivePay(sb, ORG, REL, { bankAccountId: BA, mode: 'SINCE_LAST' }, secrets, log, opts())) as PositivePayOutput;
    expect(out.issueCount).toBe(preview.issueCount);
    expect(out.voidCount).toBeGreaterThanOrEqual(3); // spoiled + voided checks
    const lines = out.content.split('\r\n').filter(Boolean);
    expect(lines.every((l) => l.length === 80 && l.startsWith('00000123456789'))).toBe(true);
    expect(lines.filter((l) => l[42] === 'V')).toHaveLength(out.voidCount);
    expect(reveals).toEqual([[BA]]);
    await expect(generatePositivePay(sb, ORG, REL, { bankAccountId: BA, mode: 'SINCE_LAST' }, secrets, log, opts())).rejects.toThrow(/no new checks/);
    // a later void is the only record in the next file
    const live = await one<{ id: string; check_number: number }>(`select id, check_number from public.ap_checks where bank_account_id = $1 and status in ('PRINTED','ISSUED') order by check_number limit 1`, [BA]);
    await voidCheck(sb, ORG, REL, live.id, { reason: 'Duplicate', voidDate: '2026-10-20' }, { ...opts(), now: new Date('2026-10-21T12:00:00Z') });
    const next = (await generatePositivePay(sb, ORG, REL, { bankAccountId: BA, mode: 'SINCE_LAST' }, secrets, log, opts())) as PositivePayOutput;
    expect([next.issueCount, next.voidCount]).toEqual([0, 1]);
    expect(next.content.slice(14, 24)).toBe(String(live.check_number).padStart(10, '0'));
  });

  it('a failed reveal log means no file', async () => {
    const p = await released(V1, 1_234);
    await printOne([p.paymentId]);
    await expect(generatePositivePay(sb, ORG, REL, { bankAccountId: BA, mode: 'SINCE_LAST' }, secrets, async () => false, opts())).rejects.toBeInstanceOf(CheckError);
    const stamped = await one<{ n: number }>(`select count(*)::int n from public.ap_checks where bank_account_id = $1 and positive_pay_issue_export_id is null and status <> 'SPOILED'`, [BA]);
    expect(stamped.n).toBeGreaterThan(0);
  });
});

describe('security review M1 — spoil only by the printer, within 24 h', () => {
  it('another user, or the printer after 24 h, is refused (app); the DB guard refuses a direct spoil by someone else', async () => {
    const p = await released(V1, 3_100);
    const printed = await printOne([p.paymentId]);
    const id = printed.checks[0].checkId;
    await expect(spoilCheck(sb, ORG, 'user_other', id, 'Printer jam', opts())).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Only the person who printed/) });
    const later = new Date(Date.now() + 25 * 3600_000);
    await expect(spoilCheck(sb, ORG, PRINTER, id, 'Printer jam', { ...opts(), now: later })).rejects.toThrow(/more than 24 hours ago.*Void it instead/);
    await expect(db.query(
      `update public.ap_checks set status = 'SPOILED', void_kind = 'SPOIL', voided_at = now(), voided_by = 'user_other', void_reason = 'x', reversal_mode = 'NONE' where id = $1`, [id],
    )).rejects.toThrow(/Only the person who printed/);
    // the printer, inside the window, may
    const res = await spoilCheck(sb, ORG, PRINTER, id, 'Printer jam', opts());
    expect(res.payments).toBe(1);
  });
});

describe('security review M3 — vendor holds re-checked at print time', () => {
  it('a bank change opened after release keeps the payment off the print run; a compliance lapse too, unless a one-time override was spent on this bill', async () => {
    const V3 = crypto.randomUUID();
    await db.query(`insert into core.vendors (id, org_id, name, address_line1, city, state, zip) values ($1, $2, 'Gamma Lumber', '5 Oak', 'Ames', 'IA', '50010')`, [V3, ORG]);
    const p = await released(V3, 4_200);
    const bc = await one<{ id: string }>(
      `insert into public.vendor_bank_change_verifications (org_id, vendor_id, source, new_account_mask, opened_by) values ($1, $2, 'manual', '****9999', 'user_x') returning id`, [ORG, V3]);
    let ready = await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD);
    const held = ready.checks.find((c) => c.vendorId === V3);
    expect(held).toMatchObject({ printable: false, blockKind: 'vendor_hold' });
    expect(held?.blockedReason).toMatch(/bank details changed/);
    expect(ready.excluded.vendorHold).toBeGreaterThanOrEqual(1);
    await expect(printOne([p.paymentId])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/bank details changed/) });

    await db.query(`update public.vendor_bank_change_verifications set status = 'cancelled', decided_by = 'user_x2', decided_at = now(), decision_reason = 'Duplicate request' where id = $1`, [bc.id]);
    await db.query(`insert into public.vendor_compliance_docs (org_id, vendor_id, doc_type, status) values ($1, $2, 'W9', 'MISSING')`, [ORG, V3]);
    ready = await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD);
    expect(ready.checks.find((c) => c.vendorId === V3)?.blockedReason).toMatch(/compliance hold/);

    await db.query(
      `insert into public.vendor_payment_holds (org_id, vendor_id, hold_type, reason, created_by, consumed_at, consumed_bill_id)
       values ($1, $2, 'ONE_TIME', 'Paid under override', $3, now(), $4)`, [ORG, V3, crypto.randomUUID(), p.billId]);
    ready = await loadReadyToPrint(sb, ORG, BA, PRINTER, SOD);
    expect(ready.checks.find((c) => c.vendorId === V3)).toMatchObject({ printable: true, blockKind: null });
    const out = await printOne([p.paymentId]);
    expect(out.checks).toHaveLength(1);
  });
});

describe('security review M9 — check stock security changes', () => {
  const ADM1 = 'user_admin_one';
  const ADM2 = 'user_admin_two';
  const CLERK = 'user_clerk_only';
  beforeAll(async () => {
    for (const [clerk, role] of [[ADM1, 'admin'], [ADM2, 'admin'], [CLERK, 'bookkeeper']] as const) {
      const u = await one<{ id: string }>(`insert into core.users (clerk_user_id, email) values ($1, $2) returning id`, [clerk, `${clerk}@example.com`]);
      await db.query(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, $3, 'active')`, [u.id, ORG, role]);
    }
  });

  it('a signature change holds the changer from printing (app + DB), notifies admins, and only a different admin can lift it', async () => {
    await setSignature(sb, ORG, ADM1, BA, 2, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), secrets, opts());
    const change = await one<{ id: string; change_kind: string; changed_by: string }>(
      `select id, change_kind, changed_by from public.check_stock_security_changes where bank_account_id = $1 and changed_by = $2`, [BA, ADM1]);
    expect(change.change_kind).toBe('SIGNATURE');
    const notes = await one<{ n: number }>(`select count(*)::int n from core.notifications where org_id = $1 and kind = 'checks.stock_security_change'`, [ORG]);
    expect(notes.n).toBeGreaterThanOrEqual(2); // both admins

    const p = await released(V1, 2_500);
    expect(await printSecurityHold(sb, ORG, BA, ADM1)).not.toBeNull();
    const ready = await loadReadyToPrint(sb, ORG, BA, ADM1, SOD);
    expect(ready.securityHold?.reason).toMatch(/Another admin has to confirm/);
    expect(ready.checks.every((c) => !c.printable)).toBe(true);
    await expect(printOne([p.paymentId], ADM1)).rejects.toMatchObject({ status: 409 });
    // the DB function refuses too, even if the app check were skipped
    await expect(db.query(
      `select public.issue_check_print_run($1, $2, $3, '2026-10-15', $4::jsonb)`,
      [ORG, BA, ADM1, JSON.stringify([{ payee_vendor_id: V1, payee_name: 'Acme', amount_cents: 2500, payments: [{ bill_payment_id: p.paymentId }] }])],
    )).rejects.toThrow(/check security settings/);
    // someone else is not held
    expect(await printSecurityHold(sb, ORG, BA, PRINTER)).toBeNull();

    // the changer can't confirm; a non-admin can't; a different admin can
    expect(await isTenantAdmin(sb, ORG, ADM2)).toBe(true);
    expect(await isTenantAdmin(sb, ORG, CLERK)).toBe(false);
    await expect(confirmSecurityChange(sb, sb, ORG, ADM1, change.id, true)).rejects.toThrow(/different admin/);
    await expect(confirmSecurityChange(sb, sb, ORG, CLERK, change.id, false)).rejects.toThrow(/tenant admin/);
    await expect(db.query(`update public.check_stock_security_changes set confirmed_by = changed_by, confirmed_at = now() where id = $1`, [change.id])).rejects.toThrow();
    await confirmSecurityChange(sb, sb, ORG, ADM2, change.id, true);
    expect(await printSecurityHold(sb, ORG, BA, ADM1)).toBeNull();
    await expect(confirmSecurityChange(sb, sb, ORG, ADM2, change.id, true)).rejects.toThrow(/already confirmed/);
    const out = await printOne([p.paymentId], ADM1);
    expect(out.checks).toHaveLength(1);
  });

  it('loosening a threshold or new bank numbers holds the changer; first-time tightening does not; the hold expires after 24 h', async () => {
    const base = {
      layout: 'VOUCHER_MIDDLE' as const, offsetXPt: 0, offsetYPt: 0, payerName: null, payerAddress: null, logoUrl: null,
      bankName: null, bankAddress: null, bankFraction: null, voidAfterDays: 90, staleAfterDays: 180, oneCheckPerBill: false,
      auxOnUsDigits: 6, positivePayFormat: 'GENERIC_CSV' as const, positivePayMapping: null,
    };
    // second-signature threshold 1,000,000 (set earlier) removed → a change; max-check null → 500,000 is a tightening
    await saveStockSettings(sb, ORG, ADM2, BA, { ...base, secondSignatureOverCents: null, maxCheckCents: 500_000 }, opts());
    const kinds = (await db.query<{ change_kind: string }>(`select change_kind from public.check_stock_security_changes where changed_by = $1 order by changed_at`, [ADM2])).rows.map((r) => r.change_kind);
    expect(kinds).toEqual(['SECOND_SIGNATURE_THRESHOLD']);
    // raising the max → a change
    await saveStockSettings(sb, ORG, ADM2, BA, { ...base, secondSignatureOverCents: null, maxCheckCents: 900_000 }, opts());
    await setMicrNumbers(sb, ORG, ADM2, BA, { routing: '021000021', account: '123456789' }, secrets, opts());
    const all = (await db.query<{ change_kind: string }>(`select change_kind from public.check_stock_security_changes where changed_by = $1 order by changed_at`, [ADM2])).rows.map((r) => r.change_kind);
    expect(all.sort()).toEqual(['BANK_NUMBERS', 'MAX_CHECK_AMOUNT', 'SECOND_SIGNATURE_THRESHOLD']);
    expect(await printSecurityHold(sb, ORG, BA, ADM2)).not.toBeNull();
    expect(await printSecurityHold(sb, ORG, BA, ADM2, new Date(Date.now() + 25 * 3600_000))).toBeNull();
    // members can read but never write the table
    expect((await db.query(`select relrowsecurity from pg_class where oid = 'public.check_stock_security_changes'::regclass`)).rows[0]).toEqual({ relrowsecurity: true });
  });
});
