/**
 * client-scope — the app-side staging layer over migration 163.
 * The DB-side truth (RLS + contract functions) is proven in src/test/client-scope-rls.test.ts;
 * here: the per-mode decision, the switcher filter, shadow logging, and the fail-safe.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CLIENT_SCOPE_OFF,
  assertClientInScope,
  accessibleLocationIds,
  decideClientScope,
  filterLocationsToScope,
  loadClientScope,
  parseClientScopeState,
  type ClientScopeContext,
  type ClientScopeMode,
} from './client-scope';

const C1 = '00000000-0000-0000-0000-0000000000c1';
const C2 = '00000000-0000-0000-0000-0000000000c2';

interface RpcCall {
  fn: string;
  args: Record<string, unknown> | undefined;
}

function fakeCtx(state: unknown, opts: { fail?: boolean; throws?: boolean } = {}): { ctx: ClientScopeContext; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (opts.throws) throw new Error('network');
    if (fn === 'client_scope_state') {
      return opts.fail ? { data: null, error: { message: 'function core.client_scope_state() does not exist' } } : { data: state, error: null };
    }
    return { data: 1, error: null };
  };
  const supabase = { schema: (_s: string) => ({ rpc }) } as unknown as SupabaseClient;
  return { ctx: { supabase }, calls };
}

const stateOf = (mode: ClientScopeMode, ids: string[], all = false) => ({
  mode,
  membership_id: 'm-1',
  all_clients: all,
  location_ids: ids,
});

describe('parseClientScopeState', () => {
  it('parses the jsonb and rejects unknown shapes', () => {
    const s = parseClientScopeState(stateOf('shadow', [C1]));
    expect(s?.mode).toBe('shadow');
    expect(s?.membershipId).toBe('m-1');
    expect([...(s?.locationIds ?? [])]).toEqual([C1]);
    expect(parseClientScopeState({ mode: 'lockdown' })).toBeNull();
    expect(parseClientScopeState(null)).toBeNull();
    expect(parseClientScopeState([1])).toBeNull();
  });
});

describe('decideClientScope', () => {
  const base = parseClientScopeState(stateOf('off', [C1]))!;
  it('off and shadow always allow; inScope still reports the truth', () => {
    for (const mode of ['off', 'shadow'] as const) {
      expect(decideClientScope({ ...base, mode }, C2)).toEqual({ allowed: true, inScope: false, mode });
      expect(decideClientScope({ ...base, mode }, C1)).toEqual({ allowed: true, inScope: true, mode });
    }
  });
  it('enforce refuses an out-of-scope client, allows org-level (null) and all_clients', () => {
    expect(decideClientScope({ ...base, mode: 'enforce' }, C2).allowed).toBe(false);
    expect(decideClientScope({ ...base, mode: 'enforce' }, C1).allowed).toBe(true);
    expect(decideClientScope({ ...base, mode: 'enforce' }, null).allowed).toBe(true);
    expect(decideClientScope({ ...base, mode: 'enforce', allClients: true }, C2).allowed).toBe(true);
  });
});

describe('loadClientScope fail-safe', () => {
  it('degrades to off when the RPC is missing or throws (pre-163 behaviour)', async () => {
    expect(await loadClientScope(fakeCtx(null, { fail: true }).ctx)).toBe(CLIENT_SCOPE_OFF);
    expect(await loadClientScope(fakeCtx(null, { throws: true }).ctx)).toBe(CLIENT_SCOPE_OFF);
    expect(await loadClientScope(fakeCtx({ mode: 42 }).ctx)).toBe(CLIENT_SCOPE_OFF);
  });
  it('accessibleLocationIds returns the DB truth', async () => {
    expect(await accessibleLocationIds(fakeCtx(stateOf('off', [C1, C2])).ctx)).toEqual([C1, C2]);
  });
});

describe('filterLocationsToScope (company switcher)', () => {
  const rows = [{ id: C1, name: 'One' }, { id: C2, name: 'Two' }];

  it('off: unchanged, no logging', async () => {
    const { ctx, calls } = fakeCtx(stateOf('off', [C1]));
    expect(await filterLocationsToScope(ctx, rows, 'company_list')).toEqual(rows);
    expect(calls.filter((c) => c.fn === 'log_client_scope_denials')).toEqual([]);
  });

  it('shadow: unchanged, logs the would-be-dropped client', async () => {
    const { ctx, calls } = fakeCtx(stateOf('shadow', [C1]));
    expect(await filterLocationsToScope(ctx, rows, 'company_list')).toEqual(rows);
    const logs = calls.filter((c) => c.fn === 'log_client_scope_denials');
    expect(logs).toEqual([{ fn: 'log_client_scope_denials', args: { p_location_ids: [C2], p_surface: 'company_list', p_detail: null } }]);
  });

  it('enforce: drops and logs the out-of-scope client', async () => {
    const { ctx, calls } = fakeCtx(stateOf('enforce', [C1]));
    expect(await filterLocationsToScope(ctx, rows, 'company_list')).toEqual([rows[0]]);
    expect(calls.some((c) => c.fn === 'log_client_scope_denials')).toBe(true);
  });

  it('all-clients holders never log', async () => {
    const { ctx, calls } = fakeCtx(stateOf('enforce', [C1, C2], true));
    expect(await filterLocationsToScope(ctx, rows, 'company_list')).toEqual(rows);
    expect(calls.some((c) => c.fn === 'log_client_scope_denials')).toBe(false);
  });
});

describe('assertClientInScope (active company)', () => {
  it('enforce refuses + logs; shadow allows + logs; in-scope never logs', async () => {
    const e = fakeCtx(stateOf('enforce', [C1]));
    expect((await assertClientInScope(e.ctx, C2, 'active_company')).allowed).toBe(false);
    expect(e.calls.filter((c) => c.fn === 'log_client_scope_denials')).toHaveLength(1);

    const s = fakeCtx(stateOf('shadow', [C1]));
    expect((await assertClientInScope(s.ctx, C2, 'active_company')).allowed).toBe(true);
    expect(s.calls.filter((c) => c.fn === 'log_client_scope_denials')).toHaveLength(1);

    const ok = fakeCtx(stateOf('enforce', [C1]));
    expect((await assertClientInScope(ok.ctx, C1, 'active_company')).allowed).toBe(true);
    expect(ok.calls.filter((c) => c.fn === 'log_client_scope_denials')).toHaveLength(0);
  });

  it('a logging failure never breaks the request', async () => {
    const calls: string[] = [];
    const supabase = {
      schema: () => ({
        rpc: async (fn: string) => {
          calls.push(fn);
          if (fn === 'log_client_scope_denials') throw new Error('db down');
          return { data: stateOf('shadow', [C1]), error: null };
        },
      }),
    } as unknown as SupabaseClient;
    expect((await assertClientInScope({ supabase }, C2, 'active_company')).allowed).toBe(true);
    expect(calls).toEqual(['client_scope_state', 'log_client_scope_denials']);
  });
});
