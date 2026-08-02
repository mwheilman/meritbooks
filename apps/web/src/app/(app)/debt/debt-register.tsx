'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, Plus, Sparkles, Landmark, X, Trash2, ShieldCheck,
  CalendarClock, ChevronRight, CheckCircle2,
} from 'lucide-react';
import { DebtForm } from './debt-form';
import { DebtParseReview } from './debt-parse-review';

type Frequency = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
type Status = 'ACTIVE' | 'PAID_OFF' | 'CLOSED' | 'INACTIVE';

interface NextPayment {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
}

interface Instrument {
  id: string;
  loan_name: string;
  lender: string | null;
  facility: string | null;
  principal_cents: number;
  interest_rate: number | string;
  rate_type: 'FIXED' | 'VARIABLE';
  amortization_method: 'AMORTIZING' | 'INTEREST_ONLY';
  payment_frequency: Frequency;
  term_periods: number | null;
  payment_cents: number | null;
  status: Status;
  loan_covenant_id: string | null;
  periods: number;
  current_balance_cents: number;
  next_payment: NextPayment | null;
}

interface ScheduleLine {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  principal_balance_cents: number;
  accrued: boolean;
  paid: boolean;
}

interface DetailResponse {
  data: {
    instrument: Instrument;
    schedule: ScheduleLine[];
    covenant: { id: string; loan_name: string; covenant_type: string } | null;
  };
}

