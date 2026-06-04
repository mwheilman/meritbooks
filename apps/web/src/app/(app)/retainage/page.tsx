'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, PiggyBank, X, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

interface Row {
  billId: string;
  billNumber: string | null;
  billDate: string;
  vendorName: string;
  locationName: string | null;
  status: string;
  retainagePct: number;
  withheldCents: number;
  releasedCents: number;
  outstandingCents: number;
}
interface Totals { withheldCents: number; releasedCents: number; outstandingCents: number }
interface Overview { rows: Row[]; totals: Totals }

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const today = () => new Date().toISOString().slice(0, 10);

export default function RetainagePage() {
  const { data, isLoading, error, refetch } = useQuery<Overview>('/api/retainage');
  const [release, setRelease] = useState<Row | null>(null);

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Retainage Payable"
        description="Retainage withheld from subcontractor bills, held until the work is accepted, then released and paid."
      />

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="animate-spin" size={20} />
        </div>
      )}

      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {totals && (
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryCard label="Withheld to date" value={fmt(totals.withheldCents)} tone="neutral" />
              <SummaryCard label="Released" value={fmt(totals.releasedCents)} tone="muted" />
              <SummaryCard label="Outstanding payable" value={fmt(totals.outstandingCents)} tone="amber" />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No retainage withheld"
              description="When you enter a bill with a retainage %, the withheld amount appears here to release once the work is accepted."
            />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">Bill</th>
                    <th className="text-left font-medium px-4 py-2.5">Vendor</th>
                    <th className="text-left font-medium px-4 py-2.5">Date</th>
                    <th className="text-right font-medium px-4 py-2.5">Withheld</th>
                    <th className="text-right font-medium px-4 py-2.5">Released</th>
                    <th className="text-right font-medium px-4 py-2.5">Outstanding</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const settled = r.outstandingCents <= 0;
                    return (
                      <tr key={r.billId} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                          {r.billNumber ?? '—'}
                          {r.locationName && <span className="block text-2xs text-slate-500">{r.locationName}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300">{r.vendorName}</td>
                        <td className="px-4 py-2.5 text-slate-400 font-mono text-xs">{r.billDate}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                          {fmt(r.withheldCents)}
                          <span className="block text-2xs text-slate-500">{r.retainagePct}%</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(r.releasedCents)}</td>
                        <td className={clsx('px-4 py-2.5 text-right font-mono', settled ? 'text-slate-500' : 'text-amber-300')}>
                          {fmt(r.outstandingCents)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {settled ? (
                            <span className="inline-flex items-center gap-1 text-2xs text-emerald-400"><CheckCircle2 size={13} /> Settled</span>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setRelease(r)}
                              disabled={r.status === 'VOIDED' || r.status === 'PENDING' || r.status === 'ON_HOLD'}
                              title={r.status === 'PENDING' || r.status === 'ON_HOLD' ? 'Approve the bill first' : 'Release & pay retainage'}
                            >
                              Release
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {release && (
        <ReleaseModal
          row={release}
          onClose={() => setRelease(null)}
          onDone={() => { setRelease(null); refetch(); }}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: 'neutral' | 'muted' | 'amber' }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('text-xl font-mono font-semibold mt-1',
        tone === 'amber' ? 'text-amber-300' : tone === 'muted' ? 'text-slate-400' : 'text-white')}>
        {value}
      </p>
    </div>
  );
}

function ReleaseModal({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState((row.outstandingCents / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('ACH');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setErr('Enter an amount greater than zero.');
    if (cents > row.outstandingCents) return setErr(`Cannot exceed the outstanding ${fmt(row.outstandingCents)}.`);

    setSaving(true);
    const res = await api.post<{ entry_number: string }>('/api/retainage', {
      bill_id: row.billId,
      amount_cents: cents,
      release_date: date,
      payment_method: method || undefined,
      memo: memo || undefined,
    });
    setSaving(false);
    if (res.error) { setErr(res.error.error); return; }
    addToast('success', `Released ${fmt(cents)} on ${row.billNumber ?? 'bill'}`);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-white">Release retainage</h3>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose}><X size={18} /></button>
        </div>

        <p className="text-sm text-slate-400 mb-4">
          {row.vendorName} · {row.billNumber ?? 'bill'} — outstanding{' '}
          <span className="font-mono text-amber-300">{fmt(row.outstandingCents)}</span>.
          Posts a payment that relieves Retainage Payable.
        </p>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400">Amount (USD)</label>
              <input className="input mt-1 font-mono" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-400">Date</label>
              <input type="date" className="input mt-1" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400">Payment method</label>
            <select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="ACH">ACH</option>
              <option value="CHECK">Check</option>
              <option value="WIRE">Wire</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">Memo (optional)</label>
            <input className="input mt-1" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Final acceptance — Phase 2" />
          </div>
          {err && <div className="text-sm text-red-400 flex items-center gap-2"><AlertCircle size={14} /> {err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Release & pay
          </button>
        </div>
      </div>
    </div>
  );
}
