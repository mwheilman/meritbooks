'use client';
/**
 * /inbox — every notification for the signed-in person, from Merit Projects and Merit Books
 * (one suite inbox, core.notifications). Unread / All / Done, grouped by job, "needs you" in
 * Brick. Every row opens its record; read / done per row, "Mark all read", "Clear done", older
 * pages. Keyboard: j / k move, Enter opens, e marks done, u toggles read.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Tabs, Tag, WidgetState, api, toast } from '@meritbooks/merit-ui';
import type { InboxFilter, InboxItem, InboxPage, MarkState } from '@/lib/notify/types';
import { ago, groupByRecord, hrefOf, needsYou } from '@/lib/notify/format';

export interface InboxViewProps {
  initial: InboxPage | null;
  initialError?: string | null;
  initialFilter?: InboxFilter;
}

const EMPTY: Readonly<Record<InboxFilter, { title: string; body: string }>> = {
  unread: { title: 'You are caught up', body: 'New assignments, approvals, signatures and mentions show here first.' },
  all: { title: 'Nothing here yet', body: 'When work is assigned to you, something needs your approval or someone mentions you, it lands here.' },
  done: { title: 'Nothing marked done', body: 'Mark a notification done once you have handled it; it moves here.' },
};

function sourceTag(i: InboxItem) {
  return i.sourceApp === 'books' ? <Tag>Books</Tag> : null;
}

export function InboxView({ initial, initialError = null, initialFilter = 'unread' }: InboxViewProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<InboxFilter>(initialFilter);
  const [page, setPage] = useState<InboxPage | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(initial === null && !initialError);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (f: InboxFilter, before?: string | null) => {
    if (before) setMore(true);
    else setLoading(true);
    const res = await api.get<InboxPage>('/api/notifications', { view: 'inbox', filter: f, before: before ?? undefined, limit: '50' });
    setLoading(false);
    setMore(false);
    if (res.error || !res.data) {
      setError(res.error?.error ?? 'The inbox did not load.');
      return;
    }
    setError(null);
    const data = res.data;
    setPage((p) => (before && p ? { items: [...p.items, ...data.items], nextBefore: data.nextBefore, unread: data.unread } : data));
  }, []);

  useEffect(() => {
    if (initial === null && !initialError) void load(initialFilter);
  }, [initial, initialError, initialFilter, load]);

  const switchTo = (f: InboxFilter) => {
    setFilter(f);
    setCursor(0);
    void load(f);
  };

  const items = useMemo(() => page?.items ?? [], [page]);
  const groups = useMemo(() => groupByRecord(items), [items]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const mark = async (ids: string[], state: MarkState, quiet = false) => {
    setBusy(state);
    const res = await api.post<{ updated: number }>('/api/notifications/read', { ids, state });
    setBusy(null);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    const now = new Date().toISOString();
    setPage((p) => {
      if (!p) return p;
      const hit = (i: InboxItem) => state === 'read_all' || state === 'done_all' || ids.includes(i.id);
      let delta = 0;
      let next = p.items.map((i) => {
        if (!hit(i)) return i;
        const n: InboxItem =
          state === 'read' || state === 'read_all' ? { ...i, readAt: i.readAt ?? now }
          : state === 'unread' ? { ...i, readAt: null }
          : state === 'done' || state === 'done_all' ? { ...i, readAt: i.readAt ?? now, doneAt: i.doneAt ?? now }
          : { ...i, doneAt: null };
        if (!i.readAt && n.readAt) delta -= 1;
        if (i.readAt && !n.readAt) delta += 1;
        return n;
      });
      // done rows leave the open views and undone rows leave Done; Unread keeps a row read from
      // here until the next load, so it does not jump away under the pointer
      next = next.filter((i) => (filter === 'done' ? Boolean(i.doneAt) : !i.doneAt));
      return { ...p, items: next, unread: state === 'read_all' || state === 'done_all' ? 0 : Math.max(0, p.unread + delta) };
    });
    if (!quiet && (state === 'read_all' || state === 'done_all')) toast(`${res.data?.updated ?? 0} updated`);
  };

  const open = (i: InboxItem) => {
    if (!i.readAt) void mark([i.id], 'read', true);
    router.push(hrefOf(i));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = flat[cursor];
    if (e.key === 'j') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(0, flat.length - 1))); }
    else if (e.key === 'k') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); open(cur); }
    else if (e.key === 'e' && cur) { e.preventDefault(); void mark([cur.id], cur.doneAt ? 'undone' : 'done', true); }
    else if (e.key === 'u' && cur) { e.preventDefault(); void mark([cur.id], cur.readAt ? 'unread' : 'read', true); }
  };

  const unread = page?.unread ?? 0;

  return (
    <div onKeyDown={onKeyDown}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <Tabs<InboxFilter>
          aria-label="Which notifications"
          value={filter}
          onChange={switchTo}
          items={[
            { value: 'unread', label: 'Unread', count: unread || undefined },
            { value: 'all', label: 'All' },
            { value: 'done', label: 'Done' },
          ]}
        />
        <span style={{ display: 'flex', gap: 8 }}>
          {filter !== 'done' && <Button disabled={busy !== null || unread === 0} onClick={() => void mark([], 'read_all')} chord="shift+r">Mark all read</Button>}
          {filter === 'all' && <Button variant="quiet" disabled={busy !== null || items.length === 0} onClick={() => void mark([], 'done_all')}>Mark all done</Button>}
        </span>
      </div>

      <div className="mp-table" role="region" aria-label="Notifications" tabIndex={0}>
        {loading ? (
          <div style={{ padding: 16 }}><WidgetState state={{ kind: 'loading', label: 'Loading your inbox', lines: 5 }} /></div>
        ) : error ? (
          <div style={{ padding: 16 }}><WidgetState state={{ kind: 'error', title: 'The inbox did not load', body: error, onRetry: () => void load(filter) }} /></div>
        ) : items.length === 0 ? (
          <div style={{ padding: 16 }}><WidgetState state={{ kind: filter === 'unread' ? 'done' : 'empty', title: EMPTY[filter].title, body: EMPTY[filter].body }} /></div>
        ) : (
          groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: 'var(--canvas)', borderBottom: '1px solid var(--line)' }}>
                {g.jobId ? <Link className="nlink t-head" href={`/jobs/${g.jobId}`}>{g.label}</Link> : <span className="t-head">{g.label}</span>}
                <span className="t-cap">{g.unread ? `${g.unread} unread` : `${g.items.length}`}</span>
              </header>
              <ul style={{ margin: 0, padding: 0 }}>
                {g.items.map((i) => {
                  const idx = flat.indexOf(i);
                  const active = idx === cursor;
                  return (
                    <li
                      key={i.id}
                      style={{
                        listStyle: 'none', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 16px', borderBottom: '1px solid var(--line)',
                        background: active ? 'var(--sky)' : i.readAt ? 'var(--white)' : 'var(--warm)',
                        boxShadow: active ? 'inset 3px 0 0 var(--electric)' : undefined,
                      }}
                    >
                      <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 6, flex: 'none', background: i.readAt ? 'transparent' : needsYou(i) ? 'var(--neg)' : 'var(--electric)' }} />
                      <button
                        type="button"
                        onClick={() => { setCursor(idx); open(i); }}
                        style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                        aria-label={`${i.title}${i.readAt ? '' : ', unread'}`}
                      >
                        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: i.readAt ? 400 : 600, color: needsYou(i) ? 'var(--neg)' : 'var(--ink)' }}>{i.title}</span>
                          {i.itemCount > 1 && <Tag>{`${i.itemCount} updates`}</Tag>}
                          {i.delivery === 'digest' && <Tag>Digest</Tag>}
                          {sourceTag(i)}
                        </span>
                        {i.body && <span className="t-cap" style={{ display: 'block', marginTop: 2, color: 'var(--ink-2)' }}>{i.body}</span>}
                      </button>
                      <span className="t-cap" style={{ flex: 'none', minWidth: 48, textAlign: 'right' }}>{ago(i.createdAt)}</span>
                      <span style={{ display: 'flex', gap: 4, flex: 'none' }}>
                        <Button variant="quiet" aria-label={i.readAt ? 'Mark unread' : 'Mark read'} onClick={() => void mark([i.id], i.readAt ? 'unread' : 'read', true)}>
                          {i.readAt ? 'Unread' : 'Read'}
                        </Button>
                        <Button variant="quiet" icon={i.doneAt ? 'undo' : 'check'} aria-label={i.doneAt ? 'Move back to the inbox' : 'Mark done'} onClick={() => void mark([i.id], i.doneAt ? 'undone' : 'done', true)}>
                          {i.doneAt ? 'Undo' : 'Done'}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {page?.nextBefore && !loading && !error && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
          <Button disabled={more} onClick={() => void load(filter, page.nextBefore)}>{more ? 'Loading' : 'Show older'}</Button>
        </div>
      )}
      <p className="t-cap" style={{ marginTop: 12 }}>Keys: j / k move · Enter opens · u read or unread · e done.</p>
    </div>
  );
}
