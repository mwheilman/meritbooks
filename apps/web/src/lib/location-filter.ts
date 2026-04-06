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
