/**
 * Pagination helper — pure, deterministic clamping + offset math for the
 * high-volume transactional LIST endpoints.
 *
 * Ledger-scale tables (invoices, bills, gl_entries, bank_transactions, documents)
 * grow without bound in production, so every list route must (a) request a bounded
 * page and (b) NEVER let a caller ask for an unbounded page. This centralizes the
 * clamp so a route can't accidentally omit the cap (the bug this module fixes).
 *
 * Everything here is pure (no I/O) so it unit-tests with no DB. `resolvePageParams`
 * turns raw string query params into a safe { page, perPage, offset, rangeFrom,
 * rangeTo } — `rangeFrom`/`rangeTo` are the inclusive bounds PostgREST `.range()`
 * expects.
 */

/** Default rows per page when the caller doesn't specify. Matches the existing list routes. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard ceiling — a caller can NEVER pull more than this many rows in one page. */
export const MAX_PAGE_SIZE = 100;

export interface PageParams {
  /** 1-based page number (>= 1). */
  page: number;
  /** Rows per page, clamped to [1, maxSize]. */
  perPage: number;
  /** 0-based offset into the result set. */
  offset: number;
  /** Inclusive lower bound for PostgREST `.range(from, to)`. */
  rangeFrom: number;
  /** Inclusive upper bound for PostgREST `.range(from, to)`. */
  rangeTo: number;
}

export interface ResolvePageOptions {
  defaultSize?: number;
  maxSize?: number;
}

/**
 * Parse a positive integer from a raw query value. Returns `fallback` for null,
 * undefined, non-numeric, non-integer, or non-positive input (never throws).
 */
function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

/**
 * Resolve raw `page` / `per_page` query params into safe, bounded pagination.
 *
 * - `page` floors to 1 (a missing/invalid/<1 page is page 1).
 * - `perPage` defaults to `defaultSize` and is HARD-CLAMPED to [1, maxSize], so
 *   `per_page=1000000` can never pull the whole table.
 * - `offset` / `rangeFrom` / `rangeTo` are derived so `.range(rangeFrom, rangeTo)`
 *   returns exactly this page with no dropped or duplicated rows.
 */
export function resolvePageParams(
  input: { page?: string | null; per_page?: string | null },
  opts: ResolvePageOptions = {},
): PageParams {
  const defaultSize = opts.defaultSize ?? DEFAULT_PAGE_SIZE;
  const maxSize = opts.maxSize ?? MAX_PAGE_SIZE;

  const page = parsePositiveInt(input.page, 1);
  const requested = parsePositiveInt(input.per_page, defaultSize);
  const perPage = Math.min(Math.max(requested, 1), maxSize);

  const offset = (page - 1) * perPage;
  return {
    page,
    perPage,
    offset,
    rangeFrom: offset,
    rangeTo: offset + perPage - 1,
  };
}

/** Total number of pages for a given total row count and page size (>= 1). */
export function totalPages(total: number, perPage: number): number {
  if (perPage <= 0) return 1;
  return Math.max(1, Math.ceil((total ?? 0) / perPage));
}
