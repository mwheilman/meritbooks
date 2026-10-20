/**
 * Client-side pager math for server-paginated lists (audit 06 §5 bug 7: Bills
 * and Receipts silently stopped at the API's 50-row default page, with nothing
 * telling the user more rows existed). Pure so it unit-tests without a DOM.
 */
export interface PagerState {
  /** 1-based first row shown, 0 when empty. */
  from: number;
  /** 1-based last row shown, 0 when empty. */
  to: number;
  total: number;
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function pagerState(page: number, perPage: number, total: number): PagerState {
  const safeTotal = Math.max(0, Math.floor(total || 0));
  const size = Math.max(1, Math.floor(perPage || 1));
  const totalPages = Math.max(1, Math.ceil(safeTotal / size));
  const p = Math.min(Math.max(1, Math.floor(page || 1)), totalPages);
  if (safeTotal === 0) {
    return { from: 0, to: 0, total: 0, page: 1, totalPages: 1, hasPrev: false, hasNext: false };
  }
  const from = (p - 1) * size + 1;
  const to = Math.min(p * size, safeTotal);
  return { from, to, total: safeTotal, page: p, totalPages, hasPrev: p > 1, hasNext: p < totalPages };
}
