'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, Plus, Sparkles, PlayCircle, CalendarClock, Ban, Wallet, CheckCircle2,
} from 'lucide-react';
import { PrepaidSetup, type PrepaidPrefill } from './prepaid-setup';
import { PrepaidParseReview } from './prepaid-parse-review';

type Status = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

interface PrepaidSchedule {
  id: string;
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
  memo: string | null;
  source_type: string | null;
}

interface PrepaidResponse {
  data: PrepaidSchedule[];
  summary: { total: number; active: number; completed: number; remaining_cents: number };
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

export function PrepaidsDashboard() {
  const [setup, setSetup] = useState<PrepaidPrefill | null | 'new'>(null);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState('0');

  const { data, isLoading, error, refetch } = useQuery<PrepaidResponse>('/api/prepaid', undefined, { key: refreshKey });
  const schedules = data?.data ?? [];
  const summary = data?.summary;

  const bump = () => { setRefreshKey((k) => String(Number(k) + 1)); refetch(); };

  async function runAll() {
    setRunning(true);
    const res = await api.post<{ result: { periods_posted: number; amount_posted_cents: number; completed: number; errors: unknown[] } }>('/api/prepaid/run', {});
    setRunning(false);
    if (res.error) { addToast('error', res.error.error); return; }
    const r = res.data?.result;
    if (!r || r.periods_posted === 0) addToast('info', 'No prepaid amortizations were due.');
    else addToast('success', `Posted ${r.periods_posted} amortization${r.periods_posted === 1 ? '' : 's'} · ${formatMoney(r.amount_posted_cents)}`);
    bump();
  }

  async function recordOne(s: PrepaidSchedule) {
    setRowBusy(s.id);
    const res = await api.post<{ result: { periods_posted: number; amount_posted_cents: number } }>('/api/prepaid/run', { schedule_id: s.id });
    setRowBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    const r = res.data?.result;
    if (!r || r.periods_posted === 0) addToast('info', 'Nothing due yet for this schedule.');
    else addToast('success', `Posted ${formatMoney(r.amount_posted_cents)} amortization`);
    bump();
  }

  async function cancel(s: PrepaidSchedule) {
    if (!confirm('Cancel this prepaid schedule? Future amortization stops; posted periods are untouched.')) return;
    setRowBusy(s.id);
    const res = await api.delete(`/api/prepaid/${s.id}`);
    setRowBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Schedule cancelled');
    bump();
  }

  const dueCount = schedules.filter((s) => s.status === 'ACTIVE' && s.next_period).length;

  const Controls = (
    <div className="flex items-center gap-2">
      <button
        onClick={runAll}
        disabled={running || dueCount === 0}
        className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-40 flex items-center gap-1.5"
        title={dueCount === 0 ? 'No amortizations due' : `${dueCount} schedule(s) with a due period`}
      >
        {running ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
        Run due amortizations
      </button>
      <button
        onClick={() => setUploading(true)}
        className="px-3 py-1.5 text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1.5"
      >
        <Sparkles size={13} /> Upload prepaid invoice
      </button>
      <button
        onClick={() => setSetup('new')}
        className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5"
      >
        <Plus size={13} /> Set up prepaid
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          {summary && (
            <>
              <span className="text-slate-500">{summary.active} active · {summary.completed} completed</span>
              <span className="text-slate-300">Prepaid on balance sheet: <span className="font-mono text-white">{formatMoney(summary.remaining_cents)}</span></span>
            </>
          )}
        </div>
        {Controls}
      </div>

      {schedules.length === 0 ? (
        <div className="card p-12 text-center">
          <Wallet className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">No prepaid schedules yet</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Spread a cost you&rsquo;ve paid up front — insurance, a subscription, a retainer — across the periods it benefits.
            Drop the invoice for AI to read it, or set one up manually. MeritBooks posts DR expense / CR prepaid asset each month.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setUploading(true)} className="px-4 py-2 text-sm font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg inline-flex items-center gap-1.5">
              <Sparkles size={14} /> Upload prepaid invoice
            </button>
            <button onClick={() => setSetup('new')} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5">
              <Plus size={14} /> Set up manually
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {schedules.map((s) => {
            const pct = s.total_cents > 0 ? Math.min(100, Math.round((s.posted_cents / s.total_cents) * 100)) : 0;
            return (
              <div key={s.id} className="card p-4 border border-slate-800">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{s.memo || 'Prepaid expense'}</p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {s.expense_account_name ?? 'expense'} ← {s.prepaid_account_name ?? 'prepaid asset'} · {s.months} mo
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
                    <span className="text-slate-300">
                      Next: {formatMoney(s.next_amount_cents ?? 0)} for {fmtPeriod(s.next_period)}
                    </span>
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
        Amortization posts a balanced journal entry each period — DR the expense account, CR the prepaid-expenses asset,
        dated month-end — through the deterministic posting engine. Each period is recorded once (the schedule&rsquo;s run
        ledger guards against a double post), and &ldquo;Run due amortizations&rdquo; catches up every period that has come due.
      </p>

      {uploading && (
        <PrepaidParseReview
          onClose={() => setUploading(false)}
          onProposed={(prefill) => { setUploading(false); setSetup(prefill); }}
        />
      )}

      {setup && (
        <PrepaidSetup
          prefill={setup === 'new' ? { origin: 'manual' } : setup}
          onClose={() => setSetup(null)}
          onSaved={() => { setSetup(null); bump(); }}
        />
      )}
    </div>
  );
}
