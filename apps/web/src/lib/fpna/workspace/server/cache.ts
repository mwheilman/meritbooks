/**
 * Per-(org, user, scope, period, basis, comparison, epoch) view cache (AC-W5). SERVER ONLY.
 *
 * The EPOCH is read cheaply from the three things that can change a figure or who may see
 * it: the latest journal-entry write (`gl_entries.updated_at` — set on insert, and bumped by
 * trigger on every post / void / edit; the balances store is maintained in the same
 * transaction), the latest fiscal-period change (close / reopen), and the latest release
 * change (release / take back). A new epoch is a new key, so a cached view can never
 * outlive the books it was computed from; entries also expire after 60 s and the map is
 * bounded. The key includes the user id: client scope and audience are per person.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const VIEW_TTL_MS = 60_000;
const MAX_ENTRIES = 300;

interface Entry<T> {
  at: number;
  value: T;
}

export class ViewCache<T> {
  private map = new Map<string, Entry<T>>();
  constructor(private ttl = VIEW_TTL_MS, private max = MAX_ENTRIES, private now: () => number = () => Date.now()) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

async function latest(db: SupabaseClient, table: string, column: string): Promise<string> {
  const { data, error } = await db.from(table).select(column).order(column, { ascending: false, nullsFirst: false }).limit(1);
  if (error) return 'x';
  const row = (data as unknown as Array<Record<string, unknown>> | null)?.[0];
  return row ? String(row[column] ?? '0') : '0';
}

/** The ledger epoch for the caller's org (RLS-scoped reads; any read error yields a fresh key). */
export async function ledgerEpoch(db: SupabaseClient): Promise<string> {
  const [pb, fp, rel] = await Promise.all([
    latest(db, 'gl_entries', 'updated_at'),
    latest(db, 'fiscal_periods', 'updated_at'),
    latest(db, 'report_releases', 'updated_at'),
  ]);
  if (pb === 'x' || fp === 'x' || rel === 'x') return `nocache:${Date.now()}`;
  return `${pb}|${fp}|${rel}`;
}

export function viewKey(parts: Record<string, string | number | boolean | null | undefined>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k] ?? ''}`)
    .join('&');
}
