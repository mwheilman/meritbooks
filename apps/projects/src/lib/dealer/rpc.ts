import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { toHttp } from '@/lib/pm/dealer/rpc';
import { depthErrorCopy } from './errors';

/**
 * The one call path for the 1122 industry-depth routes (dealer, manufacturing, flooring, design,
 * development): the caller's RLS client calls a pm definer function; failures become plain
 * sentences (1122 tokens first, then the dealer / ops / shared mappers). Never the service role.
 */
export async function xcall<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) {
    const d = depthErrorCopy(res.error);
    if (d) throw new HttpError(d.status, d.error, d.code);
    throw toHttp(res.error, fn);
  }
  return res.data as T;
}

/** Rows from a pm table or view the caller's RLS can see. */
export async function xrows<T>(
  q: PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>,
  what: string,
): Promise<T[]> {
  const r = await q;
  if (r.error) throw new PmQueryError(what, r.error);
  return (r.data ?? []) as T[];
}

/** One row (or 404). */
export async function xone<T>(
  q: PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>,
  what: string,
  notFound: string,
): Promise<T> {
  const r = await q;
  if (r.error) throw new PmQueryError(what, r.error);
  if (!r.data) throw new HttpError(404, notFound, 'NOT_FOUND');
  return r.data as T;
}

/** Job ids at one company the caller's RLS can see (pm.projects), for company-scoped lists of job-keyed rows. */
export async function companyJobIds(db: SupabaseClient, companyId: string): Promise<string[]> {
  const r = await xrows<{ job_id: string }>(db.schema('pm').from('projects').select('job_id').eq('location_id', companyId).limit(5000), 'jobs');
  return r.map((x) => x.job_id);
}

/** Supabase `.in()` with an empty list matches nothing useful; this keeps a sentinel that matches no row. */
export function inList(ids: ReadonlyArray<string>): string[] {
  return ids.length ? [...ids] : ['00000000-0000-0000-0000-000000000000'];
}
