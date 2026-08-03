'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertCircle,
  Building2,
  ChevronLeft,
  ChevronRight,
  Wallet,
  Inbox,
  ClipboardCheck,
  ArrowDownRight,
  ArrowUpRight,
  Search,
  LayoutGrid,
  Users,
  CheckCircle2,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { addToast } from '@/hooks/use-toast';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/ui';

// ── Types (mirror /api/portfolio + /api/portfolio/assignments) ─────────────────

type Rag = 'green' | 'amber' | 'red';
type CashStatus = 'HEALTHY' | 'ADEQUATE' | 'NEAR_MINIMUM' | 'CRITICAL';
type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';
type PortfolioFunction = 'close' | 'ar' | 'ap' | 'review';

interface Assignee {
  employeeId: string;
  name: string;
}

interface PortfolioEntity {
  locationId: string;
  name: string;
  shortCode: string;
  periodStatus: PeriodStatus;
  periodId: string | null;
  readyToClose: boolean;
  closeBlockers: number;
  closedAt: string | null;
  cashCents: number;
  minimumCashCents: number;
  cashStatus: CashStatus;
  openExceptions: number;
  overdueArCents: number;
  overdueApCents: number;
  rag: Rag;
  concerns: string[];
  assignments: Partial<Record<PortfolioFunction, Assignee>>;
}

interface PortfolioBoard {
  period: { year: number; month: number; label: string };
  generatedAt: string;
  totals: {
    entities: number;
    cashCents: number;
    overdueArCents: number;
    overdueApCents: number;
    openExceptions: number;
    red: number;
    amber: number;
    green: number;
    readyToClose: number;
    blocked: number;
    closed: number;
  };
  entities: PortfolioEntity[];
  assignmentsAvailable: boolean;
}

interface AssignmentsResponse {
  available: boolean;
  roster: { employeeId: string; name: string }[];
  assignments: { locationId: string; function: PortfolioFunction; employeeId: string }[];
}

// ── Small display helpers ─────────────────────────────────────────────────────

const FUNCTIONS: { key: PortfolioFunction; label: string }[] = [
  { key: 'close', label: 'Close' },
  { key: 'ar', label: 'AR' },
  { key: 'ap', label: 'AP' },
  { key: 'review', label: 'Review' },
];

const RAG_DOT: Record<Rag, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-400',
};

const RAG_LABEL: Record<Rag, string> = { green: 'On track', amber: 'Watch', red: 'Action' };

function RagDot({ rag }: { rag: Rag }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx('h-2.5 w-2.5 rounded-full', RAG_DOT[rag])} />
      <span
        className={clsx(
          'text-xs font-medium',
          rag === 'green' && 'text-emerald-400',
          rag === 'amber' && 'text-amber-400',
          rag === 'red' && 'text-red-400',
        )}
      >
        {RAG_LABEL[rag]}
      </span>
    </span>
  );
}

function ClosePill({ e }: { e: PortfolioEntity }) {
  if (e.periodStatus === 'HARD_CLOSE') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-slate-500/20 bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
        <CheckCircle2 size={11} /> Closed
      </span>
    );
  }
  if (e.periodStatus === 'NO_PERIOD') {
    return (
      <span className="inline-flex items-center rounded border border-slate-600/30 bg-slate-700/20 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
        No period
      </span>
    );
  }
  if (e.readyToClose) {
    return (
      <span className="inline-flex items-center rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        Ready to close
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
      {e.closeBlockers} blocker{e.closeBlockers === 1 ? '' : 's'}
    </span>
  );
}

const CASH_TONE: Record<CashStatus, string> = {
  HEALTHY: 'text-emerald-400',
  ADEQUATE: 'text-slate-200',
  NEAR_MINIMUM: 'text-amber-400',
  CRITICAL: 'text-red-400',
};

// ── Summary metric card ───────────────────────────────────────────────────────

function Metric({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone?: string;
  icon: typeof Wallet;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">{label}</p>
        <Icon size={15} className="text-slate-500" />
      </div>
      <p className={clsx('mt-2 text-xl font-semibold tracking-tight font-mono tabular-nums', tone ?? 'text-white')}>
        {value}
      </p>
    </div>
  );
}

// ── Ownership grid (degrade-safe editor) ──────────────────────────────────────

