import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { opsErrorCopy } from './errors';

/**
 * One call path for the ops routes: the RLS client calls a pm definer function; a failure
 * becomes a plain-language HttpError (ops tokens) or a PmQueryError the shared mapper answers.
 */
export async function call<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>, skillNames?: Readonly<Record<string, string>>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw toHttp(res.error, fn, skillNames);
  return res.data as T;
}

/** Table write (insert/update/delete) with the same error handling. */
export async function write<T = unknown>(res: PromiseLike<{ data: unknown; error: PgErrorLike | null }>, what: string): Promise<T> {
  const r = await res;
  if (r.error) throw toHttp(r.error, what);
  return r.data as T;
}

function toHttp(e: PgErrorLike, what: string, skillNames?: Readonly<Record<string, string>>): Error {
  const copy = opsErrorCopy(e, skillNames);
  if (copy) return new HttpError(copy.status, copy.error, copy.code);
  return new PmQueryError(what, e);
}

/** Load one row the caller's RLS can see (scoped by `match`), or 404. */
export async function own<T>(db: SupabaseClient, table: string, cols: string, match: Record<string, string>, notFound: string): Promise<T> {
  let q = db.schema('pm').from(table).select(cols);
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const res = await q.maybeSingle();
  if (res.error) throw new PmQueryError(table, res.error);
  if (!res.data) throw new HttpError(404, notFound, 'NOT_FOUND');
  return res.data as T;
}
