'use client';

import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  Loader2, Landmark, CalendarClock, Layers, ShieldCheck, ShieldAlert, ShieldX,
  ArrowRight, TrendingDown,
} from 'lucide-react';
import { clsx } from 'clsx';

interface NextPayment {
  instrumentId: string; loanName: string; lender: string | null;
  period: number; dueDate: string | null; paymentCents: number;
}
interface CovenantRollup {
  total: number; breach: number; warn: number; pass: number; unknown: number;
  worstHeadroom: { loanName: string; covenantType: string; headroomPct: number | null; band: string } | null;
}
interface DebtSummaryResponse {
  data: {
    loanCount: number;
    loansWithSchedule: number;
    totalOutstandingCents: number;
    currentPortionCents: number;
    nonCurrentPortionCents: number;
    nextPayment: NextPayment | null;
    debtService12Mo: { totalCents: number; interestCents: number; principalCents: number };
    covenants: CovenantRollup;
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * At-a-glance debt posture above the register: outstanding split current vs
 * non-current, the next payment due, total debt service coming due in 12 months,
 * and a covenant-headroom chip that deep-links to the Covenant Monitor tab (the
 * monitor is not rebuilt here — this only summarizes + links).
 */
export function DebtSummary({ onViewCovenants }: { onViewCovenants?: () => void }) {
  const { data, isLoading, error } = useQuery<DebtSummaryResponse>('/api/debt/summary');

  if (isLoading) {
    return <div className="card p-6 flex items-center justify-center h-[128px]"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>;
  }
  // Degrade quietly — the register below still renders; don't block it on a summary error.
  if (error || !data) return null;

  const s = data.data;
  if (s.loanCount === 0) return null;

  const currentPct = s.totalOutstandingCents > 0
    ? Math.round((s.currentPortionCents / s.totalOutstandingCents) * 100)
    : 0;

  const cov = s.covenants;
  const worst = cov.worstHeadroom;
  const covBand = cov.breach > 0 ? 'BREACH' : cov.warn > 0 ? 'WARN' : cov.pass > 0 ? 'PASS' : 'UNKNOWN';
  const CovIcon = covBand === 'BREACH' ? ShieldX : covBand === 'WARN' ? ShieldAlert : ShieldCheck;
  const covCls = covBand === 'BREACH' ? 'text-red-400 bg-red-500/10 border-red-500/20'
    : covBand === 'WARN' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    : covBand === 'PASS' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : 'text-slate-400 bg-slate-700/30 border-slate-700';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {/* Outstanding + current/non-current split */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <Layers size={14} className="text-slate-400" />
          <span className="text-xs text-slate-500 uppercase tracking-wider">Total Outstanding</span>
        </div>
        <p className="text-2xl font-mono font-semibold text-white">{formatMoney(s.totalOutstandingCents, { compact: true })}</p>
        <div className="mt-2 h-1.5 w-full rounded-full bg-slate-700 overflow-hidden flex">
          <div className="h-full bg-amber-500" style={{ width: `${currentPct}%` }} title="Current portion (≤12mo)" />
          <div className="h-full bg-emerald-500/70" style={{ width: `${100 - currentPct}%` }} title="Non-current" />
        </div>
        <div className="flex items-center justify-between text-[10px] font-mono mt-1.5">
          <span className="text-amber-400">Current {formatMoney(s.currentPortionCents, { compact: true })}</span>
          <span className="text-emerald-400/80">Non-current {formatMoney(s.nonCurrentPortionCents, { compact: true })}</span>
        </div>
      </div>

      {/* Next payment */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <CalendarClock size={14} className="text-slate-400" />
          <span className="text-xs text-slate-500 uppercase tracking-wider">Next Payment</span>
        </div>
        {s.nextPayment ? (
          <>
            <p className="text-2xl font-mono font-semibold text-white">{formatMoney(s.nextPayment.paymentCents, { compact: true })}</p>
            <p className="text-[11px] text-slate-500 mt-1 truncate">{s.nextPayment.loanName}</p>
            <p className="text-[10px] text-slate-600 font-mono">{fmtDate(s.nextPayment.dueDate)}</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-mono font-semibold text-slate-500">—</p>
            <p className="text-[11px] text-slate-600 mt-1">No upcoming scheduled payment</p>
          </>
        )}
      </div>

      {/* 12-month debt service */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <TrendingDown size={14} className="text-slate-400" />
          <span className="text-xs text-slate-500 uppercase tracking-wider">Debt Service · 12mo</span>
        </div>
        <p className="text-2xl font-mono font-semibold text-white">{formatMoney(s.debtService12Mo.totalCents, { compact: true })}</p>
        <p className="text-[10px] text-slate-600 font-mono mt-1">
          Interest {formatMoney(s.debtService12Mo.interestCents, { compact: true })} · Principal {formatMoney(s.debtService12Mo.principalCents, { compact: true })}
        </p>
      </div>

      {/* Covenant headroom (links to monitor) */}
      <button
        onClick={onViewCovenants}
        disabled={!onViewCovenants}
        className={clsx('card p-4 text-left transition-colors', onViewCovenants && 'hover:border-slate-700 cursor-pointer')}
      >
        <div className="flex items-center gap-2 mb-1">
          <Landmark size={14} className="text-slate-400" />
          <span className="text-xs text-slate-500 uppercase tracking-wider">Covenant Headroom</span>
        </div>
        {cov.total === 0 ? (
          <>
            <p className="text-sm text-slate-400 mt-1">No covenants tracked</p>
            {onViewCovenants && <p className="text-[11px] text-indigo-300 mt-1 flex items-center gap-1">Open monitor <ArrowRight size={11} /></p>}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium', covCls)}>
                <CovIcon size={11} /> {covBand === 'UNKNOWN' ? 'Not computable' : covBand.toLowerCase()}
              </span>
            </div>
            {worst && worst.headroomPct !== null ? (
              <p className="text-[11px] text-slate-500 mt-1.5 truncate">
                Tightest: <span className="font-mono text-slate-300">{(worst.headroomPct * 100).toFixed(0)}%</span> · {worst.loanName}
              </p>
            ) : (
              <p className="text-[11px] text-slate-600 mt-1.5">{cov.total} covenant{cov.total === 1 ? '' : 's'} tracked</p>
            )}
            {onViewCovenants && <p className="text-[11px] text-indigo-300 mt-1 flex items-center gap-1">Open monitor <ArrowRight size={11} /></p>}
          </>
        )}
      </button>
    </div>
  );
}