function OwnershipGrid({
  entities,
  onChanged,
}: {
  entities: PortfolioEntity[];
  onChanged: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery<AssignmentsResponse>('/api/portfolio/assignments');
  const [saving, setSaving] = useState<string | null>(null);

  const roster = data?.roster ?? [];
  const available = data?.available ?? false;

  // Map for current owner lookup: `${locationId}:${fn}` → employeeId
  const ownerOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data?.assignments ?? []) m.set(`${a.locationId}:${a.function}`, a.employeeId);
    return m;
  }, [data]);

  async function setOwner(locationId: string, fn: PortfolioFunction, employeeId: string | null) {
    const cell = `${locationId}:${fn}`;
    setSaving(cell);
    const res = await api.put<{ applied: boolean; reason?: string }>('/api/portfolio/assignments', {
      locationId,
      function: fn,
      assigneeEmployeeId: employeeId,
    });
    setSaving(null);
    if (res.error) {
      addToast('error', res.error.error || 'Could not save assignment');
      return;
    }
    if (res.data && res.data.applied === false) {
      addToast('error', res.data.reason || 'Assignments unavailable');
      return;
    }
    addToast('success', 'Owner updated');
    await refetch();
    onChanged();
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-500">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card p-6 flex items-center gap-3 text-red-400">
        <AlertCircle size={18} /> <span className="text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!available && (
        <div className="card border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
          Ownership is read-only until the <code className="font-mono">core.practice_assignments</code> table is
          applied. The board still works; assignments show as unassigned.
        </div>
      )}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-2xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Company</th>
              {FUNCTIONS.map((f) => (
                <th key={f.key} className="px-4 py-3 font-medium">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.locationId} className="border-b border-slate-800/60 last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-white">{e.name}</div>
                  <div className="font-mono text-2xs text-slate-500">{e.shortCode}</div>
                </td>
                {FUNCTIONS.map((f) => {
                  const cell = `${e.locationId}:${f.key}`;
                  const current = ownerOf.get(cell) ?? '';
                  return (
                    <td key={f.key} className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <select
                          value={current}
                          disabled={!available || saving === cell}
                          onChange={(ev) => setOwner(e.locationId, f.key, ev.target.value || null)}
                          className="w-full max-w-[11rem] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-brand-500 focus:outline-none disabled:opacity-50"
                        >
                          <option value="">Unassigned</option>
                          {roster.map((m) => (
                            <option key={m.employeeId} value={m.employeeId}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                        {saving === cell && <Loader2 size={13} className="animate-spin text-slate-500" />}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = 'board' | 'ownership';
type SortKey = 'rag' | 'name' | 'cash' | 'exceptions' | 'overdueAr';

export default function PortfolioPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [tab, setTab] = useState<Tab>('board');
  const [ragFilter, setRagFilter] = useState<'all' | Rag>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('rag');
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, isLoading, error } = useQuery<PortfolioBoard>(
    '/api/portfolio',
    { year: String(year), month: String(month) },
    { key: `${year}-${month}-${refreshKey}` },
  );

  function shiftPeriod(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  }

  const filtered = useMemo(() => {
    const entities = data?.entities ?? [];
    const q = search.trim().toLowerCase();
    const out = entities.filter((e) => {
      if (ragFilter !== 'all' && e.rag !== ragFilter) return false;
      if (q && !e.name.toLowerCase().includes(q) && !e.shortCode.toLowerCase().includes(q)) return false;
      return true;
    });
    const ragRank: Record<Rag, number> = { red: 2, amber: 1, green: 0 };
    const sorted = [...out];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'cash':
          return a.cashCents - b.cashCents;
        case 'exceptions':
          return b.openExceptions - a.openExceptions;
        case 'overdueAr':
          return b.overdueArCents - a.overdueArCents;
        case 'rag':
        default:
          return ragRank[b.rag] - ragRank[a.rag] || b.openExceptions - a.openExceptions;
      }
    });
    return sorted;
  }, [data, search, ragFilter, sort]);

  const totals = data?.totals;

  return (
    <div className="pb-12">
      <PageHeader
        title="Portfolio"
        description="Every company on one screen — close, cash, exceptions and overdue balances, with a red/amber/green roll-up."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftPeriod(-1)}
              className="rounded border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800"
              aria-label="Previous period"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[8rem] text-center text-sm font-medium text-slate-200">
              {data?.period.label ?? '—'}
            </span>
            <button
              onClick={() => shiftPeriod(1)}
              className="rounded border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800"
              aria-label="Next period"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        }
      />

      {/* Summary strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Companies" value={String(totals?.entities ?? 0)} icon={Building2} />
        <Metric
          label="Total cash"
          value={totals ? formatMoney(totals.cashCents, { compact: true }) : '—'}
          icon={Wallet}
        />
        <Metric
          label="Open exceptions"
          value={String(totals?.openExceptions ?? 0)}
          tone={totals && totals.openExceptions > 0 ? 'text-amber-400' : undefined}
          icon={Inbox}
        />
        <Metric
          label="Overdue AR"
          value={totals ? formatMoney(totals.overdueArCents, { compact: true }) : '—'}
          tone={totals && totals.overdueArCents > 0 ? 'text-amber-400' : undefined}
          icon={ArrowDownRight}
        />
        <Metric
          label="Overdue AP"
          value={totals ? formatMoney(totals.overdueApCents, { compact: true }) : '—'}
          tone={totals && totals.overdueApCents > 0 ? 'text-amber-400' : undefined}
          icon={ArrowUpRight}
        />
        <Metric
          label="Ready to close"
          value={totals ? `${totals.readyToClose}/${totals.entities}` : '—'}
          tone="text-emerald-400"
          icon={ClipboardCheck}
        />
      </div>

      {/* Tabs + controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/50 p-0.5">
          <button
            onClick={() => setTab('board')}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              tab === 'board' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <LayoutGrid size={14} /> Board
          </button>
          <button
            onClick={() => setTab('ownership')}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              tab === 'ownership' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <Users size={14} /> Ownership
          </button>
        </div>

        {tab === 'board' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {(['all', 'red', 'amber', 'green'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRagFilter(r)}
                  className={clsx(
                    'rounded-md border px-2 py-1 text-2xs font-medium transition-colors',
                    ragFilter === r
                      ? 'border-brand-500/40 bg-brand-500/10 text-brand-300'
                      : 'border-slate-800 text-slate-400 hover:text-slate-200',
                  )}
                >
                  {r === 'all'
                    ? `All ${data ? `(${data.entities.length})` : ''}`
                    : `${RAG_LABEL[r]} ${totals ? `(${totals[r]})` : ''}`}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search company"
                className="w-44 rounded-md border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-2 text-xs text-slate-200 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 focus:border-brand-500 focus:outline-none"
            >
              <option value="rag">Sort: Priority</option>
              <option value="name">Sort: Name</option>
              <option value="cash">Sort: Cash (low first)</option>
              <option value="exceptions">Sort: Exceptions</option>
              <option value="overdueAr">Sort: Overdue AR</option>
            </select>
          </div>
        )}
      </div>

      {/* States */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-slate-500">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="card p-6 flex items-center gap-3 text-red-400">
          <AlertCircle size={18} /> <span className="text-sm">{error}</span>
        </div>
      ) : !data || data.entities.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
            <Building2 size={24} className="text-slate-500" />
          </div>
          <h3 className="mb-1 text-sm font-medium text-slate-300">No companies yet</h3>
          <p className="max-w-sm text-sm text-slate-500">
            Add entities under Companies and the portfolio board will light up with their live health.
          </p>
        </div>
      ) : tab === 'ownership' ? (
        <OwnershipGrid entities={data.entities} onChanged={() => setRefreshKey((k) => k + 1)} />
      ) : (
        <BoardTable entities={filtered} />
      )}
    </div>
  );
}

