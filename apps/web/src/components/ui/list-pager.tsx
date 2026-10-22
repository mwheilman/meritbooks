'use client';

import { Button, count } from '@meritbooks/merit-ui';
import { pagerState } from '@/lib/pager';

interface ListPagerProps {
  page: number;
  perPage: number;
  total: number;
  /** Noun for the count line, e.g. "bills". */
  noun: string;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
}

/**
 * Footer pager for server-paginated tables on merit-ui: "51–100 of 132 bills" plus
 * previous/next (kit icon buttons). Renders nothing when everything fits on one page.
 */
export function ListPager({ page, perPage, total, noun, onPageChange, isLoading }: ListPagerProps) {
  const s = pagerState(page, perPage, total);
  if (s.totalPages <= 1) return null;
  return (
    <nav aria-label={`${noun} pagination`} className="row row--between mb-pager">
      <span className="t-cap tnum" aria-live="polite">
        {count(s.from)}–{count(s.to)} of {count(s.total)} {noun}
      </span>
      <span className="btn-row">
        <Button iconOnly icon="left" aria-label="Previous page" disabled={!s.hasPrev || isLoading} onClick={() => onPageChange(s.page - 1)} />
        <span className="t-cap tnum">
          Page {s.page} of {s.totalPages}
        </span>
        <Button iconOnly icon="right" aria-label="Next page" disabled={!s.hasNext || isLoading} onClick={() => onPageChange(s.page + 1)} />
      </span>
    </nav>
  );
}
