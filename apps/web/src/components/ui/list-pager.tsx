'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
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
 * Footer pager for server-paginated tables: "Showing 51–100 of 132 bills" plus
 * Prev/Next. Renders nothing when everything fits on one page.
 */
export function ListPager({ page, perPage, total, noun, onPageChange, isLoading }: ListPagerProps) {
  const s = pagerState(page, perPage, total);
  if (s.totalPages <= 1) return null;
  return (
    <nav
      aria-label={`${noun} pagination`}
      className="flex items-center justify-between px-4 py-3 border-t border-slate-800 text-xs text-slate-500"
    >
      <span className="font-mono tabular-nums" aria-live="polite">
        Showing {s.from.toLocaleString()}–{s.to.toLocaleString()} of {s.total.toLocaleString()} {noun}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(s.page - 1)}
          disabled={!s.hasPrev || isLoading}
          aria-label="Previous page"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] disabled:text-slate-700 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="px-2 font-mono tabular-nums">
          {s.page} / {s.totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(s.page + 1)}
          disabled={!s.hasNext || isLoading}
          aria-label="Next page"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] disabled:text-slate-700 disabled:cursor-not-allowed transition-colors"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </nav>
  );
}
