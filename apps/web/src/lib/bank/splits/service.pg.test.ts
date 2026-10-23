/**
 * Bank / card feed splits against the REAL schema (PGlite replay of every migration,
 * incl. 177): balance trigger, period lock, posted immutability (153), the source_ref
 * unique index (064), the 177 posted-split guard and write lock.
 *
 * FPB-bank-feed-splits acceptance: AC-2 N-line balanced post · AC-3/4 cross-company
 * due-to/due-from both sides · AC-5 validation before any write · AC-6 period lock in the
 * affiliate leaves nothing posted · AC-7 no double post · AC-8 rule application ·
 * AC-9 reverse → draft → re-post.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from '@/test/pg';
import { pgSupabase } from '@/test/pg-supabase';
import type { SplitLineInput } from '@/lib/validations/bank-splits';
import {
  loadFeedTxn,
  loadSplitRows,
  postSplit,
  reverseFeedPosting,
  rowsToLineInputs,
  saveDraftSplit,
  saveSplitRule,
  suggestSplit,
  fetchSplitSummaries,
  validateSplitLines,
  SplitError,
  type FeedTxn,
} from './service';

let db: PGlite;
let sb: SupabaseClient;
const opts = () => ({ writer: sb });

const ORG = crypto.randomUUID();
const OTHER_ORG = crypto.randomUUID();
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const acct: Record<string, string> = {};
let bankAcctId = '';
let cardAcctId = '';
let jobA = '';
let jobB = '';
let vendorId = '';
let deptA = '';
let foreignAcct = '';

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

async function group(org: string, type: string, subType: string): Promise<string> {
  const t = await one<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance)
     values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, type, ['ASSET', 'COGS', 'OPEX', 'OTHER'].includes(type) ? 'DEBIT' : 'CREDIT']);
  const st = await one<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
     values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, t.id, subType]);
  const g = await one<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
     values ($1, $2, $3, 1) on conflict (org_id, name) do update set display_order = 1 returning id`,
    [org, st.id, `G ${subType}`]);
  return g.id;
}

async function account(org: string, number: string, name: string, type: string, subType: string, companyLoc: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type,
       is_active, approval_status, is_company_specific, company_location_id)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED', $8, $9)`,
    [id, org, await group(org, type, subType), number, name, type, subType, companyLoc !== null, companyLoc]);
  return id;
}

async function periods(loc: string, hardCloseMonth: number | null = null) {
  for (let m = 1; m <= 12; m++) {
    const start = `2026-${String(m).padStart(2, '0')}-01`;
    await db.query(
      `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
       values ($1, $2, 2026, $3, $4::date, ($4::date + interval '1 month' - interval '1 day')::date, $5)`,
      [ORG, loc, m, start, m === hardCloseMonth ? 'HARD_CLOSE' : 'OPEN']);
  }
}

async function mkTxn(amountCents: number, date = '2026-06-10', desc = 'VERIZON WIRELESS 4411', bank = bankAcctId): Promise<FeedTxn> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.bank_transactions (id, org_id, bank_account_id, location_id, transaction_date, description, amount_cents, status, ai_vendor_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'CATEGORIZED', $8)`,
    [id, ORG, bank, A, date, desc, amountCents, vendorId]);
  const t = await loadFeedTxn(sb, ORG, id);
  if (!t) throw new Error('seed txn not found');
  return t;
}

async function post(txn: FeedTxn, lines: SplitLineInput[]) {
  const resolved = await validateSplitLines(sb, ORG, txn, lines, opts());
  return postSplit(sb, { orgId: ORG, txn, lines: resolved, memo: `Bank feed: ${txn.description}`, vendorId }, opts());
}

async function entryTotals(entryId: string) {
  return one<{ dr: number; cr: number; n: number }>(
    `select sum(debit_cents)::int as dr, sum(credit_cents)::int as cr, count(*)::int as n from public.gl_entry_lines where gl_entry_id = $1`, [entryId]);
}

async function postedBankFeedEntries(txnId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `select count(*)::int as n from public.gl_entries where source_module = 'BANK_FEED' and source_id = $1 and status = 'POSTED'`, [txnId]);
  return r.n;
}

async function balanceOf(accountId: string, loc: string): Promise<number> {
  const r = await one<{ n: number | null }>(
    `select coalesce(sum(l.debit_cents - l.credit_cents), 0)::int as n
       from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
      where l.account_id = $1 and l.location_id = $2 and e.status = 'POSTED'`, [accountId, loc]);
  return Number(r.n ?? 0);
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  for (const [org, slug] of [[ORG, 'splits'], [OTHER_ORG, 'other']] as const) {
    await db.query(`insert into core.organizations (id, name, slug) values ($1, $2, $3)`, [org, `Org ${slug}`, `${slug}-${org.slice(0, 6)}`]);
  }
  await db.query(`insert into core.locations (id, org_id, name, short_code) values ($1, $2, 'Heating Co', 'HC'), ($3, $2, 'Plumbing Co', 'PC')`, [A, ORG, B]);
  acct.BANK = await account(ORG, '1000', 'Operating Bank', 'ASSET', 'CURRENT_ASSET');
  acct.CARD = await account(ORG, '2100', 'Credit Card Payable', 'LIABILITY', 'CURRENT_LIABILITY');
  acct.IC_AR = await account(ORG, '1160', 'Intercompany Receivable', 'ASSET', 'CURRENT_ASSET');
  acct.IC_AP = await account(ORG, '2020', 'Intercompany Payable', 'LIABILITY', 'CURRENT_LIABILITY');
  acct.PHONE = await account(ORG, '6100', 'Telephone', 'OPEX', 'OPERATING_EXPENSE');
  acct.SUPPLIES = await account(ORG, '6200', 'Supplies', 'OPEX', 'OPERATING_EXPENSE');
  acct.MATERIALS = await account(ORG, '5100', 'Materials', 'COGS', 'COST_OF_GOODS_SOLD');
  acct.REVENUE = await account(ORG, '4000', 'Service Revenue', 'REVENUE', 'REVENUE');
  acct.B_ONLY = await account(ORG, '6150', 'Plumbing Co phones', 'OPEX', 'OPERATING_EXPENSE', B);
  foreignAcct = await account(OTHER_ORG, '6100', 'Other tenant phone', 'OPEX', 'OPERATING_EXPENSE');
  await periods(A);
  await periods(B, 3); // Plumbing Co: March 2026 hard-closed
  bankAcctId = crypto.randomUUID();
  cardAcctId = crypto.randomUUID();
  await db.query(
    `insert into public.bank_accounts (id, org_id, location_id, account_id, institution_name, account_name, account_type)
     values ($1, $2, $3, $4, 'First Bank', 'Operating', 'CHECKING'), ($5, $2, $3, $6, 'Amex', 'Company card', 'CREDIT_CARD')`,
    [bankAcctId, ORG, A, acct.BANK, cardAcctId, acct.CARD]);
  vendorId = crypto.randomUUID();
  await db.query(`insert into core.vendors (id, org_id, name) values ($1, $2, 'Verizon')`, [vendorId, ORG]);
  jobA = crypto.randomUUID();
  jobB = crypto.randomUUID();
  await db.query(
    `insert into core.jobs (id, org_id, location_id, job_number, name) values ($1, $2, $3, 'J-100', 'Main St'), ($4, $2, $5, 'J-200', 'Oak Ave')`,
    [jobA, ORG, A, jobB, B]);
  deptA = crypto.randomUUID();
  await db.query(`insert into core.departments (id, org_id, name, code, location_id) values ($1, $2, 'HVAC', 'HVAC', $3)`, [deptA, ORG, A]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 177 — tables are locked to service writes', () => {
  it('members can read but not write; RLS is on', async () => {
    for (const t of ['bank_transaction_splits', 'split_rules']) {
      const r = await one<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; rls: boolean }>(
        `select has_table_privilege('authenticated', 'public.${t}', 'select') sel,
                has_table_privilege('authenticated', 'public.${t}', 'insert') ins,
                has_table_privilege('authenticated', 'public.${t}', 'update') upd,
                has_table_privilege('authenticated', 'public.${t}', 'delete') del,
                (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) rls`);
      expect(r).toEqual({ sel: true, ins: false, upd: false, del: false, rls: true });
      const anon = await one<{ sel: boolean }>(`select has_table_privilege('anon', 'public.${t}', 'select') sel`);
      expect(anon.sel).toBe(false);
    }
  });
});

describe('posting a split', () => {
  it('AC-2: a 3-line same-company split posts ONE balanced JE with per-line dimensions and job cost', async () => {
    const txn = await mkTxn(-18_640);
    const res = await post(txn, [
      { amount_cents: 10_000, account_id: acct.PHONE, department_id: deptA, memo: 'HVAC phones' },
      { amount_cents: 6_000, account_id: acct.PHONE },
      { amount_cents: 2_640, account_id: acct.MATERIALS, job_id: jobA },
    ]);
    expect(res.entries).toHaveLength(1);
    const t = await entryTotals(res.entries[0].entry_id);
    expect(t).toEqual({ dr: 18_640, cr: 18_640, n: 4 });
    const lines = (await db.query<{ account_id: string; department_id: string | null; job_id: string | null; memo: string | null; debit_cents: number }>(
      `select account_id, department_id, job_id, memo, debit_cents from public.gl_entry_lines where gl_entry_id = $1 order by line_number`, [res.entries[0].entry_id])).rows;
    expect(lines[0]).toMatchObject({ department_id: deptA, memo: 'HVAC phones' });
    expect(lines[2]).toMatchObject({ job_id: jobA });
    const rows = await loadSplitRows(sb, ORG, txn.id);
    expect(rows.map((r) => [r.status, r.amount_cents, r.posting_version])).toEqual([['POSTED', 10_000, 1], ['POSTED', 6_000, 1], ['POSTED', 2_640, 1]]);
    expect(rows.every((r) => r.gl_entry_id === res.entries[0].entry_id)).toBe(true);
    const after = await loadFeedTxn(sb, ORG, txn.id);
    expect(after).toMatchObject({ status: 'POSTED', gl_entry_id: res.entries[0].entry_id });
    const jc = await one<{ n: number; amt: number }>(`select count(*)::int n, sum(amount_cents)::int amt from public.job_cost_entries where job_id = $1`, [jobA]);
    expect(jc).toEqual({ n: 1, amt: 2_640 });
    const summary = await fetchSplitSummaries(sb, [txn.id]);
    expect(summary.get(txn.id)).toEqual({ lines: 3, companies: 1, status: 'POSTED' });
  });

  it('AC-3: a cross-company CARD outflow books due-from in A and due-to in B, each entry balanced', async () => {
    const icArBefore = await balanceOf(acct.IC_AR, A);
    const icApBefore = await balanceOf(acct.IC_AP, B);
    const txn = await mkTxn(-10_000, '2026-06-12', 'AMEX HOME DEPOT', cardAcctId);
    expect(txn.cash_account_id).toBe(acct.CARD);
    const res = await post(txn, [
      { amount_cents: 6_000, account_id: acct.SUPPLIES },
      { amount_cents: 3_000, account_id: acct.B_ONLY, allocation_location_id: B },
      { amount_cents: 1_000, account_id: acct.MATERIALS, allocation_location_id: B, job_id: jobB },
    ]);
    expect(res.entries.map((e) => e.location_id)).toEqual([A, B]);
    for (const e of res.entries) {
      const t = await entryTotals(e.entry_id);
      expect(t.dr).toBe(t.cr);
    }
    expect((await balanceOf(acct.IC_AR, A)) - icArBefore).toBe(4_000);
    expect((await balanceOf(acct.IC_AP, B)) - icApBefore).toBe(-4_000);
    const cp = await one<{ a: string; b: string }>(
      `select (select counterparty_location_id from public.gl_entry_lines where gl_entry_id = $1 and account_id = $3) a,
              (select counterparty_location_id from public.gl_entry_lines where gl_entry_id = $2 and account_id = $4) b`,
      [res.entries[0].entry_id, res.entries[1].entry_id, acct.IC_AR, acct.IC_AP]);
    expect(cp).toEqual({ a: B, b: A });
    const card = await one<{ cr: number }>(`select credit_cents::int cr from public.gl_entry_lines where gl_entry_id = $1 and account_id = $2`, [res.entries[0].entry_id, acct.CARD]);
    expect(card.cr).toBe(10_000);
    const summary = await fetchSplitSummaries(sb, [txn.id]);
    expect(summary.get(txn.id)).toEqual({ lines: 3, companies: 2, status: 'POSTED' });
  });

  it('AC-4: a cross-company inflow mirrors it (due-to in A, due-from in B)', async () => {
    const icApA = await balanceOf(acct.IC_AP, A);
    const icArB = await balanceOf(acct.IC_AR, B);
    const txn = await mkTxn(5_000, '2026-06-15', 'DEPOSIT');
    const res = await post(txn, [
      { amount_cents: 2_000, account_id: acct.REVENUE },
      { amount_cents: 3_000, account_id: acct.REVENUE, allocation_location_id: B },
    ]);
    expect(res.entries).toHaveLength(2);
    for (const e of res.entries) {
      const t = await entryTotals(e.entry_id);
      expect(t.dr).toBe(t.cr);
    }
    expect((await balanceOf(acct.IC_AP, A)) - icApA).toBe(-3_000);
    expect((await balanceOf(acct.IC_AR, B)) - icArB).toBe(3_000);
  });
});

describe('gates', () => {
  it('AC-5: bad splits are refused before any GL write', async () => {
    const txn = await mkTxn(-1_000, '2026-06-20', 'MIXED');
    const bad: Array<[SplitLineInput[], RegExp]> = [
      [[{ amount_cents: 600, account_id: acct.PHONE }, { amount_cents: 300, account_id: acct.PHONE }], /short/],
      [[{ amount_cents: 1_000, account_id: foreignAcct }], /not part of this organization/],
      [[{ amount_cents: 1_000, account_id: acct.B_ONLY }], /belongs to another company/],
      [[{ amount_cents: 1_000, account_id: acct.MATERIALS, allocation_location_id: B, job_id: jobA }], /job belongs to another company/],
      [[{ amount_cents: 1_000, account_id: acct.MATERIALS }], /COGS lines need a job/],
      [[{ amount_cents: 1_000, account_id: acct.BANK }], /bank \/ card account itself/],
    ];
    for (const [lines, re] of bad) {
      await expect(post(txn, lines)).rejects.toThrow(re);
    }
    expect(await postedBankFeedEntries(txn.id)).toBe(0);
  });

  it('AC-6: a hard-closed period in the affiliate rejects the whole split; nothing stays posted', async () => {
    const txn = await mkTxn(-2_000, '2026-03-14', 'MARCH CHARGE');
    await expect(
      post(txn, [
        { amount_cents: 1_500, account_id: acct.SUPPLIES },
        { amount_cents: 500, account_id: acct.SUPPLIES, allocation_location_id: B },
      ]),
    ).rejects.toThrow(/hard-closed|closed period/i);
    expect(await postedBankFeedEntries(txn.id)).toBe(0);
    expect((await loadFeedTxn(sb, ORG, txn.id))?.status).toBe('CATEGORIZED');
    expect(await loadSplitRows(sb, ORG, txn.id)).toHaveLength(0);
  });

  it('AC-7: approving twice never double-posts (DB unique source_ref is the guarantor)', async () => {
    const txn = await mkTxn(-4_000, '2026-06-22', 'DOUBLE CLICK');
    const lines: SplitLineInput[] = [
      { amount_cents: 2_500, account_id: acct.PHONE },
      { amount_cents: 1_500, account_id: acct.SUPPLIES },
    ];
    const results = await Promise.allSettled([post(txn, lines), post(txn, lines)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SplitError);
    expect((rejected.reason as SplitError).status).toBe(409);
    expect(await postedBankFeedEntries(txn.id)).toBe(1);
    // A stale retry (the caller's copy still says CATEGORIZED) is refused too.
    await expect(post(txn, lines)).rejects.toMatchObject({ status: 409 });
    expect(await postedBankFeedEntries(txn.id)).toBe(1);
  });

  it('a posted split line cannot be deleted or rewritten directly', async () => {
    const txn = await mkTxn(-3_000, '2026-06-24', 'IMMUTABLE');
    await post(txn, [{ amount_cents: 2_000, account_id: acct.PHONE }, { amount_cents: 1_000, account_id: acct.SUPPLIES }]);
    await expect(db.query(`delete from public.bank_transaction_splits where bank_transaction_id = $1`, [txn.id])).rejects.toThrow(/posted split line/);
    await expect(db.query(`update public.bank_transaction_splits set amount_cents = 1 where bank_transaction_id = $1 and line_no = 1`, [txn.id])).rejects.toThrow(/immutable/);
  });
});

describe('edit before and after posting', () => {
  it('saves, replaces and clears a draft split; refuses once posted', async () => {
    const txn = await mkTxn(-900, '2026-06-25', 'DRAFTY');
    await saveDraftSplit(sb, { orgId: ORG, txn, lines: [{ amount_cents: 450, account_id: acct.PHONE }, { amount_cents: 450, account_id: acct.SUPPLIES }] }, opts());
    expect((await loadSplitRows(sb, ORG, txn.id)).map((r) => r.status)).toEqual(['DRAFT', 'DRAFT']);
    await saveDraftSplit(sb, { orgId: ORG, txn, lines: [{ amount_cents: 300, account_id: acct.PHONE }, { amount_cents: 300, account_id: acct.PHONE }, { amount_cents: 300, account_id: acct.SUPPLIES }] }, opts());
    expect(await loadSplitRows(sb, ORG, txn.id)).toHaveLength(3);
    expect((await fetchSplitSummaries(sb, [txn.id])).get(txn.id)).toEqual({ lines: 3, companies: 1, status: 'DRAFT' });
    await saveDraftSplit(sb, { orgId: ORG, txn, lines: [] }, opts());
    expect(await loadSplitRows(sb, ORG, txn.id)).toHaveLength(0);
    await expect(saveDraftSplit(sb, { orgId: ORG, txn, lines: [{ amount_cents: 800, account_id: acct.PHONE }] }, opts())).rejects.toThrow(/short/);

    // A saved draft is what a plain approve posts.
    await saveDraftSplit(sb, { orgId: ORG, txn, lines: [{ amount_cents: 600, account_id: acct.PHONE }, { amount_cents: 300, account_id: acct.SUPPLIES }] }, opts());
    const draft = await loadSplitRows(sb, ORG, txn.id);
    const res = await post(txn, rowsToLineInputs(draft));
    expect((await entryTotals(res.entries[0].entry_id)).n).toBe(3);
    const posted = await loadFeedTxn(sb, ORG, txn.id);
    await expect(saveDraftSplit(sb, { orgId: ORG, txn: posted as FeedTxn, lines: [] }, opts())).rejects.toMatchObject({ status: 409 });
  });

  it('AC-9: reverse voids every company entry, reopens the line with the split as a draft, and a re-post is fresh', async () => {
    const icArBefore = await balanceOf(acct.IC_AR, A);
    const txn = await mkTxn(-8_000, '2026-06-26', 'REVERSE ME');
    const first = await post(txn, [
      { amount_cents: 5_000, account_id: acct.MATERIALS, job_id: jobA },
      { amount_cents: 3_000, account_id: acct.SUPPLIES, allocation_location_id: B },
    ]);
    expect(first.entries).toHaveLength(2);
    expect(await postedBankFeedEntries(txn.id)).toBe(2);

    const posted = (await loadFeedTxn(sb, ORG, txn.id)) as FeedTxn;
    const rev = await reverseFeedPosting(sb, { orgId: ORG, txn: posted, reason: 'wrong job' }, opts());
    expect(rev.voided).toHaveLength(2);
    expect(rev.version).toBe(2);
    expect(await postedBankFeedEntries(txn.id)).toBe(0);
    expect(await balanceOf(acct.IC_AR, A)).toBe(icArBefore);
    const reopened = (await loadFeedTxn(sb, ORG, txn.id)) as FeedTxn;
    expect(reopened).toMatchObject({ status: 'CATEGORIZED', gl_entry_id: null });
    const draft = await loadSplitRows(sb, ORG, txn.id);
    expect(draft.map((r) => [r.status, r.posting_version, r.gl_entry_id])).toEqual([['DRAFT', 2, null], ['DRAFT', 2, null]]);
    const jc = await one<{ n: number }>(
      `select count(*)::int n from public.job_cost_entries j join public.gl_entry_lines l on l.id = j.gl_entry_line_id where l.gl_entry_id = $1`,
      [first.entries[0].entry_id]);
    expect(jc.n).toBe(0);

    const again = await post(reopened, rowsToLineInputs(draft));
    expect(again.version).toBe(2);
    expect(await postedBankFeedEntries(txn.id)).toBe(2);
    expect((await balanceOf(acct.IC_AR, A)) - icArBefore).toBe(3_000);
    const refs = (await db.query<{ source_ref: string; status: string }>(
      `select source_ref, status from public.gl_entries where source_id = $1 order by created_at, source_ref`, [txn.id])).rows;
    expect(refs.filter((r) => r.status === 'POSTED').map((r) => r.source_ref).sort()).toEqual([`bankfeed:${txn.id}:v2`, `bankfeed:${txn.id}:v2:${B}`]);
  });

  it('refuses to reverse a hard-closed posting as a whole', async () => {
    const txn = await mkTxn(-1_000, '2026-07-02', 'JULY');
    await post(txn, [{ amount_cents: 1_000, account_id: acct.SUPPLIES }]);
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and location_id = $2 and period_month = 7`, [ORG, A]);
    const posted = (await loadFeedTxn(sb, ORG, txn.id)) as FeedTxn;
    await expect(reverseFeedPosting(sb, { orgId: ORG, txn: posted, reason: 'too late' }, opts())).rejects.toThrow(/hard-closed/);
    expect(await postedBankFeedEntries(txn.id)).toBe(1);
  });
});

describe('reversal only undoes what the bank feed posted for this line', () => {
  it('refuses a reconciled line or one with a matched receipt; nothing is voided', async () => {
    const txn = await mkTxn(-2_000, '2026-06-11', 'RECONCILED');
    await post(txn, [{ amount_cents: 2_000, account_id: acct.SUPPLIES }]);
    await db.query(`update public.bank_transactions set reconciled_at = now() where id = $1`, [txn.id]);
    let posted = (await loadFeedTxn(sb, ORG, txn.id)) as FeedTxn;
    await expect(reverseFeedPosting(sb, { orgId: ORG, txn: posted, reason: 'oops' }, opts())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reconciliation/) });
    expect(await postedBankFeedEntries(txn.id)).toBe(1);

    await db.query(`update public.bank_transactions set reconciled_at = null where id = $1`, [txn.id]);
    // The receipt side of the match (receipts.bank_transaction_id).
    await db.query(`insert into public.receipts (org_id, location_id, source, bank_transaction_id) values ($1, $2, 'MANUAL_UPLOAD', $3)`, [ORG, A, txn.id]);
    posted = (await loadFeedTxn(sb, ORG, txn.id)) as FeedTxn;
    await expect(reverseFeedPosting(sb, { orgId: ORG, txn: posted, reason: 'oops' }, opts())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/receipt/) });
    expect(await postedBankFeedEntries(txn.id)).toBe(1);
  });

  it('never voids an entry another line or module owns (no gl_entry_id fallback)', async () => {
    const mine = await mkTxn(-1_500, '2026-06-12', 'MINE');
    const theirs = await mkTxn(-700, '2026-06-12', 'THEIRS');
    await post(theirs, [{ amount_cents: 700, account_id: acct.SUPPLIES }]);
    const theirEntry = await one<{ id: string }>(
      `select id from public.gl_entries where source_module = 'BANK_FEED' and source_id = $1 and status = 'POSTED'`, [theirs.id]);
    // A line marked posted against someone else's entry (cash application / a reconciliation adjustment do this).
    await db.query(`update public.bank_transactions set status = 'POSTED', gl_entry_id = $2 where id = $1`, [mine.id, theirEntry.id]);
    const posted = (await loadFeedTxn(sb, ORG, mine.id)) as FeedTxn;
    await expect(reverseFeedPosting(sb, { orgId: ORG, txn: posted, reason: 'undo' }, opts())).rejects.toMatchObject({ status: 409 });
    expect(await postedBankFeedEntries(theirs.id)).toBe(1); // untouched
  });
});

describe('remember this split (AC-8)', () => {
  it('saves a vendor rule and suggests it on the next charge; falls back to history', async () => {
    const txn = await mkTxn(-10_000, '2026-08-03', 'VERIZON WIRELESS 5512');
    const resolved = await validateSplitLines(sb, ORG, txn, [
      { amount_cents: 6_000, account_id: acct.PHONE, department_id: deptA },
      { amount_cents: 4_000, account_id: acct.PHONE, allocation_location_id: B },
    ], opts());
    const rule = await saveSplitRule(sb, { orgId: ORG, txn, vendorId, vendorName: 'Verizon', lines: resolved, userId: 'user_x' }, opts());
    expect(rule?.name).toBe('Verizon 60/40');
    await postSplit(sb, { orgId: ORG, txn, lines: resolved, memo: 'v', vendorId, splitRuleId: rule?.id }, opts());

    const next = await mkTxn(-12_345, '2026-08-20', 'VERIZON WIRELESS 7781');
    const s = await suggestSplit(sb, ORG, next, vendorId);
    expect(s?.source).toBe('RULE');
    expect(s?.lines.map((l) => [l.amount_cents, l.allocation_location_id])).toEqual([[7_407, A], [4_938, B]]);

    // Saving again replaces the active vendor rule (one per vendor per company).
    const again = await saveSplitRule(sb, { orgId: ORG, txn, vendorId, vendorName: 'Verizon', lines: resolved, userId: 'user_x' }, opts());
    const active = await one<{ n: number }>(`select count(*)::int n from public.split_rules where org_id = $1 and vendor_id = $2 and is_active`, [ORG, vendorId]);
    expect(active.n).toBe(1);

    await db.query(`update public.split_rules set is_active = false where id = $1`, [again?.id]);
    await db.query(`update public.bank_transactions set final_vendor_id = $1 where id = $2`, [vendorId, txn.id]);
    const hist = await suggestSplit(sb, ORG, next, vendorId);
    expect(hist?.source).toBe('HISTORY');
    expect(hist?.lines.map((l) => l.amount_cents)).toEqual([7_407, 4_938]);
  });
});
