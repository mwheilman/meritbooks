'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks/use-query';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { EmptyState } from '@/components/ui';
import { EstimateForm } from './estimate-form';
import { EstimateDrawer } from './estimate-drawer';
import { EstimateStatusBadge } from './estimate-status-badge';
import type { EstimateRow, EstimateListResponse, EstimateDetail } from './types';
import {
  FileText, Plus, Search, AlertCircle, Loader2, TrendingUp, Target, Layers, ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';

type SortKey = 'estimateNumber' | 'customer' | 'estimateDate' | 'totalCents' | 'status';

const TABS = ['ALL', 'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED'] as const;

export function EstimatesManager() {
  const { activeCompanyId, isAll } = useActiveCompany();

  const [status, setStatus] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('estimateDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [refreshKey, setRefreshKey] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [editDetail, setEditDetail] = useState<EstimateDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams();
  if (status !== 'ALL') params.set('status', status);
  if (debounced) params.set('search', debounced);

  const { data, isLoading, error } = useQuery<EstimateListResponse>(
    `/api/estimates?${params.toString()}`,
    undefined,
    { key: String(refreshKey) },
  );

  const rows = useMemo(() => data?.data ?? [], [data]);
  const counts = data?.counts ?? {};
  const pipeline = data?.pipeline;

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'estimateNumber':
          cmp = a.estimateNumber.localeCompare(b.estimateNumber);
          break;
        case 'customer':
          cmp = (a.customer?.name ?? '').localeCompare(b.customer?.name ?? '');
          break;
        case 'estimateDate':
          cmp = a.estimateDate.localeCompare(b.estimateDate);
          break;
        case 'totalCents':
          cmp = a.totalCents - b.totalCents;
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'totalCents' || key === 'estimateDate' ? 'desc' : 'asc');
    }
  };

  const onCreated = () => {
    setShowCreate(false);
    refresh();
  };
  const onEdited = () => {
    setEditDetail(null);
    refresh();
  };

  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-red-400">Failed to load estimates</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Estimates &amp; Quotes</h1>
          <p className="text-sm text-gray-400 mt-1">
            Quote work, track your pipeline, and convert a won estimate into a posting invoice.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={isAll}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Estimate
        </button>
      </div>

      {/* Pipeline / win-rate strip (Rule 2 enhancement) */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
        <PipelineCard
          label="Open pipeline"
          hint="Draft + sent, still undecided"
          value={formatMoney(pipeline?.openPipelineCents ?? 0)}
          icon={Layers}
          color="text-blue-400"
        />
        <PipelineCard
          label="Won value"
          hint="Accepted + converted"
          value={formatMoney(pipeline?.acceptedCents ?? 0)}
          icon={TrendingUp}
          color="text-emerald-400"
        />
        <PipelineCard
          label="Win rate"
          hint="Won ÷ decided (by $)"
          value={`${pipeline?.winRatePct ?? 0}%`}
          icon={Target}
          color="text-indigo-400"
        />
        <PipelineCard
          label="All estimates"
          hint={`${counts.ALL?.count ?? 0} total`}
          value={formatMoney(counts.ALL?.totalCents ?? 0)}
          icon={FileText}
          color="text-gray-400"
        />
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by estimate number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search estimates"
            className="w-full pl-9 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-500"
          />
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-700/50 pb-px overflow-x-auto">
        {TABS.map((t) => {
          const c = counts[t];
          return (
            <button
              key={t}
              onClick={() => setStatus(t)}
              className={`px-3 py-2 text-sm rounded-t-lg whitespace-nowrap transition-colors ${
                status === t
                  ? 'bg-gray-800 text-emerald-400 border-b-2 border-emerald-400'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {t.charAt(0) + t.slice(1).toLowerCase()}{' '}
              <span className="text-xs ml-1 opacity-70">{c?.count ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No estimates yet"
          description="Create your first estimate to quote work and build a pipeline you can convert to invoices."
          action={{ label: 'New Estimate', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                <SortHeader label="Estimate #" active={sortKey === 'estimateNumber'} dir={sortDir} onClick={() => toggleSort('estimateNumber')} />
                <SortHeader label="Customer" active={sortKey === 'customer'} dir={sortDir} onClick={() => toggleSort('customer')} />
                <SortHeader label="Date" active={sortKey === 'estimateDate'} dir={sortDir} onClick={() => toggleSort('estimateDate')} />
                <th className="pb-3 pr-4">Valid until</th>
                <SortHeader label="Total" align="right" active={sortKey === 'totalCents'} dir={sortDir} onClick={() => toggleSort('totalCents')} />
                <SortHeader label="Status" active={sortKey === 'status'} dir={sortDir} onClick={() => toggleSort('status')} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <EstimateTableRow key={e.id} row={e} onClick={() => setDetailId(e.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      {showCreate && (
        <EstimateForm
          mode="create"
          initial={null}
          locationId={activeCompanyId}
          onClose={() => setShowCreate(false)}
          onSaved={onCreated}
        />
      )}

      {/* Edit (opened from the drawer) */}
      {editDetail && (
        <EstimateForm
          mode="edit"
          initial={editDetail}
          locationId={editDetail.location?.id ?? activeCompanyId}
          onClose={() => setEditDetail(null)}
          onSaved={onEdited}
        />
      )}

      {/* Detail drawer */}
      <EstimateDrawer
        estimateId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={refresh}
        onEdit={(detail) => {
          setDetailId(null);
          setEditDetail(detail);
        }}
      />
    </div>
  );
}

function EstimateTableRow({ row, onClick }: { row: EstimateRow; onClick: () => void }) {
  return (
    <tr onClick={onClick} className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/40 transition-colors">
      <td className="py-3 pr-4">
        <span className="font-mono text-white">{row.estimateNumber}</span>
      </td>
      <td className="py-3 pr-4 text-gray-300">{row.customer?.name ?? '—'}</td>
      <td className="py-3 pr-4 font-mono text-gray-400 text-xs tabular-nums">{row.estimateDate}</td>
      <td className="py-3 pr-4">
        <span className={`font-mono text-xs tabular-nums ${row.isPastExpiration ? 'text-amber-400' : 'text-gray-400'}`}>
          {row.expirationDate ?? '—'}
        </span>
        {row.isPastExpiration && <span className="ml-1 text-[10px] text-amber-400">past</span>}
      </td>
      <td className="py-3 pr-4 text-right font-mono text-white tabular-nums">
        {formatMoney(row.totalCents, { currency: row.currency })}
      </td>
      <td className="py-3 pr-4">
        <EstimateStatusBadge status={row.status} />
      </td>
    </tr>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`pb-3 pr-4 ${align === 'right' ? 'text-right' : ''}`}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-300 ${
          active ? 'text-emerald-400' : ''
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        {active ? (
          dir === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

function PipelineCard({
  label,
  hint,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  hint: string;
  value: string;
  icon: typeof FileText;
  color: string;
}) {
  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-400">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className="text-xl font-mono font-semibold text-white tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{hint}</p>
    </div>
  );
}
