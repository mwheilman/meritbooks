'use client';

import { useState } from 'react';
import { Package, Loader2, AlertCircle, Search, DollarSign, TrendingDown, Archive } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';

interface AssetRow {
  id: string; assetTag: string | null; name: string; description: string | null;
  serialNumber: string | null; category: string | null;
  acquisitionDate: string; acquisitionCostCents: number;
  salvageValueCents: number; usefulLifeMonths: number;
  depreciationMethod: string;
  accumulatedDepreciationCents: number; netBookValueCents: number;
  lastDepreciationDate: string | null; status: string;
  physicalLocation: string | null; condition: string | null;
  location: { id: string; name: string; short_code: string } | null;
  assignedTo: { id: string; first_name: string; last_name: string } | null;
}

interface AssetsResponse {
  data: AssetRow[];
  summary: { count: number; totalCostCents: number; totalNBVCents: number; totalAccumDepCents: number; byStatus: Record<string, number> };
}

const STATUS_CLS: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400',
  FULLY_DEPRECIATED: 'bg-amber-500/10 text-amber-400',
  DISPOSED: 'bg-slate-500/10 text-slate-500',
  IMPAIRED: 'bg-red-500/10 text-red-400',
};

const METHOD_LABELS: Record<string, string> = {
  STRAIGHT_LINE: 'SL',
  DOUBLE_DECLINING: 'DDB',
  MACRS_3: 'MACRS-3',
  MACRS_5: 'MACRS-5',
  MACRS_7: 'MACRS-7',
  MACRS_10: 'MACRS-10',
  MACRS_15: 'MACRS-15',
  MACRS_20: 'MACRS-20',
};

export default function FixedAssetsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');

  const params: Record<string, string> = {};
  if (statusFilter) params.status = statusFilter;
  if (locationFilter) params.location_id = locationFilter;

  const { data, isLoading, error } = useQuery<AssetsResponse>('/api/fixed-assets', Object.keys(params).length > 0 ? params : undefined);
  const assets = data?.data ?? [];
  const summary = data?.summary;

  const filtered = search
    ? assets.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        (a.assetTag ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (a.serialNumber ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : assets;

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Fixed Assets" description={`${summary?.count ?? 0} assets registered`} />

      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1"><DollarSign size={14} className="text-slate-400" /><span className="text-xs text-slate-500 uppercase">Total Cost</span></div>
          <p className="text-xl font-mono font-semibold text-white">{formatMoney(summary?.totalCostCents ?? 0, { compact: true })}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1"><TrendingDown size={14} className="text-amber-400" /><span className="text-xs text-slate-500 uppercase">Accum Dep</span></div>
          <p className="text-xl font-mono font-semibold text-amber-400">{formatMoney(summary?.totalAccumDepCents ?? 0, { compact: true })}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1"><Archive size={14} className="text-emerald-400" /><span className="text-xs text-slate-500 uppercase">Net Book Value</span></div>
          <p className="text-xl font-mono font-semibold text-emerald-400">{formatMoney(summary?.totalNBVCents ?? 0, { compact: true })}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search assets..." className="w-full pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-500" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
          <option value="">All Status</option>
          <option value="ACTIVE">Active</option>
          <option value="FULLY_DEPRECIATED">Fully Depreciated</option>
          <option value="DISPOSED">Disposed</option>
          <option value="IMPAIRED">Impaired</option>
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <Package className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-500">No fixed assets found.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Asset</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Company</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Category</th>
                  <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Method</th>
                  <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Cost</th>
                  <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Accum Dep</th>
                  <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">NBV</th>
                  <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Life</th>
                  <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {filtered.map((asset) => {
                  const depPct = asset.acquisitionCostCents > 0
                    ? Math.round((asset.accumulatedDepreciationCents / asset.acquisitionCostCents) * 100)
                    : 0;
                  return (
                    <tr key={asset.id} className="hover:bg-slate-800/20">
                      <td className="px-4 py-3">
                        <p className="text-sm text-white font-medium">{asset.name}</p>
                        <p className="text-[10px] text-slate-600 font-mono">{asset.assetTag ?? '—'}{asset.serialNumber ? ` · SN: ${asset.serialNumber}` : ''}</p>
                      </td>
                      <td className="px-4 py-3">
                        {asset.location ? (
                          <span className="text-xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{(asset.location as Record<string, unknown>).short_code as string}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{asset.category ?? '—'}</td>
                      <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">{METHOD_LABELS[asset.depreciationMethod] ?? asset.depreciationMethod}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">{formatMoney(asset.acquisitionCostCents)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs font-mono text-amber-400">{formatMoney(asset.accumulatedDepreciationCents)}</span>
                        <span className="text-[10px] text-slate-600 ml-1">{depPct}%</span>
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-mono font-medium text-white">{formatMoney(asset.netBookValueCents)}</td>
                      <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">{asset.usefulLifeMonths}mo</td>
                      <td className="px-4 py-3 text-center">
                        <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium', STATUS_CLS[asset.status] ?? 'bg-slate-500/10 text-slate-500')}>
                          {asset.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