const STATUS_STYLE: Record<Status, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  PAID_OFF: 'bg-slate-700/40 text-slate-300 border-slate-700',
  CLOSED: 'bg-slate-700/40 text-slate-400 border-slate-700',
  INACTIVE: 'bg-slate-700/40 text-slate-500 border-slate-700',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function DebtRegister() {
  const [mode, setMode] = useState<null | 'parse' | 'manual'>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState('0');

  const { data, isLoading, error, refetch } = useQuery<{ data: Instrument[] }>('/api/debt', undefined, { key: refreshKey });
  const instruments = data?.data ?? [];

  function bump() {
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }

  async function remove(inst: Instrument) {
    if (!confirm(`Delete "${inst.loan_name}"? This removes its amortization schedule. Posted GL entries are not reversed.`)) return;
    const res = await api.delete(`/api/debt/${inst.id}`);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Loan deleted');
    if (openId === inst.id) setOpenId(null);
    bump();
  }

  const Controls = (
    <div className="flex items-center gap-2">
      <button onClick={() => setMode('parse')} className="px-3 py-1.5 text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1.5">
        <Sparkles size={13} /> Upload loan document
      </button>
      <button onClick={() => setMode('manual')} className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5">
        <Plus size={13} /> Add loan
      </button>
    </div>
  );

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  }
  if (error) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  const totalOutstanding = instruments.reduce((s, i) => s + i.current_balance_cents, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-500">{instruments.length} loan{instruments.length === 1 ? '' : 's'}</span>
          {instruments.length > 0 && (
            <span className="text-slate-300">Outstanding <span className="font-mono text-white">{formatMoney(totalOutstanding)}</span></span>
          )}
        </div>
        {Controls}
      </div>

      {instruments.length === 0 ? (
        <div className="card p-12 text-center">
          <Landmark className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">No debt on the books</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Drop in a loan agreement and AI extracts the terms — principal, rate, term, payment, dates. After you confirm,
            MeritBooks builds the amortization schedule and can post the monthly interest accrual to the ledger.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setMode('parse')} className="px-4 py-2 text-sm font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg inline-flex items-center gap-1.5">
              <Sparkles size={14} /> Upload loan document
            </button>
            <button onClick={() => setMode('manual')} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5">
              <Plus size={14} /> Add manually
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {instruments.map((inst) => (
            <div key={inst.id} className="card p-4 border border-slate-800">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{inst.loan_name}</p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {inst.facility ? `${inst.facility} · ` : ''}{inst.lender ?? 'No lender'} · {Number(inst.interest_rate)}% {inst.rate_type.toLowerCase()} · {inst.payment_frequency.toLowerCase()}
                  </p>
                </div>
                <span className={clsx('shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium', STATUS_STYLE[inst.status])}>
                  {inst.status.replace('_', ' ').toLowerCase()}
                </span>
              </div>

              <div className="flex items-end justify-between mb-3">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Current balance</p>
                  <p className="text-2xl font-mono font-semibold text-white mt-0.5">{formatMoney(inst.current_balance_cents)}</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">of {formatMoney(inst.principal_cents)} original</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Next payment</p>
                  {inst.next_payment ? (
                    <>
                      <p className="text-sm font-mono text-slate-200">{formatMoney(inst.next_payment.payment_cents)}</p>
                      <p className="text-[10px] text-slate-500 flex items-center gap-1 justify-end"><CalendarClock size={10} /> {fmtDate(inst.next_payment.period_date)}</p>
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">—</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => setOpenId(inst.id)} className="px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-md flex items-center gap-1">
                  View schedule <ChevronRight size={12} />
                </button>
                {inst.loan_covenant_id && (
                  <span className="px-2 py-1 text-[11px] text-indigo-300 bg-indigo-500/10 rounded-md flex items-center gap-1"><ShieldCheck size={11} /> Covenant linked</span>
                )}
                <button onClick={() => remove(inst)} className="ml-auto px-2 py-1 text-[11px] text-slate-500 hover:text-red-400 rounded-md hover:bg-slate-800 flex items-center gap-1">
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-slate-600 leading-relaxed">
        Amortization is computed deterministically in cents (standard amortizing + interest-only). Interest accrual posts
        DR Interest Expense / CR Interest Payable; a payment clears the payable (or expenses interest) and reduces the debt
        against cash — both by account role, source-ref-guarded against a double post. AI is used only to read the document.
      </p>

      {mode === 'parse' && <DebtParseReview onClose={() => setMode(null)} onConfirmed={() => { setMode(null); bump(); }} />}

      {mode === 'manual' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setMode(null)}>
          <div className="card w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Add a loan</h2>
              <button onClick={() => setMode(null)} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close"><X size={18} /></button>
            </div>
            <DebtForm initial={null} onClose={() => setMode(null)} onSaved={() => { setMode(null); bump(); }} />
          </div>
        </div>
      )}

      {openId && <ScheduleDrawer instrumentId={openId} onClose={() => setOpenId(null)} onPosted={bump} />}
    </div>
  );
}

function ScheduleDrawer({ instrumentId, onClose, onPosted }: { instrumentId: string; onClose: () => void; onPosted: () => void }) {
  const [refreshKey, setRefreshKey] = useState('0');
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery<DetailResponse>(`/api/debt/${instrumentId}`, undefined, { key: refreshKey });

  const detail = data?.data;
  const inst = detail?.instrument;
  const lines = detail?.schedule ?? [];

  async function post(period: number, kind: 'ACCRUAL' | 'PAYMENT') {
    setBusy(`${period}:${kind}`);
    const res = await api.post<{ already_posted: boolean; entry_number: string | null }>(`/api/debt/${instrumentId}/post`, { period, kind });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', res.data?.already_posted ? 'Already posted for this period' : `${kind === 'ACCRUAL' ? 'Interest accrual' : 'Payment'} posted${res.data?.entry_number ? ` · ${res.data.entry_number}` : ''}`);
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
    onPosted();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60" onClick={onClose}>
      <div className="bg-surface-950 border-l border-slate-800 w-full max-w-2xl h-full overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">{inst?.loan_name ?? 'Amortization schedule'}</h2>
            {inst && (
              <p className="text-[11px] text-slate-500">
                {formatMoney(inst.principal_cents)} · {Number(inst.interest_rate)}% · {inst.amortization_method === 'INTEREST_ONLY' ? 'interest-only' : 'amortizing'} · {inst.payment_frequency.toLowerCase()}
                {detail?.covenant ? ` · covenant: ${detail.covenant.loan_name}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close"><X size={18} /></button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
        ) : error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-slate-400">No schedule lines.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left py-1.5 pr-2">#</th>
                  <th className="text-left py-1.5 pr-2">Date</th>
                  <th className="text-right py-1.5 pr-2">Payment</th>
                  <th className="text-right py-1.5 pr-2">Interest</th>
                  <th className="text-right py-1.5 pr-2">Principal</th>
                  <th className="text-right py-1.5 pr-2">Balance</th>
                  <th className="text-right py-1.5">Post</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {lines.map((l) => (
                  <tr key={l.period} className="border-b border-slate-900 hover:bg-slate-900/40">
                    <td className="py-1.5 pr-2 text-slate-500">{l.period}</td>
                    <td className="py-1.5 pr-2 text-slate-400 font-sans">{fmtDate(l.period_date)}</td>
                    <td className="py-1.5 pr-2 text-right text-slate-200">{formatMoney(l.payment_cents)}</td>
                    <td className="py-1.5 pr-2 text-right text-amber-300/80">{formatMoney(l.interest_cents)}</td>
                    <td className="py-1.5 pr-2 text-right text-emerald-300/80">{formatMoney(l.principal_cents)}</td>
                    <td className="py-1.5 pr-2 text-right text-slate-300">{formatMoney(l.principal_balance_cents)}</td>
                    <td className="py-1.5 text-right font-sans">
                      <div className="flex items-center justify-end gap-1">
                        {l.accrued ? (
                          <span className="inline-flex items-center gap-0.5 text-emerald-400/70" title="Interest accrued"><CheckCircle2 size={11} /></span>
                        ) : l.interest_cents > 0 ? (
                          <button onClick={() => post(l.period, 'ACCRUAL')} disabled={busy !== null} className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40">
                            {busy === `${l.period}:ACCRUAL` ? <Loader2 size={10} className="animate-spin" /> : 'Accrue'}
                          </button>
                        ) : null}
                        {l.paid ? (
                          <span className="inline-flex items-center gap-0.5 text-emerald-400 text-[10px]" title="Paid"><CheckCircle2 size={11} /> paid</span>
                        ) : (
                          <button onClick={() => post(l.period, 'PAYMENT')} disabled={busy !== null} className="px-1.5 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white disabled:opacity-40">
                            {busy === `${l.period}:PAYMENT` ? <Loader2 size={10} className="animate-spin" /> : 'Pay'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-[11px] text-slate-600">
          Posting requires the loan to have a company/location. Principal-reducing payments also require a notes-payable
          account on the loan. Each period posts at most once (source-ref guarded).
        </p>
      </div>
    </div>
  );
}
