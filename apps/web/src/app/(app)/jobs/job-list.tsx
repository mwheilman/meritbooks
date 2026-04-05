'use client';

import { useState } from 'react';
import { Inbox, AlertCircle, Search, AlertTriangle, TrendingUp, TrendingDown, ExternalLink, Layers, FileText, Clock, Repeat } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import { CompanySelector } from '../bank-feed/company-selector';

interface JobRow {
  id: string; job_number: string; name: string; customer_name: string | null;
  job_type: string | null; status: string; pricing_model: string; markup_pct: number;
  contract_amount_cents: number | null; original_contract_cents: number | null;
  estimated_cost_cents: number | null; estimatedRevenueCents: number;
  actual_cost_cents: number; billed_to_date_cents: number;
  retainage_pct: number; retainage_held_cents: number;
  computedPctComplete: number; rev_rec_method: string | null;
  monthly_retainer_cents: number | null; hourly_rate_cents: number | null;
  budget_hours: number | null; actual_hours: number | null;
  total_milestones: number | null; completed_milestones: number | null;
  billing_frequency: string | null; service_start_date: string | null; service_end_date: string | null;
  start_date: string | null; estimated_completion_date: string | null;
  job_site_city: string | null; job_site_state: string | null;
  external_source: string | null; location: { id: string; name: string; short_code: string } | null;
  phaseCount: number; profitMarginPct: number; costPctOfBudget: number; isOverBudget: boolean;
  wipStatus: string; wipVarianceCents: number; isErpSynced: boolean; isService: boolean;
  changeOrderCount: number; pendingCOCount: number;
}

interface JobResponse {
  data: JobRow[]; counts: Record<string, number>;
  summary: { totalContractCents: number; totalEstRevCents: number; totalActualCents: number;
    totalBilledCents: number; overBudgetCount: number; activeCount: number;
    serviceCount: number; projectCount: number; erpSyncedCount: number };
}

const TABS = [
  { key: 'all', label: 'All' }, { key: 'ACTIVE', label: 'Active' },
  { key: 'BID', label: 'Bid' }, { key: 'COMPLETE', label: 'Complete' },
] as const;

const PRICING: Record<string, { label: string; cls: string }> = {
  FIXED_PRICE: { label: 'Fixed', cls: 'text-slate-400 bg-slate-500/10' },
  COST_PLUS: { label: 'Cost+', cls: 'text-blue-400 bg-blue-500/10' },
  TIME_AND_MATERIALS: { label: 'T&M', cls: 'text-purple-400 bg-purple-500/10' },
  UNIT_PRICE: { label: 'Unit', cls: 'text-amber-400 bg-amber-500/10' },
  RETAINER: { label: 'Retainer', cls: 'text-emerald-400 bg-emerald-500/10' },
  SUBSCRIPTION: { label: 'Subscription', cls: 'text-cyan-400 bg-cyan-500/10' },
  HOURLY: { label: 'Hourly', cls: 'text-indigo-400 bg-indigo-500/10' },
};

const RR: Record<string, string> = {
  PCT_COSTS_INCURRED: '% Costs', PCT_COMPLETE: '% Complete', COMPLETED_CONTRACT: 'Completed',
  POINT_OF_SALE: 'POS', RATABLY: 'Ratable', AS_BILLED: 'As Billed',
  MILESTONE: 'Milestone', SUBSCRIPTION: 'Subscription',
};

const ERP: Record<string, string> = {
  BUILDERTREND: 'BT', SIMPRO: 'Simpro', SERVICETITAN: 'ST',
  FIELDEDGE: 'FE', RFMS: 'RFMS', INNERGY: 'Innergy', JOBBER: 'Jobber',
};

