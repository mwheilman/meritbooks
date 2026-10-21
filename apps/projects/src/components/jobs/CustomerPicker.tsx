'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input, api, toast, useDebounce } from '@meritbooks/merit-ui';
import { CUSTOMER_SHARED_NOTE, sameName } from '@/lib/pm/parties/schemas';

export interface CustomerValue {
  id: string | null;
  name: string;
}

/** A typed name with no customer picked: the form must ask the user to add it or pick one. */
export function customerPending(v: CustomerValue): boolean {
  return !v.id && v.name.trim().length > 0;
}

export function customerPendingMessage(v: CustomerValue): string {
  return `Add “${v.name.trim()}” as a new customer, or pick one from the list.`;
}

/**
 * Search core.customers as you type and pick one, or add a new customer on the spot:
 * "Add new customer" creates the real core.customers row now (pm.create_customer, shared with
 * Merit Books; an exact name already on file links to that customer instead).
 */
export function CustomerPicker({ value, onChange, companyId, id, invalid }: { value: CustomerValue; onChange: (v: CustomerValue) => void; companyId: string | null; id?: string; invalid?: boolean }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [adding, setAdding] = useState(false);
  const q = useDebounce(value.name.trim(), 200);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    if (!open || q.length < 1 || value.id) {
      setItems([]);
      setLoaded(false);
      return;
    }
    void api.get<{ customers: Array<{ id: string; name: string }> }>('/api/customers', { q, companyId }).then((r) => {
      if (!live) return;
      setItems(r.data?.customers ?? []);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [q, open, companyId, value.id]);

  const typed = value.name.trim();
  const exact = items.find((c) => sameName(c.name, typed)) ?? null;
  const offerAdd = !value.id && typed.length > 0 && !exact && loaded;
  const options = offerAdd ? items.length + 1 : items.length;

  const choose = (c: { id: string; name: string }) => {
    onChange({ id: c.id, name: c.name });
    setOpen(false);
    setAdding(false);
  };
  const startAdd = () => {
    setAdding(true);
    setOpen(false);
  };

  return (
    <div ref={box} style={{ position: 'relative' }} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Input
        id={id}
        role="combobox"
        invalid={invalid}
        aria-expanded={open && options > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={cursor >= 0 ? `${uid}-o${cursor}` : undefined}
        autoComplete="off"
        placeholder="Search customers or add a new one"
        value={value.name}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({ id: null, name: e.target.value });
          setOpen(true);
          setAdding(false);
          setCursor(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
          if (!options) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % options); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c <= 0 ? options - 1 : c - 1)); }
          else if (e.key === 'Enter' && cursor >= 0) {
            e.preventDefault();
            if (cursor < items.length) choose(items[cursor]!);
            else startAdd();
          }
        }}
      />
      {open && options > 0 && (
        <ul className="popover popover-list" id={listId} role="listbox" style={{ position: 'absolute', zIndex: 20, top: 36, left: 0, right: 0, maxHeight: 260, overflow: 'auto' }}>
          {items.map((c, i) => (
            <li key={c.id} id={`${uid}-o${i}`} role="option" aria-selected={i === cursor} className="popover-item" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c)}>
              {c.name}
            </li>
          ))}
          {offerAdd && (
            <li id={`${uid}-o${items.length}`} role="option" aria-selected={cursor === items.length} className="popover-item" tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()} onClick={startAdd}>
              <span className="l1">Add new customer “{typed}”</span>
              <span className="l2">Creates it in your customer list, shared with Merit Books</span>
            </li>
          )}
        </ul>
      )}
      {adding && !value.id ? (
        <NewCustomerInline name={typed} companyId={companyId} onCancel={() => setAdding(false)} onAdded={(c) => choose(c)} />
      ) : (
        <span className="field-help" style={{ display: 'block', marginTop: 4 }}>
          {value.id
            ? 'From your customer list.'
            : typed && loaded && !exact
              ? 'Not on your list yet. Choose “Add new customer” to add it.'
              : typed && exact
                ? 'Pick it from the list.'
                : 'Optional. Stage moves may need one later.'}
        </span>
      )}
    </div>
  );
}

/** The short "Add new customer" form: name plus optional contact. Not a <form> (it sits inside one). */
function NewCustomerInline({ name: initial, companyId, onCancel, onAdded }: { name: string; companyId: string | null; onCancel: () => void; onAdded: (c: { id: string; name: string }) => void }) {
  const [name, setName] = useState(initial);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});

  const add = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Give the customer a name.';
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = 'Enter an email like name@company.com.';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await api.post<{ customer: { id: string; name: string }; existing: boolean }>('/api/customers', {
      name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, companyId, contactFirst: first.trim() || null, contactLast: last.trim() || null,
    });
    setBusy(false);
    if (r.error) {
      const d = r.error.details ?? {};
      setErr({ ...Object.fromEntries(Object.entries(d).map(([k, m]) => [k, m[0] ?? ''])), _: r.error.error });
      return;
    }
    toast(r.data!.existing ? `${r.data!.customer.name} is already on your customer list; linked it` : `Added ${r.data!.customer.name} to your customers`);
    onAdded(r.data!.customer);
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void add(); }
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
  };

  return (
    <div className="stack" role="group" aria-label="Add new customer" style={{ gap: 8, marginTop: 8, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
      <Field label="Customer name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} maxLength={200} autoFocus /></Field>
      <div className="mp-form-2">
        <Field label="Email" error={err.email}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} maxLength={254} placeholder="Optional" /></Field>
        <Field label="Phone" error={err.phone}><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={enter} maxLength={40} placeholder="Optional" /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Contact first name"><Input value={first} onChange={(e) => setFirst(e.target.value)} onKeyDown={enter} maxLength={100} placeholder="Optional" /></Field>
        <Field label="Contact last name"><Input value={last} onChange={(e) => setLast(e.target.value)} onKeyDown={enter} maxLength={100} placeholder="Optional" /></Field>
      </div>
      <span className="t-cap">{CUSTOMER_SHARED_NOTE}</span>
      {err._ && <span className="field-error" role="alert">{err._}</span>}
      <div className="btn-row">
        <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void add()}>Add customer</Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
