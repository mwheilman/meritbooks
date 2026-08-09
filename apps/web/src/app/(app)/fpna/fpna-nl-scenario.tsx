'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  Sparkles, Wand2, Loader2, AlertCircle, Info, CornerDownLeft, ArrowRight,
  TrendingUp, TrendingDown, Minus, Building2,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import type { BudgetDriver } from '@/lib/budget/drivers';

// ── Response types (mirror POST /api/fpna/nl-scenario) ───────────────────────
type CaseKey = 'best' | 'base' | 'worst';

interface ParsedCaseLevers {
  revenueGrowthPct: number;
  costChangePct: number;
  headcountDelta: number;
}
interface ParsedScenario {
  scenarioName: string;
  cases: Record<CaseKey, ParsedCaseLevers>;
  assumptions: string[];
  notes: string | null;
  confidence: number;
}
interface CaseSummaryLite {
  revenueCents: number;
  netIncomeCents: number;
  endingCashCents: number;
  grossMarginBps: number;
}
interface ModelResult {
  best: { summary: CaseSummaryLite };
  base: { summary: CaseSummaryLite };
  worst: { summary: CaseSummaryLite };
}
interface NlResponse {
  parsed: ParsedScenario;
  result: ModelResult;
  meta: { source: 'ai' | 'heuristic'; model: string | null; message?: string | null; budgetState?: string };
}