// ── Board table ───────────────────────────────────────────────────────────────

function BoardTable({ entities }: { entities: PortfolioEntity[] }) {
  if (entities.length === 0) {
    return (
      <div className="card py-12 text-center text-sm text-slate-500">
        No companies match the current filter.
      </div>
    );
  }
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left text-2xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3 font-medium">Company</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Close</th>
            <th className="px-4 py-3 text-right font-medium">Cash</th>
            <th className="px-4 py-3 text-right font-medium">Exceptions</th>
            <th className="px-4 py-3 text-right font-medium">Overdue AR</th>
            <th className="px-4 py-3 text-right font-medium">Overdue AP</th>
            <th className="px-4 py-3 font-medium">Owners</th>
          </tr>
        </thead>
        <tbody>
          {entities.map((e) => (
            <tr key={e.locationId} className="border-b border-slate-800/60 transition-colors last:border-0 hover:bg-slate-800/30">
              <td className="px-4 py-3">
                <div className="font-medium text-white">{e.name}</div>
                <div className="font-mono text-2xs text-slate-500">{e.shortCode}</div>
                {e.concerns.length > 0 && (
                  <div className="mt-0.5 text-2xs text-slate-500">{e.concerns.join(' · ')}</div>
                )}
              </td>
              <td className="px-4 py-3">
                <RagDot rag={e.rag} />
              </td>
              <td className="px-4 py-3">
                <Link href="/close" className="inline-block hover:opacity-80">
                  <ClosePill e={e} />
                </Link>
              </td>
              <td className={clsx('px-4 py-3 text-right font-mono tabular-nums', CASH_TONE[e.cashStatus])}>
                <Link href={`/cash?location_id=${e.locationId}`} className="hover:underline">
                  {formatMoney(e.cashCents, { compact: true })}
                </Link>
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                {e.openExceptions > 0 ? (
                  <Link href="/exceptions" className="text-amber-400 hover:underline">
                    {e.openExceptions}
                  </Link>
                ) : (
                  <span className="text-slate-600">0</span>
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                {e.overdueArCents > 0 ? (
                  <Link href="/collections" className="text-amber-400 hover:underline">
                    {formatMoney(e.overdueArCents, { compact: true })}
                  </Link>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                {e.overdueApCents > 0 ? (
                  <Link href="/bills" className="text-amber-400 hover:underline">
                    {formatMoney(e.overdueApCents, { compact: true })}
                  </Link>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                <OwnersInline assignments={e.assignments} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OwnersInline({ assignments }: { assignments: PortfolioEntity['assignments'] }) {
  const owned = FUNCTIONS.filter((f) => assignments[f.key]);
  if (owned.length === 0) {
    return <span className="text-2xs text-slate-600">Unassigned</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {owned.map((f) => (
        <span
          key={f.key}
          className="inline-flex items-center gap-1 rounded border border-slate-700/60 bg-slate-800/50 px-1.5 py-0.5 text-2xs text-slate-300"
          title={`${f.label}: ${assignments[f.key]!.name}`}
        >
          <span className="text-slate-500">{f.label}</span>
          <span className="text-slate-300">{assignments[f.key]!.name.split(' ')[0]}</span>
        </span>
      ))}
    </div>
  );
}
