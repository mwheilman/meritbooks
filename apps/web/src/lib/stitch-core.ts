import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cross-schema stitch helper.
 *
 * PostgREST cannot embed across the core↔public schema boundary: a `public`
 * table (bank_transactions, bank_accounts, bills, receipts, invoices, gl_entries,
 * …) selecting `location:locations!fk(...)` throws
 * "Could not find a relationship between '<table>' and 'locations' in the schema
 * cache" because locations / vendors / departments / classes / jobs / customers
 * live in `core`. The fix everywhere is the same: select the FK id column on the
 * public row, then fetch the referenced core rows in one batched query and stitch
 * them in JS.
 *
 * This helper centralizes that batched lookup so each route stays small and the
 * pattern is identical across the codebase.
 */
type CoreTable =
  | 'locations'
  | 'vendors'
  | 'departments'
  | 'classes'
  | 'jobs'
  | 'customers'
  | 'employees';

/**
 * Fetch a Map<id, row> from a `core` table for the given set of ids.
 * Nullish / duplicate ids are ignored. Returns an empty Map if nothing to fetch.
 */
export async function fetchCoreMap<T extends { id: string }>(
  supabase: SupabaseClient,
  table: CoreTable,
  columns: string,
  ids: Array<string | null | undefined>,
): Promise<Map<string, T>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0)));
  const map = new Map<string, T>();
  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .schema('core')
    .from(table)
    .select(columns)
    .in('id', unique);

  if (error) {
    // Surface nothing rather than throw: a failed lookup degrades to blank
    // labels, which is preferable to 500-ing the whole list.
    console.error(`[stitch-core] ${table} lookup failed:`, error.message);
    return map;
  }

  for (const row of (data ?? []) as unknown as T[]) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}