interface AccountLite { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const EXAMPLES = [
  'Raise revenue 8% and cut costs 12%',
  'What if we lose our biggest customer',
  'Model a 15% price increase with 5% volume attrition',
  'Hire 3 people and grow sales 10%',
];

const DEFAULT_COST_PER_HEAD_DOLLARS = '8000'; // $/month per added head

const CASE_META: Record<CaseKey, { label: string; text: string; ring: string; icon: typeof TrendingUp }> = {
  best: { label: 'Best', text: 'text-emerald-400', ring: 'border-emerald-500/30', icon: TrendingUp },
  base: { label: 'Base', text: 'text-slate-300', ring: 'border-slate-700', icon: Minus },
  worst: { label: 'Worst', text: 'text-red-400', ring: 'border-red-500/30', icon: TrendingDown },
};

const isEmptyCase = (c: ParsedCaseLevers) =>
  c.revenueGrowthPct === 0 && c.costChangePct === 0 && c.headcountDelta === 0;

/**
 * FP&A Dashboard natural-language what-if. A REAL, self-contained input (not a
 * link): the user describes a scenario in plain English, and the deterministic
 * scenario engine models it on the active company's driver-based budget.
 *
 * The Core AI gateway only PARSES the sentence into levers; every dollar is
 * computed in code. AI is currently disabled, so the route returns a keyword
 * heuristic — this UI surfaces that honestly ("AI unavailable — used keyword
 * model") and still shows the parsed assumptions + modeled best/base/worst
 * result. It never leaves the user on a spinner or a silent failure.
 */
export function FpnaNlScenario({ fiscalYear }: { fiscalYear: number }) {
  const { activeCompanyId, activeCompany } = useActiveCompany();
  const locationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : '';

  const [baseDrivers, setBaseDrivers] = useState<BudgetDriver[] | null>(null);
  const [headcountAccountId, setHeadcountAccountId] = useState<string | undefined>(undefined);
  const [loadingModel, setLoadingModel] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [resp, setResp] = useState<NlResponse | null>(null);

  const monthlyCostPerHeadCents = useMemo(
    () => dollarsToCents(DEFAULT_COST_PER_HEAD_DOLLARS) || 0,
    [],
  );

  // Load the active company's driver budget (+ an OPEX account for headcount).
  useEffect(() => {
    if (!locationId) { setBaseDrivers(null); setLoadError(null); return; }
    let cancelled = false;
    setLoadingModel(true);
    setLoadError(null);
    setResp(null);
    (async () => {
      const [modelRes, acctRes] = await Promise.all([
        api.get<{ model: { drivers: BudgetDriver[] } | null }>('/api/budgets/drivers', {
          location_id: locationId,
          fiscal_year: String(fiscalYear),
        }),
        api.get<{ data: AccountLite[] }>('/api/accounts', { location_id: locationId }),
      ]);
      if (cancelled) return;
      setLoadingModel(false);
      if (modelRes.error) { setLoadError(modelRes.error.error); setBaseDrivers(null); return; }
      const drivers = modelRes.data?.model?.drivers ?? null;
      setBaseDrivers(drivers && drivers.length > 0 ? drivers : null);
      const opex = (acctRes.data?.data ?? [])
        .filter((a) => a.accountType === 'OPEX' && a.isActive && a.approvalStatus === 'APPROVED')
        .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
      setHeadcountAccountId(opex[0]?.id);
    })();
    return () => { cancelled = true; };
  }, [locationId, fiscalYear]);

  const run = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length < 2 || !baseDrivers) return;
    setRunning(true);
    setRunError(null);
    const res = await api.post<NlResponse>('/api/fpna/nl-scenario', {
      text: trimmed,
      baseDrivers,
      monthlyCostPerHeadCents,
      ...(headcountAccountId ? { headcountAccountId } : {}),
    });
    setRunning(false);
    if (res.error) { setRunError(res.error.error || 'Could not model that scenario.'); return; }
    if (res.data) setResp(res.data);
  }, [text, baseDrivers, monthlyCostPerHeadCents, headcountAccountId]);

  // ── Shell (indigo = AI feature) ──
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/15">
          <Sparkles size={13} className="text-indigo-300" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Model a what-if in plain English</span>
        {activeCompany && (
          <span className="inline-flex items-center gap-1 text-2xs text-slate-500">
            <Building2 size={11} /> {activeCompany.name} · FY {fiscalYear}
          </span>
        )}
        <span className="ml-auto hidden text-2xs text-slate-500 sm:inline">AI parses your words into levers · the engine does the math</span>
      </div>

      {/* No single company selected → the driver budget is per-company */}
      {!locationId ? (
        <div className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 text-xs text-slate-400">
          <Info size={14} className="mt-0.5 shrink-0 text-indigo-300" />
          <span>Pick a company in the header to model a what-if — scenarios run on that company&apos;s driver-based budget.</span>
        </div>
      ) : loadingModel ? (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-slate-400">
          <Loader2 size={14} className="animate-spin text-indigo-300" /> Loading {activeCompany?.name ?? 'company'} plan…
        </div>
      ) : loadError ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <AlertCircle size={13} /> {loadError}
        </div>
      ) : !baseDrivers ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 text-xs text-slate-400">
          <Info size={14} className="shrink-0 text-indigo-300" />
          <span>No driver-based budget for {activeCompany?.name ?? 'this company'} (FY {fiscalYear}) yet — build one to model a what-if.</span>
          <Link href="/budgets?tab=drivers" className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200">
            Build a driver budget <ArrowRight size={12} />
          </Link>
        </div>
      ) : (
        <>
          <div className="relative">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
              }}
              rows={2}
              placeholder='e.g. "raise revenue 8% and cut costs 12%"'
              className="w-full resize-none rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2.5 pr-28 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500/50 focus:outline-none"
            />
            <button
              onClick={run}
              disabled={running || text.trim().length < 2}
              className={clsx(
                'absolute right-2 top-2 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
                running || text.trim().length < 2 ? 'bg-slate-800 text-slate-500' : 'bg-indigo-600 text-white hover:bg-indigo-500',
              )}
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {running ? 'Modeling…' : 'Model it'}
            </button>
          </div>

          {!resp && !running && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setText(ex)}
                  className="rounded-full border border-slate-800 bg-slate-900/50 px-2.5 py-1 text-2xs text-slate-400 hover:border-indigo-500/40 hover:text-indigo-300"
                >
                  {ex}
                </button>
              ))}
              <span className="ml-auto hidden items-center gap-1 text-2xs text-slate-600 sm:inline-flex">
                <CornerDownLeft size={10} /> ⌘/Ctrl + Enter
              </span>
            </div>
          )}

          {runError && (
            <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              <AlertCircle size={13} /> {runError}
            </div>
          )}

          {resp && <ScenarioResult resp={resp} fiscalYear={fiscalYear} />}
        </>
      )}
    </div>
  );
}

