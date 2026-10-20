'use client';

/**
 * Searchable note picker (lender invoice # / description) over GET /api/dealer/notes,
 * optionally limited to one line. Keyboard: ↑/↓, Enter, Esc. Debounced search.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import { money } from '@/lib/dealer/ui/format';
import { NOTE_STATUS, labelOf } from '@/lib/dealer/ui/labels';
import { useDealerList } from '../../_lib/use-dealer';
import type { FpNote } from '../_lib/types';

export function NotePicker({
  lineId,
  value,
  onChange,
  id,
  placeholder = 'No specific note',
}: {
  lineId: string | null;
  value: FpNote | null;
  onChange: (n: FpNote | null) => void;
  id?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const list = useDealerList<FpNote>(open ? '/api/dealer/notes' : null, {
    sort: 'floored_date',
    dir: 'desc',
    perPage: 20,
    filters: { status: 'OPEN,SOLD_UNPAID,IN_DEFAULT', ...(lineId ? { line_id: lineId } : {}) },
  });
  const { setFilter } = list;
  const items = list.data?.rows ?? [];

  useEffect(() => {
    setFilter('line_id', lineId);
  }, [lineId, setFilter]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setTimeout(() => input.current?.focus(), 0);
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(n: FpNote | null) {
    onChange(n);
    setOpen(false);
    list.setSearch('');
  }

  return (
    <div ref={wrap} className="relative">
      <button id={id} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="input flex w-full items-center justify-between gap-2 text-left">
        <span className={clsx('min-w-0 truncate', value ? 'font-mono tabular-nums text-slate-100' : 'text-slate-500')}>{value ? value.lender_invoice_number : placeholder}</span>
        <span className="flex shrink-0 items-center gap-1">
          {value && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear note"
              onClick={(e) => {
                e.stopPropagation();
                pick(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  pick(null);
                }
              }}
              className="rounded p-0.5 text-slate-500 hover:text-slate-200"
            >
              <X size={12} />
            </span>
          )}
          <ChevronDown size={13} className="text-slate-500" />
        </span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-surface-900 shadow-xl">
          <div className="border-b border-slate-800 p-2">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                ref={input}
                value={list.state.search}
                onChange={(e) => {
                  list.setSearch(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, items.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (items[active]) pick(items[active]);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
                role="combobox"
                aria-controls={listId}
                aria-expanded
                aria-activedescendant={items[active] ? `${listId}-${items[active].id}` : undefined}
                placeholder="Search lender invoice #…"
                className="w-full rounded border border-slate-700 bg-slate-800/60 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
              />
            </div>
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {list.isLoading && (
              <li className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                <Loader2 size={12} className="animate-spin" /> Searching…
              </li>
            )}
            {!list.isLoading && list.error && <li className="px-3 py-2 text-xs text-red-400">{list.error.error}</li>}
            {!list.isLoading && !list.error && items.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">No outstanding notes match.</li>}
            {!list.isLoading &&
              items.map((n, i) => (
                <li
                  key={n.id}
                  id={`${listId}-${n.id}`}
                  role="option"
                  aria-selected={value?.id === n.id}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(n);
                  }}
                  className={clsx('flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-xs', i === active ? 'bg-slate-800 text-white' : 'text-slate-300')}
                >
                  <span className="font-mono tabular-nums">{n.lender_invoice_number}</span>
                  <span className="text-2xs text-slate-500">
                    {labelOf(NOTE_STATUS, n.status)} · <span className="font-mono tabular-nums">{money(n.principal_balance_cents)}</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
