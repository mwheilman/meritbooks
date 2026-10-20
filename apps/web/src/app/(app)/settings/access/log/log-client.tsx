'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Download, History, Loader2, RefreshCw, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { NoAccessState } from '@/components/access/no-access-state';
import { LOG_EVENT_GROUPS } from '@/lib/access-governance/describe';
import type { AccessLogEntry } from '@/lib/access-governance/types';

interface Directory {
  clients: Array<{ id: string; name: string }>;
  people: Array<{ membershipId: string; name: string }>;
}

interface Filters {
  member: string;
  client: string;
  group: string;
  from: string;
  to: string;
  q: string;
}

const EMPTY: Filters = { member: '', client: '', group: '', from: '', to: '', q: '' };

const SOURCE_LABEL: Record<string, string> = {
  ui: 'Screen',
  api: 'App',
  backfill: 'Start of log',
  template_update: 'MeritBooks suggestion',
  review: 'Access review',
  request: 'Access request',
  sweeper: 'End date',
  system: 'MeritBooks',
};

function tone(event: string): string {
  if (/\.(revoke|expire|end|delete|suspend|deny)$/.test(event)) return 'bg-red-500/10 text-red-400';
  if (/\.(grant|approve|reinstate|confirm|publish|adopt)$/.test(event)) return 'bg-emerald-500/10 text-emerald-400';
  if (/\.(grant_pending|create|suggest|start)$/.test(event)) return 'bg-blue-500/10 text-blue-400';
  return 'bg-slate-500/10 text-slate-400';
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function params(f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v) p[k] = v;
  return p;
}

/** Before → after, field by field, for the expanded row. */
function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
    (k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null) || !before,
  );
  if (!keys.length) return <p className="text-xs text-slate-500">No field-level detail.</p>;
  const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
      <dt className="text-slate-500">Field</dt>
      <dd className="text-slate-500">Before</dd>
      <dd className="text-slate-500">After</dd>
      {keys.map((k) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="break-all text-slate-500">{before ? show(before[k]) : '—'}</dd>
          <dd className="break-all text-slate-200">{after ? show(after[k]) : '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AccessLogClient() {
  const [dir, setDir] = useState<Directory | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<AccessLogEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const reqId = useRef(0);

  useEffect(() => {
    api.get<{ data: Directory }>('/api/access/directory').then((res) => {
      if (res.data) setDir(res.data.data);
    });
  }, []);

  // Debounced free-text search.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (f: Filters, before?: number) => {
    const id = ++reqId.current;
    if (before) setLoadingMore(true);
    else {
      setLoading(true);
      setError(null);
    }
    const res = await api.get<{ data: { entries: AccessLogEntry[]; nextCursor: number | null } }>('/api/access/log', {
      ...params(f),
      ...(before ? { before: String(before) } : {}),
    });
    if (id !== reqId.current) return;
    setLoading(false);
    setLoadingMore(false);
    if (res.error) {
      if (res.status === 403) setForbidden(true);
      else setError(res.error.error || 'Could not load the access log');
      return;
    }
    const d = res.data!.data;
    setEntries((prev) => (before ? [...prev, ...d.entries] : d.entries));
    setCursor(d.nextCursor);
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const csvHref = useMemo(() => {
    const sp = new URLSearchParams({ ...params(filters), format: 'csv' });
    return `/api/access/log?${sp.toString()}`;
  }, [filters]);

  const filtered = Object.values(filters).some(Boolean);
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (forbidden) return <NoAccessState capability="ctl.audit_trail" actions={['view']} title="You can't see the access log" />;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">Search</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
            <input className="input pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reason or event" />
          </span>
        </label>
        <label className="w-48">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">Person</span>
          <select className="input" value={filters.member} onChange={(e) => setFilters({ ...filters, member: e.target.value })}>
            <option value="">Everyone</option>
            {(dir?.people ?? []).map((p) => (
              <option key={p.membershipId} value={p.membershipId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-48">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">Client</span>
          <select className="input" value={filters.client} onChange={(e) => setFilters({ ...filters, client: e.target.value })}>
            <option value="">All clients</option>
            {(dir?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-52">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">What</span>
          <select className="input" value={filters.group} onChange={(e) => setFilters({ ...filters, group: e.target.value })}>
            <option value="">Every change</option>
            {LOG_EVENT_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="w-40">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">From</span>
          <input type="date" className="input" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label className="w-40">
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-slate-500">To</span>
          <input type="date" className="input" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <div className="ml-auto flex items-center gap-2">
          {filtered && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setSearch('');
                setFilters(EMPTY);
              }}
            >
              Clear
            </button>
          )}
          <button type="button" className="btn-ghost btn-sm" onClick={() => void load(filters)} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <a href={csvHref} className="btn-secondary btn-sm" download>
            <Download className="h-3.5 w-3.5" aria-hidden /> Export CSV
          </a>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={8} />
      ) : error ? (
        <div className="card flex items-center gap-3 p-4 text-sm text-red-400" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden />
          {error}
          <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => void load(filters)}>
            Try again
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={History}
            title={filtered ? 'Nothing matches these filters' : 'No access changes yet'}
            description={
              filtered
                ? 'Try a wider date range or clear the filters.'
                : 'When someone is given access, loses it, or a role changes, it shows up here.'
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <ol className="divide-y divide-slate-800">
            {entries.map((e) => {
              const isOpen = expanded.has(e.id);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(e.id)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus:bg-white/[0.03] focus:outline-none"
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-slate-200">{e.summary}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {e.actorName ?? (e.actorContext.startsWith('system') ? 'MeritBooks (automatic)' : 'Unknown')}
                        {' · '}
                        {SOURCE_LABEL[e.source] ?? e.source}
                        {e.reason ? ` · “${e.reason}”` : ''}
                      </span>
                    </span>
                    <span className={clsx('badge shrink-0 font-mono', tone(e.event))}>{e.event}</span>
                    <time dateTime={e.at} className="w-40 shrink-0 text-right font-mono text-xs text-slate-500">
                      {when(e.at)}
                    </time>
                  </button>
                  {isOpen && (
                    <div className="space-y-2 border-t border-slate-800/60 bg-surface-950 px-11 py-3">
                      <p className="text-xs text-slate-400">
                        {e.allClients ? 'All clients' : e.locationNames.length ? e.locationNames.join(', ') : 'No client'}
                        {e.approvalRef ? ` · Reference ${e.approvalRef}` : ''}
                      </p>
                      <Diff before={e.before} after={e.after} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {cursor && (
            <div className="border-t border-slate-800 p-3 text-center">
              <button type="button" className="btn-secondary btn-sm" disabled={loadingMore} onClick={() => void load(filters, cursor)}>
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Load older changes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
