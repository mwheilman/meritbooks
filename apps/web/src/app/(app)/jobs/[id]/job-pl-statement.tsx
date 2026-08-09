'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import {
  Loader2, AlertCircle, FileBarChart, TrendingDown, AlertTriangle, CircleCheck, CircleAlert,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

/** Mirror of the JobPLResult fields this statement renders (lib/jobs/job-pl.ts). */
interface JobPLCategory {
  key: string;
  label: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  pctUsed: number | null;
  overBudget: boolean;
}

interface JobPL {
  jobNumber: string;
  jobName: string;
  contractValueCents: number;
  originalContractCents: number;
  approvedCoCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  revenueRecognizedCents: number;
  retainageHeldCents: number;
  overBillingCents: number;
  underBillingCents: number;
  netBillingPositionCents: number;
  wipStatus: 'OVERBILLED' | 'UNDERBILLED' | 'ON_TARGET';
  categories: JobPLCategory[];
  estimatedCostCents: number;
  costsToDateCents: number;
  committedOpenCents: number;
  eacCents: number;
  costToCompleteCents: number;
  costPctCompleteDisplay: number;
  pctCompleteDisplay: number;
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';
  grossProfitToDateCents: number;
  grossMarginToDatePct: number | null;
  estimatedGrossProfitCents: number;
  projectedFinalMarginCents: number;
  projectedFinalMarginPct: number | null;
  originalMarginCents: number;
  originalMarginPct: number | null;
  marginFadeBps: number;
  varianceVsBudgetCents: number;
  projectedLoss: boolean;
  marginFade: boolean;
  overBudget: boolean;
  glPostedCostsCents: number;
  glCostTieDeltaCents: number;
  glCostTied: boolean;
}

interface PLResponse {
  method: string;
  pl: JobPL;
}

const METHODS: { value: 'COMMITMENTS' | 'COST_TO_COST' | 'PROGRESS'; label: string; hint: string }[] = [
  { value: 'COMMITMENTS', label: 'Commitments', hint: 'costs to date + open commitments (default)' },
  { value: 'COST_TO_COST', label: 'Cost-to-cost', hint: 'holds the budget unless actuals exceed it' },
  { value: 'PROGRESS', label: 'Physical %', hint: 'CPI projection from measured %-complete' },
];

