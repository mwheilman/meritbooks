'use client';

import { useState } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { CheckCircle2, AlertCircle, Loader2, Building2, CreditCard, ChevronDown, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';

interface ReconciliationRow {
  id: string; bankAccountName: string; bankAccountNumber: string;
  locationName: string; locationCode: string;
  periodYear: number; periodMonth: number;
  statementBalanceCents: number; glBalanceCents: number;
  outstandingDepositsCents: number; outstandingChecksCents: number;
  adjustedBankBalanceCents: number; differenceCents: number;
  isReconciled: boolean;
}
interface NeedsRecRow {
  id: string; accountName: string; accountNumber: string;
  balanceCents: number; accountType: string;
  locationName: string; locationCode: string;
}
interface RecResponse {
  reconciliations: ReconciliationRow[];
  needsReconciliation: NeedsRecRow[];
}

export function ReconciliationView() {
  const [locationId, setLocationId] = useState('');
  const { data: locData } = useQuery<{ data: { id: string; name: string }[] }>('/api/locations');
  const locations = locData?.data ?? [];

  const params: Record<string, string> = {};
  if (locationId) params.location_id = locationId;
  const qs = new URLSearchParams(params).toString();

  const { data, isLoading, error } = useQuery<RecResponse>(`/api/reconciliation${qs ? '?' + qs : ''}`);

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;

  const recs = data?.reconciliations ?? [];
  const needs = data?.needsReconciliation ?? [];

  return (
    <div className="space-y-6">
      {/* Filter */}
      <div className="flex items-center gap-3">
        <Building2 className="w-4 h-4 text-gray-500" />
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
          <option value="">All Companies</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {/* Accounts needing reconciliation */}
      {needs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {needs.length} accounts need reconciliation
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {needs.map((a) => (
              <div key={a.id} className="bg-gray-800/30 border border-amber-700/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-white font-medium">{a.accountName}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">{a.locationCode} · {a.accountNumber}</span>
                  <span className="font-mono text-gray-300">{formatMoney(a.balanceCents)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed reconciliations */}
      {recs.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Reconciliation History</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                  <th className="pb-3 pr-4">Account</th>
                  <th className="pb-3 pr-4">Company</th>
                  <th className="pb-3 pr-4">Period</th>
                  <th className="pb-3 pr-4 text-right">Statement</th>
                  <th className="pb-3 pr-4 text-right">GL Balance</th>
                  <th className="pb-3 pr-4 text-right">Outstanding</th>
                  <th className="pb-3 pr-4 text-right">Difference</th>
                  <th className="pb-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/30">
                {recs.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-800/20">
                    <td className="py-2.5 pr-4 text-white">{r.bankAccountName}</td>
                    <td className="py-2.5 pr-4 text-xs text-gray-400">{r.locationCode}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-gray-400">{r.periodYear}-{String(r.periodMonth).padStart(2, '0')}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{formatMoney(r.statementBalanceCents)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{formatMoney(r.glBalanceCents)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gray-400 text-xs">
                      +{formatMoney(r.outstandingDepositsCents)} / -{formatMoney(r.outstandingChecksCents)}
                    </td>
                    <td className={clsx('py-2.5 pr-4 text-right font-mono font-medium', r.differenceCents === 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {formatMoney(r.differenceCents)}
                    </td>
                    <td className="py-2.5">
                      {r.isReconciled
                        ? <span className="flex items-center gap-1 text-emerald-400 text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> Reconciled</span>
                        : <span className="flex items-center gap-1 text-amber-400 text-xs"><AlertCircle className="w-3.5 h-3.5" /> Pending</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : needs.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No reconciliations found</p>
          <p className="text-sm text-gray-500 mt-1">Bank accounts will appear here when connected via Plaid</p>
        </div>
      ) : null}
    </div>
  );
}
