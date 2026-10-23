/**
 * Parse location filter from query params.
 * Accepts either location_id (single) or location_ids (comma-separated).
 * Returns an array of location IDs, or empty array for "all".
 */
export function parseLocationFilter(searchParams: URLSearchParams): string[] {
  const ids = searchParams.get('location_ids');
  if (ids) return ids.split(',').filter(Boolean);

  const id = searchParams.get('location_id');
  if (id && id !== 'all') return [id];

  return [];
}

/**
 * Apply location filter to a Supabase query.
 * Call with the query builder and the column name (default: 'location_id').
 */
export function applyLocationFilter<T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(
  query: T,
  locationIds: string[],
  column = 'location_id'
): T {
  if (locationIds.length === 1) return query.eq(column, locationIds[0]);
  if (locationIds.length > 1) return query.in(column, locationIds);
  return query;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The active single-client context wins over a stale multi-company filter (live check
 * Wave 1, fix 1G-2). The shared fetch hook attaches the header's client as `location_id`;
 * a report that still carries the PREVIOUS client in `location_ids` must not show that
 * client's numbers under the new header. When `location_id` names one client and
 * `location_ids` names anything other than exactly that client, `location_ids` is
 * replaced by the client. Consolidated (`location_id` absent / 'all') is untouched.
 *
 * Pure: returns the corrected `location_ids` value, or null when nothing changes.
 */
export function reconcileClientScope(locationId: string | null, locationIds: string | null): string | null {
  if (locationIds === null) return null;
  if (!locationId || locationId === 'all' || !UUID.test(locationId)) return null;
  const ids = locationIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 1 && ids[0] === locationId) return null;
  return locationId;
}
