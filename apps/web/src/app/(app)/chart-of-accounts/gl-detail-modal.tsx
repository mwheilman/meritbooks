'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, ChevronLeft, ChevronRight, Inbox, AlertCircle } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';

// Full general-ledger detail for a single account, reusing the existing
// read route (/api/reports/gl-detail). Opened from the Chart of Accounts
// grouped view as the per-account "drill to GL detail".

interface GlTxn {
  id: string;
  entryNumber: string;
  entryDate: string;
  sourceModule: string;
  entryMemo: string | null;
  lineMemo: string | null;
  debitCents: number;
  creditCents: number;
  locationCode: string;
}

interface GlDetailResponse {
  data: GlTxn[];
  summary: { totalDebitCents: number; totalCreditCents: number; netCents: number };
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const SOURCE_BADGE: Record<string, string> = {
  MANUAL: 'bg-slate-500/15 text-slate-300',
  AR: 'bg-blue-500/15 text-blue-300',
  AP: 'bg-amber-500/15 text-amber-300',
  CASH_MGMT: 'bg-cyan-500/15 text-cyan-300',
  PAYROLL: 'bg-emerald-500/15 text-emerald-300',
  FIXED_ASSETS: 'bg-purple-500/15 text-purple-300',
  BANK_FEED: 'bg-teal-500/15 text-teal-300',
  SYSTEM: 'bg-indigo-500/15 text-indigo-300',
};

export function GlDetailModal({
  accountId,
  accountNumber,
  accountName,
  startDate,
  endDate,
  locationId,
  onClose,
}: {
  accountId: string;
  accountNumber: string;
  accountName: string;
  startDate: string;
  endDate: string;
  /** Active-company scope; omit/'all' for consolidated. */
  locationId?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<GlDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    params.set('account_id', accountId);
    params.set('start_date', startDate);
    params.set('end_date', endDate);
    if (locationId && locationId !== 'all') params.set('location_id', locationId);
    params.set('page', String(page));
    params.set('per_page', '50');

    fetch(`/api/reports/gl-detail?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.error) { setError(d.error); setData(null); }
        else setData(d);
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [accountId, startDate, endDate, locationId, page]);

  const txns = data?.data ?? [];
  const summary = data?.summary;
  const pagination = data?.pagination;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-8 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl mb-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white">GL Detail · <span className="font-mono text-emerald-400">{accountNumber}</span></h2>
            <p className="text-sm text-slate-400 mt-0.5">{accountName}</p>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{startDate} → {endDate}</p>
          </div>
          <div className="flex items-center gap-4">
            {summary && (
              <div className="text-right text-xs">
                <div className="text-slate-500">Net <span className="font-mono text-white font-medium">{formatMoney(summary.netCents)}</span></div>
                <div className="text-slate-600">{pagination?.total ?? 0} entries</div>
              </div>
            )}
            <button onClick={onClose} aria-label="Close GL detail" className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
        ) : error ? (
          <div className="p-8 text-center"><AlertCircle className="w-7 h-7 mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
        ) : txns.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="w-8 h-8 mx-auto text-slate-600 mb-2" />
            <p className="text-sm text-slate-400">No posted activity for this account in the selected period.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-2xs text-slate-500 uppercase tracking-wider border-b border-slate-800">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Entry #</th>
                    <th className="px-4 py-2.5">Source</th>
                    <th className="px-4 py-2.5">Memo</th>
                    <th className="px-4 py-2.5">Co.</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {txns.map((t) => (
                    <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2 font-mono text-xs text-slate-400">{t.entryDate}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-300">{t.entryNumber}</td>
                      <td className="px-4 py-2">
                        <span className={`px-1.5 py-0.5 text-[10px] rounded ${SOURCE_BADGE[t.sourceModule] ?? SOURCE_BADGE.MANUAL}`}>
                          {t.sourceModule || 'MANUAL'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-300 max-w-[220px] truncate" title={t.lineMemo ?? t.entryMemo ?? ''}>
                        {t.lineMemo || t.entryMemo || '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">{t.locationCode}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-200">{t.debitCents > 0 ? formatMoney(t.debitCents) : ''}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-200">{t.creditCents > 0 ? formatMoney(t.creditCents) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-700 bg-slate-800/30">
                    <td colSpan={5} className="px-4 py-2.5 text-xs font-semibold text-white">Page totals</td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-white">{formatMoney(summary?.totalDebitCents ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-white">{formatMoney(summary?.totalCreditCents ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {pagination && pagination.total_pages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800">
                <span className="text-xs text-slate-500">Page {pagination.page} of {pagination.total_pages} · {pagination.total} entries</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page"
                    className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setPage((p) => Math.min(pagination.total_pages, p + 1))} disabled={page >= pagination.total_pages} aria-label="Next page"
                    className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
