/**
 * In-memory supabase-js stand-in for scan tests: real filtering over seeded rows,
 * inserts that can be read back, updates that persist — so a detector can be run
 * twice (idempotency) and after a state change (expiry). Only the builder methods
 * the dealer detectors use exist. Not a PostgREST emulator: select() column lists
 * are ignored (whole rows come back) and embedded resources are not supported.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type MemRow = Record<string, unknown>;
export type MemTables = Record<string, MemRow[]>;

type Filter = (r: MemRow) => boolean;

interface Resp {
  data: unknown;
  error: { message: string } | null;
}

let seq = 0;

class MemQuery implements PromiseLike<Resp> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: MemRow | MemRow[] | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private single = false;

  constructor(private readonly db: MemDb, private readonly table: string) {}

  select(): this { return this; }
  insert(p: MemRow | MemRow[]): this { this.op = 'insert'; this.payload = p; return this; }
  update(p: MemRow): this { this.op = 'update'; this.payload = p; return this; }
  delete(): this { this.op = 'delete'; return this; }
  eq(c: string, v: unknown): this { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown): this { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, v: unknown[]): this { this.filters.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown): this { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, op: string, v: unknown): this {
    if (op === 'is' && v === null) this.filters.push((r) => r[c] != null);
    else this.filters.push((r) => r[c] !== v);
    return this;
  }
  gte(c: string, v: string | number): this { this.filters.push((r) => r[c] != null && (r[c] as string | number) >= v); return this; }
  lte(c: string, v: string | number): this { this.filters.push((r) => r[c] != null && (r[c] as string | number) <= v); return this; }
  gt(c: string, v: string | number): this { this.filters.push((r) => r[c] != null && (r[c] as string | number) > v); return this; }
  lt(c: string, v: string | number): this { this.filters.push((r) => r[c] != null && (r[c] as string | number) < v); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  range(from: number, to: number): this { this.rangeFrom = from; this.rangeTo = to; return this; }
  maybeSingle(): Promise<Resp> { this.single = true; return this.exec(); }
  then<A = Resp, B = never>(ok?: ((v: Resp) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().then(ok, bad);
  }

  private exec(): Promise<Resp> {
    const fail = this.db.failOn?.(this.table, this.op);
    if (fail) return Promise.resolve({ data: null, error: { message: fail } });
    const rows = (this.db.tables[this.table] ??= []);
    const match = (r: MemRow) => this.filters.every((f) => f(r));
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const inserted = list.map((p) => ({ id: `mem-${++seq}`, ...p }));
      rows.push(...inserted);
      this.db.writes.push({ table: this.table, op: 'insert', rows: inserted });
      return Promise.resolve({ data: inserted, error: null });
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.payload);
      this.db.writes.push({ table: this.table, op: 'update', rows: hit });
      return Promise.resolve({ data: hit, error: null });
    }
    if (this.op === 'delete') {
      const keep = rows.filter((r) => !match(r));
      this.db.tables[this.table] = keep;
      return Promise.resolve({ data: null, error: null });
    }
    let out = rows.filter(match).map((r) => ({ ...r }));
    if (this.rangeFrom != null && this.rangeTo != null) out = out.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.single) return Promise.resolve({ data: out[0] ?? null, error: null });
    return Promise.resolve({ data: out, error: null });
  }
}

export interface MemDb {
  tables: MemTables;
  writes: Array<{ table: string; op: 'insert' | 'update'; rows: MemRow[] }>;
  /** Return an error message to make a (table, op) fail. */
  failOn?: (table: string, op: string) => string | null;
  client: SupabaseClient;
}

export function memorySupabase(tables: MemTables = {}): MemDb {
  const db: MemDb = { tables, writes: [], client: null as unknown as SupabaseClient };
  const scoped = (schema: string | null) => ({
    schema: (s: string) => scoped(s),
    from: (t: string) => new MemQuery(db, schema && schema !== 'public' ? `${schema}.${t}` : t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  });
  db.client = scoped(null) as unknown as SupabaseClient;
  return db;
}
