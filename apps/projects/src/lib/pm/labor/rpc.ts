import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { laborErrorCopy } from './errors';

/** Call a pm labor / time definer function; known tokens become plain HttpErrors. */
export async function laborCall<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) {
    const c = laborErrorCopy(res.error);
    if (c) throw new HttpError(c.status, c.error, c.code);
    throw new PmQueryError(fn, res.error);
  }
  return res.data as T;
}
