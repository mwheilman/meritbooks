'use client';

import { useState } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { CheckCircle2, AlertCircle, Loader2, Building2, CreditCard, ArrowRight, Lock } from 'lucide-react';
import { clsx } from 'clsx';
import { PlaidLinkButton } from '@/components/integrations/plaid-link-button';
import { ReconciliationWorkspace } from './reconciliation-workspace';

interface ReconciliationRow {
  id: string;
  bankAccountId: string | null;
  fiscalPeriodId: string | null;
  bankAccountName: string; bankAccountNumber: string;
  locationId: string | null;
  locationName: string; locationCode: string;
  periodYear: number; periodMonth: number;
  statementBalanceCents: number; glBalanceCents: number;
  outstandingDepositsCents: number; outstandingChecksCents: number;
  adjustedBankBalanceCents: number; differenceCents: number;
  isReconciled: boolean;
  isFinalized: boolean;
  reconciledAt: string | null;
}
interface NeedsRecRow {
  id: string; accountName: string; accountNumber: string;
  balanceCents: number; accountType: string;
  locationId: string | null; locationName: string; locationCode: string;
}
interface RecResponse {
  reconciliations: ReconciliationRow[];
  needsReconciliation: NeedsRecRow[];
}

interface WorkspaceTarget {
  account: { id: string; accountName: string; locationId: string | null; locationCode: string };
  periodId: string | null;
  year: number | null;
}

export function ReconciliationView() {
  const [locationId, setLocationId] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceTarget | null>(null);
  const { data: locData } = useQuery<{ id: string; name: string }[]>('/api/locations');
  const locations = locData ?? [];

  const params: Record<string, string> = {};
  if (locationId) params.location_id = locationId;
  const qs = new URLSearchParams(params).toString();

  const { data, isLoading, error, refetch } = useQuery<RecResponse>(`/api/reconciliation${qs ? '?' + qs : ''}`);

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
              <button
                key={a.id}
                onClick={() => setWorkspace({ account: { id: a.id, accountName: a.accountName, locationId: a.locationId, locationCode: a.locationCode }, periodId: null, year: null })}
                className="text-left bg-gray-800/30 border border-amber-700/30 rounded-lg p-3 hover:border-emerald-500/50 hover:bg-gray-800/50 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-white font-medium">{a.accountName}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-gray-600 ml-auto group-hover:text-emerald-400 transition-colors" />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">{a.locationCode} · {a.accountNumber}</span>
                  <span className="font-mono text-gray-300">{formatMoney(a.balanceCents)}</span>
                </div>
                <div className="mt-2 text-2xs text-emerald-400/80 opacity-0 group-hover:opacity-100 transition-opacity">
                  Click to reconcile →
                </div>
              </button>
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
                  <th className="pb-3 pr-4 text-right">Book − Stmt</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/30">
                {recs.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() =>
                      r.bankAccountId &&
                      setWorkspace({
                        account: { id: r.bankAccountId, accountName: r.bankAccountName, locationId: r.locationId, locationCode: r.locationCode },
                        periodId: r.fiscalPeriodId,
                        year: r.periodYear,
                      })
                    }
                    className="hover:bg-gray-800/20 cursor-pointer"
                  >
                    <td className="py-2.5 pr-4 text-white">{r.bankAccountName}</td>
                    <td className="py-2.5 pr-4 text-xs text-gray-400">{r.locationCode}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-gray-400">{r.periodYear}-{String(r.periodMonth).padStart(2, '0')}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{formatMoney(r.statementBalanceCents)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{formatMoney(r.glBalanceCents)}</td>
                    <td className={clsx('py-2.5 pr-4 text-right font-mono font-medium', r.differenceCents === 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {formatMoney(r.differenceCents)}
                    </td>
                    <td className="py-2.5">
                      {r.isFinalized
                        ? <span className="flex items-center gap-1 text-emerald-400 text-xs"><Lock className="w-3.5 h-3.5" /> Reconciled</span>
                        : <span className="flex items-center gap-1 text-amber-400 text-xs"><AlertCircle className="w-3.5 h-3.5" /> Draft</span>
                      }
                    </td>
                    <td className="py-2.5 text-right">
                      <ArrowRight className="w-3.5 h-3.5 text-gray-600 ml-auto" />
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
          <p className="text-gray-400">No bank accounts connected yet</p>
          <p className="text-sm text-gray-500 mt-1 mb-4">Connect a bank to import transactions and reconcile against the GL.</p>
          <div className="flex justify-center">
            <PlaidLinkButton variant="full" entities={locations} onChanged={() => refetch()} />
          </div>
        </div>
      ) : null}

      {workspace && (
        <ReconciliationWorkspace
          account={workspace.account}
          initialPeriodId={workspace.periodId}
          initialYear={workspace.year}
          onClose={() => setWorkspace(null)}
          onChanged={() => refetch()}
        />
      )}
    </div>
  );
}
