import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { opsErrorCopy } from '@/lib/pm/ops/errors';
import { dealerErrorCopy } from './errors';

/**
 * The dealer routes' one call path: the RLS client calls a pm definer function from 1109. A failure
 * becomes a plain-language HttpError (dealer tokens first, then the 1104–1107 ops tokens) or a
 * PmQueryError the shared mapper answers. Never a service-role client.
 */
export async function dcall<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw toHttp(res.error, fn);
  return res.data as T;
}

/** Table write (insert / update / delete) with the same error handling. */
export async function dwrite<T = unknown>(res: PromiseLike<{ data: unknown; error: PgErrorLike | null }>, what: string): Promise<T> {
  const r = await res;
  if (r.error) throw toHttp(r.error, what);
  return r.data as T;
}

export function toHttp(e: PgErrorLike, what: string): Error {
  const d = dealerErrorCopy(e);
  if (d) return new HttpError(d.status, d.error, d.code);
  const o = opsErrorCopy(e);
  if (o) return new HttpError(o.status, o.error, o.code);
  return new PmQueryError(what, e);
}

/** One row the caller's RLS can see (pm schema), or 404. */
export async function downs<T>(db: SupabaseClient, table: string, cols: string, id: string, notFound: string): Promise<T> {
  const res = await db.schema('pm').from(table).select(cols).eq('id', id).maybeSingle();
  if (res.error) throw new PmQueryError(table, res.error);
  if (!res.data) throw new HttpError(404, notFound, 'NOT_FOUND');
  return res.data as T;
}
