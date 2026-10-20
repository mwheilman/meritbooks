'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input, api, useDebounce } from '@meritbooks/merit-ui';

export interface VendorOption {
  id: string;
  name: string;
  email: string | null;
  city: string | null;
  /** The vendor's AP retainage default as a fraction (core.vendors keeps a percent). */
  retainagePct: number;
}

export interface VendorValue {
  id: string | null;
  name: string;
}

/**
 * Search core.vendors as you type (Merit Books owns vendors; Merit Projects only picks one).
 * Arrow keys move, Enter picks, Escape closes.
 */
export function VendorPicker({ value, onChange, onPick, id, invalid }: { value: VendorValue; onChange: (v: VendorValue) => void; onPick?: (v: VendorOption) => void; id?: string; invalid?: boolean }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<VendorOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [cursor, setCursor] = useState(-1);
  const q = useDebounce(value.name.trim(), 200);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    if (!open || value.id) {
      setItems([]);
      return;
    }
    setState('loading');
    void api.get<{ vendors: VendorOption[] }>('/api/commitments/vendors', { q }).then((r) => {
      if (!live) return;
      if (r.error) {
        setState('error');
        setItems([]);
      } else {
        setState('idle');
        setItems(r.data?.vendors ?? []);
      }
    });
    return () => {
      live = false;
    };
  }, [q, open, value.id]);

  const choose = (v: VendorOption) => {
    onChange({ id: v.id, name: v.name });
    onPick?.(v);
    setOpen(false);
  };

  return (
    <div ref={box} style={{ position: 'relative' }} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Input
        id={id}
        role="combobox"
        invalid={invalid}
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={cursor >= 0 ? `${uid}-o${cursor}` : undefined}
        autoComplete="off"
        placeholder="Search vendors"
        value={value.name}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({ id: null, name: e.target.value });
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
      {open && items.length > 0 && (
        <ul className="popover popover-list" id={listId} role="listbox" style={{ position: 'absolute', zIndex: 20, top: 36, left: 0, right: 0, maxHeight: 240, overflow: 'auto' }}>
          {items.map((v, i) => (
            <li key={v.id} id={`${uid}-o${i}`} role="option" aria-selected={i === cursor} className="popover-item" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(v)}>
              <span className="l1">{v.name}</span>
              <span className="l2">{[v.city, v.email, v.retainagePct ? `${Math.round(v.retainagePct * 10000) / 100}% retainage` : null].filter(Boolean).join(' · ') || ' '}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="field-help" style={{ display: 'block', marginTop: 4 }}>
        {value.id
          ? 'From your vendor list in Merit Books.'
          : state === 'error'
            ? 'Vendors did not load. Keep typing to try again.'
            : open && q && items.length === 0 && state === 'idle'
              ? 'No vendor by that name. Add the vendor in Merit Books, then pick it here.'
              : 'Required to approve. Vendors come from Merit Books.'}
      </span>
    </div>
  );
}
