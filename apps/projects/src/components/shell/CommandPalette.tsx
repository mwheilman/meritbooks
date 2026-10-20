'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  Icon, Keys, Popover, PopoverFoot, PopoverGroup, PopoverHead, PopoverItem, PopoverList, Tag,
  api, useDebounce, type FilteredNavGroup, type IconName,
} from '@meritbooks/merit-ui';

export interface SearchJob {
  id: string;
  number: string | null;
  name: string;
  customer: string | null;
  stage: string | null;
  company: string | null;
}

export interface SearchCustomer {
  id: string;
  name: string;
}

export interface SearchResult {
  jobs: SearchJob[];
  customers: SearchCustomer[];
}

interface Row {
  id: string;
  group: 'Jobs' | 'Customers' | 'Pages' | 'Ask';
  label: string;
  sub?: string;
  icon: IconName;
  href?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement>;
  nav: ReadonlyArray<FilteredNavGroup>;
  jobsLabel: string;
  onNavigate: (href: string) => void;
}

function matches(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/**
 * ⌘K — jump to a job, a customer or a page. A typed question with no match gets a
 * calm "Ask is coming" row: Ask (NL over the metric catalog) ships in a later release.
 */
export function CommandPalette({ open, onClose, anchorRef, nav, jobsLabel, onNavigate }: CommandPaletteProps) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [result, setResult] = useState<SearchResult>({ jobs: [], customers: [] });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const debounced = useDebounce(q.trim(), 200);
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    if (debounced.length < 2) {
      setResult({ jobs: [], customers: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    void api.get<SearchResult>('/api/search', { q: debounced }).then((res) => {
      if (!live) return;
      setLoading(false);
      if (res.error) setFailed(true);
      else if (res.data) setResult(res.data);
    });
    return () => {
      live = false;
    };
  }, [debounced, open]);

  const pages = useMemo(() => nav.flatMap((g) => [...g.items, ...g.more]).filter((it, i, all) => all.findIndex((x) => x.href === it.href) === i), [nav]);

  const rows = useMemo<Row[]>(() => {
    const term = q.trim();
    const pageRows: Row[] = pages
      .filter((p) => !term || matches(`${p.label} ${p.href}`, term))
      .slice(0, term ? 6 : 8)
      .map((p) => ({ id: `p:${p.href}`, group: 'Pages', label: p.label, icon: 'right', href: p.href }));
    const jobRows: Row[] = result.jobs.map((j) => ({
      id: `j:${j.id}`,
      group: 'Jobs',
      label: [j.number, j.name].filter(Boolean).join(' · '),
      sub: [j.customer, j.stage, j.company].filter(Boolean).join(' · '),
      icon: 'hammer',
      href: `/jobs/${j.id}`,
    }));
    const custRows: Row[] = result.customers.map((c) => ({
      id: `c:${c.id}`,
      group: 'Customers',
      label: c.name,
      sub: `${jobsLabel} for this customer`,
      icon: 'users',
      href: `/jobs?q=${encodeURIComponent(c.name)}`,
    }));
    const out = [...jobRows, ...custRows, ...pageRows];
    if (term.length >= 2 && !loading && jobRows.length + custRows.length + pageRows.length === 0) {
      out.push({ id: 'ask', group: 'Ask', label: 'Ask is coming in a later release', sub: `For now, try a job number, a customer or a page name.`, icon: 'ask' });
    }
    return out;
  }, [q, pages, result, loading, jobsLabel]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))), [rows.length]);
  const active = rows[cursor];
  useEffect(() => {
    if (active) refs.current.get(active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (r: Row | undefined) => {
    if (!r?.href) return;
    onClose();
    onNavigate(r.href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setCursor((c) => (c + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setCursor((c) => (c - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  };

  const groups: Array<Row['group']> = ['Jobs', 'Customers', 'Pages', 'Ask'];
  const listId = `${uid}-list`;
  const optId = (r: Row) => `${uid}-${r.id.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={560} placement="bottom-end" aria-label="Jump to">
      <PopoverHead>
        <Icon name="search" className="ink-3" />
        <input
          data-autofocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? optId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Jump to a job, customer or page"
          placeholder="Jump to a job, customer or page"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd">Esc</kbd>
      </PopoverHead>
      <PopoverList role="listbox" id={listId} aria-label="Results">
        {groups.map((g) => {
          const items = rows.filter((r) => r.group === g);
          if (items.length === 0) return null;
          return (
            <GroupBlock key={g} label={g === 'Jobs' ? jobsLabel : g} meta={g === 'Jobs' && loading ? 'Searching…' : undefined}>
              {items.map((r) => (
                <PopoverItem
                  key={r.id}
                  id={optId(r)}
                  ref={(el) => {
                    if (el) refs.current.set(r.id, el);
                    else refs.current.delete(r.id);
                  }}
                  active={active?.id === r.id}
                  aria-disabled={r.href ? undefined : true}
                  onMouseMove={() => {
                    const i = rows.findIndex((x) => x.id === r.id);
                    if (i >= 0 && i !== cursor) setCursor(i);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                  right={r.group === 'Ask' ? <Tag>Later release</Tag> : undefined}
                >
                  <Icon name={r.icon} className="ink-2" />
                  <span style={{ minWidth: 0 }}>
                    {r.label}
                    {r.sub ? <span className="l2">{r.sub}</span> : null}
                  </span>
                </PopoverItem>
              ))}
            </GroupBlock>
          );
        })}
        {rows.length === 0 && (
          <li className="popover-group" role="presentation">
            <span>{loading ? 'Searching…' : failed ? 'Search did not load. Keep typing to try again.' : 'Type a job number, a name or a customer.'}</span>
          </li>
        )}
      </PopoverList>
      <PopoverFoot>
        <Keys chord="↑ ↓">move</Keys>
        <Keys chord="enter">open</Keys>
        <Keys chord="escape">close</Keys>
      </PopoverFoot>
    </Popover>
  );
}

function GroupBlock({ label, meta, children }: { label: string; meta?: string; children: React.ReactNode }) {
  return (
    <>
      <PopoverGroup label={label} meta={meta} />
      {children}
    </>
  );
}
