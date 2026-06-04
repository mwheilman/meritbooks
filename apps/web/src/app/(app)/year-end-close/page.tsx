'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, Lock, X, RotateCcw, CheckCircle2, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

interface EntityRow {
  locationId: string; locationName: string;
  revenueCents: number; expenseCents: number; netIncomeCents: number;
  closed: boolean; closeId: string | null; entryNumber: string | null; closeDate: string | null;
}
interface Totals { revenueCents: number; expenseCents: number; netIncomeCents: number; closedCount: number }
interface Overview { fiscalYear: number; rows: EntityRow[]; totals: Totals }

interface PreviewAccount { accountId: string; accountNumber: string; name: string; accountType: string; balanceCents: number; debitCents: number; creditCents: number }
interface Preview { fiscalYear: number; closeDate: string; accounts: PreviewAccount[]; revenueCents: number; expenseCents: number; netIncomeCents: number; isEmpty: boolean }

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtSigned = (c: number) => (c < 0 ? `(${fmt(-c)})` : fmt(c));

export default function YearEndClosePage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const { data, isLoading, error, refetch } = useQuery<Overview>('/api/year-end-close', { year: String(year) });
  const [preview, setPreview] = useState<{ row: EntityRow; data: Preview | null; loading: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = data?.rows ?? [];
  const t = data?.totals;
  const years = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];

  const openPreview = async (row: EntityRow) => {
    setPreview({ row, data: null, loading: true });
    const res = await api.post<Preview>('/api/year-end-close', { action: 'preview', location_id: row.locationId, year });
    if (res.error) { addToast('error', res.error.error); setPreview(null); return; }
    setPreview({ row, data: res.data ?? null, loading: false });
  };

  const runClose = async (row: EntityRow) => {
    setBusy(row.locationId);
    const res = await api.post<{ entry_number: string }>('/api/year-end-close', { action: 'run', location_id: row.locationId, year });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `${row.locationName} closed — ${res.data?.entry_number}`);
    setPreview(null);
    refetch();
  };

  const reverseClose = async (row: EntityRow) => {
    if (!row.closeId) return;
    const reason = window.prompt(`Reverse the FY${year} close for ${row.locationName}? The closing entry will be voided. Reason:`);
    if (!reason || reason.trim().length < 3) return;
    setBusy(row.locationId);
    const res = await api.post('/api/year-end-close', { action: 'reverse', close_id: row.closeId, reason: reason.trim() });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `FY${year} close reversed for ${row.locationName}`);
    refetch();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Year-End Close"
        description="Roll each entity's temporary accounts (revenue, COGS, expenses) into retained earnings at fiscal year-end."
        actions={
          <div className="relative">
            <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="appearance-none input pr-8">
              {years.map((y) => <option key={y} value={y}>FY {y}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          </div>
        }
      />

      {isLoading && <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>}
      {error && !isLoading && <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>}

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {t && (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <SummaryCard label="Group revenue" value={fmt(t.revenueCents)} />
              <SummaryCard label="Group expense" value={fmt(t.expenseCents)} />
              <SummaryCard label={`FY${year} net income`} value={fmtSigned(t.netIncomeCents)} tone={t.netIncomeCents >= 0 ? 'emerald' : 'red'} />
              <SummaryCard label="Entities closed" value={`${t.closedCount}/${rows.length}`} tone="neutral" />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState icon={Lock} title="No entities" description="Add a company/entity to run year-end close." />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">Entity</th>
                    <th className="text-right font-medium px-4 py-2.5">Revenue</th>
                    <th className="text-right font-medium px-4 py-2.5">Expense</th>
                    <th className="text-right font-medium px-4 py-2.5">Net income</th>
                    <th className="text-left font-medium px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.locationId} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-4 py-3 text-slate-200 font-medium">{r.locationName}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-400">{fmt(r.revenueCents)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-400">{fmt(r.expenseCents)}</td>
                      <td className={clsx('px-4 py-3 text-right font-mono font-semibold', r.netIncomeCents >= 0 ? 'text-emerald-300' : 'text-red-300')}>
                        {fmtSigned(r.netIncomeCents)}
                      </td>
                      <td className="px-4 py-3">
                        {r.closed ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-medium" title={r.entryNumber ?? undefined}>
                            <CheckCircle2 size={14} /> Closed {r.entryNumber && <span className="text-slate-500 font-mono">· {r.entryNumber}</span>}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-400 text-xs">Open</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {r.closed ? (
                          <button className="btn btn-ghost btn-sm text-amber-400" onClick={() => reverseClose(r)} disabled={busy === r.locationId}
                            title="Reverse close (voids the closing entry)">
                            {busy === r.locationId ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reverse
                          </button>
                        ) : (
                          <button className="btn btn-secondary btn-sm" onClick={() => openPreview(r)}
                            disabled={r.revenueCents === 0 && r.expenseCents === 0}>
                            Review &amp; close
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {preview && (
        <PreviewModal
          entityName={preview.row.locationName}
          year={year}
          loading={preview.loading}
          preview={preview.data}
          posting={busy === preview.row.locationId}
          onClose={() => setPreview(null)}
          onConfirm={() => runClose(preview.row)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'red' | 'neutral' }) {
  const cls = tone === 'emerald' ? 'text-emerald-300' : tone === 'red' ? 'text-red-300' : tone === 'neutral' ? 'text-white' : 'text-slate-200';
  return (
    <div className="card p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('text-lg font-mono font-semibold mt-1', cls)}>{value}</p>
    </div>
  );
}

function PreviewModal(props: {
  entityName: string; year: number; loading: boolean; preview: Preview | null; posting: boolean;
  onClose: () => void; onConfirm: () => void;
}) {
  const { entityName, year, loading, preview, posting, onClose, onConfirm } = props;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-white">Closing entry — {entityName} · FY{year}</h3>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose}><X size={18} /></button>
        </div>

        {loading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>}

        {!loading && preview && (
          <>
            {preview.isEmpty ? (
              <p className="text-sm text-slate-400 py-6">No temporary-account activity to close for FY{year}.</p>
            ) : (
              <>
                <p className="text-sm text-slate-400 mb-3">
                  Dated {preview.closeDate}. Each account below is zeroed; net income of{' '}
                  <span className={clsx('font-mono font-medium', preview.netIncomeCents >= 0 ? 'text-emerald-300' : 'text-red-300')}>
                    {fmtSigned(preview.netIncomeCents)}
                  </span>{' '}
                  moves to retained earnings.
                </p>
                <div className="overflow-auto border border-slate-800 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800 sticky top-0 bg-slate-900">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Account</th>
                        <th className="text-right font-medium px-3 py-2">Debit</th>
                        <th className="text-right font-medium px-3 py-2">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.accounts.map((a) => (
                        <tr key={a.accountId} className="border-b border-slate-800/40">
                          <td className="px-3 py-1.5 text-slate-300"><span className="font-mono text-xs text-slate-500">{a.accountNumber}</span> {a.name}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-slate-300">{a.debitCents ? fmt(a.debitCents) : ''}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-slate-300">{a.creditCents ? fmt(a.creditCents) : ''}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-800/30 font-medium">
                        <td className="px-3 py-1.5 text-slate-200">Retained Earnings (net {preview.netIncomeCents >= 0 ? 'income' : 'loss'})</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-200">{preview.netIncomeCents < 0 ? fmt(-preview.netIncomeCents) : ''}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-200">{preview.netIncomeCents > 0 ? fmt(preview.netIncomeCents) : ''}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={posting}>Cancel</button>
              {!preview.isEmpty && (
                <button className="btn btn-primary btn-sm" onClick={onConfirm} disabled={posting}>
                  {posting ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />} Post closing entry
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
