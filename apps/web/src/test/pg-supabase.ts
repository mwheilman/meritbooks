/**
 * A supabase-js stand-in that runs against a REAL Postgres (the PGlite migration
 * replay in ./pg.ts), so service code that takes a `SupabaseClient` can be driven
 * end-to-end through the real schema: CHECKs, unique indexes, the GL balance /
 * period-lock / numbering triggers, and the Projects emitter functions.
 *
 * It connects as the PGlite superuser, i.e. it behaves like the SERVICE-ROLE
 * (admin) client: RLS is bypassed, exactly as in the event drains. It is NOT a
 * PostgREST emulator — only the builder surface Books' services use exists:
 *
 *   .schema(s).from(t) · .select(cols?, { count, head }) · .insert(rows) · .update(vals)
 *   .delete() · .eq/.neq/.gt/.gte/.lt/.lte/.in/.is/.like/.ilike/.not(col, op, v)
 *   .or('a.eq.x,b.is.null') · .order(col, { ascending }) · .limit(n) · .range(a, b)
 *   .single() / .maybeSingle() / await · .rpc(fn, namedArgs)
 *
 * Column lists in select() are ignored (whole rows come back as to_jsonb, so
 * bigint → number and date → 'YYYY-MM-DD' just like PostgREST); embedded
 * resources are not supported. Errors carry the Postgres SQLSTATE in `code`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
interface PgErr { message: string; code?: string; details?: string }
interface Resp { data: unknown; error: PgErr | null; count?: number | null }

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function toPgErr(e: unknown): PgErr {
  const x = e as { message?: string; code?: string; detail?: string };
  return { message: x?.message ?? String(e), code: x?.code, details: x?.detail };
}

/** Serialize a JS value for a text-typed parameter (Postgres casts it to the column type). */
function param(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

class PgQuery implements PromiseLike<Resp> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private where: string[] = [];
  private params: unknown[] = [];
  private payload: Row[] = [];
  private updates: Row = {};
  private returning = false;
  private countMode = false;
  private head = false;
  private orderBy: string[] = [];
  private lim: number | null = null;
  private off: number | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(private readonly db: PGlite, private readonly schema: string, private readonly table: string) {}

  private get rel() { return `${ident(this.schema)}.${ident(this.table)}`; }
  private p(v: unknown): string { this.params.push(param(v)); return `$${this.params.length}`; }

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.op === 'select') {
      if (opts?.count) this.countMode = true;
      if (opts?.head) this.head = true;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(rows: Row | Row[]): this { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(vals: Row): this { this.op = 'update'; this.updates = vals; return this; }
  delete(): this { this.op = 'delete'; return this; }

  private cond(col: string, op: string, v: unknown): string {
    const c = ident(col);
    switch (op) {
      case 'eq': return `${c} = ${this.p(v)}`;
      case 'neq': return `${c} <> ${this.p(v)}`;
      case 'gt': return `${c} > ${this.p(v)}`;
      case 'gte': return `${c} >= ${this.p(v)}`;
      case 'lt': return `${c} < ${this.p(v)}`;
      case 'lte': return `${c} <= ${this.p(v)}`;
      case 'like': return `${c}::text like ${this.p(v)}`;
      case 'ilike': return `${c}::text ilike ${this.p(v)}`;
      case 'is': return v === null || v === 'null' ? `${c} is null` : `${c} is ${v === true || v === 'true' ? 'true' : 'false'}`;
      case 'in': {
        const list = Array.isArray(v) ? v : String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        if (list.length === 0) return 'false';
        return `${c}::text in (${list.map((x) => `${this.p(String(x))}::text`).join(', ')})`;
      }
      default: throw new Error(`pg-supabase: unsupported filter op ${op}`);
    }
  }

  eq(c: string, v: unknown) { this.where.push(this.cond(c, 'eq', v)); return this; }
  neq(c: string, v: unknown) { this.where.push(this.cond(c, 'neq', v)); return this; }
  gt(c: string, v: unknown) { this.where.push(this.cond(c, 'gt', v)); return this; }
  gte(c: string, v: unknown) { this.where.push(this.cond(c, 'gte', v)); return this; }
  lt(c: string, v: unknown) { this.where.push(this.cond(c, 'lt', v)); return this; }
  lte(c: string, v: unknown) { this.where.push(this.cond(c, 'lte', v)); return this; }
  like(c: string, v: unknown) { this.where.push(this.cond(c, 'like', v)); return this; }
  ilike(c: string, v: unknown) { this.where.push(this.cond(c, 'ilike', v)); return this; }
  in(c: string, v: unknown[]) { this.where.push(this.cond(c, 'in', v)); return this; }
  is(c: string, v: unknown) { this.where.push(this.cond(c, 'is', v)); return this; }
  not(c: string, op: string, v: unknown) { this.where.push(`not (${this.cond(c, op, v)})`); return this; }
  /** PostgREST or-syntax, flat only: `col.op.value,col.op.value`. */
  or(expr: string) {
    const parts = expr.split(',').map((term) => {
      const [col, op, ...rest] = term.split('.');
      return this.cond(col, op, rest.join('.'));
    });
    this.where.push(`(${parts.join(' or ')})`);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push(`${ident(col)} ${opts?.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.off = from; this.lim = to - from + 1; return this; }
  returns() { return this; }
  single(): Promise<Resp> { this.mode = 'single'; return this.exec(); }
  maybeSingle(): Promise<Resp> { this.mode = 'maybe'; return this.exec(); }
  then<A = Resp, B = never>(ok?: ((v: Resp) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().then(ok, bad);
  }

  private whereSql() { return this.where.length ? ` where ${this.where.join(' and ')}` : ''; }

  private build(): string {
    if (this.op === 'insert') {
      const cols = Array.from(new Set(this.payload.flatMap((r) => Object.keys(r))));
      const json = this.p(JSON.stringify(this.payload.map((r) => {
        const o: Row = {};
        for (const k of cols) o[k] = r[k] === undefined ? null : r[k];
        return o;
      })));
      const list = cols.map(ident).join(', ');
      return `insert into ${this.rel} (${list}) select ${list} from jsonb_populate_recordset(null::${this.rel}, ${json}::jsonb) returning to_jsonb(${ident(this.table)}.*) as j`;
    }
    if (this.op === 'update') {
      const cols = Object.keys(this.updates);
      const json = this.p(JSON.stringify(this.updates));
      const list = cols.map(ident).join(', ');
      const set = cols.length === 1
        ? `${list} = (select ${list} from jsonb_populate_record(null::${this.rel}, ${json}::jsonb))`
        : `(${list}) = (select ${list} from jsonb_populate_record(null::${this.rel}, ${json}::jsonb))`;
      return `update ${this.rel} set ${set}${this.whereSql()} returning to_jsonb(${ident(this.table)}.*) as j`;
    }
    if (this.op === 'delete') {
      return `delete from ${this.rel}${this.whereSql()} returning to_jsonb(${ident(this.table)}.*) as j`;
    }
    if (this.countMode && this.head) return `select count(*)::int as n from ${this.rel}${this.whereSql()}`;
    let sql = `select to_jsonb(t.*) as j from ${this.rel} t${this.whereSql()}`;
    if (this.orderBy.length) sql += ` order by ${this.orderBy.join(', ')}`;
    if (this.lim != null) sql += ` limit ${this.lim}`;
    if (this.off != null) sql += ` offset ${this.off}`;
    return sql;
  }

  private async exec(): Promise<Resp> {
    let res: { rows: Row[] };
    try {
      res = await this.db.query<Row>(this.build(), this.params);
    } catch (e) {
      return { data: null, error: toPgErr(e) };
    }
    if (this.countMode && this.head) return { data: null, error: null, count: Number(res.rows[0]?.n ?? 0) };
    const rows = res.rows.map((r) => r.j as Row);
    if (this.op !== 'select' && !this.returning && this.mode === 'many') return { data: null, error: null };
    if (this.mode === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})`, code: 'PGRST116' } };
      return { data: rows[0], error: null };
    }
    if (this.mode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows returned', code: 'PGRST116' } };
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null, count: this.countMode ? rows.length : null };
  }
}

