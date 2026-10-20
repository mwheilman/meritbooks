import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, type PgErrorLike } from '@/lib/api-errors';
import { mapMoneyError, type MoneySubject } from './errors';

/** An HttpError that also carries failing billing preconditions (bulk approve shows them per row). */
export class MoneyError extends HttpError {
  constructor(status: number, message: string, code: string, public readonly preconditions: string[] = []) {
    super(status, message, code);
    this.name = 'MoneyError';
  }
}

export function moneyError(err: PgErrorLike, subject: MoneySubject): MoneyError {
  const m = mapMoneyError(err, subject);
  return new MoneyError(m.status, m.body.error, m.body.code, m.body.preconditions ?? []);
}

/** Call a pm member RPC; a PG error becomes a MoneyError with the plain sentence. */
export async function callRpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, subject: MoneySubject = 'record'): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw moneyError(res.error, subject);
  return res.data as T;
}

/** A table write's result, with money tokens mapped (trigger raises like PM_ESTIMATE_LOCKED). */
export function wrote<T>(res: { data: unknown; error: PgErrorLike | null }, subject: MoneySubject = 'record'): T {
  if (res.error) throw moneyError(res.error, subject);
  return res.data as T;
}
