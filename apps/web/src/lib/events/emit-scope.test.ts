/**
 * Migration 168 — core.events / core.vendors are member read-only, so every emitter and
 * vendor create writes through the SERVICE-ROLE writer (never the caller's RLS client),
 * pinned to the caller's org, after the scope / permission checks.
 */
import { describe, it, expect } from 'vitest';
import { emitJobCostEvent } from '@/lib/services/job-cost-events';
import { emitDeptInvoiceIssue } from '@/lib/services/dept-invoice-events';
import { resolveVendorIdByName } from '@/lib/bank/vendor-resolution';
import { EventScopeError } from './emit-scope';
import { fakeSupabase, forbiddenSupabase, filterValue, type FakeCall, type FakeResp } from '@/test/fake-supabase';

const ORG = 'org-1';
const LOC = 'loc-1';
const JOB = 'job-1';

/** A writer whose core.locations / core.jobs only know ORG's rows. */
function scopedWriter(extra: (c: FakeCall) => FakeResp | null = () => null) {
  return fakeSupabase((c) => {
    const hit = extra(c);
    if (hit) return hit;
    if (c.table === 'locations' || c.table === 'jobs') {
      const id = filterValue(c, 'id');
      const org = filterValue(c, 'org_id');
      const known = c.table === 'locations' ? id === LOC : id === JOB;
      return { data: known && org === ORG ? { id } : null, error: null };
    }
    if (c.table === 'events' && c.op === 'select') return { data: null, error: null }; // no pending duplicate
    if (c.table === 'events' && c.op === 'insert') return { data: null, error: null };
    if (c.table === 'organizations') return { data: { entitlements: { projects: true } }, error: null };
    return { data: null, error: null };
  });
}

const jobCost = (over: Partial<Parameters<typeof emitJobCostEvent>[1]> = {}) => ({
  orgId: ORG, locationId: LOC, jobId: JOB, costType: 'MATERIALS' as const, amountCents: 12_300,
  occurredOn: '2026-10-01', lifecycle: 'PENDING' as const, gate: 'PAYABLE_APPROVAL' as const, sourceRef: 'bill-1', ...over,
});

describe('emitJobCostEvent', () => {
  it('writes core.events with the service-role writer, never the caller client, org pinned', async () => {
    const w = scopedWriter();
    const id = await emitJobCostEvent(forbiddenSupabase('caller RLS client'), jobCost(), { writer: w.client });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const ins = w.calls.find((c) => c.table === 'events' && c.op === 'insert')!;
    expect(ins.schema).toBe('core');
    expect(ins.payload).toMatchObject({ org_id: ORG, event_type: 'JOB_COST', status: 'pending', payload: { org_id: ORG, location_id: LOC, job_id: JOB } });
  });

  it('refuses a client or job from another tenant before writing anything', async () => {
    for (const bad of [{ locationId: 'loc-of-tenant-b' }, { jobId: 'job-of-tenant-b' }]) {
      const w = scopedWriter();
      await expect(emitJobCostEvent(forbiddenSupabase('caller'), jobCost(bad), { writer: w.client })).rejects.toBeInstanceOf(EventScopeError);
      expect(w.calls.some((c) => c.table === 'events')).toBe(false);
    }
  });

  it('returns the pending duplicate instead of emitting twice', async () => {
    const w = scopedWriter((c) => (c.table === 'events' && c.op === 'select' ? { data: { event_id: 'existing-ev' }, error: null } : null));
    expect(await emitJobCostEvent(forbiddenSupabase('caller'), jobCost(), { writer: w.client })).toBe('existing-ev');
    expect(w.calls.some((c) => c.table === 'events' && c.op === 'insert')).toBe(false);
  });
});

describe('emitDeptInvoiceIssue', () => {
  const input = {
    orgId: ORG, locationId: LOC, providerDepartmentId: 'd1', receiverDepartmentId: 'd2', occurredOn: '2026-10-01',
    sourceRef: 'ii-1', lines: [{ description: 'Design', amount_cents: 50_000 }], projectsDocumentId: 'doc-1',
  };

  it('writes with the service-role writer after the client-scope check', async () => {
    const w = scopedWriter();
    await emitDeptInvoiceIssue(forbiddenSupabase('caller'), input, { writer: w.client });
    const ins = w.calls.find((c) => c.table === 'events' && c.op === 'insert')!;
    expect(ins.payload).toMatchObject({ org_id: ORG, event_type: 'DEPT_INVOICE_ISSUE', source_module: 'projects' });
    // scope check ran first, on the writer
    expect(w.calls.findIndex((c) => c.table === 'locations')).toBeLessThan(w.calls.indexOf(ins));
  });

  it('refuses a client from another tenant', async () => {
    const w = scopedWriter();
    await expect(emitDeptInvoiceIssue(forbiddenSupabase('caller'), { ...input, locationId: 'loc-b' }, { writer: w.client }))
      .rejects.toBeInstanceOf(EventScopeError);
    expect(w.calls.some((c) => c.table === 'events')).toBe(false);
  });
});

describe('resolveVendorIdByName — create branch', () => {
  const lookup = () => fakeSupabase(() => ({ data: [], error: null })); // caller RLS: no match

  it('creates through the service-role writer, pinned to the org', async () => {
    const reader = lookup();
    const w = fakeSupabase((c) => (c.op === 'insert' ? { data: { id: 'v-new' }, error: null } : { data: null, error: null }));
    const r = await resolveVendorIdByName(reader.client, ORG, 'Acme Supply', 'user_1', { writer: w.client, mayCreate: async () => true });
    expect(r).toEqual({ id: 'v-new', created: true });
    expect(reader.calls.every((c) => c.op === 'select')).toBe(true);
    const ins = w.calls.find((c) => c.op === 'insert')!;
    expect(ins.schema).toBe('core');
    expect(ins.table).toBe('vendors');
    expect(ins.payload).toMatchObject({ org_id: ORG, name: 'Acme Supply' });
  });

  it('refuses to create when the caller may not add vendors (nothing written)', async () => {
    const w = fakeSupabase(() => ({ data: { id: 'never' }, error: null }));
    await expect(resolveVendorIdByName(lookup().client, ORG, 'Acme Supply', 'user_1', { writer: w.client, mayCreate: async () => false }))
      .rejects.toThrow(/can't add vendors/);
    expect(w.calls).toEqual([]);
  });

  it('an existing vendor is reused without any write or permission check', async () => {
    const reader = fakeSupabase(() => ({ data: [{ id: 'v1', name: 'Acme Supply', display_name: null, is_active: true }], error: null }));
    const r = await resolveVendorIdByName(reader.client, ORG, 'acme  supply', 'user_1', {
      writer: forbiddenSupabase('writer'),
      mayCreate: async () => { throw new Error('must not be asked'); },
    });
    expect(r).toEqual({ id: 'v1', created: false });
  });
});
