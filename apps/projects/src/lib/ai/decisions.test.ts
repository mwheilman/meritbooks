import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { approveDecision, proposeDecision } from './decisions';

interface Call { table: string; op: string; payload?: unknown; filters: [string, string, unknown][] }

/** A tiny PostgREST-builder fake that records every call. */
function fakeDb(results: { insert?: unknown; update?: unknown } = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: '', filters: [] };
      const b = {
        update(p: unknown) { call.op = 'update'; call.payload = p; calls.push(call); return b; },
        insert(p: unknown) { call.op = 'insert'; call.payload = p; calls.push(call); return b; },
        eq(c: string, v: unknown) { call.filters.push(['eq', c, v]); return b; },
        select() { return b; },
        single() { return Promise.resolve({ data: results.insert ?? { id: 'dec-1' }, error: null }); },
        then(resolve: (v: unknown) => void) {
          resolve({ data: call.op === 'update' ? results.update ?? [{ id: 'dec-1' }] : null, error: null });
        },
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('ai_decisions lifecycle', () => {
  it('propose expires the open row with the same dedup key, then inserts one PROPOSED row', async () => {
    const { db, calls } = fakeDb();
    const r = await proposeDecision(db, {
      orgId: 'org', locationId: 'loc', feature: 'PROJECTS_PACK_CONFIGURE', userId: 'u',
      inputSummary: 'Configure', proposedOutput: { dedup_key: 'pack_configure:loc', packs: [] },
      confidence: 0.91234567, reasoning: 'r',
    });
    expect(r).toEqual({ ok: true, id: 'dec-1' });
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert']);
    expect(calls[0].payload).toMatchObject({ status: 'EXPIRED' });
    expect(calls[0].filters).toContainEqual(['eq', 'proposed_output->>dedup_key', 'pack_configure:loc']);
    expect(calls[0].filters).toContainEqual(['eq', 'status', 'PROPOSED']);
    expect(calls[1].payload).toMatchObject({ status: 'PROPOSED', org_id: 'org', feature: 'PROJECTS_PACK_CONFIGURE', confidence: 0.9123 });
  });

  it('approve UPDATES the same row (never inserts a second one)', async () => {
    const { db, calls } = fakeDb();
    const r = await approveDecision(db, { id: 'dec-1', orgId: 'org', userId: 'u', note: 'Applied' });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('update');
    expect(calls[0].payload).toMatchObject({ status: 'APPROVED', disposition_by_user: 'u' });
    expect(calls[0].filters).toContainEqual(['eq', 'id', 'dec-1']);
    expect(calls[0].filters).toContainEqual(['eq', 'status', 'PROPOSED']);
  });

  it('never throws when the client does', async () => {
    const db = { from() { throw new Error('boom'); } } as unknown as SupabaseClient;
    await expect(proposeDecision(db, { orgId: 'o', locationId: null, feature: 'F', userId: null, inputSummary: 'x', proposedOutput: {}, confidence: null, reasoning: null })).resolves.toMatchObject({ ok: false });
    await expect(approveDecision(db, { id: 'x', orgId: 'o', userId: null, note: 'n' })).resolves.toMatchObject({ ok: false });
  });
});