async function rpc(db: PGlite, schema: string, fn: string, args: Record<string, unknown> = {}): Promise<Resp> {
  const keys = Object.keys(args);
  const params = keys.map((k) => param(args[k]));
  const named = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
  try {
    const meta = await db.query<{ retset: boolean; composite: boolean }>(
      `select p.proretset as retset, (t.typtype = 'c') as composite
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
        where n.nspname = $1 and p.proname = $2 limit 1`, [schema, fn]);
    const m = meta.rows[0];
    const call = `${ident(schema)}.${ident(fn)}(${named})`;
    if (m?.composite || m?.retset) {
      const r = await db.query<{ j: Row }>(`select to_jsonb(x.*) as j from ${call} x`, params);
      return { data: r.rows.map((x) => x.j), error: null };
    }
    const r = await db.query<{ v: unknown }>(`select to_jsonb(${call}) as v`, params);
    return { data: r.rows[0]?.v ?? null, error: null };
  } catch (e) {
    return { data: null, error: toPgErr(e) };
  }
}

/** A service-role-like supabase client over the PGlite database. */
export function pgSupabase(db: PGlite): SupabaseClient {
  const scoped = (schema: string) => ({
    schema: (s: string) => scoped(s),
    from: (t: string) => new PgQuery(db, schema, t),
    rpc: (fn: string, args?: Record<string, unknown>) => rpc(db, schema, fn, args),
  });
  return scoped('public') as unknown as SupabaseClient;
}
