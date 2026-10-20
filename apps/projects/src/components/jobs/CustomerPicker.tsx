'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input, api, useDebounce } from '@meritbooks/merit-ui';

export interface CustomerValue {
  id: string | null;
  name: string;
}

/**
 * Search core.customers as you type; pick one, or keep the typed name as a
 * provisional customer (stored on the job until it exists in Merit Books).
 */
export function CustomerPicker({ value, onChange, companyId, id }: { value: CustomerValue; onChange: (v: CustomerValue) => void; companyId: string | null; id?: string }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  const [cursor, setCursor] = useState(-1);
  const q = useDebounce(value.name.trim(), 200);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    if (!open || q.length < 1 || value.id) {
      setItems([]);
      return;
    }
    void api.get<{ customers: Array<{ id: string; name: string }> }>('/api/customers', { q, companyId }).then((r) => {
      if (live && r.data) setItems(r.data.customers);
    });
    return () => {
      live = false;
    };
  }, [q, open, companyId, value.id]);

  const choose = (c: { id: string; name: string }) => {
    onChange({ id: c.id, name: c.name });
    setOpen(false);
  };

  const exact = items.some((c) => c.name.toLowerCase() === value.name.trim().toLowerCase());
  return (
    <div ref={box} style={{ position: 'relative' }} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Input
        id={id}
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={cursor >= 0 ? `${uid}-o${cursor}` : undefined}
        autoComplete="off"
        placeholder="Search customers or type a new name"
        value={value.name}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({ id: null, name: e.target.value });
          setOpen(true);
          setCursor(-1);
        }}
        onKeyDown={(e) => {
          if (!items.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % items.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c <= 0 ? items.length - 1 : c - 1)); }
          else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(items[cursor]!); }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && items.length > 0 && (
        <ul className="popover popover-list" id={listId} role="listbox" style={{ position: 'absolute', zIndex: 20, top: 36, left: 0, right: 0, maxHeight: 240, overflow: 'auto' }}>
          {items.map((c, i) => (
            <li
              key={c.id}
              id={`${uid}-o${i}`}
              role="option"
              aria-selected={i === cursor}
              className="popover-item"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c)}
            >
              {c.name}
            </li>
          ))}
        </ul>
      )}
      <span className="field-help" style={{ display: 'block', marginTop: 4 }}>
        {value.id ? 'From your customer list.' : value.name.trim() && !exact ? 'New name: kept on the job until the customer is added in Merit Books.' : 'Optional. Stage moves may need one later.'}
      </span>
    </div>
  );
}
