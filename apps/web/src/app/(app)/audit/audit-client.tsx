'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Loader2,
  AlertCircle,
  Bot,
  Cpu,
  User,
  History,
  Download,
  Filter,
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { useDebounce } from '@/hooks/use-debounce';
import { addToast } from '@/hooks/use-toast';
import { PageHeader, EmptyState } from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';

interface AuditEntry {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  module: string;
  summary: string | null;
  subjectTable: string | null;
  subjectId: string | null;
  tier: string | null;
  confidence: number | null;
  createdAt: string;
}

interface AuditResponse {
  data: AuditEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface SummaryResponse {
  total: number;
  capped: boolean;
  byActorType: { actorType: ActorType; count: number }[];
  byTier: { tier: string; count: number }[];
  byActor: { actorId: string | null; actorType: ActorType; actorName: string; count: number }[];
  byModule: { key: string; label: string; count: number }[];
  actions: { action: string; count: number }[];
  aiDecisions: { total: number; proposed: number; approved: number; rejected: number; expired: number };
}

interface TimelineEvent {
  id: string;
  source: 'action_log' | 'ai_decision';
  actorType: ActorType;
  actorName: string;
  action: string;
  module: string;
  summary: string | null;
  tier: string | null;
  confidence: number | null;
  status: string | null;
  createdAt: string;
}

type ActorFilter = 'all' | ActorType;

interface Filters {
  actorType: ActorFilter;
  actorId: string;
  action: string;
  module: string;
  from: string;
  to: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { actorType: 'all', actorId: '', action: '', module: '', from: '', to: '', q: '' };
const PAGE_SIZE = 50;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

const INPUT_CLASS =
  'rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500/50 focus:outline-none';

// ── Actor badge ─────────────────────────────────────────────────────────────────

function ActorBadge({ type }: { type: ActorType }) {
  const config: Record<ActorType, { label: string; className: string; icon: typeof User }> = {
    HUMAN: { label: 'Human', className: 'bg-slate-500/10 text-slate-300 border-slate-500/20', icon: User },
    AI: { label: 'AI', className: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20', icon: Bot },
    SYSTEM: { label: 'System', className: 'bg-blue-500/10 text-blue-300 border-blue-500/20', icon: Cpu },
  };
  const { label, className, icon: Icon } = config[type];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        className,
      )}
    >
      <Icon size={11} />
      {label}
    </span>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const cfg: Record<string, string> = {
    auto: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    review: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    escalate: 'bg-red-500/10 text-red-300 border-red-500/20',
  };
  return (
    <span
      className={clsx(
        'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize',
        cfg[tier] ?? 'bg-slate-500/10 text-slate-300 border-slate-500/20',
      )}
    >
      {tier}
    </span>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function StatTile({ label, value, tint }: { label: string; value: string | number; tint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-xl font-semibold tabular-nums', tint ?? 'text-white')}>{value}</p>
    </div>
  );
}

function DistributionPanel({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; count: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No activity in range.</p>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 8).map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-xs text-slate-300" title={r.label}>
                {r.label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-emerald-500/70"
                  style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-slate-400">
                {r.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Timeline drawer ─────────────────────────────────────────────────────────────

function TimelineDrawer({
  subjectTable,
  subjectId,
  onClose,
}: {
  subjectTable: string | null;
  subjectId: string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    setError(null);
    const params = new URLSearchParams({ subjectId });
    if (subjectTable) params.set('subjectTable', subjectTable);
    fetch(`/api/audit/timeline?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Failed to load timeline');
        return r.json();
      })
      .then((j) => {
        if (alive) setEvents(j.data as TimelineEvent[]);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load timeline');
      });
    return () => {
      alive = false;
    };
  }, [subjectTable, subjectId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-950 shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Clock size={15} className="text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">Record timeline</h2>
            </div>
            <p className="mt-1 truncate font-mono text-2xs text-slate-500" title={`${subjectTable ?? ''} ${subjectId}`}>
              {subjectTable ? `${subjectTable} · ` : ''}
              {subjectId}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="py-10 text-center">
              <AlertCircle className="mx-auto mb-2 h-6 w-6 text-red-400" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          ) : events === null ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
            </div>
          ) : events.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">No recorded actions for this record.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-slate-800 pl-4">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span
                    className={clsx(
                      'absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-slate-950',
                      e.actorType === 'AI'
                        ? 'bg-indigo-400'
                        : e.actorType === 'SYSTEM'
                          ? 'bg-blue-400'
                          : 'bg-emerald-400',
                    )}
                  />
                  <div className="flex items-center gap-2">
                    <ActorBadge type={e.actorType} />
                    <span className="text-xs text-slate-300">{e.actorName}</span>
                    {e.status && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{e.status}</span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-2xs text-slate-400">{e.action}</p>
                  {e.summary && <p className="mt-0.5 text-xs text-slate-300">{e.summary}</p>}
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-2xs text-slate-500" title={absoluteTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </span>
                    {e.confidence != null && (
                      <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                        {Math.round(e.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

const ACTOR_TABS: { key: ActorFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'HUMAN', label: 'Human' },
  { key: 'AI', label: 'AI' },
  { key: 'SYSTEM', label: 'System' },
];

export function AuditClient() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [timeline, setTimeline] = useState<{ subjectTable: string | null; subjectId: string } | null>(null);

  const debouncedQ = useDebounce(filters.q, 350);

  const setFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }, []);

  // Facet-scoping filters (date/module/search) drive the summary; the actor/action
  // facets stay full within that window so the dropdowns remain useful.
  const summaryParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (filters.module) p.module = filters.module;
    if (filters.from) p.from = filters.from;
    if (filters.to) p.to = filters.to;
    if (debouncedQ) p.q = debouncedQ;
    return p;
  }, [filters.module, filters.from, filters.to, debouncedQ]);

  const listParams = useMemo(() => {
    const p: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) };
    if (filters.actorType !== 'all') p.actorType = filters.actorType;
    if (filters.actorId) p.actorId = filters.actorId;
    if (filters.action) p.action = filters.action;
    if (filters.module) p.module = filters.module;
    if (filters.from) p.from = filters.from;
    if (filters.to) p.to = filters.to;
    if (debouncedQ) p.q = debouncedQ;
    return p;
  }, [filters.actorType, filters.actorId, filters.action, filters.module, filters.from, filters.to, debouncedQ, page]);

  const exportQueryString = useMemo(() => {
    const { page: _p, pageSize: _ps, ...rest } = listParams;
    void _p;
    void _ps;
    return new URLSearchParams(rest).toString();
  }, [listParams]);

  const { data: summary } = useQuery<SummaryResponse>('/api/audit/summary', summaryParams, { scope: false });
  const { data, isLoading, error } = useQuery<AuditResponse>('/api/audit', listParams, { scope: false });

  const entries = useMemo(() => data?.data ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const actorTypeCount = useCallback(
    (t: ActorType): number => summary?.byActorType.find((x) => x.actorType === t)?.count ?? 0,
    [summary],
  );

  const hasFilters =
    filters.actorType !== 'all' ||
    !!filters.actorId ||
    !!filters.action ||
    !!filters.module ||
    !!filters.from ||
    !!filters.to ||
    !!filters.q;

  const humanActors = useMemo(
    () => (summary?.byActor ?? []).filter((a) => a.actorType === 'HUMAN' && a.actorId),
    [summary],
  );

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const resp = await fetch(`/api/audit/export?${exportQueryString}`);
      if (!resp.ok) {
        let msg = `Export failed (${resp.status})`;
        try {
          msg = (await resp.json()).error ?? msg;
        } catch {
          /* binary */
        }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-log_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('success', 'Audit log exported to CSV.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }, [exportQueryString]);

  const exportBtn = (
    <button
      onClick={handleExport}
      disabled={exporting}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
    >
      {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      Export CSV
    </button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        description="Every action across the book of record, with machine-vs-human attribution."
        actions={exportBtn}
      />

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Events" value={(summary?.total ?? 0).toLocaleString()} />
        <StatTile label="Human" value={actorTypeCount('HUMAN').toLocaleString()} tint="text-slate-200" />
        <StatTile label="AI" value={actorTypeCount('AI').toLocaleString()} tint="text-indigo-300" />
        <StatTile label="System" value={actorTypeCount('SYSTEM').toLocaleString()} tint="text-blue-300" />
        <StatTile
          label="AI approved"
          value={(summary?.aiDecisions.approved ?? 0).toLocaleString()}
          tint="text-emerald-300"
        />
        <StatTile
          label="AI pending"
          value={(summary?.aiDecisions.proposed ?? 0).toLocaleString()}
          tint="text-amber-300"
        />
      </div>

      {/* Distributions */}
      <div className="grid gap-3 lg:grid-cols-2">
        <DistributionPanel
          title="By module"
          rows={(summary?.byModule ?? []).map((m) => ({ label: m.label, count: m.count }))}
        />
        <DistributionPanel
          title="By actor"
          rows={(summary?.byActor ?? []).map((a) => ({ label: a.actorName, count: a.count }))}
        />
      </div>
      {summary?.capped && (
        <p className="-mt-3 text-2xs text-amber-400/80">
          Summary reflects the most recent {(20000).toLocaleString()} matching events.
        </p>
      )}

      {/* Filter bar */}
      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-800/30 p-0.5 w-fit">
          {ACTOR_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter('actorType', tab.key)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                filters.actorType === tab.key
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-slate-500">
            <Filter size={13} />
          </div>

          <select
            value={filters.module}
            onChange={(e) => setFilter('module', e.target.value)}
            className={INPUT_CLASS}
            aria-label="Module"
          >
            <option value="">All modules</option>
            {(summary?.byModule ?? []).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} ({m.count})
              </option>
            ))}
          </select>

          <select
            value={filters.action}
            onChange={(e) => setFilter('action', e.target.value)}
            className={INPUT_CLASS}
            aria-label="Action type"
          >
            <option value="">All actions</option>
            {(summary?.actions ?? []).map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.count})
              </option>
            ))}
          </select>

          <select
            value={filters.actorId}
            onChange={(e) => setFilter('actorId', e.target.value)}
            className={INPUT_CLASS}
            aria-label="Actor"
            disabled={humanActors.length === 0}
          >
            <option value="">All people</option>
            {humanActors.map((a) => (
              <option key={a.actorId ?? ''} value={a.actorId ?? ''}>
                {a.actorName} ({a.count})
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1 text-2xs text-slate-500">
            From
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex items-center gap-1 text-2xs text-slate-500">
            To
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
              className={INPUT_CLASS}
            />
          </label>

          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder="Search summary, action, record id…"
            className={clsx(INPUT_CLASS, 'min-w-[220px] flex-1')}
          />

          {hasFilters && (
            <button
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
            >
              <X size={12} /> Reset
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={History}
            title={hasFilters ? 'No matching events' : 'No actions recorded yet'}
            description={
              hasFilters
                ? 'Try widening the date range or clearing filters.'
                : 'Actions will appear here as postings, approvals, and AI decisions are recorded.'
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Actor</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Module</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Action</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Summary</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Record</th>
                  <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ActorBadge type={e.actorType} />
                        <span className="text-xs text-slate-300">{e.actorName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-slate-400">{e.module}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-slate-400">{e.action}</span>
                        {e.tier && <TierBadge tier={e.tier} />}
                      </div>
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <span className="text-xs text-slate-300">{e.summary ?? '—'}</span>
                      {e.confidence != null && (
                        <span className="ml-2 rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                          {Math.round(e.confidence * 100)}%
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {e.subjectId ? (
                        <button
                          onClick={() => setTimeline({ subjectTable: e.subjectTable, subjectId: e.subjectId! })}
                          className="inline-flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:border-emerald-500/40 hover:text-emerald-300"
                          title="View this record's full timeline"
                        >
                          <Clock size={10} />
                          {(e.subjectTable ? `${e.subjectTable}:` : '') + e.subjectId.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="text-2xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="whitespace-nowrap text-xs text-slate-500" title={absoluteTime(e.createdAt)}>
                        {relativeTime(e.createdAt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
            <span className="text-2xs text-slate-500">
              {total === 0
                ? '0 events'
                : `${((page - 1) * PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                    page * PAGE_SIZE,
                    total,
                  ).toLocaleString()} of ${total.toLocaleString()}`}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                <ChevronLeft size={13} /> Prev
              </button>
              <span className="px-2 text-2xs text-slate-500">
                Page {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                Next <ChevronRight size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {timeline && (
        <TimelineDrawer
          subjectTable={timeline.subjectTable}
          subjectId={timeline.subjectId}
          onClose={() => setTimeline(null)}
        />
      )}
    </div>
  );
}
