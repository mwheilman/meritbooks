'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Loader2, AlertCircle, Gauge, Sparkles, TrendingDown, AlertTriangle } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';

/** Mirror of lib/jobcost/eac.ts EacResult (the fields the panel renders). */
interface EacResult {
  method: 'COST_TO_COST' | 'COMMITMENTS' | 'PROGRESS';
  contractValueCents: number;
  originalBudgetCents: number;
  budgetCents: number;
  costsToDateCents: number;
  committedOpenCents: number;
  pctCompleteDisplay: number;
  costToCompleteCents: number;
  eacCents: number;
  estimatedFinalMarginCents: number;
  estimatedFinalMarginPct: number | null;
  originalMarginPct: number | null;
  varianceVsBudgetCents: number;
  marginFadeBps: number;
  projectedLoss: boolean;
  marginFade: boolean;
}

interface EacResponse {
  job: { id: string; jobNumber: string; jobName: string };
  method: string;
  eac: EacResult;
}

const METHODS: { value: EacResult['method']; label: string; hint: string }[] = [
  { value: 'COMMITMENTS', label: 'Commitments', hint: 'costs to date + open commitments (default)' },
  { value: 'COST_TO_COST', label: 'Cost-to-cost', hint: 'holds the budget unless actuals exceed it' },
  { value: 'PROGRESS', label: 'Physical %', hint: 'CPI projection from measured %-complete' },
];

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className="rounded-lg bg-slate-800/30 p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p className={clsx('text-base font-mono font-semibold mt-1',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-white')}>
        {value}
      </p>
      {sub && <p className="text-2xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export function JobCostEacPanel({ jobId }: { jobId: string }) {
  const [method, setMethod] = useState<EacResult['method']>('COMMITMENTS');
  const { data, isLoading, error } = useQuery<EacResponse>(`/api/jobs/eac`, { job_id: jobId, method });

  const [explaining, setExplaining] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);

  const explain = useCallback(async () => {
    setExplaining(true);
    setNarrative(null);
    try {
      const res = await fetch(`/api/jobs/eac?job_id=${jobId}&method=${method}&explain=1`);
      const json = await res.json();
      if (!res.ok) { addToast('error', json.error ?? 'Explain failed'); return; }
      setNarrative(json.narrative ?? null);
      setDecisionId(json.decisionId ?? null);
      if (json.decisionId) addToast('success', 'At-risk job logged to Exceptions for review');
    } catch {
      addToast('error', 'Network error');
    } finally {
      setExplaining(false);
    }
  }, [jobId, method]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Gauge size={15} className="text-brand-400" /> Cost-to-Complete / EAC
        </h2>
        <div className="flex items-center gap-1 rounded-lg bg-slate-800/50 p-0.5">
          {METHODS.map((m) => (
            <button key={m.value} onClick={() => setMethod(m.value)} title={m.hint}
              className={clsx('px-2.5 py-1 rounded-md text-2xs font-medium transition-colors',
                method === m.value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200')}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error || !data ? (
        <div className="py-6 text-center text-sm text-red-400"><AlertCircle size={18} className="mx-auto mb-1" />{error ?? 'Unable to compute EAC'}</div>
      ) : (
        <>
          {(data.eac.projectedLoss || data.eac.marginFade) && (
            <div className="flex flex-wrap gap-2 mb-3">
              {data.eac.projectedLoss && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold bg-red-500/15 text-red-300">
                  <TrendingDown size={11} /> Projected loss
                </span>
              )}
              {data.eac.marginFade && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold bg-amber-500/15 text-amber-300">
                  <AlertTriangle size={11} /> Margin fade {(data.eac.marginFadeBps / 100).toFixed(1)} pts
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <Metric label="Estimate at Completion" value={formatMoney(data.eac.eacCents)}
              sub={`${data.eac.pctCompleteDisplay}% complete`}
              tone={data.eac.eacCents > data.eac.budgetCents ? 'warn' : undefined} />
            <Metric label="Cost to Complete" value={formatMoney(data.eac.costToCompleteCents)}
              sub={`${formatMoney(data.eac.costsToDateCents)} spent to date`} />
            <Metric label="Projected Final Margin"
              value={data.eac.estimatedFinalMarginPct != null ? `${data.eac.estimatedFinalMarginPct}%` : '--'}
              sub={formatMoney(data.eac.estimatedFinalMarginCents)}
              tone={data.eac.projectedLoss ? 'bad' : data.eac.marginFade ? 'warn' : 'good'} />
            <Metric label="Variance vs Budget" value={formatMoney(data.eac.varianceVsBudgetCents)}
              sub={data.eac.varianceVsBudgetCents > 0 ? 'projected overrun' : data.eac.varianceVsBudgetCents < 0 ? 'under budget' : 'on budget'}
              tone={data.eac.varianceVsBudgetCents > 0 ? 'bad' : data.eac.varianceVsBudgetCents < 0 ? 'good' : undefined} />
          </div>

          {/* Spend-vs-EAC bar */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-2xs text-slate-500 mb-1">
              <span>Spent {formatMoney(data.eac.costsToDateCents)}{data.eac.committedOpenCents > 0 ? ` + committed ${formatMoney(data.eac.committedOpenCents)}` : ''}</span>
              <span>EAC {formatMoney(data.eac.eacCents)}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-800 overflow-hidden flex">
              <div className="h-full bg-emerald-500" style={{ width: `${pctOf(data.eac.costsToDateCents, data.eac.eacCents)}%` }} />
              <div className="h-full bg-amber-500/70" style={{ width: `${pctOf(data.eac.committedOpenCents, data.eac.eacCents)}%` }} />
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <p className="text-2xs text-slate-500">
              Original margin {data.eac.originalMarginPct != null ? `${data.eac.originalMarginPct}%` : '--'} · figures computed deterministically; AI only phrases them.
            </p>
            <button onClick={explain} disabled={explaining}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-indigo-600/80 text-white hover:bg-indigo-500 disabled:opacity-40">
              {explaining ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Explain{data.eac.projectedLoss || data.eac.marginFade ? ' & flag' : ''}
            </button>
          </div>

          {narrative && (
            <div className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
              <p className="text-sm text-slate-200 leading-relaxed">{narrative}</p>
              {decisionId && (
                <Link href="/exceptions" className="inline-flex items-center gap-1 mt-2 text-2xs text-indigo-300 hover:text-indigo-200">
                  Logged to Exceptions — review →
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}
