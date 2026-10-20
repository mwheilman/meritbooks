import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDb } from '@/lib/tenant';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';

/** The RLS client for this request; pages behind the (app) gate always have one. */
export async function requireDb(): Promise<SupabaseClient> {
  const db = await getDb();
  if (!db) throw new PmQueryError('session', { code: '42501', message: 'No signed-in session' });
  return db;
}

export function pm(db: SupabaseClient) {
  return db.schema('pm');
}

export function core(db: SupabaseClient) {
  return db.schema('core');
}

/** Rows or throw (the PG error is kept for mapping). */
export function rows<T>(res: { data: unknown; error: PgErrorLike | null }, what: string): T[] {
  if (res.error) throw new PmQueryError(what, res.error);
  return (res.data ?? []) as T[];
}

/** One row (or null) or throw. */
export function one<T>(res: { data: unknown; error: PgErrorLike | null }, what: string): T | null {
  if (res.error) throw new PmQueryError(what, res.error);
  return (res.data ?? null) as T | null;
}

/** Strip characters that would break a PostgREST or/ilike filter. */
export function cleanSearch(q: string | null | undefined): string {
  return (q ?? '').replace(/[%_,()*\\:."'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
