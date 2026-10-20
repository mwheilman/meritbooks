'use client';

import { count } from '../format';
import { Button } from '../primitives/Button';

/**
 * Pager math for server-paginated lists (ported from Books lib/pager.ts — a
 * list must never silently stop at the API's page size). Pure.
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
  if (safeTotal === 0) return { from: 0, to: 0, total: 0, page: 1, totalPages: 1, hasPrev: false, hasNext: false };
  const from = (p - 1) * size + 1;
  const to = Math.min(p * size, safeTotal);
  return { from, to, total: safeTotal, page: p, totalPages, hasPrev: p > 1, hasNext: p < totalPages };
}

export interface ListPagerProps {
  page: number;
  perPage: number;
  total: number;
  onPage: (page: number) => void;
  /** What the rows are ("change orders"). */
  noun?: string;
  className?: string;
}

/** "1–50 of 213 change orders" + previous/next. Hidden when everything fits on one page. */
export function ListPager({ page, perPage, total, onPage, noun, className }: ListPagerProps) {
  const s = pagerState(page, perPage, total);
  if (s.totalPages <= 1) return null;
  return (
    <nav className={className ?? 'row row--between'} aria-label="Pages" style={className ? undefined : { padding: '8px 0' }}>
      <span className="t-cap tnum" aria-live="polite">
        {count(s.from)}–{count(s.to)} of {count(s.total)}
        {noun ? ` ${noun}` : ''}
      </span>
      <span className="btn-row">
        <Button iconOnly icon="left" aria-label="Previous page" disabled={!s.hasPrev} onClick={() => onPage(s.page - 1)} />
        <span className="t-cap tnum">
          Page {s.page} of {s.totalPages}
        </span>
        <Button iconOnly icon="right" aria-label="Next page" disabled={!s.hasNext} onClick={() => onPage(s.page + 1)} />
      </span>
    </nav>
  );
}
