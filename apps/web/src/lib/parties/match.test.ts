/** "Already in Merit" — the matcher client (Projects 1111 core.match_parties) and its wording. */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addressText, describeMatched, describeUsage, exactMatchOrNull, matchParties } from './match';

/**
 * The caller's client: the RPC answer plus the RLS re-read of candidates (M3). `visible` = the
 * customer ids the caller's RLS returns (undefined = all); `contacts` maps contact → customer.
 */
function fakeDb(
  result: { data: unknown; error: { code?: string; message: string } | null },
  calls: unknown[] = [],
  scope: { visible?: string[]; contacts?: Record<string, string | null>; readError?: boolean } = {},
): SupabaseClient {
  const table = (t: string) => ({
    select: () => ({
      in: (_c: string, ids: string[]) => {
        if (scope.readError) return Promise.resolve({ data: null, error: { message: 'boom' } });
        if (t === 'contacts') return Promise.resolve({ data: ids.filter((id) => scope.contacts && id in scope.contacts).map((id) => ({ id, customer_id: scope.contacts![id] })), error: null });
        return Promise.resolve({ data: ids.filter((id) => !scope.visible || scope.visible.includes(id)).map((id) => ({ id })), error: null });
      },
    }),
  });
  return {
    schema: (s: string) => ({
      rpc: (fn: string, args: unknown) => { calls.push({ s, fn, args }); return Promise.resolve(result); },
      from: table,
    }),
  } as unknown as SupabaseClient;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Harbor Holdings', score: 0.93, matched: ['name', 'email'],
  detail: { level: 'exact', email: 'ap@harbor.com', phone: null, city: 'Ames', books_since: null, created_at: '2026-03-04T10:00:00Z', source: 'projects', masked: false },
  ...over,
});

describe('matchParties', () => {
  it('calls core.match_parties as the caller and maps the rows ("used in Projects since March 2026")', async () => {
    const calls: unknown[] = [];
    const r = await matchParties(fakeDb({ data: [row()], error: null }, calls), { kind: 'customer', name: ' Harbor Holdings ', email: 'AP@harbor.com', address: '12 Oak St, Ames, IA 50010' });
    expect(calls[0]).toMatchObject({ s: 'core', fn: 'match_parties', args: { p_kind: 'customer', p_name: 'Harbor Holdings', p_email: 'AP@harbor.com', p_address: '12 Oak St, Ames, IA 50010', p_limit: 5 } });
    expect(r.available).toBe(true);
    expect(r.matches[0]).toMatchObject({ id: 'c1', level: 'exact', source: 'projects', usage: 'used in Projects since March 2026' });
  });

  it('Books-only orgs work the same (Books records: "used in Books since …")', () => {
    expect(describeUsage({ source: 'books', booksSince: '2025-11-02', createdAt: '2025-01-01' })).toBe('used in Books since November 2025');
    expect(describeUsage({ source: 'unused', booksSince: null, createdAt: '2026-10-01' })).toBe('added October 2026, not used yet');
  });

  it('degrades to "door open" when 1111 is not deployed or the seat may not match', async () => {
    expect(await matchParties(fakeDb({ data: null, error: { code: 'PGRST202', message: 'Could not find the function core.match_parties' } }), { kind: 'vendor', name: 'Acme' }))
      .toEqual({ available: false, matches: [] });
    expect(await matchParties(fakeDb({ data: null, error: { code: '42501', message: 'CORE_FORBIDDEN: requires a customer grant' } }), { kind: 'vendor', name: 'Acme' }))
      .toEqual({ available: false, matches: [] });
  });

  it('does not ask for one-letter names with nothing else to go on', async () => {
    const calls: unknown[] = [];
    expect(await matchParties(fakeDb({ data: [row()], error: null }, calls), { kind: 'customer', name: 'H' })).toEqual({ available: true, matches: [] });
    expect(calls).toHaveLength(0);
  });

  it('exactMatchOrNull: only an EXACT match stops a create; a matcher fault never blocks', async () => {
    expect((await exactMatchOrNull(fakeDb({ data: [row()], error: null }), { kind: 'customer', name: 'Harbor' }))?.id).toBe('c1');
    expect(await exactMatchOrNull(fakeDb({ data: [row({ detail: { level: 'likely' } })], error: null }), { kind: 'customer', name: 'Harbor' })).toBeNull();
    expect(await exactMatchOrNull(fakeDb({ data: null, error: { code: 'XX000', message: 'boom' } }), { kind: 'customer', name: 'Harbor' })).toBeNull();
  });

  it('M3: a customer outside the caller\'s Books client scope is dropped (RLS re-read), so no name / email leaks', async () => {
    const data = [row({ id: 'c1' }), row({ id: 'c2', name: 'Other Client Customer', detail: { level: 'exact', email: 'x@other.com' } })];
    const r = await matchParties(fakeDb({ data, error: null }, [], { visible: ['c1'] }), { kind: 'customer', name: 'Harbor' });
    expect(r.matches.map((m) => m.id)).toEqual(['c1']);
    expect(JSON.stringify(r)).not.toContain('x@other.com');
    // the 409 door uses the same filtered answer
    expect(await exactMatchOrNull(fakeDb({ data: [data[1]], error: null }, [], { visible: ['c1'] }), { kind: 'customer', name: 'Other' })).toBeNull();
  });

  it('M3: a contact follows its customer; a read failure fails closed; vendors (org master) pass', async () => {
    const data = [row({ id: 'k1' }), row({ id: 'k2' }), row({ id: 'k3' })];
    const r = await matchParties(fakeDb({ data, error: null }, [], { visible: ['c1'], contacts: { k1: 'c1', k2: 'c2', k3: null } }), { kind: 'contact', name: 'Pat' });
    expect(r.matches.map((m) => m.id)).toEqual(['k1', 'k3']);
    expect((await matchParties(fakeDb({ data: [row()], error: null }, [], { readError: true }), { kind: 'customer', name: 'Harbor' })).matches).toEqual([]);
    expect((await matchParties(fakeDb({ data: [row()], error: null }, [], { visible: [] }), { kind: 'vendor', name: 'Harbor' })).matches).toHaveLength(1);
  });

  it('wording helpers', () => {
    expect(describeMatched(['tax_id', 'name'])).toBe('same tax ID, similar name');
    expect(addressText({ address_line1: '12 Oak St', city: 'Ames', state: 'IA', zip: '50010' })).toBe('12 Oak St, Ames IA 50010');
    expect(addressText({})).toBeNull();
  });
});