function ScenarioResult({ resp, fiscalYear }: { resp: NlResponse; fiscalYear: number }) {
  const { parsed, result, meta } = resp;
  const heuristic = meta.source === 'heuristic';
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-white">{parsed.scenarioName}</span>
        <span
          className={clsx(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
            heuristic ? 'bg-indigo-500/10 text-indigo-300' : 'bg-indigo-500/10 text-indigo-300',
          )}
        >
          <Sparkles size={10} />
          {heuristic ? 'Keyword model' : `AI parsed${meta.model ? ` · ${meta.model}` : ''}`}
        </span>
        <span className="text-2xs text-slate-500">confidence {(parsed.confidence * 100).toFixed(0)}%</span>
        <Link
          href={`/budgets?tab=scenarios&fiscal_year=${fiscalYear}`}
          className="ml-auto inline-flex items-center gap-1 text-2xs text-slate-400 hover:text-indigo-300"
        >
          Refine &amp; save in Scenarios <ArrowRight size={11} />
        </Link>
      </div>

      {/* Honest degrade note when the AI provider is unavailable */}
      {heuristic && (
        <div className="flex items-start gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.05] px-2.5 py-1.5 text-2xs text-indigo-300/90">
          <Info size={11} className="mt-0.5 shrink-0" />
          AI unavailable — used keyword model{meta.message ? ` (${meta.message})` : ''}. Figures are computed by the deterministic budget engine; refine the levers in Scenarios.
        </div>
      )}

      {/* Modeled best / base / worst */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {(['worst', 'base', 'best'] as CaseKey[]).map((key) => {
          const lv = parsed.cases[key];
          const empty = isEmptyCase(lv);
          const cmeta = CASE_META[key];
          const Icon = cmeta.icon;
          const sum = result[key].summary;
          return (
            <div key={key} className={clsx('rounded-lg border p-2.5', cmeta.ring, empty && 'opacity-60')}>
              <div className={clsx('mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase', cmeta.text)}>
                <Icon size={12} /> {cmeta.label} case
              </div>
              {empty ? (
                <p className="text-2xs text-slate-600">Plan of record (unchanged)</p>
              ) : (
                <ul className="space-y-0.5 text-2xs">
                  {lv.revenueGrowthPct !== 0 && <LeverLine label="Revenue" value={`${lv.revenueGrowthPct > 0 ? '+' : ''}${lv.revenueGrowthPct}%`} />}
                  {lv.costChangePct !== 0 && <LeverLine label="Costs" value={`${lv.costChangePct > 0 ? '+' : ''}${lv.costChangePct}%`} />}
                  {lv.headcountDelta !== 0 && <LeverLine label="Headcount" value={`${lv.headcountDelta > 0 ? '+' : ''}${lv.headcountDelta}`} />}
                </ul>
              )}
              <div className="mt-2 border-t border-slate-800 pt-1.5">
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-slate-500">Revenue</span>
                  <span className="font-mono text-slate-300">{formatMoney(sum.revenueCents, { compact: true })}</span>
                </div>
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-slate-500">Net income</span>
                  <span className={clsx('font-mono font-semibold', sum.netIncomeCents >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {formatMoney(sum.netIncomeCents, { compact: true })}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Parsed assumptions */}
      {parsed.assumptions.length > 0 && (
        <div>
          <div className="mb-1 text-2xs font-semibold uppercase text-slate-500">Parsed assumptions</div>
          <ul className="space-y-1">
            {parsed.assumptions.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5 text-2xs text-slate-400">
                <span className="mt-0.5 text-indigo-400">•</span> {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {parsed.notes && !heuristic && (
        <p className="flex items-start gap-1.5 border-t border-slate-800 pt-2 text-2xs text-slate-500">
          <Info size={11} className="mt-0.5 shrink-0" /> {parsed.notes}
        </p>
      )}
    </div>
  );
}

function LeverLine({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-300">{value}</span>
    </li>
  );
}
