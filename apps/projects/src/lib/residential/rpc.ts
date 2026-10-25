import 'server-only';
/**
 * Calls into migration 1119 on the RLS client. A raised token becomes a plain HTTP error: the
 * database's own sentence after the token is what the person reads (it is written for them).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, mapPgError, splitToken, type PgErrorLike } from '@/lib/api-errors';

export function resError(err: PgErrorLike): HttpError {
  const code = (err.code ?? '').toUpperCase();
  const { token, detail } = splitToken(err.message);
  // 55000 (object locked) is not in the generic map: a locked proposal / selection is a conflict
  if (code === '55000') return new HttpError(409, detail || 'That record is locked.', token ?? 'LOCKED');
  const m = mapPgError(err);
  if (m.status === 500 && token && detail) return new HttpError(422, detail.replace(/\.?$/, '.'), token);
  return new HttpError(m.status, m.body.error, m.body.code);
}

export async function resRpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await db.schema('pm').rpc(fn, args);
  if (r.error) throw resError(r.error);
  return r.data as T;
}

/** A table write's result with the same mapping. */
export function resWrote<T>(res: { data: unknown; error: PgErrorLike | null }): T {
  if (res.error) throw resError(res.error);
  return res.data as T;
}
