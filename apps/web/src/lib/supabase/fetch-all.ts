/**
 * fetchAll — page through a PostgREST query until every row has been read.
 *
 * WHY: Supabase's API caps any single response at `max-rows` (1,000 by default).
 * A report that does `await supabase.from('gl_entry_lines').select(...)` with no
 * `.range()` silently receives the FIRST 1,000 rows and nothing else — no error,
 * no flag. Once a company has more than 1,000 ledger lines its balance sheet,
 * income statement, cash flow and trial balance quietly become wrong. Every
 * ledger-scale read must go through this helper (or an explicit bounded page).
 *
 * HOW:
 *  - The caller passes a FACTORY that returns a fresh, fully-filtered query
 *    builder. A PostgREST builder is single-use (it is a thenable that mutates its
 *    URL), so each page needs a brand-new builder.
 *  - The helper appends a STABLE, UNIQUE ordering (`orderBy`, default `id`) so
 *    consecutive `.range()` pages can neither overlap nor skip rows. If the
 *    factory already orders by something non-unique (e.g. `account_id`), the
 *    helper's order is appended as a tie-breaker — postgrest-js concatenates
 *    successive `.order()` calls.
 *  - Pages of `pageSize` (default 1,000 — must be <= the server's max-rows) are
 *    requested until a SHORT page (fewer than `pageSize` rows) comes back.
 *  - A hard ceiling (default 500,000 rows) throws `FetchAllLimitError` instead of
 *    silently truncating. A report that is wrong-but-quiet is worse than one
 *    that fails loudly.
 *  - On a query error the helper stops and returns `{ data: null, error }` —
 *    the same shape as an awaited PostgREST builder — so call sites keep their
 *    existing error handling unchanged.
 *
 * `fetchAllIn` additionally chunks a large `.in(column, ids)` list (a long id
 * list blows past URL-length limits) and pages each chunk.
 */

/** Rows requested per page. Must not exceed the PostgREST `max-rows` setting (1,000 on Supabase). */
export const FETCH_ALL_PAGE_SIZE = 1000;
/** Hard safety ceiling — more rows than this throws instead of truncating. */
export const FETCH_ALL_MAX_ROWS = 500_000;
/** Ids per `.in()` chunk in `fetchAllIn` (36-char UUIDs keep the URL well under 16 KB). */
export const FETCH_ALL_IN_CHUNK = 200;

/** Minimal error shape shared by PostgrestError and test fakes. */
export interface FetchAllErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** What an awaited, ranged PostgREST builder resolves to (structurally). */
export interface FetchAllPageResult<Row> {
  data: Row[] | null;
  error: FetchAllErrorLike | null;
}

/**
 * The structural subset of a PostgREST filter builder this helper needs. Real
 * supabase-js builders satisfy it; tests pass a small fake.
 */
export interface PageableQuery<Row> {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): PageableQuery<Row>;
  range(from: number, to: number): PromiseLike<FetchAllPageResult<Row>>;
}

export interface FetchAllOptions {
  /**
   * Column(s) giving a UNIQUE, deterministic order across the full result set.
   * Defaults to `id`. For views without an `id`, pass the view's unique key
   * (e.g. `['location_id', 'account_id']` for `v_trial_balance`).
   */
  orderBy?: string | readonly string[];
  /** Rows per page (default 1,000). */
  pageSize?: number;
  /** Throw once more than this many rows would be returned (default 500,000). */
  maxRows?: number;
  /** Label used in the ceiling error message (e.g. `'balance-sheet gl_entry_lines'`). */
  label?: string;
}

export class FetchAllLimitError extends Error {
  readonly maxRows: number;
  constructor(label: string, maxRows: number) {
    super(
      `fetchAll(${label}): result exceeds the ${maxRows.toLocaleString('en-US')}-row safety ceiling. ` +
        'Refusing to return a truncated ledger read — narrow the query (date range / entity) or aggregate in SQL.',
    );
    this.name = 'FetchAllLimitError';
    this.maxRows = maxRows;
  }
}

function orderColumns(orderBy: FetchAllOptions['orderBy']): readonly string[] {
  if (orderBy === undefined) return ['id'];
  const cols = typeof orderBy === 'string' ? [orderBy] : orderBy;
  if (cols.length === 0) throw new Error('fetchAll: orderBy must name at least one column');
  return cols;
}

/**
 * Read EVERY row of a query, one `.range()` page at a time.
 *
 * @example
 *   const { data, error } = await fetchAll<LineRow>(
 *     () => supabase.from('gl_entry_lines').select('id, account_id, debit_cents')
 *                   .eq('org_id', orgId),
 *     { label: 'trial-balance lines' },
 *   );
 */
export async function fetchAll<Row>(
  makeQuery: () => PageableQuery<Row>,
  options: FetchAllOptions = {},
): Promise<FetchAllPageResult<Row>> {
  const pageSize = options.pageSize ?? FETCH_ALL_PAGE_SIZE;
  const maxRows = options.maxRows ?? FETCH_ALL_MAX_ROWS;
  const label = options.label ?? 'query';
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`fetchAll(${label}): pageSize must be a positive integer`);
  }
  const cols = orderColumns(options.orderBy);

  const out: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = makeQuery();
    for (const col of cols) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) return { data: null, error };

    const page = data ?? [];
    if (out.length + page.length > maxRows) throw new FetchAllLimitError(label, maxRows);
    for (const row of page) out.push(row);

    if (page.length < pageSize) break;
  }
  return { data: out, error: null };
}

/**
 * Like `fetchAll`, but for a filter on a (possibly huge) id list: splits `ids`
 * into chunks, pages each chunk fully, and concatenates. The factory receives
 * the chunk and must apply the `.in(column, chunk)` filter itself.
 *
 * Chunks are disjoint, so the union is exactly the rows a single `.in(ids)`
 * query would return (row ORDER across chunks is not meaningful — callers that
 * need an order must sort the result). Duplicate ids are de-duplicated first.
 */
export async function fetchAllIn<Row, Id extends string | number = string>(
  ids: readonly Id[],
  makeQuery: (chunk: Id[]) => PageableQuery<Row>,
  options: FetchAllOptions & { chunkSize?: number } = {},
): Promise<FetchAllPageResult<Row>> {
  const chunkSize = options.chunkSize ?? FETCH_ALL_IN_CHUNK;
  const maxRows = options.maxRows ?? FETCH_ALL_MAX_ROWS;
  const label = options.label ?? 'query';
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return { data: [], error: null };

  const out: Row[] = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const remaining = maxRows - out.length;
    const res = await fetchAll<Row>(() => makeQuery(chunk), { ...options, maxRows: remaining });
    if (res.error) return { data: null, error: res.error };
    for (const row of res.data ?? []) out.push(row);
  }
  if (out.length > maxRows) throw new FetchAllLimitError(label, maxRows);
  return { data: out, error: null };
}
