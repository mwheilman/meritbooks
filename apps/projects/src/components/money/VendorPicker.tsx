'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input, Seg, api, toast, useDebounce } from '@meritbooks/merit-ui';
import { VENDOR_COMPLIANCE_NOTE, VENDOR_KIND_WORDS, sameName, type VendorKind } from '@/lib/pm/parties/schemas';
import { checkDecision, decisionBody, type MatchCandidate, type MatchDecision } from '@/lib/parties/match';
import { MatchAtTheDoor, useDoorMatch } from '@/components/crm/MatchAtTheDoor';
import { fieldErrors, postToDoor } from '@/components/crm/door-fetch';

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

/** Lets the picker add a vendor on the spot (pm.create_vendor via POST /api/vendors). */
export interface VendorAdd {
  kind: VendorKind;
  companyId: string | null;
}

/**
 * Search core.vendors as you type (one shared vendor list with Merit Books). With `add`, a name
 * that is not on the list can be added now: "Add new vendor or subcontractor" creates the real
 * core.vendors row as provisional (W-9 missing), so Merit Books requests the W-9 and COI.
 * Arrow keys move, Enter picks, Escape closes.
 */
export function VendorPicker({ value, onChange, onPick, id, invalid, add }: { value: VendorValue; onChange: (v: VendorValue) => void; onPick?: (v: VendorOption) => void; id?: string; invalid?: boolean; add?: VendorAdd }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<VendorOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [cursor, setCursor] = useState(-1);
  const [adding, setAdding] = useState(false);
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
    setAdding(false);
  };
  const typed = value.name.trim();
  const offerAdd = !!add && !value.id && typed.length > 0 && state === 'idle' && q === typed && !items.some((v) => sameName(v.name, typed));
  const options = items.length + (offerAdd ? 1 : 0);
  const startAdd = () => { setAdding(true); setOpen(false); };

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
        placeholder="Search vendors"
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
          else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); if (cursor < items.length) choose(items[cursor]!); else startAdd(); }
        }}
      />
      {open && options > 0 && (
        <ul className="popover popover-list" id={listId} role="listbox" style={{ position: 'absolute', zIndex: 20, top: 36, left: 0, right: 0, maxHeight: 240, overflow: 'auto' }}>
          {items.map((v, i) => (
            <li key={v.id} id={`${uid}-o${i}`} role="option" aria-selected={i === cursor} className="popover-item" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(v)}>
              <span className="l1">{v.name}</span>
              <span className="l2">{[v.city, v.email, v.retainagePct ? `${Math.round(v.retainagePct * 10000) / 100}% retainage` : null].filter(Boolean).join(' · ') || ' '}</span>
            </li>
          ))}
          {offerAdd && (
            <li id={`${uid}-o${items.length}`} role="option" aria-selected={cursor === items.length} className="popover-item" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={startAdd}>
              <span className="l1">Add new vendor or subcontractor “{typed}”</span>
              <span className="l2">{VENDOR_COMPLIANCE_NOTE}</span>
            </li>
          )}
        </ul>
      )}
      {adding && add && !value.id ? (
        <NewVendorInline name={typed} add={add} onCancel={() => setAdding(false)} onAdded={choose} />
      ) : (
        <span className="field-help" style={{ display: 'block', marginTop: 4 }}>
          {value.id
            ? 'From your vendor list, shared with Merit Books.'
            : state === 'error'
              ? 'Vendors did not load. Keep typing to try again.'
              : open && q && items.length === 0 && state === 'idle'
                ? add ? 'Not on your vendor list yet. Choose “Add new vendor or subcontractor”.' : 'No vendor by that name. Add the vendor in Merit Books, then pick it here.'
                : add ? 'Required to approve. Pick from your vendor list or add a new one.' : 'Required to approve. Vendors come from Merit Books.'}
        </span>
      )}
    </div>
  );
}

/** "Add new vendor or subcontractor": name, kind, contact. Not a <form> (it sits inside one). */
function NewVendorInline({ name: initial, add, onCancel, onAdded }: { name: string; add: VendorAdd; onCancel: () => void; onAdded: (v: VendorOption) => void }) {
  const [name, setName] = useState(initial);
  const [kind, setKind] = useState<VendorKind>(add.kind);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  // Matching at the door (SHARED-RECORDS §3): a vendor Books already pays is offered first.
  const [decision, setDecision] = useState<MatchDecision | null>(null);
  const [conflict, setConflict] = useState<MatchCandidate[] | null>(null);
  const [doorProblem, setDoorProblem] = useState<string | null>(null);
  const door = useDoorMatch('vendor', { name, email, phone }, conflict);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Give the vendor a name.';
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = 'Enter an email like office@company.com.';
    const check = checkDecision(door.verdict, decision, 'vendor');
    setErr(e);
    setDoorProblem(check.ok ? null : check.message);
    if (Object.keys(e).length || !check.ok) return;
    setBusy(true);
    const r = await postToDoor<{ vendor: VendorOption; existing: boolean }>('/api/vendors', { name: name.trim(), kind, email: email.trim() || null, phone: phone.trim() || null, companyId: add.companyId, match: decisionBody(decision) });
    setBusy(false);
    if (r.kind === 'match') {
      setConflict(r.candidates);
      setDoorProblem(r.message);
      return;
    }
    if (r.kind === 'error') {
      setErr({ ...fieldErrors(r.error), _: r.error.error });
      return;
    }
    toast(r.data.existing ? `${r.data.vendor.name} is already on your vendor list; picked it` : `Added ${r.data.vendor.name}. Merit Books will request the W-9 and COI`);
    onAdded(r.data.vendor);
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void submit(); }
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
  };

  return (
    <div className="stack" role="group" aria-label="Add new vendor or subcontractor" style={{ gap: 8, marginTop: 8, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
      <Field label="Name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} maxLength={200} autoFocus /></Field>
      <Field label="Kind">
        <Seg<VendorKind> aria-label="Vendor kind" value={kind} onChange={setKind}
          items={(['SUBCONTRACTOR', 'SUPPLIER', 'OTHER'] as const).map((k) => ({ value: k, label: VENDOR_KIND_WORDS[k] }))} />
      </Field>
      <div className="mp-form-2">
        <Field label="Email" error={err.email} help="Where the W-9 and COI request goes"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} maxLength={254} /></Field>
        <Field label="Phone" error={err.phone}><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={enter} maxLength={40} placeholder="Optional" /></Field>
      </div>
      <MatchAtTheDoor kind="vendor" verdict={door.verdict} decision={decision} onDecision={setDecision} loading={door.loading} error={door.error} problem={doorProblem} />
      <span className="t-cap">{VENDOR_COMPLIANCE_NOTE} Terms, tax details and retainage defaults are set there.</span>
      {err._ && <span className="field-error" role="alert">{err._}</span>}
      <div className="btn-row">
        <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void submit()}>Add vendor</Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
