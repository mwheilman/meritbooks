'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { formatMoney } from '@meritbooks/shared';
import {
  DollarSign, AlertTriangle, TrendingDown, Building2, Loader2, AlertCircle,
  ChevronDown, ChevronRight, Wallet, RefreshCw, Landmark, Clock
} from 'lucide-react';
import { clsx } from 'clsx';
import { PlaidLinkButton } from '@/components/integrations/plaid-link-button';
import { CashTrend } from './cash-trend';
import { CashObligations } from './cash-obligations';

interface CashAccount {
  id: string;
  name: string;
  mask: string;
  type: string;
  balanceCents: number;
  availableCents: number;
  status: string;
  updatedAt: string | null;
  stale: boolean;
}

interface CashLocation {
  locationId: string;
  locationName: string;
  minimumCashCents: number;
  accounts: CashAccount[];
  totalCashCents: number;
  cashStatus: string;
  staleCount: number;
}

interface CashResponse {
  locations: CashLocation[];
  summary: {
    totalCashCents: number;
    entityCount: number;
    accountCount: number;
    criticalCount: number;
    nearMinCount: number;
    staleCount: number;
    asOfDate: string | null;
  };
}

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: typeof AlertTriangle }> = {
  ADEQUATE: { label: 'Healthy', cls: 'text-emerald-400 bg-emerald-500/10', icon: DollarSign },
  NEAR_MINIMUM: { label: 'Near Minimum', cls: 'text-amber-400 bg-amber-500/10', icon: TrendingDown },
  CRITICAL: { label: 'Critical', cls: 'text-red-400 bg-red-500/10', icon: AlertTriangle },
};

