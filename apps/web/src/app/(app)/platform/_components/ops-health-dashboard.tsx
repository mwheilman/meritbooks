'use client';

/**
 * Ops Health — internal observability dashboard (platform plane).
 *
 * Reads /api/platform/errors (admin client, platform-staff gated) and shows the
 * operator every recent failure across every tenant: grouped by fingerprint with
 * an occurrence count, level/source/route filters, first/last-seen, affected-org
 * count, a 24h/7d open-error-rate summary, and a resolve toggle per group. This is
 * the "failures are visible before a paid APM" surface.
 *
 * Cross-tenant, so every fetch is scope:false (must NOT inherit the header's
 * active-company filter). All states rendered; numbers are tabular-nums.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useQuery, useMutation, useDebounce } from '@/hooks';
import {
  Loader2, AlertCircle, ActivitySquare, ShieldAlert, ShieldCheck, Bug, CheckCircle2,
  Undo2, Search, Clock, Building2, Filter,
} from 'lucide-react';

// ── Types (mirror /api/platform/errors) ───────────────────────────────────────
interface ErrorGroup {
  digest: string;
  count: number;
  level: 'ERROR' | 'WARN' | 'FATAL' | string;
  source: string;
  route: string | null;
  message: string;
  firstSeen: string;
  lastSeen: string;
  resolved: boolean;
  affectedOrgs: number;
  sampleId: string;
}
interface ErrorsResponse {
  window: { key: string; days: number; since: string };
  filters: { level: string | null; source: string | null; route: string | null; status: string };
  summary: {
    totalEvents: number;
    distinctIssues: number;
    capped: boolean;
    byLevel: Record<string, number>;
    openLast24h: number;
    openLast7d: number;
  };
  groups: ErrorGroup[];
  generatedAt: string;
}

const WINDOWS: { key: string; label: string }[] = [
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];
const LEVELS = ['FATAL', 'ERROR', 'WARN'] as const;
const SOURCES = ['api', 'ui', 'job', 'webhook'] as const;
const STATUSES: { key: string; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

const relTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

const LEVEL_STYLE: Record<string, string> = {
  FATAL: 'text-red-300 bg-red-500/15 border-red-500/30',
  ERROR: 'text-red-400 bg-red-500/10 border-red-500/20',
  WARN: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
};
const SOURCE_STYLE: Record<string, string> = {
  api: 'text-indigo-300 bg-indigo-500/10',
  ui: 'text-sky-300 bg-sky-500/10',
  job: 'text-violet-300 bg-violet-500/10',
  webhook: 'text-emerald-300 bg-emerald-500/10',
};

export function OpsHealthDashboard() {
  const [windowKey, setWindowKey] = useState('7d');
  const [level, setLevel] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [status, setStatus] = useState('open');
  const [routeInput, setRouteInput] = useState('');
  const routeQuery = useDebounce(routeInput, 300);
  const [cacheKey, setCacheKey] = useState(0);
  const [busyDigest, setBusyDigest] = useState<string | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { window: windowKey, status };
    if (level) p.level = level;
    if (source) p.source = source;
    if (routeQuery.trim()) p.route = routeQuery.trim();
    return p;
  }, [windowKey, status, level, source, routeQuery]);

  const { data, isLoading, error, refetch } = useQuery<ErrorsResponse>(
    '/api/platform/errors',
    params,
    { scope: false, key: String(cacheKey) },
  );

  const { mutate: patch } = useMutation<{ digest: string; resolved: boolean }, { ok: boolean }>(
    '/api/platform/errors',
    'patch',
  );

  const toggleResolve = async (g: ErrorGroup) => {
    setBusyDigest(g.digest);
    await patch({ digest: g.digest, resolved: !g.resolved });
    setBusyDigest(null);
    setCacheKey((k) => k + 1);
    await refetch();
  };

  const Controls = (
    <div className="flex flex-wrap items-center gap-2">
      <SegGroup value={windowKey} options={WINDOWS} onChange={setWindowKey} />
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={routeInput}
          onChange={(e) => setRouteInput(e.target.value)}
          placeholder="Filter by route…"
          aria-label="Filter by route"
          className="w-44 pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
        />
      </div>
      <FilterSelect label="Level" value={level} options={[...LEVELS]} onChange={setLevel} />
      <FilterSelect label="Source" value={source} options={[...SOURCES]} onChange={setSource} />
      <SegGroup value={status} options={STATUSES} onChange={setStatus} />
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <ActivitySquare size={16} className="text-indigo-400" /> Ops health
          </h2>
          <p className="text-sm text-slate-500">
            Every captured failure across all tenants — grouped by fingerprint. Table-first
            observability; forwards to Sentry only when a DSN is configured.
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          icon={Clock}
          label="Open · last 24h"
          value={data ? data.summary.openLast24h.toLocaleString() : '—'}
          accent={data && data.summary.openLast24h > 0 ? 'red' : 'emerald'}
          loading={isLoading}
        />
        <SummaryCard
          icon={Clock}
          label="Open · last 7d"
          value={data ? data.summary.openLast7d.toLocaleString() : '—'}
          accent={data && data.summary.openLast7d > 0 ? 'amber' : 'emerald'}
          loading={isLoading}
        />
        <SummaryCard
          icon={ShieldAlert}
          label="Fatal · in window"
          value={data ? (data.summary.byLevel.FATAL ?? 0).toLocaleString() : '—'}
          accent={data && (data.summary.byLevel.FATAL ?? 0) > 0 ? 'red' : 'slate'}
          loading={isLoading}
        />
        <SummaryCard
          icon={Bug}
          label="Distinct issues"
          value={data ? data.summary.distinctIssues.toLocaleString() : '—'}
          sub={data ? `${data.summary.totalEvents.toLocaleString()} events${data.summary.capped ? '+' : ''}` : undefined}
          accent="indigo"
          loading={isLoading}
        />
      </div>

      {Controls}

      {/* Body */}
      {isLoading ? (
        <div className="card p-12 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
          <p className="text-xs text-slate-500 mt-1">
            The error log could not be loaded. This view is restricted to platform staff.
          </p>
        </div>
      ) : !data || data.groups.length === 0 ? (
        <div className="card p-12 text-center">
          <ShieldCheck size={26} className="text-emerald-400/80 mx-auto mb-2" />
          <p className="text-sm text-slate-300">No {status === 'resolved' ? 'resolved ' : status === 'open' ? 'open ' : ''}errors in this window.</p>
          <p className="text-xs text-slate-600 mt-1">
            When a failure is captured (API, UI, job, or webhook) it appears here, grouped and counted.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
            <Filter size={13} className="text-slate-500" />
            <p className="text-xs font-semibold text-slate-300">
              {data.groups.length} issue{data.groups.length === 1 ? '' : 's'}
              {data.summary.capped && (
                <span className="text-amber-400/70 font-normal"> · window capped, narrow filters for older data</span>
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 text-left font-semibold">Issue</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Source</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Count</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Orgs</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Last seen</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.digest} className={clsx('border-b border-slate-800/40 hover:bg-slate-800/20 align-top', g.resolved && 'opacity-55')}>
                    <td className="px-4 py-3 max-w-lg">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={clsx('text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 border', LEVEL_STYLE[g.level] ?? 'text-slate-300 bg-slate-700/40 border-slate-600/30')}>
                          {g.level}
                        </span>
                        {g.route && <span className="font-mono text-2xs text-slate-400 truncate">{g.route}</span>}
                        <span className="font-mono text-[10px] text-slate-600">#{g.digest}</span>
                      </div>
                      <p className="mt-1 text-slate-200 text-[13px] leading-snug line-clamp-2 break-words">{g.message}</p>
                      <p className="mt-0.5 text-2xs text-slate-600">
                        first seen {relTime(g.firstSeen)}
                        {g.resolved && <span className="text-emerald-400/70"> · resolved</span>}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={clsx('text-[10px] font-medium uppercase tracking-wider rounded px-1.5 py-0.5', SOURCE_STYLE[g.source] ?? 'text-slate-300 bg-slate-700/40')}>
                        {g.source}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200 font-semibold">
                      {g.count.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">
                      <span className="inline-flex items-center gap-1 justify-end">
                        <Building2 size={11} className="text-slate-600" />
                        {g.affectedOrgs.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {relTime(g.lastSeen)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => toggleResolve(g)}
                        disabled={busyDigest === g.digest}
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-2xs font-medium border transition-colors disabled:opacity-50',
                          g.resolved
                            ? 'border-slate-700 text-slate-300 hover:border-slate-500'
                            : 'border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10',
                        )}
                        aria-label={g.resolved ? 'Re-open issue' : 'Mark issue resolved'}
                      >
                        {busyDigest === g.digest ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : g.resolved ? (
                          <Undo2 size={12} />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                        {g.resolved ? 'Re-open' : 'Resolve'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────
type Accent = 'indigo' | 'emerald' | 'red' | 'amber' | 'slate';
const ACCENT: Record<Accent, { bg: string; fg: string }> = {
  indigo: { bg: 'bg-indigo-500/15', fg: 'text-indigo-300' },
  emerald: { bg: 'bg-emerald-500/10', fg: 'text-emerald-400' },
  red: { bg: 'bg-red-500/10', fg: 'text-red-400' },
  amber: { bg: 'bg-amber-500/10', fg: 'text-amber-400' },
  slate: { bg: 'bg-slate-700/40', fg: 'text-slate-300' },
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'slate',
  loading = false,
}: {
  icon: typeof Bug;
  label: string;
  value: string;
  sub?: string;
  accent?: Accent;
  loading?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center', a.bg)}>
          <Icon size={16} className={a.fg} />
        </div>
      </div>
      {loading ? (
        <div className="mt-3 h-7 w-16 bg-slate-800 rounded animate-pulse" />
      ) : (
        <p className={clsx('mt-2 text-2xl font-semibold tracking-tight font-mono tabular-nums', a.fg)}>{value}</p>
      )}
      {sub && !loading && <p className="mt-1 text-2xs text-slate-500">{sub}</p>}
    </div>
  );
}

function SegGroup({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { key: string; label: string }[];
  onChange: (k: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900 p-0.5" role="group">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={clsx(
            'px-2.5 py-1 text-2xs font-medium rounded-md transition-colors',
            value === o.key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={`Filter by ${label.toLowerCase()}`}
      className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-2xs text-white focus:border-indigo-500 focus:outline-none"
    >
      <option value="">All {label.toLowerCase()}s</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
