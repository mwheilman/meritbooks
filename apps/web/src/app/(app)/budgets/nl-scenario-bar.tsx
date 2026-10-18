'use client';

import { useCallback, useState } from 'react';
import { clsx } from 'clsx';
import {
  Sparkles, Loader2, Wand2, AlertCircle, Check, X, CornerDownLeft, Info,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import type { BudgetDriver } from '@/lib/budget/drivers';

export type CaseKey = 'best' | 'base' | 'worst';

export interface ParsedCaseLevers {
  revenueGrowthPct: number;
  costChangePct: number;
  headcountDelta: number;
}

export interface ParsedScenario {
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

const EXAMPLES = [
  'Raise revenue 8% and cut headcount cost 12% starting Q3',
  'What if we lose our biggest customer',
  'Model a 15% price increase with 5% volume attrition',
  'Hire 3 people and grow sales 10%',
];

const CASE_META: Record<CaseKey, { label: string; text: string; ring: string }> = {
  best: { label: 'Best', text: 'text-emerald-400', ring: 'border-emerald-500/30' },
  base: { label: 'Base', text: 'text-slate-300', ring: 'border-slate-700' },
  worst: { label: 'Worst', text: 'text-red-400', ring: 'border-red-500/30' },
};

const isEmptyCase = (c: ParsedCaseLevers) =>
  c.revenueGrowthPct === 0 && c.costChangePct === 0 && c.headcountDelta === 0;

/**
 * Natural-language what-if bar. The user describes a scenario in plain English;
 * the Core AI gateway PARSES it (never computes) into scenario levers grounded in
 * the tenant's real driver budget, and the deterministic engine models the impact.
 * The user confirms/tweaks the parsed assumptions, then applies them to the
 * best/base/worst modeler below (which recomputes live and can save the scenario).
 */
export function NlScenarioBar({
  baseDrivers,
  beginningCashCents,
  monthlyCostPerHeadCents,
  headcountAccountId,
  onApply,
}: {
  baseDrivers: BudgetDriver[];
  beginningCashCents: number;
  monthlyCostPerHeadCents: number;
  headcountAccountId: string | undefined;
  onApply: (scenarioName: string, cases: Record<CaseKey, ParsedCaseLevers>) => void;
}) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<NlResponse | null>(null);
  // Editable copy of the parsed levers (the user can tweak before applying).
  const [draft, setDraft] = useState<ParsedScenario | null>(null);

  const run = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length < 2) return;
    setLoading(true);
    setError(null);
    const res = await api.post<NlResponse>('/api/fpna/nl-scenario', {
      text: trimmed,
      baseDrivers,
      beginningCashCents,
      monthlyCostPerHeadCents,
      ...(headcountAccountId ? { headcountAccountId } : {}),
    });
    setLoading(false);
    if (res.error) {
      setError(res.error.error || 'Could not model that scenario.');
      return;
    }
    if (res.data) {
      setResp(res.data);
      setDraft(structuredClone(res.data.parsed));
    }
  }, [text, baseDrivers, beginningCashCents, monthlyCostPerHeadCents, headcountAccountId]);

  const patchLever = useCallback((key: CaseKey, patch: Partial<ParsedCaseLevers>) => {
    setDraft((d) => (d ? { ...d, cases: { ...d.cases, [key]: { ...d.cases[key], ...patch } } } : d));
  }, []);

  const discard = useCallback(() => {
    setResp(null);
    setDraft(null);
    setError(null);
  }, []);

  const apply = useCallback(() => {
    if (!draft) return;
    onApply(draft.scenarioName, draft.cases);
    addToast('success', 'Scenario assumptions applied — review and save below.');
    discard();
  }, [draft, onApply, discard]);

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/15">
          <Sparkles size={13} className="text-indigo-300" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Describe a scenario</span>
        <span className="text-2xs text-slate-500">AI parses your words into levers · the engine does the math</span>
      </div>

      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
          }}
          rows={2}
          placeholder='e.g. "raise revenue 8% and cut headcount cost 12% starting Q3"'
          className="w-full resize-none rounded-lg bg-slate-900/70 border border-slate-800 px-3 py-2.5 pr-28 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50"
        />
        <button
          onClick={run}
          disabled={loading || text.trim().length < 2}
          className={clsx(
            'absolute right-2 top-2 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
            loading || text.trim().length < 2
              ? 'bg-slate-800 text-slate-500'
              : 'bg-indigo-600 text-white hover:bg-indigo-500',
          )}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
          {loading ? 'Modeling…' : 'Model it'}
        </button>
      </div>

      {/* Example chips */}
      {!resp && !loading && (
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

      {error && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {/* Parsed result — confirm / tweak / apply */}
      {resp && draft && (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={draft.scenarioName}
              onChange={(e) => setDraft((d) => (d ? { ...d, scenarioName: e.target.value } : d))}
              className="rounded-lg bg-slate-800 border border-slate-700 px-2 py-1 text-sm font-medium text-white w-[220px] focus:outline-none focus:border-indigo-500/50"
            />
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
                resp.meta.source === 'ai'
                  ? 'bg-indigo-500/10 text-indigo-300'
                  : 'bg-amber-500/10 text-amber-300',
              )}
            >
              <Sparkles size={10} />
              {resp.meta.source === 'ai' ? `AI parsed${resp.meta.model ? ` · ${resp.meta.model}` : ''}` : 'Keyword heuristic'}
            </span>
            <span className="text-2xs text-slate-500">confidence {(draft.confidence * 100).toFixed(0)}%</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={discard} className="flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">
                <X size={12} /> Discard
              </button>
              <button onClick={apply} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500">
                <Check size={12} /> Apply to model
              </button>
            </div>
          </div>

          {resp.meta.message && (
            <div className="flex items-center gap-1.5 text-2xs text-amber-300/90">
              <Info size={11} /> {resp.meta.message}
            </div>
          )}

          {/* Editable per-case levers (only cases the parse touched) */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {(['worst', 'base', 'best'] as CaseKey[]).map((key) => {
              const lv = draft.cases[key];
              const empty = isEmptyCase(lv);
              const meta = CASE_META[key];
              const sum = resp.result[key].summary;
              return (
                <div key={key} className={clsx('rounded-lg border p-2.5', meta.ring, empty && 'opacity-50')}>
                  <div className={clsx('mb-2 flex items-center justify-between text-2xs font-semibold uppercase', meta.text)}>
                    <span>{meta.label} case</span>
                    {empty ? <span className="text-slate-600">plan of record</span> : <span className="font-mono text-slate-400">NI {formatMoney(sum.netIncomeCents, { compact: true })}</span>}
                  </div>
                  <div className="space-y-1.5">
                    <MiniLever label="Revenue" suffix="%" value={lv.revenueGrowthPct} onChange={(v) => patchLever(key, { revenueGrowthPct: v })} />
                    <MiniLever label="Cost" suffix="%" value={lv.costChangePct} onChange={(v) => patchLever(key, { costChangePct: v })} />
                    <MiniLever label="Headcount" suffix="" value={lv.headcountDelta} onChange={(v) => patchLever(key, { headcountDelta: Math.trunc(v) })} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Assumptions the model flagged */}
          {draft.assumptions.length > 0 && (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase text-slate-500">Assumptions</div>
              <ul className="space-y-1">
                {draft.assumptions.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-2xs text-slate-400">
                    <span className="mt-0.5 text-indigo-400">•</span> {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {draft.notes && (
            <p className="flex items-start gap-1.5 border-t border-slate-800 pt-2 text-2xs text-slate-500">
              <Info size={11} className="mt-0.5 shrink-0" /> {draft.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MiniLever({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix: string }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-2xs text-slate-500">{label}</span>
      <div className="relative flex-1">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded bg-slate-900/70 border border-slate-800 px-2 py-1 text-right font-mono text-2xs text-slate-200 focus:outline-none focus:border-indigo-500/50"
        />
        {suffix && <span className="pointer-events-none absolute right-1.5 top-1 text-2xs text-slate-600">{suffix}</span>}
      </div>
    </label>
  );
}