export function CashDashboard() {
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);
  // Default the in-page company filter to the header's active company (this page
  // is company-scoped) so a fresh session lands on the scoped view instead of a
  // misleading "All companies" label. Re-sync whenever the header company changes;
  // an explicit in-page pick still sticks (activeCompanyId doesn't change then).
  const { activeCompanyId } = useActiveCompany();
  const [filterLoc, setFilterLoc] = useState(() =>
    isSpecificCompany(activeCompanyId) ? activeCompanyId : '',
  );
  useEffect(() => {
    setFilterLoc(isSpecificCompany(activeCompanyId) ? activeCompanyId : '');
  }, [activeCompanyId]);
  const cashParams = filterLoc ? { location_id: filterLoc } : undefined;
  const { data, isLoading, error, refetch } = useQuery<CashResponse>('/api/cash', cashParams);
  const { data: entitiesData } = useQuery<Array<{ id: string; name: string }>>('/api/locations');
  const entities = entitiesData ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const locations = data?.locations ?? [];
  const summary = data?.summary;

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Wallet size={14} className="text-emerald-400" />
            <span className="text-xs text-slate-500 uppercase tracking-wider">Total Cash</span>
          </div>
          <p className="text-2xl font-mono font-semibold text-white">
            {formatMoney(summary?.totalCashCents ?? 0, { compact: true })}
          </p>
          {summary?.asOfDate && (
            <p className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
              <Clock size={9} /> as of {new Date(summary.asOfDate).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={14} className="text-slate-400" />
            <span className="text-xs text-slate-500 uppercase tracking-wider">Entities</span>
          </div>
          <p className="text-2xl font-mono font-semibold text-white">{summary?.entityCount ?? 0}</p>
          <p className="text-xs text-slate-500">{summary?.accountCount ?? 0} accounts</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-red-400" />
            <span className="text-xs text-slate-500 uppercase tracking-wider">Critical</span>
          </div>
          <p className={clsx('text-2xl font-mono font-semibold', (summary?.criticalCount ?? 0) > 0 ? 'text-red-400' : 'text-white')}>
            {summary?.criticalCount ?? 0}
          </p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown size={14} className="text-amber-400" />
            <span className="text-xs text-slate-500 uppercase tracking-wider">Near Min</span>
          </div>
          <p className={clsx('text-2xl font-mono font-semibold', (summary?.nearMinCount ?? 0) > 0 ? 'text-amber-400' : 'text-white')}>
            {summary?.nearMinCount ?? 0}
          </p>
        </div>
      </div>

      {/* Stale-feed advisory */}
      {(summary?.staleCount ?? 0) > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border bg-amber-500/[0.06] border-amber-500/20 text-amber-300 text-xs">
          <Clock size={14} />
          <span>
            {summary?.staleCount} account{(summary?.staleCount ?? 0) === 1 ? '' : 's'} {(summary?.staleCount ?? 0) === 1 ? 'has' : 'have'} no recent feed activity — {(summary?.staleCount ?? 0) === 1 ? 'its' : 'their'} balance may be out of date. Refresh the connection to bring it current.
          </span>
        </div>
      )}

      {/* Trend + upcoming obligations — the treasurer's near-term view */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CashTrend locationId={filterLoc || undefined} />
        <CashObligations locationId={filterLoc || undefined} />
      </div>

      {/* Company filter + refresh + bank connection */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <PlaidLinkButton variant="full" entities={entities} onChanged={() => refetch()} />
          <select
            value={filterLoc}
            onChange={(e) => { setFilterLoc(e.target.value); setExpandedLoc(null); }}
            className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="">All companies</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Entity rows */}
      {locations.length === 0 ? (
        <div className="card p-12 text-center">
          <Landmark className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-500">No bank accounts connected.</p>
          <p className="text-xs text-slate-600 mt-1">Use “Connect a bank” above to link an account and see live cash positions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {locations.map((loc) => {
            const isExpanded = expandedLoc === loc.locationId;
            const statusCfg = STATUS_CONFIG[loc.cashStatus] ?? STATUS_CONFIG.ADEQUATE;
            const StatusIcon = statusCfg.icon;
            const pctOfMin = loc.minimumCashCents > 0
              ? Math.round((loc.totalCashCents / loc.minimumCashCents) * 100)
              : null;

            return (
              <div key={loc.locationId} className="bg-slate-800/20 border border-slate-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedLoc(isExpanded ? null : loc.locationId)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-800/40 transition-colors text-left"
                >
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}

                  <span className="text-sm font-medium text-white flex-1">{loc.locationName}</span>

                  {pctOfMin !== null && (
                    <div className="flex items-center gap-2 mr-4">
                      <div className="h-1.5 w-20 rounded-full bg-slate-700 overflow-hidden">
                        <div
                          className={clsx('h-full rounded-full', loc.cashStatus === 'CRITICAL' ? 'bg-red-500' : loc.cashStatus === 'NEAR_MINIMUM' ? 'bg-amber-500' : 'bg-emerald-500')}
                          style={{ width: `${Math.min(pctOfMin, 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-slate-500">{pctOfMin}% of min</span>
                    </div>
                  )}

                  <span className="text-lg font-mono font-semibold text-white mr-3">
                    {formatMoney(loc.totalCashCents)}
                  </span>

                  <span className={clsx('flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium', statusCfg.cls)}>
                    <StatusIcon size={10} /> {statusCfg.label}
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-800/50 px-5 py-3 space-y-2">
                    {loc.minimumCashCents > 0 && (
                      <div className="flex items-center justify-between text-xs text-slate-500 pb-2 border-b border-slate-800/30">
                        <span>Minimum cash target</span>
                        <span className="font-mono">{formatMoney(loc.minimumCashCents)}</span>
                      </div>
                    )}
                    {loc.accounts.map((acct) => (
                      <div key={acct.id} className="flex items-center justify-between py-1.5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-slate-700/50 flex items-center justify-center">
                            <Landmark size={14} className="text-slate-400" />
                          </div>
                          <div>
                            <p className="text-sm text-slate-300 flex items-center gap-1.5">
                              {acct.name}
                              {acct.stale && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium text-amber-400 bg-amber-500/10">
                                  <Clock size={9} /> Stale
                                </span>
                              )}
                            </p>
                            <p className="text-[10px] text-slate-600 font-mono">
                              ····{acct.mask} · {acct.type}
                              {acct.updatedAt
                                ? <> · Updated {new Date(acct.updatedAt).toLocaleDateString()}</>
                                : <> · Never updated</>}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-mono text-white">{formatMoney(acct.balanceCents)}</p>
                          {acct.availableCents !== acct.balanceCents && (
                            <p className="text-[10px] text-slate-600 font-mono">Avail: {formatMoney(acct.availableCents)}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
