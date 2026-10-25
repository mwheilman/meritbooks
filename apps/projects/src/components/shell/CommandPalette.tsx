'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  Icon, Keys, Popover, PopoverFoot, PopoverGroup, PopoverHead, PopoverItem, PopoverList, Tag,
  api, useDebounce, type FilteredNavGroup, type IconName,
} from '@meritbooks/merit-ui';
import { matches, type PaletteAction } from './actions';

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

/** Whether Ask can answer here. When it can't, the palette says so plainly (never a fake answer). */
export interface AskStatus {
  available: boolean;
  /** One sentence shown on the Ask row when it is paused. */
  reason: string;
}

type Group = 'Recent' | 'Go to' | 'Actions' | 'Jobs' | 'Customers' | 'Ask';

interface Row {
  id: string;
  group: Group;
  label: string;
  sub?: string;
  icon: IconName;
  href?: string;
  keys?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement>;
  nav: ReadonlyArray<FilteredNavGroup>;
  /** Registered actions the caller may take here (components/shell/actions.ts). */
  actions?: ReadonlyArray<PaletteAction>;
  ask?: AskStatus;
  jobsLabel: string;
  onNavigate: (href: string) => void;
}

const RECENT_KEY = 'mp.cmdk.recent';
const RECENT_MAX = 6;

interface Recent { id: string; label: string; sub?: string; href: string; icon: IconName }

function readRecent(): Recent[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v.filter((r) => r && typeof r.href === 'string' && typeof r.label === 'string') as Recent[]).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(r: Recent): void {
  try {
    const next = [r, ...readRecent().filter((x) => x.href !== r.href)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private window or blocked storage: recents are a convenience */
  }
}

/**
 * ⌘K (UX seat §3f): navigation matches → actions → records → "Ask AI". With no query it shows
 * recent picks, then the rail and the actions for this screen. Ask degrades honestly: it says
 * why it is paused and never invents an answer.
 */
export function CommandPalette({ open, onClose, anchorRef, nav, actions = [], ask, jobsLabel, onNavigate }: CommandPaletteProps) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [result, setResult] = useState<SearchResult>({ jobs: [], customers: [] });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [askNote, setAskNote] = useState<string | null>(null);
  const debounced = useDebounce(q.trim(), 150);
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      setAskNote(null);
      setRecent(readRecent());
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
    const out: Row[] = [];
    if (!term) {
      for (const r of recent) out.push({ id: `r:${r.href}`, group: 'Recent', label: r.label, sub: r.sub, icon: r.icon, href: r.href });
    }
    const seen = new Set(out.map((r) => r.href));
    for (const p of pages.filter((p) => !term || matches(`${p.label} ${p.href}`, term)).slice(0, term ? 6 : 8)) {
      if (seen.has(p.href)) continue;
      out.push({ id: `p:${p.href}`, group: 'Go to', label: p.label, icon: 'right', href: p.href, keys: p.keys });
    }
    const acts = actions.filter((a) => !term || matches(`${a.label} ${a.keywords}`, term));
    // On a job page its own actions lead.
    acts.sort((a, b) => Number(!!b.jobScoped) - Number(!!a.jobScoped));
    for (const a of acts.slice(0, term ? 6 : 5)) out.push({ id: `a:${a.id}`, group: 'Actions', label: a.label, icon: 'plus', href: a.href, keys: a.keys });
    for (const j of result.jobs) {
      out.push({
        id: `j:${j.id}`, group: 'Jobs', label: [j.number, j.name].filter(Boolean).join(' · '),
        sub: [j.customer, j.stage, j.company].filter(Boolean).join(' · '), icon: 'hammer', href: `/jobs/${j.id}`,
      });
    }
    for (const c of result.customers) {
      out.push({ id: `c:${c.id}`, group: 'Customers', label: c.name, sub: 'Customer record', icon: 'users', href: `/customers/${c.id}` });
    }
    if (term.length >= 3) {
      out.push({
        id: 'ask', group: 'Ask', label: `Ask AI: “${term.length > 60 ? `${term.slice(0, 57)}…` : term}”`,
        sub: ask?.available ? 'Answers with the numbers it used and where they came from.' : ask?.reason ?? 'AI assist is paused.',
        icon: 'ask',
      });
    }
    return out;
  }, [q, pages, actions, result, recent, ask]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))), [rows.length]);
  const active = rows[cursor];
  useEffect(() => {
    if (active) refs.current.get(active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.group === 'Ask') {
      setAskNote(ask?.available ? null : ask?.reason ?? 'AI assist is paused.');
      return;
    }
    if (!r.href) return;
    writeRecent({ id: r.id, label: r.label, sub: r.sub, href: r.href, icon: r.icon });
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

  const groups: Group[] = ['Recent', 'Go to', 'Actions', 'Jobs', 'Customers', 'Ask'];
  const listId = `${uid}-list`;
  const optId = (r: Row) => `${uid}-${r.id.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={600} placement="bottom-end" aria-label="Command palette">
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
          aria-label="Go to a page, run an action, find a record or ask"
          placeholder={`Go to, do, find a ${jobsLabel.toLowerCase().replace(/s$/, '')} or customer, or ask`}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
            setAskNote(null);
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
                  onMouseMove={() => {
                    const i = rows.findIndex((x) => x.id === r.id);
                    if (i >= 0 && i !== cursor) setCursor(i);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                  right={r.group === 'Ask' ? (ask?.available ? <Tag tone="ai">AI</Tag> : <Tag tone="warn">Paused</Tag>) : r.keys ? <Keys chord={r.keys} /> : undefined}
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
        {askNote && (
          <li className="popover-group" role="status">
            <span>{askNote}</span>
          </li>
        )}
        {rows.length === 0 && (
          <li className="popover-group" role="presentation">
            <span>{loading ? 'Searching…' : failed ? 'Search did not load. Keep typing to try again.' : 'Type a page, an action, a job number, a name or a customer.'}</span>
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
