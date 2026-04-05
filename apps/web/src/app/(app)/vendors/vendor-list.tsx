'use client';

import { useState } from 'react';
import { Search, Shield, AlertTriangle, CheckCircle, FileWarning, Inbox, AlertCircle, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';

interface VendorRow {
  id: string;
  name: string;
  displayName: string;
  defaultAccount: string | null;
  ai_confidence: number;
  auto_approve: boolean;
  transaction_count: number;
  ytd_spend_cents: number;
  is_1099_eligible: boolean;
  compliance: { w9: string; glCoi: string; wcCoi: string };
  hasPaymentHold: boolean;
  hasComplianceIssue: boolean;
}

interface VendorResponse {
  data: VendorRow[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
  summary: { total: number; withIssues: number; with1099: number };
}

function ComplianceIcon({ status }: { status: string }) {
  if (status === 'VALID' || status === 'VERIFIED') return <CheckCircle size={14} className="text-emerald-400" />;
  if (status === 'EXPIRED') return <AlertTriangle size={14} className="text-amber-400" />;
  if (status === 'MISSING') return <FileWarning size={14} className="text-red-400" />;
  if (status === 'PENDING') return <AlertTriangle size={14} className="text-amber-400" />;
  return <span className="text-2xs text-slate-600">—</span>;
}

const FILTER_TABS = [
  { key: 'all', label: 'All Vendors' },
  { key: 'issues', label: 'Compliance Issues' },
  { key: 'compliant', label: 'Compliant' },
] as const;

export function VendorList() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [filter, setFilter] = useState('all');

  const params: Record<string, string> = {};
  if (debouncedSearch) params.search = debouncedSearch;
  if (filter !== 'all') params.compliance = filter;

  const { data, isLoading, error } = useQuery<VendorResponse>(
    '/api/vendors',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const vendors = data?.data ?? [];
  const summary = data?.summary ?? null;

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      {summary && (
        <div className="flex items-center gap-6 px-4 py-3 rounded-lg bg-surface-900 border border-slate-800">
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-slate-500" />
            <span className="text-sm text-slate-400">Total vendors</span>
            <span className="text-sm font-medium text-white font-mono">{summary.total}</span>
          </div>
          <div className="h-4 w-px bg-slate-800" />
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" />
            <span className="text-sm text-slate-400">With issues</span>
            <span className="text-sm font-medium text-amber-400 font-mono">{summary.withIssues}</span>
          </div>
          <div className="h-4 w-px bg-slate-800" />
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">1099 vendors</span>
            <span className="text-sm font-medium text-white font-mono">{summary.with1099}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={clsx(
                'px-3 py-1.5 rounded-md text-sm transition-colors',
                filter === tab.key
                  ? 'bg-slate-800 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-300'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors..."
            className="input pl-9"
          />
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={9} />
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400 font-medium">{error}</p>
        </div>
      ) : vendors.length === 0 ? (
        <EmptyState icon={Inbox} title="No vendors" description="No vendors match your search or filter." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendor</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Default Account</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-20">AI Conf.</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Txns</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">YTD Spend</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">W-9</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">GL COI</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">WC COI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {vendors.map((v) => (
                <tr key={v.id} className="table-row-hover">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-200 font-medium">{v.displayName}</span>
                      {v.hasPaymentHold && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-red-500/10 text-red-400">
                          <ShieldAlert size={10} />
                          HOLD
                        </span>
                      )}
                      {v.auto_approve && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-emerald-500/10 text-emerald-400">
                          Auto
                        </span>
                      )}
                      {v.is_1099_eligible && (
                        <span className="text-2xs text-slate-600 font-mono">1099</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {v.defaultAccount ? (
                      <span className="text-xs font-mono text-slate-400">{v.defaultAccount}</span>
                    ) : (
                      <span className="text-xs text-slate-600 italic">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ConfidenceBar value={v.ai_confidence} />
                  </td>
                  <td className="px-4 py-3 text-center text-sm font-mono tabular-nums text-slate-400">
                    {v.transaction_count}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                    {formatMoney(v.ytd_spend_cents, { compact: true })}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ComplianceIcon status={v.compliance.w9} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ComplianceIcon status={v.compliance.glCoi} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ComplianceIcon status={v.compliance.wcCoi} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
