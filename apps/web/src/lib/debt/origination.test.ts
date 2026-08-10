import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountRef } from '@/lib/posting/account-roles';
import {
  buildDebtOriginationLines,
  buildDebtPaymentLines,
  recordDebtOrigination,
  originationRef,
} from './posting';

// ── Synthetic resolved accounts (only the fields the builders/engine read) ─────────
const cash: AccountRef = { id: 'acct-cash', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', account_number: '1000' };
const notesPayable: AccountRef = { id: 'acct-2500', account_type: 'LIABILITY', account_sub_type: 'LONG_TERM_LIABILITY', account_number: '2500' };
const interestExpense: AccountRef = { id: 'acct-8000', account_type: 'OTHER', account_sub_type: 'OTHER_EXPENSE', account_number: '8000' };
const interestPayable: AccountRef = { id: 'acct-2400', account_type: 'LIABILITY', account_sub_type: 'CURRENT_LIABILITY', account_number: '2400' };

const LOC = 'loc-1';
const ORG = 'org-1';

function sum(lines: { debit_cents: number; credit_cents: number }[]) {
  return {
    debits: lines.reduce((s, l) => s + l.debit_cents, 0),
    credits: lines.reduce((s, l) => s + l.credit_cents, 0),
  };
}

describe('debt origination JE (opening recognition)', () => {
  it('DR Cash / CR Notes Payable, balanced, correct sides', () => {
    const lines = buildDebtOriginationLines({ cash, liability: notesPayable }, 5_000_000, LOC, 'origination');
    const { debits, credits } = sum(lines);
    expect(debits).toBe(5_000_000);
    expect(credits).toBe(5_000_000); // balanced

    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    const npLine = lines.find((l) => l.account_id === 'acct-2500')!;
    expect(cashLine.debit_cents).toBe(5_000_000); // asset increase -> debit
    expect(cashLine.credit_cents).toBe(0);
    expect(npLine.credit_cents).toBe(5_000_000); // liability increase -> credit
    expect(npLine.debit_cents).toBe(0);
  });
});

describe('debt payment JE (principal/interest split by role)', () => {
  it('un-accrued period: DR Interest Expense + DR Notes Payable / CR Cash', () => {
    const lines = buildDebtPaymentLines(
      { interestDebit: interestExpense, liability: notesPayable, cash },
      { interestCents: 30_000, principalCents: 70_000 },
      LOC,
      'payment',
    );
    const { debits, credits } = sum(lines);
    expect(debits).toBe(100_000);
    expect(credits).toBe(100_000); // balanced

    const intLine = lines.find((l) => l.account_id === 'acct-8000')!;
    const npLine = lines.find((l) => l.account_id === 'acct-2500')!;
    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    expect(intLine.debit_cents).toBe(30_000); // interest expensed (not previously accrued)
    expect(npLine.debit_cents).toBe(70_000); // principal reduces the liability
    expect(cashLine.credit_cents).toBe(100_000); // full payment out of cash
  });

  it('previously-accrued period clears Interest Payable instead of expense', () => {
    const lines = buildDebtPaymentLines(
      { interestDebit: interestPayable, liability: notesPayable, cash },
      { interestCents: 30_000, principalCents: 70_000 },
      LOC,
      'payment',
    );
    const payableLine = lines.find((l) => l.account_id === 'acct-2400')!;
    expect(payableLine.debit_cents).toBe(30_000); // clears the accrued payable
    expect(lines.find((l) => l.account_id === 'acct-8000')).toBeUndefined(); // not re-expensed
    const { debits, credits } = sum(lines);
    expect(debits).toBe(credits);
  });
});

// ── Idempotency: recordDebtOrigination posts once, a re-run posts nothing ───────────
type Row = Record<string, unknown>;

function makeDb(instruments: Row[], accounts: Row[]) {
  const glEntries: Row[] = [];
  const glLines: Row[] = [];
  let seq = 0;

  function make(table: string) {
    const state: {
      table: string;
      filters: Record<string, unknown>;
      insertRows?: unknown;
      isDelete?: boolean;
    } = { table, filters: {} };
    const api: Record<string, unknown> = {
      select: () => api,
      insert: (rows: unknown) => { state.insertRows = rows; return api; },
      update: () => api,
      delete: () => { state.isDelete = true; return api; },
      eq: (k: string, v: unknown) => { state.filters[k] = v; return api; },
      neq: () => api,
      lte: () => api,
      gte: () => api,
      is: () => api,
      or: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve(read(state)),
      single: () => Promise.resolve(terminal(state)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(terminal(state)).then(onF, onR),
    };
    return api;
  }

  function terminal(state: { table: string; filters: Record<string, unknown>; insertRows?: unknown; isDelete?: boolean }) {
    if (state.insertRows !== undefined) {
      if (state.table === 'gl_entries') {
        const r = (Array.isArray(state.insertRows) ? state.insertRows[0] : state.insertRows) as Row;
        seq += 1;
        const entry = { id: `je-${seq}`, entry_number: `JE-${1000 + seq}`, ...r };
        glEntries.push(entry);
        return { data: { id: entry.id, entry_number: entry.entry_number }, error: null };
      }
      if (state.table === 'gl_entry_lines') {
        const rows = (Array.isArray(state.insertRows) ? state.insertRows : [state.insertRows]) as Row[];
        glLines.push(...rows);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (state.isDelete) return { data: null, error: null };
    return read(state);
  }

  function read(state: { table: string; filters: Record<string, unknown> }) {
    const f = state.filters;
    if (state.table === 'debt_instruments') return { data: instruments.find((r) => r.id === f.id) ?? null, error: null };
    if (state.table === 'accounts') {
      const row = f.id
        ? accounts.find((a) => a.id === f.id)
        : accounts.find((a) => a.account_number === f.account_number);
      return { data: row ?? null, error: null };
    }
    if (state.table === 'gl_entries') {
      const hit = glEntries.find((e) => e.source_ref === f.source_ref && e.status !== 'VOIDED') ?? null;
      return { data: hit ? { id: hit.id, entry_number: hit.entry_number, status: hit.status } : null, error: null };
    }
    if (state.table === 'fiscal_periods') return { data: { id: 'fp-1', status: 'OPEN' }, error: null };
    if (state.table === 'account_roles') return { data: [], error: null };
    return { data: null, error: null };
  }

  return { db: { from: make } as unknown as SupabaseClient, glEntries, glLines };
}

describe('recordDebtOrigination — idempotent opening post', () => {
  const instrument: Row = {
    id: '11111111-1111-1111-1111-111111111111',
    org_id: ORG,
    location_id: LOC,
    loan_name: 'Test Term Loan',
    original_amount_cents: 5_000_000,
    origination_date: '2026-03-15',
    liability_account_id: 'acct-2500',
    interest_expense_account_id: 'acct-8000',
    interest_payable_account_id: 'acct-2400',
    cash_account_id: 'acct-cash',
  };
  const acctRows: Row[] = [
    { ...cash, org_id: ORG, is_active: true, company_location_id: LOC },
    { ...notesPayable, org_id: ORG, is_active: true, company_location_id: LOC },
    { ...interestExpense, org_id: ORG, is_active: true, company_location_id: null },
    { ...interestPayable, org_id: ORG, is_active: true, company_location_id: null },
  ];

  it('posts a balanced DR Cash / CR Notes Payable entry, then is a no-op on re-run', async () => {
    const { db, glEntries, glLines } = makeDb([instrument], acctRows);

    const first = await recordDebtOrigination(db, { orgId: ORG, instrumentId: instrument.id as string });
    expect(first.alreadyPosted).toBe(false);
    expect(glEntries).toHaveLength(1);
    expect(glEntries[0].source_ref).toBe(originationRef(instrument.id as string));

    const debits = glLines.reduce((s, l) => s + (l.debit_cents as number), 0);
    const credits = glLines.reduce((s, l) => s + (l.credit_cents as number), 0);
    expect(debits).toBe(5_000_000);
    expect(credits).toBe(5_000_000);
    const cashLine = glLines.find((l) => l.account_id === 'acct-cash')!;
    const npLine = glLines.find((l) => l.account_id === 'acct-2500')!;
    expect(cashLine.debit_cents).toBe(5_000_000);
    expect(npLine.credit_cents).toBe(5_000_000);

    // Re-run: the source_ref guard finds the existing entry — nothing new posts.
    const second = await recordDebtOrigination(db, { orgId: ORG, instrumentId: instrument.id as string });
    expect(second.alreadyPosted).toBe(true);
    expect(glEntries).toHaveLength(1); // still one entry
  });
});
