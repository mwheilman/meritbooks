'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Building2, ChevronRight, Loader2, RefreshCw, Search, Upload, Wrench } from 'lucide-react';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { addToast } from '@/hooks/use-toast';
import { api } from '@/lib/api-client';
import { TOWER_STAGES, TOWER_STAGE_LABEL, type ControlTowerData, type TowerRow, type TowerStage } from '@/lib/companies/portfolio/types';
import { StageChips } from './stage-chips';

type SortKey = 'name' | 'stage' | 'owner' | 'cutover';
type SortDir = 'asc' | 'desc';

interface Props {
  data: ControlTowerData | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
  onAddCompanies: () => void;
  onUpload: () => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

function compare(a: TowerRow, b: TowerRow, key: SortKey): number {
  switch (key) {
    case 'stage': return a.stageIndex - b.stageIndex || a.name.localeCompare(b.name);
    case 'owner': return Number(!a.ownerName) - Number(!b.ownerName) || (a.ownerName ?? '').localeCompare(b.ownerName ?? '') || a.name.localeCompare(b.name);
    case 'cutover': return (a.cutoverDate ?? '').localeCompare(b.cutoverDate ?? '') || a.name.localeCompare(b.name);
    default: return a.name.localeCompare(b.name);
  }
}

export function ControlTower({ data, loading, refreshing, error, onRetry, onChanged, onAddCompanies, onUpload }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [stageFilter, setStageFilter] = useState<TowerStage | 'all' | 'action'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'stage', dir: 'asc' });
  const [repairing, setRepairing] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const rows = useMemo(() => {
    let r = data?.rows ?? [];
    if (debounced) r = r.filter((x) => x.name.toLowerCase().includes(debounced) || x.shortCode.toLowerCase().includes(debounced) || (x.ownerName ?? '').toLowerCase().includes(debounced));
    if (stageFilter === 'action') r = r.filter((x) => x.stage !== 'live' || x.periodsMissing);
    else if (stageFilter !== 'all') r = r.filter((x) => x.stage === stageFilter);
    const sorted = [...r].sort((a, b) => compare(a, b, sort.key));
    return sort.dir === 'desc' ? sorted.reverse() : sorted;
  }, [data, debounced, stageFilter, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const repairPeriods = async (row: TowerRow) => {
    setRepairing(row.locationId);
    const res = await api.post<{ created: number }>('/api/onboarding/portfolio/periods', { locationId: row.locationId });
    setRepairing(null);
    if (res.data) {
      addToast('success', `Added ${res.data.created} fiscal periods to ${row.name}`);
      onChanged();
    } else {
      addToast('error', res.error?.error ?? 'Could not add fiscal periods');
    }
  };

  if (loading && !data) return <div className="card"><TableSkeleton rows={6} cols={5} /></div>;

  if (error && !data) {
    return (
      <div className="card p-6 flex items-start gap-3" role="alert">
        <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1">
          <p className="text-sm text-red-300 font-medium">Couldn’t load the Control Tower</p>
          <p className="text-sm text-slate-400 mt-1">{error}</p>
        </div>
        <button className="btn-secondary btn-sm" onClick={onRetry}><RefreshCw size={13} aria-hidden /> Retry</button>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={Building2}
          title="No companies yet"
          description="Paste a list of your companies (or upload a CSV) and MeritBooks creates them all — each with its own books and accounting periods."
          action={{ label: 'Add companies', onClick: onAddCompanies }}
        />
      </div>
    );
  }

  const sortHeader = (k: SortKey, label: string, className?: string) => {
    const active = sort.key === k;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th key={k} className={clsx('px-4 py-3 font-medium', className)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded">
          {label}
          <Icon size={12} aria-hidden className={active ? 'text-emerald-400' : 'text-slate-600'} />
        </button>
      </th>
    );
  };

  const needsAction = data.rows.filter((r) => r.stage !== 'live' || r.periodsMissing).length;

  return (
    <div className="space-y-4">
      {/* Stage funnel */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {TOWER_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStageFilter(stageFilter === s ? 'all' : s)}
            aria-pressed={stageFilter === s}
            className={clsx(
              'card px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50',
              stageFilter === s ? 'border-emerald-500/60' : 'hover:border-slate-700',
            )}
          >
            <div className="text-2xs uppercase tracking-wide text-slate-500">{s === 'live' ? 'Live' : `At ${TOWER_STAGE_LABEL[s]}`}</div>
            <div className={clsx('mt-1 text-lg font-semibold font-mono tabular-nums', s === 'live' ? 'text-emerald-400' : 'text-white')}>
              {data.counts[s]}
            </div>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            className="input pl-8"
            placeholder="Search company, code or owner"
            aria-label="Search companies"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className={clsx('btn-sm', stageFilter === 'action' ? 'btn-primary' : 'btn-secondary')}
          aria-pressed={stageFilter === 'action'}
          onClick={() => setStageFilter(stageFilter === 'action' ? 'all' : 'action')}
        >
          Needs action <span className="font-mono tabular-nums">{needsAction}</span>
        </button>
        {stageFilter !== 'all' && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setStageFilter('all')}>Clear filter</button>
        )}
        <div className="ml-auto flex items-center gap-2 text-2xs text-slate-500">
          {refreshing && <Loader2 size={12} className="animate-spin" aria-label="Refreshing" />}
          {!data.ownershipAvailable && <span>Ownership needs migration 121</span>}
          <button type="button" className="btn-ghost btn-sm" onClick={onChanged} aria-label="Refresh"><RefreshCw size={13} aria-hidden /></button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Onboarding progress for each company</caption>
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              {sortHeader('name', 'Company')}
              {sortHeader('stage', 'Progress')}
              {sortHeader('owner', 'Who owns it')}
              {sortHeader('cutover', 'Takeover date')}
              <th className="px-4 py-3 font-medium text-right">Next step</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">No companies match this filter.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.locationId} className="table-row-hover border-b border-slate-800/60 last:border-0">
                <td className="px-4 py-3">
                  <div className="text-slate-200 font-medium">{r.name}</div>
                  <div className="font-mono text-2xs text-slate-500">{r.shortCode}</div>
                </td>
                <td className="px-4 py-3">
                  <StageChips stage={r.stage} />
                  {r.session && !r.session.balanced && r.stage !== 'live' && (
                    <div className="mt-1 text-2xs text-amber-400">Trial balance is out of balance</div>
                  )}
                  {r.periodsMissing && (
                    <div className="mt-1 text-2xs text-red-400">No accounting period for this month — nothing can post yet</div>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {r.ownerName ?? <span className="text-slate-500">Unassigned</span>}
                </td>
                <td className="px-4 py-3 font-mono tabular-nums text-slate-300">{fmtDate(r.cutoverDate)}</td>
                <td className="px-4 py-3 text-right">
                  <NextStep row={r} busy={repairing === r.locationId} onRepair={() => void repairPeriods(r)} onUpload={onUpload} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-2xs text-slate-500">
        Assign who owns each company’s onboarding from <Link href="/portfolio" className="text-emerald-400 hover:underline">Portfolio</Link>. Status there updates automatically as companies move through these steps.
      </p>
    </div>
  );
}

function NextStep({ row, busy, onRepair, onUpload }: { row: TowerRow; busy: boolean; onRepair: () => void; onUpload: () => void }) {
  const a = row.nextAction;
  if (a.kind === 'repair_periods') {
    return (
      <button type="button" className="btn-secondary btn-sm" onClick={onRepair} disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Wrench size={13} aria-hidden />}
        {a.label}
      </button>
    );
  }
  if (a.kind === 'upload') {
    return (
      <button type="button" className="btn-secondary btn-sm" onClick={onUpload}>
        <Upload size={13} aria-hidden /> {a.label}
      </button>
    );
  }
  if (!a.href) return <span className="badge-success">Live</span>;
  return (
    <Link
      href={a.href}
      className={clsx(row.stage === 'live' ? 'btn-ghost' : 'btn-primary', 'btn-sm')}
    >
      {a.label} <ChevronRight size={13} aria-hidden />
    </Link>
  );
}
