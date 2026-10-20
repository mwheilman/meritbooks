'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input, api, useDebounce } from '@meritbooks/merit-ui';
import type { LookupItem } from '@/lib/pm/ops/types';

export type LookupKind = 'jobs' | 'assets' | 'price_book' | 'employees' | 'vendors' | 'customers';

export interface LookupProps {
  kind: LookupKind;
  value: { id: string; label: string } | null;
  onChange: (item: LookupItem | null) => void;
  companyId?: string | null;
  customerId?: string | null;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  /** Show results on focus even before typing (short lists: assets of a customer). */
  eager?: boolean;
  'aria-label'?: string;
}

/**
 * Type-ahead over /api/ops/lookup. Arrow keys move, Enter picks, Escape closes;
 * clearing the text clears the pick.
 */
export function Lookup({ kind, value, onChange, companyId, customerId, placeholder, id, disabled, eager, ...aria }: LookupProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [text, setText] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LookupItem[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [loading, setLoading] = useState(false);
  const q = useDebounce(text.trim(), 200);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(value?.label ?? '');
  }, [value?.id, value?.label]);

  useEffect(() => {
    let live = true;
    const picked = value && value.label === text;
    if (!open || picked || (!eager && q.length < 1)) {
      setItems([]);
      return;
    }
    setLoading(true);
    void api.get<{ items: LookupItem[] }>('/api/ops/lookup', { kind, q, companyId: companyId ?? undefined, customerId: customerId ?? undefined }).then((r) => {
      if (!live) return;
      setLoading(false);
      setItems(r.data?.items ?? []);
    });
    return () => {
      live = false;
    };
  }, [q, open, kind, companyId, customerId, eager, value, text]);

  const choose = (it: LookupItem) => {
    onChange(it);
    setText(it.label);
    setOpen(false);
  };

  return (
    <div ref={box} style={{ position: 'relative' }} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Input
        id={id}
        role="combobox"
        aria-label={aria['aria-label']}
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={cursor >= 0 ? `${uid}-o${cursor}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          if (value) onChange(null);
          setOpen(true);
          setCursor(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
          if (!items.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % items.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c <= 0 ? items.length - 1 : c - 1)); }
          else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(items[cursor]!); }
        }}
      />
      {open && (items.length > 0 || (loading && q.length > 0)) && (
        <ul className="popover popover-list" id={listId} role="listbox" style={{ position: 'absolute', zIndex: 30, top: 36, left: 0, right: 0, maxHeight: 260, overflow: 'auto' }}>
          {items.length === 0 ? (
            <li className="popover-item" aria-disabled="true">Searching…</li>
          ) : (
            items.map((it, i) => (
              <li
                key={it.id}
                id={`${uid}-o${i}`}
                role="option"
                aria-selected={i === cursor}
                className="popover-item"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(it)}
              >
                <span className="l1">{it.label}</span>
                {it.sub && <span className="l2" style={{ display: 'block' }}>{it.sub}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
