/**
 * Revenue-recognition correctness tests (subledger-to-GL tie-out audit).
 *
 * Pins the two invariants the fix restored:
 *   1. Deferred Revenue (2410) and Unbilled Receivable (1180) are resolved by ROLE
 *      (DEFERRED_REVENUE / UNBILLED_RECEIVABLE) — so a tenant's account remap is
 *      honored — and the revenue credit follows the job's own revenue account. No
 *      hard-coded numbers, no name heuristic.
 *   2. Each recognition entry carries a per-job+period source_ref
 *      (`rev_rec:<jobId>:<YYYY-MM>`), and a second run for the same period is a
 *      no-op (skipped) — the app-level pre-check that fronts migration-064's UNIQUE
 *      (org_id, source_ref, entry_type) DB guarantor.
 *
 * Driven against a small table-dispatch Supabase fake that answers role/account
 * lookups and captures the posted JE header + lines.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recognizeJob, revRecSourceRef, type JobRevRecRow, type RevRecMethod } from './rev-rec';

interface FakeConfig {
  rolesByKey?: Record<string, Array<{ account_id: string; location_id: string | null }>>;
  accountsById?: Record<string, Record<string, unknown>>;
  accountsByNumber?: Record<string, Record<string, unknown>>;
  revenueAccounts?: Array<{ id: string; name: string }>;
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
  postedRefs: Set<string>;
}

function makeFake(cfg: FakeConfig, cap: Captured): SupabaseClient {
  function resolve(state: QueryState): { data: unknown; error: unknown } {
    const { table, op, filters } = state;
    if (op === 'insert') {
      if (table === 'gl_entries') {
        const row = state.insert as Record<string, unknown>;
        const ref = row.source_ref as string | null;
        const key = ref ? `${ref}|${row.entry_type}` : null;
        if (key && cap.postedRefs.has(key)) return { data: null, error: { message: 'duplicate key value' } };
        if (key) cap.postedRefs.add(key);
        cap.entries.push(row);
        return { data: { id: `E${cap.entries.length}`, entry_number: `JE-${cap.entries.length}` }, error: null };
      }
      if (table === 'gl_entry_lines') {
        for (const l of state.insert as Array<Record<string, unknown>>) cap.lines.push(l);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (op === 'update' || op === 'delete') return { data: null, error: null };
    // select
    if (table === 'account_roles') return { data: cfg.rolesByKey?.[filters.role_key as string] ?? [], error: null };
    if (table === 'accounts') {
      if (filters.id) return { data: cfg.accountsById?.[filters.id as string] ?? null, error: null };
      if (filters.account_number) return { data: cfg.accountsByNumber?.[filters.account_number as string] ?? null, error: null };
      return { data: cfg.revenueAccounts ?? [], error: null };
    }
    if (table === 'gl_entries') {
      const ref = filters.source_ref as string | undefined;
      const exists = !!ref && (cfg.existingRefs?.has(ref) || cap.postedRefs.has(`${ref}|STANDARD`));
      return { data: exists ? { id: 'existing' } : null, error: null };
    }
    if (table === 'gl_entry_lines') return { data: [], error: null };
    if (table === 'fiscal_periods') return { data: { id: 'FP', status: 'OPEN' }, error: null };
    if (table === 'invoices') return { data: [], error: null };
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

  return {
    from: (t: string) => builder(t),
    schema: () => ({ from: (t: string) => builder(t) }),
  } as unknown as SupabaseClient;
}

function baseJob(over: Partial<JobRevRecRow>): JobRevRecRow {
  return {
    id: 'job1',
    location_id: 'loc1',
    job_type: null,
    archetype: null,
    status: 'ACTIVE',
    rev_rec_method: null,
    rev_rec_method_override: null,
    revenue_account_id: null,
    contract_amount_cents: 100_000,
    estimated_cost_cents: 50_000,
    actual_cost_cents: 25_000,
    billed_to_date_cents: 0,
    pct_complete: 50,
    revenue_recognized_cents: 0,
    service_start_date: null,
    service_end_date: null,
    ...over,
  };
}

describe('revRecSourceRef', () => {
  it('is a stable per-job+period key', () => {
    expect(revRecSourceRef('abc', '2026-08-31')).toBe('rev_rec:abc:2026-08');
    expect(revRecSourceRef('abc', '2026-09-01')).toBe('rev_rec:abc:2026-09');
  });
});

describe('recognizeJob — role resolution + source_ref', () => {
  const method: RevRecMethod = 'PCT_COMPLETE';

  it('resolves 2410/1180 by role (honors a remap), credits the job revenue account, and posts a balanced JE with a per-period source_ref', async () => {
    const cap: Captured = { entries: [], lines: [], postedRefs: new Set() };
    const db = makeFake(
      {
        // Tenant has REMAPPED deferred/unbilled off the standard 2410/1180.
        rolesByKey: {
          DEFERRED_REVENUE: [{ account_id: 'REMAP_DEF', location_id: null }],
          UNBILLED_RECEIVABLE: [{ account_id: 'REMAP_UNB', location_id: null }],
        },
        accountsById: {
          REMAP_DEF: { id: 'REMAP_DEF', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2999' },
          REMAP_UNB: { id: 'REMAP_UNB', account_type: 'ASSET', account_sub_type: 'OTHER_CURRENT_ASSET', account_number: '1999' },
        },
      },
      cap,
    );

    const job = baseJob({ revenue_account_id: 'JOB_REV' }); // earned 50% of 100000 = 50000, prior 0 -> delta 50000
    const r = await recognizeJob(db, 'org1', job, method, '2026-08-31', 'clerk_runner');

    expect(r.status).toBe('posted');
    expect(r.deltaCents).toBe(50_000);

    // Balance-sheet offset resolved by role (the remapped account, NOT 1180).
    const unbilled = cap.lines.find((l) => l.account_id === 'REMAP_UNB');
    expect(unbilled).toBeTruthy();
    expect(unbilled!.debit_cents).toBe(50_000);
    // Revenue credit follows the job's own revenue account.
    const revenue = cap.lines.find((l) => l.account_id === 'JOB_REV');
    expect(revenue).toBeTruthy();
    expect(revenue!.credit_cents).toBe(50_000);

    // Balanced.
    const debits = cap.lines.reduce((s, l) => s + Number(l.debit_cents ?? 0), 0);
    const credits = cap.lines.reduce((s, l) => s + Number(l.credit_cents ?? 0), 0);
    expect(debits).toBe(credits);

    // Per-job+period idempotency key on the header.
    expect(cap.entries[0].source_ref).toBe('rev_rec:job1:2026-08');
  });

  it('is idempotent per job+period — a second run for the same period is skipped (source_ref pre-check)', async () => {
    const cap: Captured = { entries: [], lines: [], postedRefs: new Set() };
    const db = makeFake(
      {
        rolesByKey: {
          DEFERRED_REVENUE: [{ account_id: 'REMAP_DEF', location_id: null }],
          UNBILLED_RECEIVABLE: [{ account_id: 'REMAP_UNB', location_id: null }],
        },
        accountsById: {
          REMAP_DEF: { id: 'REMAP_DEF', account_type: 'LIABILITY', account_sub_type: 'OTHER_CURRENT_LIABILITY', account_number: '2999' },
          REMAP_UNB: { id: 'REMAP_UNB', account_type: 'ASSET', account_sub_type: 'OTHER_CURRENT_ASSET', account_number: '1999' },
        },
        // A recognition entry for this job+period already exists.
        existingRefs: new Set(['rev_rec:job1:2026-08']),
      },
      cap,
    );

    const job = baseJob({ revenue_account_id: 'JOB_REV' });
    const r = await recognizeJob(db, 'org1', job, method, '2026-08-31', 'clerk_runner');

    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/already recognized/i);
    expect(cap.entries).toHaveLength(0); // nothing posted
  });
});
