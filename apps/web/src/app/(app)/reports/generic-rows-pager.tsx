'use client';

import { Button, ListPager } from '@meritbooks/merit-ui';

/**
 * Paging for the catalog's generic row reports (GL detail, transaction list, open
 * items …). They used to render the first 200 rows and silently drop the rest; now
 * the header states the full count and the reader pages through every row, or
 * shows them all at once.
 */

export const GENERIC_PAGE_SIZE = 100;

/** The rows on `page` (1-based), or every row when `showAll`. Pure. */
export function pageRows<T>(rows: readonly T[], page: number, perPage: number, showAll: boolean): T[] {
  if (showAll) return [...rows];
  const size = Math.max(1, Math.floor(perPage));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  return rows.slice((p - 1) * size, p * size);
}

export function GenericRowsPager({
  total,
  page,
  perPage,
  showAll,
  onPage,
  onShowAll,
}: {
  total: number;
  page: number;
  perPage: number;
  showAll: boolean;
  onPage: (p: number) => void;
  onShowAll: (v: boolean) => void;
}) {
  const paged = total > perPage;
  return (
    <div className="row row--between" style={{ padding: '8px 16px', gap: 12, alignItems: 'center' }}>
      <span className="t-cap tnum">
        {total.toLocaleString()} {total === 1 ? 'row' : 'rows'}
        {paged && showAll ? ' · showing all' : ''}
      </span>
      {paged && (
        <span className="btn-row" style={{ alignItems: 'center' }}>
          {!showAll && <ListPager page={page} perPage={perPage} total={total} onPage={onPage} noun="rows" className="btn-row" />}
          <Button variant="quiet" onClick={() => onShowAll(!showAll)}>
            {showAll ? `Show ${perPage} per page` : `Show all ${total.toLocaleString()}`}
          </Button>
        </span>
      )}
    </div>
  );
}
