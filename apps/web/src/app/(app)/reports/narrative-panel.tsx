'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Sparkles, Loader2, AlertCircle, RefreshCw, TrendingUp, TrendingDown, ArrowRight, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useMutation } from '@/hooks';

// ── Types mirror the /api/reports/narrative response ──────────────────────────
interface NarrativeDriver {
  line: string;
  key: string;
  section: string;
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  pct: number | null;
  direction: 'up' | 'down' | 'flat';
  favorable: boolean | null;
}
interface Citation { label: string; href: string }
interface NarrativeResponse {
  narrative: string;
  drivers: NarrativeDriver[];
  citations: Citation[];
  meta: { report: string; source: 'ai' | 'deterministic'; model: string | null; decisionId: string | null; budgetState: string; message?: string | null };
}

type ReportKind = 'pnl' | 'balance_sheet' | 'cash_flow' | 'budget_vs_actual';
type Compare = 'prior_period' | 'prior_year';

// ── Compact date helpers (self-contained) ─────────────────────────────────────
function pad(n: number) { return String(n).padStart(2, '0'); }
function parseISO(s: string) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
function isoStr(y: number, m: number, d: number) { return `${y}-${pad(m)}-${pad(d)}`; }
function lastDay(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addMonths(y: number, m: number, delta: number) { const idx = y * 12 + (m - 1) + delta; return { y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 + 1 }; }

function derivePriorPeriod(sd: string, ed: string): { s: string; e: string } {
  const a = parseISO(sd), b = parseISO(ed);
  const wholeMonths = a.d === 1 && b.d === lastDay(b.y, b.m);
  if (wholeMonths) {
    const span = (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
    const ps = addMonths(a.y, a.m, -span);
    const pe = addMonths(a.y, a.m, -1);
    return { s: isoStr(ps.y, ps.m, 1), e: isoStr(pe.y, pe.m, lastDay(pe.y, pe.m)) };
  }
  const len = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000) + 1;
  const peD = new Date(Date.UTC(a.y, a.m - 1, a.d) - 86400000);
  const psD = new Date(peD.getTime() - (len - 1) * 86400000);
  return { s: isoStr(psD.getUTCFullYear(), psD.getUTCMonth() + 1, psD.getUTCDate()), e: isoStr(peD.getUTCFullYear(), peD.getUTCMonth() + 1, peD.getUTCDate()) };
}
function derivePriorYear(sd: string, ed: string): { s: string; e: string } {
  const a = parseISO(sd), b = parseISO(ed);
  const sD = Math.min(a.d, lastDay(a.y - 1, a.m));
  const eD = b.d === lastDay(b.y, b.m) ? lastDay(b.y - 1, b.m) : Math.min(b.d, lastDay(b.y - 1, b.m));
  return { s: isoStr(a.y - 1, a.m, sD), e: isoStr(b.y - 1, b.m, eD) };
}
function priorAsOf(ed: string, mode: Compare): string {
  const b = parseISO(ed);
  if (mode === 'prior_year') return isoStr(b.y - 1, b.m, b.d === lastDay(b.y, b.m) ? lastDay(b.y - 1, b.m) : b.d);
  const pm = addMonths(b.y, b.m, -1);
  return isoStr(pm.y, pm.m, lastDay(pm.y, pm.m));
}

// ── Component ─────────────────────────────────────────────────────────────────
export function NarrativePanel({ report, sd = '', ed = '', locIds = '', basis = 'accrual', fiscalYear, periodNumber = 0, departmentId }: {
  report: ReportKind;
  sd?: string;
  ed?: string;
  locIds?: string;
  basis?: string;
  /** Budget-vs-actual scope (only used when report === 'budget_vs_actual'). */
  fiscalYear?: number;
  periodNumber?: number; // 0 = full year, 1..12 = fiscal month
  departmentId?: string | null;
}) {
  const [compare, setCompare] = useState<Compare>('prior_period');
  const { mutate, data, error, isLoading, reset } = useMutation<Record<string, unknown>, NarrativeResponse>('/api/reports/narrative');

  const isBudget = report === 'budget_vs_actual';

  // The scope changes → clear any stale narrative so we never show one for the wrong window.
  const periodKeyId = `${report}|${sd}|${ed}|${locIds}|${basis}|${compare}|${fiscalYear}|${periodNumber}|${departmentId ?? ''}`;
  useEffect(() => { reset(); }, [periodKeyId, reset]);

  const ready = isBudget
    ? !!fiscalYear
    : report === 'balance_sheet' ? !!ed : !!sd && !!ed;

  const buildRequest = useCallback((): Record<string, unknown> | null => {
    const dimensions: Record<string, string> = {};
    if (locIds) dimensions.location_ids = locIds;
    if (basis && basis !== 'accrual') dimensions.basis = basis;

    if (report === 'budget_vs_actual') {
      if (!fiscalYear) return null;
      if (departmentId) dimensions.department_id = departmentId;
      const scope = periodNumber >= 1 ? `FY ${fiscalYear} · P${periodNumber}` : `FY ${fiscalYear}`;
      return {
        report: 'budget_vs_actual',
        fiscal_year: fiscalYear,
        period_number: periodNumber,
        periodA: { label: scope },
        periodB: { label: 'budget' },
        dimensions,
      };
    }
    if (report === 'balance_sheet') {
      if (!ed) return null;
      return {
        report: 'balance_sheet',
        periodA: { as_of_date: ed, label: `as of ${ed}` },
        periodB: { as_of_date: priorAsOf(ed, compare), label: `as of ${priorAsOf(ed, compare)}` },
        dimensions,
      };
    }
    // pnl and cash_flow share the same period/comparison shape.
    if (!sd || !ed) return null;
    const prior = compare === 'prior_year' ? derivePriorYear(sd, ed) : derivePriorPeriod(sd, ed);
    return {
      report,
      periodA: { start_date: sd, end_date: ed, label: `${sd} to ${ed}` },
      periodB: { start_date: prior.s, end_date: prior.e, label: `${prior.s} to ${prior.e}` },
      dimensions,
    };
  }, [report, sd, ed, locIds, basis, compare, fiscalYear, periodNumber, departmentId]);

  const generate = useCallback(() => {
    const req = buildRequest();
    if (req) mutate(req);
  }, [buildRequest, mutate]);

  const compareLabel = isBudget ? 'budget' : compare === 'prior_year' ? 'prior year' : 'prior period';
  const title = isBudget ? 'Budget Variance Narrative' : report === 'cash_flow' ? 'Cash Flow Narrative' : 'Flux Narrative';
  const subtitle = isBudget
    ? 'AI explains where actuals beat or missed budget — figures computed in the ledger, not by the model'
    : report === 'cash_flow'
      ? 'AI explains the biggest sources and uses of cash vs prior period — figures computed in the ledger, not by the model'
      : `AI explains the movement vs ${compareLabel} — figures computed in the ledger, not by the model`;

  return (
    <div className="mb-5 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-indigo-500/10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center">
            <Sparkles size={14} className="text-indigo-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{title}</p>
            <p className="text-[11px] text-indigo-300/60">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isBudget && (
            <select
              value={compare}
              onChange={(e) => setCompare(e.target.value as Compare)}
              className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-indigo-500/40"
              aria-label="Comparison basis"
            >
              <option value="prior_period">vs Prior Period</option>
              <option value="prior_year">vs Prior Year</option>
            </select>
          )}
          <button
            onClick={generate}
            disabled={!ready || isLoading}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              !ready || isLoading
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-indigo-600 text-white hover:bg-indigo-500',
            )}
          >
            {isLoading ? <Loader2 size={13} className="animate-spin" /> : data ? <RefreshCw size={13} /> : <Sparkles size={13} />}
            {isLoading ? 'Analyzing…' : data ? 'Regenerate' : 'Generate narrative'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        {!ready && (
          <p className="text-xs text-slate-500">Select a period to generate a flux narrative.</p>
        )}

        {ready && isLoading && (
          <div className="flex items-center gap-2 text-sm text-indigo-300/70">
            <Loader2 size={16} className="animate-spin" /> Computing variances and drafting the board narrative…
          </div>
        )}

        {ready && !isLoading && error && (
          <div className="flex items-start gap-2 text-sm text-red-400">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p>{error}</p>
              <button onClick={generate} className="mt-1 text-xs text-indigo-400 hover:text-indigo-300 underline">Try again</button>
            </div>
          </div>
        )}

        {ready && !isLoading && !error && !data && (
          <p className="text-xs text-slate-500">
            Click <span className="text-indigo-300">Generate narrative</span> to see the largest drivers behind the change vs {compareLabel}, explained in plain language.
          </p>
        )}

        {ready && !isLoading && !error && data && (
          <NarrativeBody data={data} />
        )}
      </div>
    </div>
  );
}

