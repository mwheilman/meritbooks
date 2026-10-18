'use client';

/**
 * Debt lifecycle actions — Rate reset, Refinance, Pay off. Each is a modal that first
 * shows a deterministic BEFORE/AFTER preview (schedule, balance, and the resulting
 * balanced journal entry) and only writes on an explicit confirm. AI never touches
 * these; the math is the pure engine (lib/debt/reset.ts) surfaced by the API.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X, RefreshCw, ArrowLeftRight, CheckCircle2 } from 'lucide-react';

type Frequency = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
type Method = 'AMORTIZING' | 'INTEREST_ONLY';

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

export interface ActionInstrument {
  id: string;
  loan_name: string;
  principal_cents: number;
  interest_rate: number | string;
  amortization_method: Method;
  payment_frequency: Frequency;
}

interface EntryLine {
  label: string;
  account_number: string | null;
  debit_cents: number;
  credit_cents: number;
}

const inputCls = 'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
const labelCls = 'block text-[10px] text-slate-500 mb-1 uppercase tracking-wide';

/** Outstanding principal = balance after the last paid period, else the full principal. */
function outstandingFromLines(lines: ScheduleLine[], principalCents: number): number {
  let bal = principalCents;
  let lastPaid = 0;
  for (const l of lines) {
    if (l.paid && l.period > lastPaid) {
      lastPaid = l.period;
      bal = l.principal_balance_cents;
    }
  }
  return lastPaid > 0 ? bal : principalCents;
}

function Shell({ title, icon, onClose, children }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">{icon} {title}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EntryTable({ lines }: { lines: EntryLine[] }) {
  const totalDr = lines.reduce((s, l) => s + l.debit_cents, 0);
  const totalCr = lines.reduce((s, l) => s + l.credit_cents, 0);
  return (
    <table className="w-full text-[11px] mt-2">
      <thead>
        <tr className="text-slate-500 border-b border-slate-800">
          <th className="text-left py-1">Account</th>
          <th className="text-right py-1">Debit</th>
          <th className="text-right py-1">Credit</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {lines.map((l, i) => (
          <tr key={i} className="border-b border-slate-900">
            <td className="py-1 font-sans text-slate-300">{l.label}{l.account_number ? <span className="text-slate-600"> · {l.account_number}</span> : ''}</td>
            <td className="py-1 text-right text-emerald-300/80">{l.debit_cents ? formatMoney(l.debit_cents) : ''}</td>
            <td className="py-1 text-right text-red-300/80">{l.credit_cents ? formatMoney(l.credit_cents) : ''}</td>
          </tr>
        ))}
        <tr className="text-slate-400">
          <td className="py-1 font-sans text-right pr-2">Totals</td>
          <td className="py-1 text-right">{formatMoney(totalDr)}</td>
          <td className="py-1 text-right">{formatMoney(totalCr)}</td>
        </tr>
      </tbody>
    </table>
  );
}

// ── Rate reset ──────────────────────────────────────────────────────────────────

interface ResetPreview {
  currentRatePercent: number;
  newRatePercent: number;
  resetAtPeriod: number;
  mode: string;
  outstandingBalanceCents: number;
  previousPaymentCents: number;
  newPaymentCents: number;
  remainingPeriods: number;
  preservedCount: number;
  newLines: { period: number; period_date: string | null; paymentCents: number; interestCents: number; principalCents: number; principalBalanceCents: number }[];
}

