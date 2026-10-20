'use client';

/**
 * Server-paginated, sortable dealer table with keyboard navigation
 * (j/k or ↑/↓ to move, Enter to open) and loading / empty / error states.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronRight, type LucideIcon } from 'lucide-react';
import { ListPager } from '@/components/ui/list-pager';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { Empty, ErrorPanel } from './ui';

export interface DealerColumn<R> {
  key: string;
  header: string;
  /** D1 sortable column name (allow-listed server side). */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  render: (row: R) => ReactNode;
}

export function DealerTable<R extends { id: string }>({
  columns,
  rows,
  isLoading,
  error,
  onRetry,
  sort,
  dir,
  onSort,
  onRowClick,
  rowClassName,
  empty,
  page,
  perPage,
  total,
  noun,
  onPageChange,
  selectedId,
  keyboard = true,
  caption,
}: {
  columns: DealerColumn<R>[];
  rows: R[];
  isLoading: boolean;
  error?: DealerApiError | null;
  onRetry?: () => void;
  sort?: string;
  dir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  onRowClick?: (row: R) => void;
  rowClassName?: (row: R) => string | undefined;
  empty: { icon: LucideIcon; title: string; description: ReactNode; action?: ReactNode };
  page?: number;
  perPage?: number;
  total?: number;
  noun?: string;
  onPageChange?: (p: number) => void;
  selectedId?: string | null;
  keyboard?: boolean;
  caption?: string;
}) {
  const [focus, setFocus] = useState(-1);
  const body = useRef<HTMLTableSectionElement>(null);

  useEffect(() => setFocus(-1), [rows]);

  useEffect(() => {
    if (!keyboard || !onRowClick) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (rows.length === 0) return;
        e.preventDefault();
        setFocus((f) => Math.min(f + 1, rows.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (rows.length === 0) return;
        e.preventDefault();
        setFocus((f) => Math.max(f - 1, 0));
      } else if (e.key === 'Enter' && focus >= 0 && rows[focus]) {
        e.preventDefault();
        onRowClick?.(rows[focus]);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyboard, onRowClick, rows, focus]);

  useEffect(() => {
    if (focus < 0) return;
    body.current?.querySelectorAll('tr')[focus]?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  if (error) return <ErrorPanel error={error} onRetry={onRetry} />;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-slate-800">
              {columns.map((c) => {
                const active = c.sortKey && sort === c.sortKey;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={clsx(
                      'whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    )}
                  >
                    {c.sortKey && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(c.sortKey!)}
                        className={clsx('inline-flex items-center gap-1 hover:text-slate-300', active && 'text-slate-300')}
                      >
                        {c.header}
                        {active && (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {onRowClick && <th aria-hidden className="w-6" />}
            </tr>
          </thead>
          <tbody ref={body} className="divide-y divide-slate-800/50">
            {isLoading && rows.length === 0
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">
                        <div className="h-3.5 w-full max-w-[140px] animate-pulse rounded bg-slate-800" />
                      </td>
                    ))}
                    {onRowClick && <td />}
                  </tr>
                ))
              : rows.map((r, i) => (
                  <tr
                    key={r.id}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(r);
                            }
                          }
                        : undefined
                    }
                    onFocus={() => setFocus(i)}
                    className={clsx(
                      onRowClick ? 'row-clickable cursor-pointer focus:outline-none' : 'table-row-hover',
                      (i === focus || r.id === selectedId) && 'bg-slate-800/40',
                      isLoading && 'opacity-60',
                      rowClassName?.(r),
                    )}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={clsx(
                          'px-4 py-2.5 align-middle',
                          c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                          c.className,
                        )}
                      >
                        {c.render(r)}
                      </td>
                    ))}
                    {onRowClick && (
                      <td className="pr-3 text-right">
                        <ChevronRight size={14} className="row-chevron inline text-slate-600" />
                      </td>
                    )}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!isLoading && rows.length === 0 && <Empty {...empty} />}
      {page !== undefined && perPage !== undefined && total !== undefined && onPageChange && (
        <ListPager page={page} perPage={perPage} total={total} noun={noun ?? 'rows'} onPageChange={onPageChange} isLoading={isLoading} />
      )}
    </div>
  );
}

/** Search box + filter row above a table. */
export function TableToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-5 py-3">{children}</div>;
}

/** A segmented filter (status tabs). */
export function Segments<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: Array<{ value: V; label: string; count?: number }>; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-slate-800 bg-surface-950 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-2.5 py-1 text-xs transition-colors',
            value === o.value ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {o.label}
          {typeof o.count === 'number' && <span className="ml-1 font-mono tabular-nums text-slate-500">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
