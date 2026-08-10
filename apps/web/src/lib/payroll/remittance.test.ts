/**
 * Payroll remittance — clears a posted run's tax/benefit payables against cash.
 *
 * Pins the invariants the wiring restored (payroll payables previously sat open
 * forever because recordPayrollRemittance was never called):
 *   1. remitRun posts a BALANCED JE that debits each payroll payable resolved BY ROLE
 *      (FEDERAL / FICA / HEALTH / GARNISHMENT) and credits cash for the total — so the
 *      remittance clears exactly what postRun booked (ties to zero).
 *   2. It carries a per-run source_ref (`payroll_remit:<runId>`) so migration-064's
 *      UNIQUE(org_id, source_ref, entry_type) is the DB double-remit guarantor.
 *   3. It refuses to remit a run that has not been posted to the GL, and returns
 *      `alreadyRemitted` when a remittance already exists.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { remitRun, remittanceSourceRef, RunStateError, type PayrollRunRow } from './run';

interface FakeConfig {
  run: Partial<PayrollRunRow>;
  accountsByNumber?: Record<string, Record<string, unknown>>;
  existingRefs?: Set<string>;
}

interface QueryState {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  insert?: unknown;
  filters: Record<string, unknown>;
}

interface Captured {
  entries: Array<Record<string, unknown>>;
  lines: Array<Record<string, unknown>>;
}

function baseRun(over: Partial<PayrollRunRow>): PayrollRunRow {
  return {
    id: 'run1',
    org_id: 'org1',
    location_id: 'loc1',
    pay_schedule_id: null,
    provider: null,
    provider_run_id: null,
    period_start: '2026-08-01',
    period_end: '2026-08-15',
    pay_date: '2026-08-20',
    status: 'PAID',
    gross_cents: 100_000,
    net_cents: 60_000,
    employer_tax_cents: 10_000,
    employee_tax_cents: 20_000,
    benefits_cents: 5_000,
    deductions_cents: 5_000,
    approval_id: null,
    gl_entry_id: 'posted_entry',
    prepared_by: 'clerk_preparer',
    approved_by: 'clerk_approver',
    released_by: 'clerk_releaser',
    memo: null,
    ...over,
  };
}

function makeFake(cfg: FakeConfig, cap: Captured): SupabaseClient {
  function resolve(state: QueryState): { data: unknown; error: unknown } {
    const { table, op, filters } = state;
    if (op === 'insert') {
      if (table === 'gl_entries') {
        cap.entries.push(state.insert as Record<string, unknown>);
        return { data: { id: `E${cap.entries.length}`, entry_number: `JE-${cap.entries.length}` }, error: null };
      }
      if (table === 'gl_entry_lines') {
        for (const l of state.insert as Array<Record<string, unknown>>) cap.lines.push(l);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (op === 'update' || op === 'delete') return { data: null, error: null };
    if (table === 'payroll_runs') return { data: cfg.run, error: null };
    if (table === 'account_roles') return { data: [], error: null }; // no explicit mappings -> COA fallback
    if (table === 'accounts') {
      if (filters.account_number) return { data: cfg.accountsByNumber?.[filters.account_number as string] ?? null, error: null };
      return { data: null, error: null };
    }
    if (table === 'gl_entries') {
      const ref = filters.source_ref as string | undefined;
      return { data: ref && cfg.existingRefs?.has(ref) ? { id: 'existing' } : null, error: null };
    }
    if (table === 'fiscal_periods') return { data: { id: 'FP', status: 'OPEN' }, error: null };
    return { data: null, error: null };
  }

  function builder(table: string) {
    const state: QueryState = { table, op: 'select', filters: {} };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'lte', 'gte', 'or', 'neq', 'is']) chain[m] = () => chain;
    chain.eq = (k: string, v: unknown) => { state.filters[k] = v; return chain; };
    chain.in = (k: string, v: unknown) => { state.filters[k] = v; return chain; };
    chain.insert = (p: unknown) => { state.op = 'insert'; state.insert = p; return chain; };
    chain.update = (p: unknown) => { state.op = 'update'; state.insert = p; return chain; };
    chain.delete = () => { state.op = 'delete'; return chain; };
    chain.single = async () => resolve(state);
    chain.maybeSingle = async () => resolve(state);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(state)).then(res, rej);
    return chain;
  }

  return { from: (t: string) => builder(t), schema: () => ({ from: (t: string) => builder(t) }) } as unknown as SupabaseClient;
}

// Standard-COA numbers per role (account-roles.ROLE_DEFAULT_NUMBER):
//   FEDERAL_TAX_PAYABLE 2200, FICA_PAYABLE 2220, HEALTH_INSURANCE_PAYABLE 2230,
//   GARNISHMENT_PAYABLE 2270, OPERATING_BANK 1000.
const PAYABLE_ACCOUNTS: Record<string, Record<string, unknown>> = {
  '2200': { id: 'FED', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2200' },
  '2220': { id: 'FICA', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2220' },
  '2230': { id: 'HEALTH', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2230' },
  '2270': { id: 'GARN', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2270' },
  '1000': { id: 'BANK', account_type: 'ASSET', account_sub_type: 'BANK', account_number: '1000' },
};

describe('remittanceSourceRef', () => {
  it('is a stable per-run key', () => {
    expect(remittanceSourceRef('run1')).toBe('payroll_remit:run1');
  });
});

describe('remitRun', () => {
  it('posts a balanced JE debiting the payroll payables by role and crediting cash, with a per-run source_ref', async () => {
    const cap: Captured = { entries: [], lines: [] };
    const db = makeFake({ run: baseRun({}), accountsByNumber: PAYABLE_ACCOUNTS }, cap);

    const r = await remitRun(db, 'org1', 'run1');

    expect(r.alreadyRemitted).toBe(false);
    // Total cleared = employee tax + employer tax + benefits + deductions.
    expect(r.totalCents).toBe(20_000 + 10_000 + 5_000 + 5_000);

    const dr = (id: string) => cap.lines.find((l) => l.account_id === id && Number(l.debit_cents) > 0);
    expect(dr('FED')!.debit_cents).toBe(20_000);   // FEDERAL_TAX_PAYABLE  <- employee_tax
    expect(dr('FICA')!.debit_cents).toBe(10_000);  // FICA_PAYABLE         <- employer_tax
    expect(dr('HEALTH')!.debit_cents).toBe(5_000); // HEALTH_INS_PAYABLE   <- benefits
    expect(dr('GARN')!.debit_cents).toBe(5_000);   // GARNISHMENT_PAYABLE  <- deductions

    // Cash (operating bank) credited for the total.
    const cash = cap.lines.find((l) => l.account_id === 'BANK');
    expect(cash!.credit_cents).toBe(40_000);

    // Balanced.
    const debits = cap.lines.reduce((s, l) => s + Number(l.debit_cents ?? 0), 0);
    const credits = cap.lines.reduce((s, l) => s + Number(l.credit_cents ?? 0), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(40_000);

    // Per-run idempotency key on the header.
    expect(cap.entries[0].source_ref).toBe('payroll_remit:run1');
  });

  it('refuses to remit a run that has not been posted to the GL', async () => {
    const cap: Captured = { entries: [], lines: [] };
    const db = makeFake({ run: baseRun({ gl_entry_id: null }), accountsByNumber: PAYABLE_ACCOUNTS }, cap);
    await expect(remitRun(db, 'org1', 'run1')).rejects.toBeInstanceOf(RunStateError);
    expect(cap.entries).toHaveLength(0);
  });

  it('is idempotent — returns alreadyRemitted when a remittance already exists (no double post)', async () => {
    const cap: Captured = { entries: [], lines: [] };
    const db = makeFake(
      { run: baseRun({}), accountsByNumber: PAYABLE_ACCOUNTS, existingRefs: new Set(['payroll_remit:run1']) },
      cap,
    );
    const r = await remitRun(db, 'org1', 'run1');
    expect(r.alreadyRemitted).toBe(true);
    expect(cap.entries).toHaveLength(0); // nothing posted
  });
});