/** A right-aligned money row in the statement. */
function Row({
  label, value, sub, tone, strong, indent,
}: {
  label: string; value: string; sub?: string;
  tone?: 'good' | 'bad' | 'warn' | 'muted'; strong?: boolean; indent?: boolean;
}) {
  return (
    <div className={clsx('flex items-baseline justify-between py-1.5', indent && 'pl-4')}>
      <span className={clsx('text-sm', strong ? 'text-white font-medium' : 'text-slate-400')}>
        {label}
        {sub && <span className="text-2xs text-slate-600 ml-2">{sub}</span>}
      </span>
      <span className={clsx('text-sm font-mono tabular-nums',
        strong && 'font-semibold',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400'
          : tone === 'warn' ? 'text-amber-400' : tone === 'muted' ? 'text-slate-500'
          : strong ? 'text-white' : 'text-slate-300')}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold pt-3 pb-1 border-b border-slate-800">{children}</p>;
}

export function JobPLStatement({ jobId }: { jobId: string }) {
  const [method, setMethod] = useState<'COMMITMENTS' | 'COST_TO_COST' | 'PROGRESS'>('COMMITMENTS');
  const { data, isLoading, error } = useQuery<PLResponse>('/api/jobs/pl', { job_id: jobId, method });

  const p = data?.pl;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <FileBarChart size={15} className="text-brand-400" /> Job P&amp;L Statement
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
      <p className="text-2xs text-slate-600 mb-2">
        Percentage-of-completion. Every figure is computed deterministically and ties to the GL.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error || !p ? (
        <div className="py-6 text-center text-sm text-red-400"><AlertCircle size={18} className="mx-auto mb-1" />{error ?? 'Unable to compute P&L'}</div>
      ) : (
        <>
          {/* Risk flags */}
          {(p.projectedLoss || p.marginFade || p.overBudget) && (
            <div className="flex flex-wrap gap-2 mb-2">
              {p.projectedLoss && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold bg-red-500/15 text-red-300">
                  <TrendingDown size={11} /> Projected loss · EAC exceeds contract
                </span>
              )}
              {p.marginFade && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold bg-amber-500/15 text-amber-300">
                  <AlertTriangle size={11} /> Margin fade {(p.marginFadeBps / 100).toFixed(1)} pts vs original
                </span>
              )}
              {p.overBudget && !p.projectedLoss && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold bg-amber-500/15 text-amber-300">
                  <AlertTriangle size={11} /> Cost overrun · EAC over budget
                </span>
              )}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-x-8">
            {/* Revenue + margin */}
            <div>
              <SectionTitle>Revenue &amp; Earnings</SectionTitle>
              <Row label="Original contract" value={formatMoney(p.originalContractCents)} tone="muted" indent />
              <Row label="Approved change orders" value={formatMoney(p.approvedCoCents)} tone="muted" indent />
              <Row label="Contract value" value={formatMoney(p.contractValueCents)} strong />
              <Row label="Earned revenue" value={formatMoney(p.earnedRevenueCents)}
                sub={`${p.pctCompleteDisplay}% · ${p.pctBasis === 'PHYSICAL' ? 'physical' : 'cost-to-cost'}`} />
              <Row label="Billed to date" value={formatMoney(p.billedToDateCents)} />
              {p.overBillingCents > 0 && (
                <Row label="Overbilling (liability)" value={formatMoney(p.overBillingCents)} tone="warn" indent
                  sub="billings in excess of costs & earnings" />
              )}
              {p.underBillingCents > 0 && (
                <Row label="Underbilling (asset)" value={formatMoney(p.underBillingCents)} tone="good" indent
                  sub="costs & earnings in excess of billings" />
              )}
              {p.retainageHeldCents > 0 && <Row label="Retainage held" value={formatMoney(p.retainageHeldCents)} tone="muted" />}

              <SectionTitle>Margin</SectionTitle>
              <Row label="Gross profit to date" value={formatMoney(p.grossProfitToDateCents)}
                sub={p.grossMarginToDatePct != null ? `${p.grossMarginToDatePct}%` : undefined}
                tone={p.grossProfitToDateCents < 0 ? 'bad' : 'good'} />
              <Row label="Est. GP at current budget" value={formatMoney(p.estimatedGrossProfitCents)} tone="muted" />
              <Row label="Projected final margin"
                value={formatMoney(p.projectedFinalMarginCents)}
                sub={p.projectedFinalMarginPct != null ? `${p.projectedFinalMarginPct}%` : undefined}
                strong tone={p.projectedLoss ? 'bad' : p.marginFade ? 'warn' : 'good'} />
              <Row label="Original margin"
                value={p.originalMarginPct != null ? `${p.originalMarginPct}%` : '--'}
                sub={formatMoney(p.originalMarginCents)} tone="muted" indent />
            </div>

            {/* Cost + EAC */}
            <div>
              <SectionTitle>Costs to Date by Category</SectionTitle>
              {p.categories.filter((c) => c.budgetCents > 0 || c.actualCents > 0).map((c) => (
                <div key={c.key} className="py-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-slate-300">{c.label}</span>
                    <span className={clsx('text-sm font-mono tabular-nums', c.overBudget ? 'text-red-400' : 'text-slate-300')}>
                      {formatMoney(c.actualCents)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                      <div className={clsx('h-full rounded-full', c.overBudget ? 'bg-red-400' : (c.pctUsed ?? 0) > 85 ? 'bg-amber-400' : 'bg-emerald-400')}
                        style={{ width: `${Math.min(100, c.pctUsed ?? 0)}%` }} />
                    </div>
                    <span className="text-2xs font-mono text-slate-600 w-24 text-right">
                      of {formatMoney(c.budgetCents)}{c.pctUsed != null ? ` · ${c.pctUsed}%` : ''}
                    </span>
                  </div>
                </div>
              ))}
              <Row label="Total cost to date" value={formatMoney(p.costsToDateCents)} strong
                sub={`${p.costPctCompleteDisplay}% by cost`} />

              <SectionTitle>Forecast at Completion</SectionTitle>
              <Row label="Open commitments" value={formatMoney(p.committedOpenCents)} tone="muted"
                sub="POs / subs awaiting bill" indent />
              <Row label="Cost to complete" value={formatMoney(p.costToCompleteCents)} />
              <Row label="Estimate at completion (EAC)" value={formatMoney(p.eacCents)} strong
                tone={p.overBudget ? 'warn' : undefined} />
              <Row label="Variance vs budget" value={formatMoney(p.varianceVsBudgetCents)}
                sub={p.varianceVsBudgetCents > 0 ? 'overrun' : p.varianceVsBudgetCents < 0 ? 'under budget' : 'on budget'}
                tone={p.varianceVsBudgetCents > 0 ? 'bad' : p.varianceVsBudgetCents < 0 ? 'good' : 'muted'} indent />
            </div>
          </div>

          {/* GL tie-out */}
          <div className="mt-3 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {p.glCostTied ? (
                <span className="inline-flex items-center gap-1.5 text-2xs text-emerald-300">
                  <CircleCheck size={13} /> Cost-to-date ties to the GL
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-2xs text-amber-300">
                  <CircleAlert size={13} /> Cost-to-date does not tie to the GL — {formatMoney(Math.abs(p.glCostTieDeltaCents))} unbridged
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-2xs text-slate-500 font-mono">
              <span title="Sum of GL-posted job-cost bridge rows">GL-posted cost {formatMoney(p.glPostedCostsCents)}</span>
              <span title="Revenue recognized to the GL by the rev-rec engine">Rev recognized {formatMoney(p.revenueRecognizedCents)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
