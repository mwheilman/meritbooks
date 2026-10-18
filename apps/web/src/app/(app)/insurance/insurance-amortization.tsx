'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, PlayCircle, CalendarClock, Ban, CheckCircle2, ShieldCheck, X,
} from 'lucide-react';

type Status = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

interface Schedule {
  id: string;
  policy_id: string;
  status: Status;
  total_cents: number;
  months: number;
  start_date: string;
  amount_per_period_cents: number;
  periods_posted: number;
  remaining_cents: number;
  posted_cents: number;
  next_period: string | null;
  next_amount_cents: number | null;
  next_post_date: string | null;
  expense_account_name: string | null;
  prepaid_account_name: string | null;
  policy_carrier: string | null;
  policy_number: string | null;
  coverage_type: string | null;
  memo: string | null;
}

interface SchedulesResponse {
  data: Schedule[];
  summary: { total: number; active: number; completed: number; remaining_cents: number };
}

/** Prefill passed from a policy row's "Amortize" action. */
export interface AmortizeSetupPrefill {
  policy_id: string;
  carrier: string | null;
  coverage_type: string | null;
  premium_cents: number | null;
  effective_date: string | null;
  expiration_date: string | null;
}

const STATUS_STYLE: Record<Status, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  COMPLETED: 'bg-slate-700/40 text-slate-400 border-slate-700',
  CANCELLED: 'bg-red-500/10 text-red-400 border-red-500/20',
};

function fmtPeriod(period: string | null): string {
  if (!period) return '—';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Whole-month span inclusive between two ISO dates (partial months count). >= 1. */
function monthSpan(startIso: string, endIso: string): number {
  const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startIso);
  const e = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endIso);
  if (!s || !e) return 12;
  const months = (Number(e[1]) - Number(s[1])) * 12 + (Number(e[2]) - Number(s[2]));
  return Math.max(1, months + 1);
}

