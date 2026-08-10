import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordLeaseCommencement, leaseCommencementRef } from './lease-posting';

const ORG = 'org-1';
const LOC = 'loc-1';

// ── Minimal fake Supabase covering the calls recordLeaseCommencement makes ──────────
// resolveLeaseRole falls through the account_roles map (empty) to the standard COA
// numbers 1580 (ROU asset) / 2550 (lease liability), so we seed those two accounts.
type Row = Record<string, unknown>;

function makeDb(accounts: Row[]) {
  const glEntries: Row[] = [];
  const glLines: Row[] = [];
  let seq = 0;

  function make(table: string) {
    const state: { table: string; filters: Record<string, unknown>; insertRows?: unknown; isDelete?: boolean } = {
      table,
      filters: {},
    };
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

const rouAsset: Row = { id: 'acct-1580', account_type: 'ASSET', account_sub_type: 'OTHER_ASSET', account_number: '1580', org_id: ORG, is_active: true, company_location_id: null };
const leaseLiability: Row = { id: 'acct-2550', account_type: 'LIABILITY', account_sub_type: 'LONG_TERM_LIABILITY', account_number: '2550', org_id: ORG, is_active: true, company_location_id: null };

const LEASE_ID = '22222222-2222-2222-2222-222222222222';

describe('recordLeaseCommencement — ASC 842 initial recognition', () => {
  it('posts a balanced DR ROU asset (1580) / CR Lease liability (2550) entry', async () => {
    const { db, glEntries, glLines } = makeDb([rouAsset, leaseLiability]);

    const res = await recordLeaseCommencement(db, ORG, null, {
      leaseId: LEASE_ID,
      locationId: LOC,
      rouAssetCents: 1_200_000,
      liabilityCents: 1_200_000,
      entryDate: '2026-01-01',
    });
    expect(res.posted).toBe(true);
    expect(res.alreadyPosted).toBe(false);
    expect(glEntries).toHaveLength(1);
    expect(glEntries[0].source_ref).toBe(leaseCommencementRef(LEASE_ID));

    const debits = glLines.reduce((s, l) => s + (l.debit_cents as number), 0);
    const credits = glLines.reduce((s, l) => s + (l.credit_cents as number), 0);
    expect(debits).toBe(1_200_000);
    expect(credits).toBe(1_200_000); // balanced

    const rouLine = glLines.find((l) => l.account_id === 'acct-1580')!;
    const liabLine = glLines.find((l) => l.account_id === 'acct-2550')!;
    expect(rouLine.debit_cents).toBe(1_200_000); // ROU asset increase -> debit
    expect(liabLine.credit_cents).toBe(1_200_000); // liability increase -> credit
  });

  it('is idempotent — a re-run posts nothing and reports the existing entry', async () => {
    const { db, glEntries } = makeDb([rouAsset, leaseLiability]);
    const base = {
      leaseId: LEASE_ID,
      locationId: LOC,
      rouAssetCents: 1_200_000,
      liabilityCents: 1_200_000,
      entryDate: '2026-01-01',
    };
    const first = await recordLeaseCommencement(db, ORG, null, base);
    expect(first.posted).toBe(true);
    const second = await recordLeaseCommencement(db, ORG, null, base);
    expect(second.alreadyPosted).toBe(true);
    expect(second.posted).toBe(false);
    expect(glEntries).toHaveLength(1); // still exactly one commencement entry
  });
});
