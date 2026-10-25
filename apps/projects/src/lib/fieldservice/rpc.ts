import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { opsErrorCopy } from '@/lib/pm/ops/errors';
import { fsErrorCopy } from './errors';

function toHttp(e: PgErrorLike, what: string): Error {
  const fs = fsErrorCopy(e);
  if (fs) return new HttpError(fs.status, fs.error, fs.code);
  const ops = opsErrorCopy(e);
  if (ops) return new HttpError(ops.status, ops.error, ops.code);
  return new PmQueryError(what, e);
}

/** Call a pm definer function on the RLS client; a failure becomes a plain-language HttpError. */
export async function fsCall<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw toHttp(res.error, fn);
  return res.data as T;
}

/** A table write with the same error handling. */
export async function fsWrite<T = unknown>(res: PromiseLike<{ data: unknown; error: PgErrorLike | null }>, what: string): Promise<T> {
  const r = await res;
  if (r.error) throw toHttp(r.error, what);
  return r.data as T;
}

/** One row the caller's RLS can see, or 404. */
export async function fsOwn<T>(db: SupabaseClient, table: string, cols: string, id: string, notFound: string): Promise<T> {
  const res = await db.schema('pm').from(table).select(cols).eq('id', id).maybeSingle();
  if (res.error) throw new PmQueryError(table, res.error);
  if (!res.data) throw new HttpError(404, notFound, 'NOT_FOUND');
  return res.data as T;
}