export function InsuranceAmortization({
  pendingSetup,
  onCloseSetup,
}: {
  pendingSetup: AmortizeSetupPrefill | null;
  onCloseSetup: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState('0');

  const { data, isLoading, error, refetch } = useQuery<SchedulesResponse>('/api/insurance/schedules', undefined, { key: refreshKey });
  const schedules = data?.data ?? [];
  const summary = data?.summary;

  const bump = () => { setRefreshKey((k) => String(Number(k) + 1)); refetch(); };

  async function runAll() {
    setRunning(true);
    const res = await api.post<{ result: { periods_posted: number; amount_posted_cents: number; errors: unknown[] } }>('/api/insurance/schedules/run', {});
    setRunning(false);
    if (res.error) { addToast('error', res.error.error); return; }
    const r = res.data?.result;
    if (!r || r.periods_posted === 0) addToast('info', 'No insurance amortizations were due.');
    else addToast('success', `Posted ${r.periods_posted} amortization${r.periods_posted === 1 ? '' : 's'} · ${formatMoney(r.amount_posted_cents)}`);
    bump();
  }

  async function recordOne(s: Schedule) {
    setRowBusy(s.id);
    const res = await api.post<{ result: { periods_posted: number; amount_posted_cents: number } }>('/api/insurance/schedules/run', { schedule_id: s.id });
    setRowBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    const r = res.data?.result;
    if (!r || r.periods_posted === 0) addToast('info', 'Nothing due yet for this schedule.');
    else addToast('success', `Posted ${formatMoney(r.amount_posted_cents)} amortization`);
    bump();
  }

  async function cancel(s: Schedule) {
    if (!confirm('Cancel this amortization schedule? Future amortization stops; posted periods are untouched.')) return;
    setRowBusy(s.id);
    const res = await api.delete(`/api/insurance/schedules/${s.id}`);
    setRowBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Schedule cancelled');
    bump();
  }

  const dueCount = schedules.filter((s) => s.status === 'ACTIVE' && s.next_period).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldCheck size={15} className="text-indigo-400" />
          <h3 className="text-sm font-semibold text-white">Premium amortization</h3>
          {summary && summary.total > 0 && (
            <span className="text-[11px] text-slate-500">
              {summary.active} active · {summary.completed} completed · prepaid on BS{' '}
              <span className="font-mono text-slate-300">{formatMoney(summary.remaining_cents)}</span>
            </span>
          )}
        </div>
        {schedules.length > 0 && (
          <button
            onClick={runAll}
            disabled={running || dueCount === 0}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-40 flex items-center gap-1.5"
            title={dueCount === 0 ? 'No amortizations due' : `${dueCount} schedule(s) with a due period`}
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
            Run due amortizations
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="card p-6 text-center">
          <AlertCircle className="w-6 h-6 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : schedules.length === 0 ? (
        <div className="card p-8 text-center border border-slate-800">
          <p className="text-sm text-slate-300 mb-1">No premiums being amortized yet</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            An up-front premium is really a prepaid ASSET consumed over the coverage term. Use
            <span className="text-indigo-300"> Amortize</span> on any active policy above to spread it
            straight-line — MeritBooks posts DR insurance expense / CR prepaid insurance each month.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {schedules.map((s) => {
            const pct = s.total_cents > 0 ? Math.min(100, Math.round((s.posted_cents / s.total_cents) * 100)) : 0;
            const title = s.memo || [s.policy_carrier, s.coverage_type].filter(Boolean).join(' · ') || 'Insurance premium';
            return (
              <div key={s.id} className="card p-4 border border-slate-800">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{title}</p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {s.expense_account_name ?? 'insurance expense'} ← {s.prepaid_account_name ?? 'prepaid insurance'} · {s.months} mo
                    </p>
                  </div>
                  <span className={clsx('shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium', STATUS_STYLE[s.status])}>
                    {s.status === 'COMPLETED' && <CheckCircle2 size={12} />}
                    {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                  </span>
                </div>

                <div className="flex items-end justify-between mb-1">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Remaining prepaid</p>
                    <p className="text-2xl font-mono font-semibold text-white mt-0.5">{formatMoney(s.remaining_cents)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Amortized</p>
                    <p className="text-sm font-mono text-slate-300">{s.periods_posted}/{s.months} · {formatMoney(s.posted_cents)}</p>
                  </div>
                </div>
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full rounded bg-emerald-500" style={{ width: `${Math.max(2, pct)}%` }} />
                </div>

                <div className="mt-3 flex items-center gap-1.5 text-[11px]">
                  <CalendarClock size={12} className={s.next_period ? 'text-emerald-400' : 'text-slate-600'} />
                  {s.status === 'ACTIVE' && s.next_period ? (
                    <span className="text-slate-300">Next: {formatMoney(s.next_amount_cents ?? 0)} for {fmtPeriod(s.next_period)}</span>
                  ) : s.status === 'COMPLETED' ? (
                    <span className="text-slate-500">Fully amortized</span>
                  ) : s.status === 'CANCELLED' ? (
                    <span className="text-slate-500">Cancelled — no further amortization</span>
                  ) : (
                    <span className="text-slate-500">No period due yet</span>
                  )}
                </div>

                {s.status === 'ACTIVE' && (
                  <div className="mt-3 flex items-center gap-1.5">
                    <button
                      onClick={() => recordOne(s)}
                      disabled={rowBusy === s.id || !s.next_period}
                      className="px-2.5 py-1 text-[11px] font-medium bg-emerald-600/90 hover:bg-emerald-500 text-white rounded-md flex items-center gap-1 disabled:opacity-40"
                    >
                      {rowBusy === s.id ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={11} />}
                      Record this period
                    </button>
                    <button
                      onClick={() => cancel(s)}
                      disabled={rowBusy === s.id}
                      className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-400 rounded-md hover:bg-slate-800 flex items-center gap-1 disabled:opacity-40"
                    >
                      <Ban size={11} /> Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-600 leading-relaxed">
        Amortization posts a balanced journal entry each period — DR the insurance expense account,
        CR prepaid insurance, dated month-end — through the deterministic posting engine (no AI). Each
        period is recorded once (the schedule&rsquo;s run ledger guards against a double post), and
        &ldquo;Run due amortizations&rdquo; catches up every period that has come due.
      </p>

      {pendingSetup && (
        <AmortizeSetup
          prefill={pendingSetup}
          onClose={onCloseSetup}
          onSaved={() => { onCloseSetup(); bump(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup modal
// ---------------------------------------------------------------------------

function AmortizeSetup({
  prefill,
  onClose,
  onSaved,
}: {
  prefill: AmortizeSetupPrefill;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = prefill.effective_date ?? today;
  const defaultMonths =
    prefill.effective_date && prefill.expiration_date ? monthSpan(prefill.effective_date, prefill.expiration_date) : 12;

  const [amount, setAmount] = useState<string>(prefill.premium_cents != null ? String(centsToDollars(prefill.premium_cents)) : '');
  const [startDate, setStartDate] = useState<string>(defaultStart);
  const [months, setMonths] = useState<string>(String(defaultMonths));
  const [memo, setMemo] = useState<string>(
    [prefill.carrier, prefill.coverage_type].filter(Boolean).join(' ') + (prefill.carrier || prefill.coverage_type ? ' premium' : 'Insurance premium'),
  );
  const [saving, setSaving] = useState(false);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalCents = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? dollarsToCents(n) : 0;
  })();
  const monthsNum = Math.max(0, Math.trunc(Number(months) || 0));
  const perPeriod = totalCents > 0 && monthsNum > 0 ? Math.floor(totalCents / monthsNum) : 0;
  const valid = totalCents > 0 && monthsNum >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  async function save() {
    if (!valid) return;
    setSaving(true);
    const res = await api.post<{ id: string }>('/api/insurance/schedules', {
      policy_id: prefill.policy_id,
      total_cents: totalCents,
      start_date: startDate,
      months: monthsNum,
      memo: memo.trim() || null,
    });
    setSaving(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Amortization schedule created');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-5 border border-slate-700" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Amortize premium</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={16} /></button>
        </div>

        <p className="text-[11px] text-slate-500 mb-4">
          Carry {prefill.carrier ? <span className="text-slate-300">{prefill.carrier}&rsquo;s </span> : ''}premium as prepaid
          insurance and amortize it straight-line to insurance expense over the coverage term.
        </p>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] text-slate-400">Premium to amortize</span>
            <div className="mt-1 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="w-full pl-6 pr-3 py-2 bg-slate-950/60 border border-slate-700 rounded-lg text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
                placeholder="0.00"
              />
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-slate-400">Start date</span>
              <input
                type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-slate-950/60 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">Term (months)</span>
              <input
                type="number" min="1" max="600" value={months} onChange={(e) => setMonths(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-slate-950/60 border border-slate-700 rounded-lg text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] text-slate-400">Memo</span>
            <input
              type="text" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500}
              className="mt-1 w-full px-3 py-2 bg-slate-950/60 border border-slate-700 rounded-lg text-sm text-white focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <div className="rounded-lg bg-slate-950/50 border border-slate-800 px-3 py-2 text-[11px] text-slate-400">
            Posts <span className="text-emerald-400">DR Insurance Expense</span> /{' '}
            <span className="text-red-400">CR Prepaid Insurance</span> each period
            {perPeriod > 0 && <> · about <span className="font-mono text-slate-200">{formatMoney(perPeriod)}</span>/mo</>}.
            Accounts resolve by role (coverage-type aware) — remap on the Account Roles screen.
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg">Cancel</button>
          <button
            onClick={save}
            disabled={!valid || saving}
            className="px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-40 flex items-center gap-1.5"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            Create schedule
          </button>
        </div>
      </div>
    </div>
  );
}