function pctText(pct: number | null) { return pct == null ? 'new' : `${pct > 0 ? '+' : ''}${pct}%`; }

function NarrativeBody({ data }: { data: NarrativeResponse }) {
  const favClass = (f: boolean | null) => f == null ? 'text-slate-300 border-slate-700 bg-slate-800/40' : f ? 'text-emerald-300 border-emerald-500/20 bg-emerald-500/[0.06]' : 'text-red-300 border-red-500/20 bg-red-500/[0.06]';
  const sourceBadge = data.meta.source === 'ai'
    ? { label: data.meta.model ? `AI · ${data.meta.model}` : 'AI', cls: 'text-indigo-300 bg-indigo-500/10' }
    : { label: 'Computed (AI unavailable)', cls: 'text-amber-300 bg-amber-500/10' };

  return (
    <div>
      <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{data.narrative}</p>

      {data.meta.message && data.meta.source === 'deterministic' && (
        <p className="mt-1.5 text-[11px] text-amber-400/70">{data.meta.message}</p>
      )}

      {data.drivers.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Computed drivers</p>
          <div className="flex flex-wrap gap-1.5">
            {data.drivers.map((d) => (
              <span key={d.key} className={clsx('inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-mono', favClass(d.favorable))}>
                {d.direction === 'up' ? <TrendingUp size={11} /> : d.direction === 'down' ? <TrendingDown size={11} /> : <ArrowRight size={11} />}
                <span className="font-sans">{d.line}</span>
                <span>{d.deltaCents > 0 ? '+' : ''}{formatMoney(d.deltaCents)}</span>
                <span className="opacity-60">{pctText(d.pct)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {data.citations.map((c) => (
            <a key={c.href + c.label} href={c.href} className="text-[11px] text-indigo-400/80 hover:text-indigo-300 underline decoration-dotted">{c.label}</a>
          ))}
        </div>
        <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium', sourceBadge.cls)}>
          <ShieldCheck size={10} /> {sourceBadge.label}
        </span>
      </div>
    </div>
  );
}