export function ResetModal({ inst, onClose, onDone }: { inst: ActionInstrument; onClose: () => void; onDone: () => void }) {
  const [newRate, setNewRate] = useState(String(Number(inst.interest_rate)));
  const [mode, setMode] = useState<'RECALC_PAYMENT' | 'KEEP_PAYMENT'>('RECALC_PAYMENT');
  const [resetDate, setResetDate] = useState('');
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: 'preview' | 'confirm') {
    const rateNum = Number(newRate);
    if (!Number.isFinite(rateNum) || rateNum < 0) { addToast('error', 'Enter a valid new rate'); return; }
    setBusy(true);
    const res = await api.post<{ preview: ResetPreview }>(`/api/debt/${inst.id}/reset`, {
      action, new_rate: rateNum, mode, reset_date: resetDate || null,
    });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    if (action === 'confirm') { addToast('success', 'Rate reset applied — remaining schedule rebuilt'); onDone(); return; }
    setPreview(res.data?.preview ?? null);
  }

  return (
    <Shell title={`Rate reset · ${inst.loan_name}`} icon={<RefreshCw size={16} className="text-indigo-300" />} onClose={onClose}>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>New rate (% / yr)</label>
          <input className={inputCls} type="number" step="0.001" value={newRate} onChange={(e) => { setNewRate(e.target.value); setPreview(null); }} />
        </div>
        <div>
          <label className={labelCls}>Recast</label>
          <select className={inputCls} value={mode} onChange={(e) => { setMode(e.target.value as 'RECALC_PAYMENT' | 'KEEP_PAYMENT'); setPreview(null); }} disabled={inst.amortization_method === 'INTEREST_ONLY'}>
            <option value="RECALC_PAYMENT">Recompute payment</option>
            <option value="KEEP_PAYMENT">Keep payment, adjust term</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Effective date (optional)</label>
          <input className={inputCls} type="date" value={resetDate} onChange={(e) => { setResetDate(e.target.value); setPreview(null); }} />
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        Rebuilds only the remaining schedule from the current outstanding balance at the new rate. Already-posted periods are
        never changed. A reset posts no journal entry — future accruals carry the new interest.
      </p>

      {preview && (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs space-y-2">
          <div className="grid grid-cols-2 gap-2 text-slate-300">
            <div>Rate <span className="font-mono text-white">{preview.currentRatePercent}% → {preview.newRatePercent}%</span></div>
            <div>Reset at period <span className="font-mono text-white">{preview.resetAtPeriod}</span> ({preview.preservedCount} preserved)</div>
            <div>Outstanding <span className="font-mono text-white">{formatMoney(preview.outstandingBalanceCents)}</span></div>
            <div>Payment <span className="font-mono text-white">{formatMoney(preview.previousPaymentCents)} → {formatMoney(preview.newPaymentCents)}</span></div>
            <div>Remaining periods <span className="font-mono text-white">{preview.remainingPeriods}</span></div>
          </div>
          <div className="text-[10px] text-slate-500">First recomputed periods:</div>
          <table className="w-full text-[11px] font-mono">
            <tbody>
              {preview.newLines.slice(0, 4).map((l) => (
                <tr key={l.period} className="border-b border-slate-900">
                  <td className="py-0.5 text-slate-500">#{l.period}</td>
                  <td className="py-0.5 text-right text-slate-200">{formatMoney(l.paymentCents)}</td>
                  <td className="py-0.5 text-right text-amber-300/80">{formatMoney(l.interestCents)} int</td>
                  <td className="py-0.5 text-right text-emerald-300/80">{formatMoney(l.principalCents)} prin</td>
                  <td className="py-0.5 text-right text-slate-300">{formatMoney(l.principalBalanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
        {!preview ? (
          <button onClick={() => run('preview')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Preview
          </button>
        ) : (
          <button onClick={() => run('confirm')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Apply reset
          </button>
        )}
      </div>
    </Shell>
  );
}

// ── Refinance ─────────────────────────────────────────────────────────────────

interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isBankAccount?: boolean }
interface LocationOption { id: string; name: string }

interface RefiPreview {
  oldBalanceCents: number;
  newPrincipalCents: number;
  cashDebitCents: number;
  cashCreditCents: number;
  entryLines: EntryLine[];
  newSchedule: { periods: number; regularPaymentCents: number; totalInterestCents: number };
}

export function RefinanceModal({ inst, lines, onClose, onDone }: { inst: ActionInstrument; lines: ScheduleLine[]; onClose: () => void; onDone: () => void }) {
  const outstanding = useMemo(() => outstandingFromLines(lines, inst.principal_cents), [lines, inst.principal_cents]);

  const [loanName, setLoanName] = useState(`${inst.loan_name} (refinanced)`);
  const [principal, setPrincipal] = useState(String(outstanding / 100));
  const [rate, setRate] = useState(String(Number(inst.interest_rate)));
  const [method, setMethod] = useState<Method>(inst.amortization_method);
  const [frequency, setFrequency] = useState<Frequency>(inst.payment_frequency);
  const [term, setTerm] = useState('');
  const [origination, setOrigination] = useState('');
  const [liabilityAcct, setLiabilityAcct] = useState('');
  const [cashAcct, setCashAcct] = useState('');
  const [locationId, setLocationId] = useState('');
  const [preview, setPreview] = useState<RefiPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: acctData } = useQuery<{ data: AccountOption[] }>('/api/accounts');
  const accounts = acctData?.data ?? [];
  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const liabilityAccts = useMemo(() => accounts.filter((a) => a.accountType === 'LIABILITY'), [accounts]);
  const cashAccts = useMemo(() => accounts.filter((a) => a.isBankAccount || a.accountType === 'ASSET'), [accounts]);

  function buildNewLoan() {
    const principalNum = Number(principal);
    const rateNum = Number(rate);
    const termNum = term ? Number(term) : null;
    return {
      loan_name: loanName.trim(),
      principal_cents: dollarsToCents(principalNum),
      interest_rate: rateNum,
      rate_type: 'FIXED' as const,
      amortization_method: method,
      payment_frequency: frequency,
      compounding: frequency,
      term_periods: termNum,
      origination_date: origination || null,
      status: 'ACTIVE' as const,
      liability_account_id: liabilityAcct || null,
      cash_account_id: cashAcct || null,
      location_id: locationId || null,
    };
  }

  async function run(action: 'preview' | 'confirm') {
    if (!loanName.trim()) { addToast('error', 'New loan name is required'); return; }
    if (!(Number(principal) > 0)) { addToast('error', 'Enter the refinanced principal'); return; }
    if (!(Number(rate) >= 0)) { addToast('error', 'Enter a valid rate'); return; }
    if (method === 'INTEREST_ONLY' && !term) { addToast('error', 'Interest-only needs a term'); return; }
    if (!term && method === 'AMORTIZING') { addToast('error', 'Enter a term (number of periods)'); return; }
    setBusy(true);
    const res = await api.post<{ preview?: RefiPreview; result?: { new_instrument_id: string } }>(`/api/debt/${inst.id}/refinance`, {
      action, new_loan: buildNewLoan(),
    });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    if (action === 'confirm') { addToast('success', 'Refinanced — old loan closed, new loan booked, rollover posted'); onDone(); return; }
    setPreview(res.data?.preview ?? null);
  }

  return (
    <Shell title={`Refinance · ${inst.loan_name}`} icon={<ArrowLeftRight size={16} className="text-amber-300" />} onClose={onClose}>
      <p className="text-[11px] text-slate-500 mb-3">
        Current outstanding balance <span className="font-mono text-white">{formatMoney(outstanding)}</span>. Borrowing more books cash-out
        proceeds; borrowing less pays cash at close. The old loan is closed and the debt rolls into the new note.
      </p>
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-6">
          <label className={labelCls}>New loan name</label>
          <input className={inputCls} value={loanName} onChange={(e) => { setLoanName(e.target.value); setPreview(null); }} />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Principal ($)</label>
          <input className={inputCls} type="number" step="0.01" value={principal} onChange={(e) => { setPrincipal(e.target.value); setPreview(null); }} />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Rate (% / yr)</label>
          <input className={inputCls} type="number" step="0.001" value={rate} onChange={(e) => { setRate(e.target.value); setPreview(null); }} />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Method</label>
          <select className={inputCls} value={method} onChange={(e) => { setMethod(e.target.value as Method); setPreview(null); }}>
            <option value="AMORTIZING">Amortizing</option>
            <option value="INTEREST_ONLY">Interest-only</option>
          </select>
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Frequency</label>
          <select className={inputCls} value={frequency} onChange={(e) => { setFrequency(e.target.value as Frequency); setPreview(null); }}>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="SEMIANNUAL">Semiannual</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Term (# periods)</label>
          <input className={inputCls} type="number" step="1" value={term} onChange={(e) => { setTerm(e.target.value); setPreview(null); }} placeholder="60" />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Origination</label>
          <input className={inputCls} type="date" value={origination} onChange={(e) => { setOrigination(e.target.value); setPreview(null); }} />
        </div>
        <div className="col-span-6">
          <label className={labelCls}>New notes-payable account</label>
          <select className={inputCls} value={liabilityAcct} onChange={(e) => { setLiabilityAcct(e.target.value); setPreview(null); }}>
            <option value="">Select (required to post rollover)</option>
            {liabilityAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
          </select>
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Cash account</label>
          <select className={inputCls} value={cashAcct} onChange={(e) => { setCashAcct(e.target.value); setPreview(null); }}>
            <option value="">Auto (operating bank)</option>
            {cashAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
          </select>
        </div>
        <div className="col-span-3">
          <label className={labelCls}>Company / location</label>
          <select className={inputCls} value={locationId} onChange={(e) => { setLocationId(e.target.value); setPreview(null); }}>
            <option value="">Same as old loan</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      </div>

      {preview && (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="flex items-center gap-4 text-slate-300">
            <span>Old balance <span className="font-mono text-white">{formatMoney(preview.oldBalanceCents)}</span></span>
            <span>New principal <span className="font-mono text-white">{formatMoney(preview.newPrincipalCents)}</span></span>
            {preview.cashDebitCents > 0 && <span className="text-emerald-300">Cash-out {formatMoney(preview.cashDebitCents)}</span>}
            {preview.cashCreditCents > 0 && <span className="text-red-300">Cash paid {formatMoney(preview.cashCreditCents)}</span>}
          </div>
          <EntryTable lines={preview.entryLines} />
          <div className="text-[11px] text-slate-500 mt-2">
            New schedule: {preview.newSchedule.periods} periods · payment {formatMoney(preview.newSchedule.regularPaymentCents)} · total interest {formatMoney(preview.newSchedule.totalInterestCents)}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
        {!preview ? (
          <button onClick={() => run('preview')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Preview rollover
          </button>
        ) : (
          <button onClick={() => run('confirm')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Confirm refinance
          </button>
        )}
      </div>
    </Shell>
  );
}

// ── Pay off ─────────────────────────────────────────────────────────────────────

interface PayoffPreview {
  remainingPrincipalCents: number;
  accruedPayableCents: number;
  additionalInterestCents: number;
  totalCashCents: number;
  entryLines: EntryLine[];
}

export function PayoffModal({ inst, onClose, onDone }: { inst: ActionInstrument; onClose: () => void; onDone: () => void }) {
  const [payoffDate, setPayoffDate] = useState('');
  const [addlInterest, setAddlInterest] = useState('');
  const [preview, setPreview] = useState<PayoffPreview | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: 'preview' | 'confirm') {
    const addl = addlInterest ? dollarsToCents(Number(addlInterest)) : 0;
    setBusy(true);
    const res = await api.post<{ preview: PayoffPreview }>(`/api/debt/${inst.id}/payoff`, {
      action, payoff_date: payoffDate || null, additional_interest_cents: addl,
    });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    if (action === 'confirm') { addToast('success', 'Loan paid off — settlement posted, marked PAID_OFF'); onDone(); return; }
    setPreview(res.data?.preview ?? null);
  }

  return (
    <Shell title={`Pay off · ${inst.loan_name}`} icon={<CheckCircle2 size={16} className="text-emerald-300" />} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Payoff date (optional)</label>
          <input className={inputCls} type="date" value={payoffDate} onChange={(e) => { setPayoffDate(e.target.value); setPreview(null); }} />
        </div>
        <div>
          <label className={labelCls}>Per-diem / extra interest ($, optional)</label>
          <input className={inputCls} type="number" step="0.01" value={addlInterest} onChange={(e) => { setAddlInterest(e.target.value); setPreview(null); }} placeholder="0.00" />
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        Settles the remaining principal plus any accrued (unpaid) interest and per-diem, all against cash, then marks the loan
        paid off and zeroes the schedule forward. Posted by account role, guarded against a double post.
      </p>

      {preview && (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="flex items-center gap-4 text-slate-300">
            <span>Principal <span className="font-mono text-white">{formatMoney(preview.remainingPrincipalCents)}</span></span>
            {preview.accruedPayableCents > 0 && <span>Accrued <span className="font-mono text-white">{formatMoney(preview.accruedPayableCents)}</span></span>}
            {preview.additionalInterestCents > 0 && <span>Per-diem <span className="font-mono text-white">{formatMoney(preview.additionalInterestCents)}</span></span>}
            <span className="ml-auto">Cash out <span className="font-mono text-white">{formatMoney(preview.totalCashCents)}</span></span>
          </div>
          <EntryTable lines={preview.entryLines} />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
        {!preview ? (
          <button onClick={() => run('preview')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Preview settlement
          </button>
        ) : (
          <button onClick={() => run('confirm')} disabled={busy} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Confirm payoff
          </button>
        )}
      </div>
    </Shell>
  );
}
