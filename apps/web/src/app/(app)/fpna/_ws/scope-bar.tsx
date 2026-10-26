'use client';

/**
 * Scope: which companies (one, several added together, or every client you can see) and how
 * (100% each, or ownership-weighted). The selection lives in the URL so a view can be shared;
 * the server re-checks it against your client access on every request.
 */
import { useRef, useState } from 'react';
import { Button, Check, Popover, Seg, Search } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import s from './fpna.module.css';

export interface ScopeBarProps {
  companies: string[];
  weighting: 'full' | 'ownership';
  onChange: (patch: { companies?: string[]; weighting?: 'full' | 'ownership' }) => void;
}

export function ScopeBar({ companies, weighting, onChange }: ScopeBarProps) {
  const { companies: all } = useActiveCompany();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set(companies));
  const label =
    companies.length === 0
      ? `All clients${all.length ? ` (${all.length})` : ''}`
      : companies.length === 1
        ? all.find((c) => c.id === companies[0])?.name ?? '1 company'
        : `${companies.length} companies`;
  const shown = all.filter((c) => c.name.toLowerCase().includes(text.toLowerCase()) || c.shortCode.toLowerCase().includes(text.toLowerCase()));
  const toggle = (id: string) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={s.scopeBtn}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setSel(new Set(companies));
          setOpen((o) => !o);
        }}
      >
        <span>{label}</span>
        <span className={s.scopeMeta}>{companies.length > 1 || companies.length === 0 ? 'added together' : ''}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={btn} width={360} aria-label="Choose companies">
        <div style={{ padding: 12 }}>
          <Search aria-label="Find a company" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a company" />
          <ul className={s.checkList}>
            {shown.map((c) => (
              <li key={c.id}>
                <Check label={`${c.name}${c.shortCode ? ` · ${c.shortCode}` : ''}`} checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              </li>
            ))}
            {shown.length === 0 && <li className={s.muted}>No company matches.</li>}
          </ul>
          <div className={s.row} style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <Button variant="quiet" onClick={() => setSel(new Set())}>All clients</Button>
            <Button
              variant="primary"
              onClick={() => {
                onChange({ companies: sel.size === all.length ? [] : [...sel] });
                setOpen(false);
              }}
            >
              Show {sel.size === 0 ? 'all clients' : `${sel.size} compan${sel.size === 1 ? 'y' : 'ies'}`}
            </Button>
          </div>
        </div>
      </Popover>
      <Seg<'full' | 'ownership'>
        aria-label="Weighting"
        value={weighting}
        onChange={(w) => onChange({ weighting: w })}
        items={[
          { value: 'full', label: '100% each' },
          { value: 'ownership', label: 'Ownership-weighted' },
        ]}
      />
    </>
  );
}
