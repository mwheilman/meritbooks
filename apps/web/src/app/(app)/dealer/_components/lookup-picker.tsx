'use client';

/**
 * Searchable picker over /api/dealer/lookups (vendors, customers, departments,
 * accounts, units, lines, programs, OEM programs). Keyboard: ↑/↓ to move, Enter
 * to pick, Esc to close. Debounced search.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import type { LookupItem, LookupKind } from '@/lib/dealer/lookups';
import { useLookupSearch, useNames } from '../_lib/use-dealer';

export function LookupPicker({
  kind,
  value,
  onChange,
  placeholder = 'Choose…',
  types,
  invalid,
  id,
  allowClear = true,
  filter,
  disabled,
  'aria-label': ariaLabel,
}: {
  kind: LookupKind;
  value: string | null;
  onChange: (id: string | null, item: LookupItem | null) => void;
  placeholder?: string;
  /** accounts: restrict to these account types. */
  types?: string[];
  invalid?: boolean;
  id?: string;
  allowClear?: boolean;
  /** Client-side filter on search results (e.g. programs of one line). */
  filter?: (item: LookupItem) => boolean;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const names = useNames(kind, [value]);
  const { items, loading, error } = useLookupSearch(kind, q, { types, enabled: open });
  const shown = filter ? items.filter(filter) : items;
  const selected = value ? names.get(value) : null;

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

  function pick(it: LookupItem | null) {
    onChange(it?.id ?? null, it);
    setOpen(false);
    setQ('');
  }

  return (
    <div ref={wrap} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((o) => !o)}
        className={clsx('input flex w-full items-center justify-between gap-2 text-left', invalid && 'input-error', disabled && 'opacity-50')}
      >
        <span className={clsx('min-w-0 truncate', selected ? 'text-slate-100' : 'text-slate-500')}>
          {value ? selected?.label ?? 'Loading…' : placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {allowClear && value && !disabled && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selection"
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
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, shown.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (shown[active]) pick(shown[active]);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
                role="combobox"
                aria-controls={listId}
                aria-expanded
                aria-activedescendant={shown[active] ? `${listId}-${shown[active].id}` : undefined}
                placeholder="Search…"
                className="w-full rounded border border-slate-700 bg-slate-800/60 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
              />
            </div>
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {loading && (
              <li className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                <Loader2 size={12} className="animate-spin" /> Searching…
              </li>
            )}
            {!loading && error && <li className="px-3 py-2 text-xs text-red-400">{error}</li>}
            {!loading && !error && shown.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">No matches.</li>}
            {!loading &&
              shown.map((it, i) => (
                <li
                  key={it.id}
                  id={`${listId}-${it.id}`}
                  role="option"
                  aria-selected={it.id === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(it);
                  }}
                  className={clsx('cursor-pointer px-3 py-1.5 text-xs', i === active ? 'bg-slate-800 text-white' : 'text-slate-300')}
                >
                  <div className="truncate">{it.label}</div>
                  {it.sub && <div className="truncate text-2xs text-slate-500">{it.sub}</div>}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
