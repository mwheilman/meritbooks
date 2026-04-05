'use client';

import { useState, useEffect } from 'react';
import { X, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';

interface GlTransaction {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  sourceModule: string;
  entryMemo: string | null;
  lineMemo: string | null;
  debitCents: number;
  creditCents: number;
  locationName: string;
  locationCode: string;
}

interface GlDetailResponse {
  data: GlTransaction[];
  summary: { totalDebitCents: number; totalCreditCents: number; netCents: number };
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  MANUAL: { label: 'Manual', cls: 'bg-gray-500/20 text-gray-300' },
  AR: { label: 'AR', cls: 'bg-blue-500/20 text-blue-300' },
  AP: { label: 'AP', cls: 'bg-amber-500/20 text-amber-300' },
  CASH_MGMT: { label: 'Cash', cls: 'bg-cyan-500/20 text-cyan-300' },
  PAYROLL: { label: 'Payroll', cls: 'bg-green-500/20 text-green-300' },
  FIXED_ASSETS: { label: 'Assets', cls: 'bg-purple-500/20 text-purple-300' },
  SYSTEM: { label: 'System', cls: 'bg-indigo-500/20 text-indigo-300' },
};

export function GlDrillDown({
  accountId,
  accountNumber,
  accountName,
  startDate,
  endDate,
  locationId,
  onClose,
}: {
  accountId?: string;
  accountNumber: string;
  accountName: string;
  startDate: string;
  endDate: string;
  locationId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<GlDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    params.set('start_date', startDate);
    params.set('end_date', endDate);
    if (locationId && locationId !== 'all') params.set('location_id', locationId);
    params.set('page', String(page));
    params.set('per_page', '50');

    fetch(`/api/reports/gl-detail?${params}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [accountId, startDate, endDate, locationId, page]);

  const txns = data?.data ?? [];
  const summary = data?.summary;
  const pagination = data?.pagination;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-8 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl mb-8 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700/50">
          <div>
            <h2 className="text-base font-semibold text-white">GL Detail — {accountNumber}</h2>
            <p className="text-sm text-gray-400 mt-0.5">{accountName}</p>
            <p className="text-xs text-gray-500 font-mono mt-0.5">{startDate} through {endDate}</p>
          </div>
          <div className="flex items-center gap-4">
            {summary && (
              <div className="text-right text-xs">
                <div className="text-gray-500">Net: <span className="font-mono text-white font-medium">{formatMoney(summary.netCents)}</span></div>
                <div className="text-gray-600">{pagination?.total ?? 0} entries</div>
              </div>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
        ) : error ? (
          <div className="p-8 text-center text-red-400 text-sm">{error}</div>
        ) : txns.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">No transactions found for this account in this period.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Entry #</th>
                    <th className="px-4 py-2.5">Source</th>
                    <th className="px-4 py-2.5">Memo</th>
                    <th className="px-4 py-2.5">Company</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {txns.map((t) => {
                    const src = SOURCE_BADGE[t.sourceModule] ?? SOURCE_BADGE.MANUAL;
                    return (
                      <tr key={t.id} className="hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2 font-mono text-xs text-gray-400">{t.entryDate}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-300">{t.entryNumber}</td>
                        <td className="px-4 py-2">
                          <span className={`px-1.5 py-0.5 text-[10px] rounded ${src.cls}`}>{src.label}</span>
                        </td>
                        <td className="px-4 py-2 text-gray-300 max-w-[200px] truncate" title={t.entryMemo ?? t.lineMemo ?? ''}>
                          {t.lineMemo || t.entryMemo || '—'}
                        </td>
                        <td className="px-4 py-2">
                          <span className="text-xs text-gray-500">{t.locationCode}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-300">
                          {t.debitCents > 0 ? formatMoney(t.debitCents) : ''}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-300">
                          {t.creditCents > 0 ? formatMoney(t.creditCents) : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-700 bg-gray-800/30">
                    <td colSpan={5} className="px-4 py-2.5 text-xs font-semibold text-white">Totals</td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-white">{formatMoney(summary?.totalDebitCents ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-white">{formatMoney(summary?.totalCreditCents ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Pagination */}
            {pagination && pagination.total_pages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-gray-700/50">
                <span className="text-xs text-gray-500">
                  Page {pagination.page} of {pagination.total_pages} ({pagination.total} entries)
                </span>
                <div className="flex gap-1">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                    className="p-1 text-gray-400 hover:text-white disabled:opacity-30 rounded"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setPage((p) => Math.min(pagination.total_pages, p + 1))} disabled={page >= pagination.total_pages}
                    className="p-1 text-gray-400 hover:text-white disabled:opacity-30 rounded"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