function Bar({ pct, warn }: { pct: number; warn: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-14 rounded-full bg-slate-800 overflow-hidden">
        <div className={clsx('h-full rounded-full', warn ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-500')}
          style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={clsx('text-2xs font-mono tabular-nums', warn ? 'text-red-400' : 'text-slate-500')}>{Math.round(pct)}%</span>
    </div>
  );
}

export function JobList() {
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const ds = useDebounce(search, 300);
  const [locId, setLocId] = useState<string | null>(null);

  const p: Record<string, string> = {};
  if (tab !== 'all') p.status = tab;
  if (ds) p.search = ds;
  if (locId) p.location_id = locId;

  const { data, isLoading, error } = useQuery<JobResponse>('/api/jobs', Object.keys(p).length > 0 ? p : undefined);
  const jobs = data?.data ?? [];
  const counts = data?.counts ?? null;
  const s = data?.summary ?? null;

  return (
    <div className="space-y-4">
      <CompanySelector selectedId={locId} onChange={setLocId} />

      {s && s.activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 rounded-lg bg-surface-900 border border-slate-800 text-sm">
          <span className="text-slate-400">Active: <span className="text-white font-mono font-medium">{s.activeCount}</span>
            <span className="text-slate-600 text-2xs ml-1">({s.projectCount} projects · {s.serviceCount} service)</span></span>
          <div className="h-4 w-px bg-slate-800" />
          <span className="text-slate-400">Est. Revenue: <span className="text-white font-mono font-medium">{formatMoney(s.totalEstRevCents, { compact: true })}</span></span>
          <div className="h-4 w-px bg-slate-800" />
          <span className="text-slate-400">Costs: <span className="text-white font-mono font-medium">{formatMoney(s.totalActualCents, { compact: true })}</span></span>
          <div className="h-4 w-px bg-slate-800" />
          <span className="text-slate-400">Billed: <span className="text-white font-mono font-medium">{formatMoney(s.totalBilledCents, { compact: true })}</span></span>
          {s.overBudgetCount > 0 && <>
            <div className="h-4 w-px bg-slate-800" />
            <span className="text-red-400 font-medium flex items-center gap-1"><AlertTriangle size={12} />{s.overBudgetCount} over budget</span>
          </>}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              tab === t.key ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300')}>
              {t.label} <span className={clsx('text-2xs font-mono', tab === t.key ? 'text-brand-400' : 'text-slate-600')}>{counts?.[t.key] ?? '--'}</span>
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search jobs..." className="input pl-9" />
        </div>
      </div>

      {isLoading ? <TableSkeleton rows={6} cols={10} /> : error ? (
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : jobs.length === 0 ? (
        <EmptyState icon={Inbox} title="No jobs" description="No jobs match your filters." />
      ) : (
        <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="w-full">
          <thead><tr className="border-b border-slate-800">
            <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job / Engagement</th>
            <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Customer</th>
            <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Co.</th>
            <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Pricing / Rev Rec</th>
            <th className="px-3 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Revenue</th>
            <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-24">Progress</th>
            <th className="px-3 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Margin</th>
            <th className="px-3 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Billed</th>
            <th className="px-3 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/30">
            {jobs.map((j) => {
              const pr = PRICING[j.pricing_model] ?? PRICING.FIXED_PRICE;
              return (
                <tr key={j.id} className="table-row-hover">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-mono text-slate-300">{j.job_number}</span>
                      {j.isErpSynced && <span className="px-1 py-0.5 rounded text-2xs font-medium text-cyan-400 bg-cyan-500/10">{ERP[j.external_source?.toUpperCase() ?? ''] ?? j.external_source}</span>}
                      {j.phaseCount > 0 && <span className="text-2xs text-slate-600 flex items-center gap-0.5"><Layers size={9} />{j.phaseCount}</span>}
                      {j.changeOrderCount > 0 && <span className={clsx('text-2xs flex items-center gap-0.5', j.pendingCOCount > 0 ? 'text-amber-400' : 'text-slate-600')}><FileText size={9} />{j.changeOrderCount} CO</span>}
                    </div>
                    <p className="text-sm text-slate-200 mt-0.5 truncate max-w-[200px]">{j.name}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-sm text-slate-400">{j.customer_name ?? '--'}</span>
                    {j.job_site_city && <span className="block text-2xs text-slate-600">{j.job_site_city}{j.job_site_state ? `, ${j.job_site_state}` : ''}</span>}
                  </td>
                  <td className="px-3 py-2.5">{j.location && <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">{j.location.short_code}</span>}</td>
                  <td className="px-3 py-2.5">
                    <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium', pr.cls)}>
                      {pr.label}
                      {(j.pricing_model === 'COST_PLUS' || j.pricing_model === 'TIME_AND_MATERIALS') && j.markup_pct > 0 && <span className="ml-0.5 font-mono">+{j.markup_pct}%</span>}
                    </span>
                    {j.rev_rec_method && <span className="block text-2xs text-slate-600 mt-0.5 font-mono">{RR[j.rev_rec_method] ?? j.rev_rec_method}</span>}
                    {/* Service-specific: show monthly/hourly/milestone info */}
                    {j.isService && j.monthly_retainer_cents && <span className="block text-2xs text-slate-500 font-mono">{formatMoney(j.monthly_retainer_cents)}/mo</span>}
                    {j.isService && j.hourly_rate_cents && <span className="block text-2xs text-slate-500 font-mono">{formatMoney(j.hourly_rate_cents)}/hr</span>}
                    {j.rev_rec_method === 'MILESTONE' && j.total_milestones && <span className="block text-2xs text-slate-500">{j.completed_milestones}/{j.total_milestones} milestones</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="text-sm font-mono tabular-nums text-slate-200">{j.estimatedRevenueCents ? formatMoney(j.estimatedRevenueCents, { compact: true }) : '--'}</span>
                    {j.isService && j.budget_hours && <span className="block text-2xs text-slate-500 font-mono">{j.actual_hours ?? 0}/{j.budget_hours}h</span>}
                    {!j.isService && j.retainage_pct > 0 && <span className="block text-2xs text-slate-600">{j.retainage_pct}% ret.</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <Bar pct={j.isService ? j.computedPctComplete : j.costPctOfBudget} warn={j.isOverBudget} />
                    <span className="text-2xs text-slate-500 font-mono">{Math.round(j.computedPctComplete)}% done</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={clsx('text-sm font-mono tabular-nums font-medium',
                      j.profitMarginPct >= 25 ? 'text-emerald-400' : j.profitMarginPct >= 10 ? 'text-amber-400' : 'text-red-400'
                    )}>{j.profitMarginPct}%</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="text-sm font-mono tabular-nums text-slate-300">{formatMoney(j.billed_to_date_cents, { compact: true })}</span>
                    {j.wipStatus !== 'ON_TRACK' && (
                      <span className={clsx('block text-2xs font-mono mt-0.5',
                        j.wipStatus === 'OVERBILLED' ? 'text-amber-400' : 'text-blue-400'
                      )}>
                        {j.wipStatus === 'OVERBILLED' ? '▲' : '▼'} {formatMoney(Math.abs(j.wipVarianceCents), { compact: true })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center"><StatusBadge status={j.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div></div>
      )}
    </div>
  );
}
