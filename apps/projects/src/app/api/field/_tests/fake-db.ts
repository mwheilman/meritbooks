/**
 * A tiny stand-in for the Supabase client the phone read loaders use: schema().from() with
 * select / eq / neq / in / gte / lte / is / not(col,'is',null) / order / limit / maybeSingle, rpc,
 * and storage signed URLs. It filters rows the way PostgREST would; RLS is modelled by the rows
 * each test puts in the table (the loaders' own filters are what the tests prove).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeDb {
  tables: Record<string, Row[]>;
  rpc: Record<string, (args: Record<string, unknown>) => unknown>;
  selected: Record<string, string[]>;
}

function query(db: FakeDb, table: string) {
  const filters: Filter[] = [];
  let cols: string[] | null = null;
  let max = Infinity;
  let single = false;
  const run = () => {
    const src = db.tables[table];
    if (!src) return { data: null, error: { code: '42P01', message: `relation ${table} does not exist` } };
    let out = src.filter((r) => filters.every((f) => f(r))).slice(0, max);
    if (cols) out = out.map((r) => Object.fromEntries(cols!.map((c) => [c, r[c] ?? null])));
    return { data: single ? out[0] ?? null : out, error: null };
  };
  const b = {
    select(c: string) {
      cols = c.split(',').map((x) => x.trim()).filter(Boolean);
      (db.selected[table] ??= []).push(...cols);
      return b;
    },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
    neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b; },
    in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
    gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b; },
    lte(c: string, v: string) { filters.push((r) => String(r[c]) <= v); return b; },
    is(c: string, v: null) { filters.push((r) => (r[c] ?? null) === v); return b; },
    not(c: string, op: string, v: null) { if (op === 'is') filters.push((r) => (r[c] ?? null) !== v); return b; },
    order() { return b; },
    limit(nr: number) { max = nr; return b; },
    maybeSingle() { single = true; return b; },
    then<T>(ok: (v: ReturnType<typeof run>) => T, bad?: (e: unknown) => T) { return Promise.resolve(run()).then(ok, bad); },
  };
  return b;
}

export function fakeDb(init: Partial<Pick<FakeDb, 'tables' | 'rpc'>> = {}): { db: SupabaseClient; state: FakeDb } {
  const state: FakeDb = { tables: init.tables ?? {}, rpc: init.rpc ?? {}, selected: {} };
  const api = {
    from: (t: string) => query(state, t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const f = state.rpc[fn];
      return f ? { data: f(args), error: null } : { data: null, error: { code: '42883', message: `function ${fn} does not exist` } };
    },
  };
  const db = {
    ...api,
    schema: () => api,
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://files.test/${p}?sig=1` })), error: null }),
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, state };
}
