/**
 * Shared read helpers for the dealer report loaders. Every read runs on the
 * caller's RLS client (`d.db`) and pins org_id (+ location_id where the table has
 * it); core master data is stitched in JS (PostgREST can't embed core from public).
 */

import type { DealerCtx } from '@/lib/dealer/service/context';
import { dbFail } from '@/lib/dealer/service/errors';
import { fetchAll, fetchAllIn, type PageableQuery } from '@/lib/supabase/fetch-all';

export type ReportCtx = Pick<DealerCtx, 'db' | 'orgId' | 'locationId'>;
export type Row = Record<string, unknown>;

export async function all(what: string, make: () => PageableQuery<Row>, orderBy: string | readonly string[] = 'id'): Promise<Row[]> {
  const { data, error } = await fetchAll<Row>(make, { label: what, orderBy });
  if (error) dbFail(`${what} lookup failed`, error);
  return data ?? [];
}

export async function allIn(what: string, ids: string[], make: (chunk: string[]) => PageableQuery<Row>): Promise<Row[]> {
  if (ids.length === 0) return [];
  const { data, error } = await fetchAllIn<Row>([...new Set(ids)], make, { label: what });
  if (error) dbFail(`${what} lookup failed`, error);
  return data ?? [];
}

export const num = (v: unknown): number => Number(v ?? 0);
export const str = (v: unknown): string | null => (v == null ? null : String(v));
export const ids = (rows: Row[], key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((x): x is string => typeof x === 'string' && x.length > 0))];

async function coreNames(d: ReportCtx, table: 'vendors' | 'departments', idList: string[], pick: (r: Row) => string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(idList)];
  for (let i = 0; i < unique.length; i += 200) {
    const cols: string = table === 'vendors' ? 'id, name, display_name' : 'id, name';
    const { data, error } = await d.db.schema('core').from(table).select(cols).eq('org_id', d.orgId).in('id', unique.slice(i, i + 200));
    if (error) dbFail(`${table} lookup failed`, error);
    for (const r of (data ?? []) as unknown as Row[]) out.set(r.id as string, pick(r));
  }
  return out;
}

export function vendorNames(d: ReportCtx, idList: string[]): Promise<Map<string, string>> {
  return coreNames(d, 'vendors', idList, (r) => String(r.display_name || r.name || 'Vendor'));
}

export function departmentNames(d: ReportCtx, idList: string[]): Promise<Map<string, string>> {
  return coreNames(d, 'departments', idList, (r) => String(r.name || 'Department'));
}

/** Clerk user id → "First Last" (best-effort; unknown → caller's fallback). */
export async function userNames(d: ReportCtx, clerkIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(clerkIds.filter(Boolean))];
  if (unique.length === 0) return out;
  try {
    const { data } = await d.db.schema('core').from('users').select('clerk_user_id, first_name, last_name, email').in('clerk_user_id', unique);
    for (const u of (data ?? []) as Row[]) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? '');
      if (name) out.set(String(u.clerk_user_id), name);
    }
  } catch {
    /* names are presentation only */
  }
  return out;
}

/** The client's display name (core.locations, through RLS). */
export async function clientName(d: ReportCtx): Promise<string> {
  const { data } = await d.db.schema('core').from('locations').select('id, name').eq('id', d.locationId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? 'Client';
}
