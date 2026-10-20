/**
 * Minimal chainable fake of the supabase-js query builder for unit tests (no `any`).
 * Every terminal call (await / single / maybeSingle) records one FakeCall and returns
 * whatever the handler says. Only the builder methods the code under test uses exist.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface FakeCall {
  schema: string | null;
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  payload: unknown;
  filters: Array<[string, string, unknown]>;
}
export interface FakeResp {
  data: unknown;
  error: { message: string } | null;
}
export type FakeHandler = (call: FakeCall) => FakeResp;

class FakeQuery implements PromiseLike<FakeResp> {
  constructor(private readonly call: FakeCall, private readonly handler: FakeHandler, private readonly calls: FakeCall[]) {}
  select(): this { return this; }
  insert(payload: unknown): this { this.call.op = 'insert'; this.call.payload = payload; return this; }
  upsert(payload: unknown): this { this.call.op = 'upsert'; this.call.payload = payload; return this; }
  update(payload: unknown): this { this.call.op = 'update'; this.call.payload = payload; return this; }
  delete(): this { this.call.op = 'delete'; return this; }
  eq(col: string, v: unknown): this { this.call.filters.push(['eq', col, v]); return this; }
  is(col: string, v: unknown): this { this.call.filters.push(['is', col, v]); return this; }
  in(col: string, v: unknown): this { this.call.filters.push(['in', col, v]); return this; }
  ilike(col: string, v: unknown): this { this.call.filters.push(['ilike', col, v]); return this; }
  or(v: string): this { this.call.filters.push(['or', '', v]); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): Promise<FakeResp> { return this.exec(); }
  single(): Promise<FakeResp> { return this.exec(); }
  then<A = FakeResp, B = never>(
    onFulfilled?: ((value: FakeResp) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.exec().then(onFulfilled, onRejected);
  }
  private exec(): Promise<FakeResp> {
    this.calls.push(this.call);
    return Promise.resolve(this.handler(this.call));
  }
}

export interface FakeDb {
  client: SupabaseClient;
  calls: FakeCall[];
}

export function fakeSupabase(handler: FakeHandler): FakeDb {
  const calls: FakeCall[] = [];
  const scoped = (schema: string | null) => ({
    schema: (s: string) => scoped(s),
    from: (table: string) =>
      new FakeQuery({ schema, table, op: 'select', payload: null, filters: [] }, handler, calls),
  });
  return { client: scoped(null) as unknown as SupabaseClient, calls };
}

/** A client that fails the test if anything touches it. */
export function forbiddenSupabase(label: string): SupabaseClient {
  const boom = () => { throw new Error(`${label} must not be used`); };
  return { schema: boom, from: boom, rpc: boom } as unknown as SupabaseClient;
}

export const filterValue = (c: FakeCall, col: string): unknown => c.filters.find((f) => f[1] === col)?.[2];
