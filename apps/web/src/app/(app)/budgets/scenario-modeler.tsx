'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Loader2, AlertCircle, Save, Sparkles, TrendingUp, TrendingDown, Minus,
  SlidersHorizontal, Info, Wallet, ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import {
  buildThreeCase, runSensitivity,
  type ScenarioOverride, type ScenarioDefinition, type ThreeCaseResult,
  type SensitivityAxis,
} from '@/lib/budget/scenarios';
import type { BudgetDriver } from '@/lib/budget/drivers';

interface AccountLite { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

// Per-case levers held in display units; converted to engine overrides at compute.
interface CaseLevers { revenueGrowthPct: string; costChangePct: string; headcountDelta: string }
type CaseKey = 'best' | 'base' | 'worst';

const EMPTY_LEVERS: CaseLevers = { revenueGrowthPct: '', costChangePct: '', headcountDelta: '' };

const DEFAULT_CASES: Record<CaseKey, CaseLevers> = {
  best: { revenueGrowthPct: '10', costChangePct: '-5', headcountDelta: '0' },
  base: { ...EMPTY_LEVERS },
  worst: { revenueGrowthPct: '-15', costChangePct: '8', headcountDelta: '2' },
};

const num = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** Build engine overrides for one case from its display levers + shared assumptions. */
function leversToOverrides(
  lv: CaseLevers,
  monthlyCostPerHeadCents: number,
  accountId: string
): ScenarioOverride[] {
  const out: ScenarioOverride[] = [];
  const rev = num(lv.revenueGrowthPct);
  if (rev !== 0) out.push({ kind: 'revenue_growth', deltaBps: Math.round(rev * 100) });
  const cost = num(lv.costChangePct);
  if (cost !== 0) out.push({ kind: 'cost_change', deltaBps: Math.round(cost * 100) });
  const heads = Math.trunc(num(lv.headcountDelta));
  if (heads !== 0) out.push({ kind: 'headcount', deltaHeads: heads, monthlyCostPerHeadCents, accountId });
  return out;
}

const SENSITIVITY_POINTS: Record<SensitivityAxis, number[]> = {
  revenue_growth: [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000],
  cost_change: [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000],
  headcount: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
};

const AXIS_LABEL: Record<SensitivityAxis, string> = {
  revenue_growth: 'Revenue growth',
  cost_change: 'Cost change',
  headcount: 'Headcount',
};

export function ScenarioModeler({
  locationId, fiscalYear, departmentId,
}: {
  locationId: string; fiscalYear: number; departmentId: string | null;
}) {
  const [baseDrivers, setBaseDrivers] = useState<BudgetDriver[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountLite[]>([]);

  const [cases, setCases] = useState<Record<CaseKey, CaseLevers>>(DEFAULT_CASES);
  const [beginningCashStr, setBeginningCashStr] = useState('0');
  const [costPerHeadStr, setCostPerHeadStr] = useState('8000'); // $/month per head
  const [headcountAccountId, setHeadcountAccountId] = useState('');
  const [scenarioName, setScenarioName] = useState('');
  const [saving, setSaving] = useState(false);

  const [axis, setAxis] = useState<SensitivityAxis>('revenue_growth');
  const [sensIndex, setSensIndex] = useState(4);

  const [savedList, setSavedList] = useState<Array<{ id: string; name: string; savedAt: string; definition: { baseDrivers: BudgetDriver[]; cases: ScenarioDefinition['cases']; beginningCashCents: number } }>>([]);

  // ── Load the base driver model + accounts for the scope ──
  const loadModel = useCallback(async () => {
    if (!locationId) { setBaseDrivers(null); setAccounts([]); return; }
    setLoading(true); setLoadError(null);
    const [modelRes, acctRes, listRes] = await Promise.all([
      api.get<{ model: { drivers: BudgetDriver[] } | null }>('/api/budgets/drivers', { location_id: locationId, fiscal_year: String(fiscalYear) }),
      api.get<{ data: AccountLite[] }>('/api/accounts', { location_id: locationId }),
      api.get<{ scenarios: typeof savedList }>('/api/budgets/scenarios', { location_id: locationId, fiscal_year: String(fiscalYear) }),
    ]);
    setLoading(false);
    if (modelRes.error) { setLoadError(modelRes.error.error); setBaseDrivers(null); return; }
    const drivers = modelRes.data?.model?.drivers ?? null;
    setBaseDrivers(drivers && drivers.length > 0 ? drivers : null);
    const opex = (acctRes.data?.data ?? []).filter((a) => a.accountType === 'OPEX' && a.isActive && a.approvalStatus === 'APPROVED')
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
    setAccounts(opex);
    setHeadcountAccountId((prev) => prev || opex[0]?.id || '');
    setSavedList(listRes.data?.scenarios ?? []);
  }, [locationId, fiscalYear]);

  useEffect(() => { loadModel(); }, [loadModel]);

  const monthlyCostPerHeadCents = useMemo(() => dollarsToCents(costPerHeadStr || '0') || 0, [costPerHeadStr]);
  const beginningCashCents = useMemo(() => dollarsToCents(beginningCashStr || '0') || 0, [beginningCashStr]);

  // ── Live three-case compute (pure, instant, same engine as the API) ──
  const three: ThreeCaseResult | null = useMemo(() => {
    if (!baseDrivers) return null;
    const def: ScenarioDefinition = {
      name: scenarioName || 'Scenario',
      baseDrivers,
      beginningCashCents,
      cases: {
        best: leversToOverrides(cases.best, monthlyCostPerHeadCents, headcountAccountId),
        base: leversToOverrides(cases.base, monthlyCostPerHeadCents, headcountAccountId),
        worst: leversToOverrides(cases.worst, monthlyCostPerHeadCents, headcountAccountId),
      },
    };
    return buildThreeCase(def);
  }, [baseDrivers, cases, beginningCashCents, monthlyCostPerHeadCents, headcountAccountId, scenarioName]);

  // ── Sensitivity sweep on the BASE case ──
  const sensitivity = useMemo(() => {
    if (!baseDrivers) return null;
    return runSensitivity(
      baseDrivers,
      {
        axis,
        points: SENSITIVITY_POINTS[axis],
        baseOverrides: leversToOverrides(cases.base, monthlyCostPerHeadCents, headcountAccountId),
        monthlyCostPerHeadCents,
        accountId: headcountAccountId,
      },
      beginningCashCents
    );
  }, [baseDrivers, axis, cases.base, monthlyCostPerHeadCents, headcountAccountId, beginningCashCents]);

  useEffect(() => { setSensIndex(Math.floor(SENSITIVITY_POINTS[axis].length / 2)); }, [axis]);

  const patchCase = useCallback((key: CaseKey, patch: Partial<CaseLevers>) => {
    setCases((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

  const save = useCallback(async () => {
    if (!baseDrivers || !three) return;
    if (!scenarioName.trim()) { addToast('error', 'Name the scenario before saving.'); return; }
    setSaving(true);
    const res = await api.post<{ saved: boolean; id: string }>('/api/budgets/scenarios', {
      location_id: locationId,
      fiscal_year: fiscalYear,
      department_id: departmentId,
      name: scenarioName.trim(),
      baseDrivers,
      beginningCashCents,
      cases: {
        best: leversToOverrides(cases.best, monthlyCostPerHeadCents, headcountAccountId),
        base: leversToOverrides(cases.base, monthlyCostPerHeadCents, headcountAccountId),
        worst: leversToOverrides(cases.worst, monthlyCostPerHeadCents, headcountAccountId),
      },
      save: true,
    });
    setSaving(false);
    if (res.error) { addToast('error', `Save failed: ${res.error.error}`); return; }
    addToast('success', `Scenario "${scenarioName.trim()}" saved.`);
    loadModel();
  }, [baseDrivers, three, scenarioName, locationId, fiscalYear, departmentId, beginningCashCents, cases, monthlyCostPerHeadCents, headcountAccountId, loadModel]);

  const loadSaved = useCallback((s: (typeof savedList)[number]) => {
    setScenarioName(s.name);
    setBeginningCashStr(String(centsToDollars(s.definition.beginningCashCents)));
    const toLevers = (ov: ScenarioOverride[]): CaseLevers => {
      const l = { ...EMPTY_LEVERS };
      for (const o of ov) {
        if (o.kind === 'revenue_growth') l.revenueGrowthPct = String(o.deltaBps / 100);
        else if (o.kind === 'cost_change') l.costChangePct = String(o.deltaBps / 100);
        else if (o.kind === 'headcount') { l.headcountDelta = String(o.deltaHeads); setCostPerHeadStr(String(centsToDollars(o.monthlyCostPerHeadCents))); setHeadcountAccountId(o.accountId); }
      }
      return l;
    };
    setCases({ best: toLevers(s.definition.cases.best), base: toLevers(s.definition.cases.base), worst: toLevers(s.definition.cases.worst) });
    addToast('info', `Loaded "${s.name}".`);
  }, []);

  // ── States ──
  if (!locationId) {
    return (
      <div className="card p-12 text-center">
        <Sparkles size={26} className="mx-auto text-slate-600 mb-3" />
        <p className="text-sm text-slate-300 font-medium">Model best / base / worst cases</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Select a company above to layer what-if overrides (revenue growth, cost change, headcount) on its driver-based budget.</p>
      </div>
    );
  }
  if (loading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (loadError) return (
    <div className="card p-8 text-center">
      <AlertCircle size={22} className="mx-auto text-red-400 mb-2" />
      <p className="text-sm text-slate-300">Couldn’t load the scenario base.</p>
      <p className="text-xs text-slate-500 mt-1">{loadError}</p>
      <button onClick={loadModel} className="mt-3 text-xs text-emerald-400 hover:text-emerald-300">Retry</button>
    </div>
  );
  if (!baseDrivers) return (
    <div className="card p-10 text-center">
      <Info size={22} className="mx-auto text-slate-600 mb-2" />
      <p className="text-sm text-slate-300 font-medium">No driver budget to model yet</p>
      <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Scenarios layer overrides on a driver-based budget. Build one for this company and year first.</p>
      <Link href="/budgets/drivers" className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300">
        Go to Driver Budget <ArrowRight size={12} />
      </Link>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Global scenario assumptions */}
      <div className="flex items-end gap-4 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <AssumptionInput icon={Wallet} label="Beginning cash ($)" value={beginningCashStr} onChange={setBeginningCashStr} placeholder="0" />
        <AssumptionInput label="Cost / head / month ($)" value={costPerHeadStr} onChange={setCostPerHeadStr} placeholder="8,000" />
        <label className="block">
          <span className="block text-2xs uppercase text-slate-500 mb-1">Headcount cost account</span>
          <select value={headcountAccountId} onChange={(e) => setHeadcountAccountId(e.target.value)}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white max-w-[220px]">
            {accounts.length === 0 && <option value="">No OPEX accounts</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-end gap-2">
          <label className="block">
            <span className="block text-2xs uppercase text-slate-500 mb-1">Scenario name</span>
            <input value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} placeholder="e.g. FY plan swing"
              className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white w-[180px]" />
          </label>
          <button onClick={save} disabled={saving}
            className={clsx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium',
              saving ? 'bg-slate-800 text-slate-500 border border-slate-700' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{saving ? 'Saving…' : 'Save Scenario'}
          </button>
        </div>
      </div>

      {/* Case override editors */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(['worst', 'base', 'best'] as CaseKey[]).map((key) => (
          <CaseEditor key={key} caseKey={key} levers={cases[key]} onChange={(p) => patchCase(key, p)} />
        ))}
      </div>

      {/* Side-by-side compare */}
      {three && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2">
            <SlidersHorizontal size={13} className="text-emerald-400" />
            <span className="text-xs font-semibold uppercase text-slate-400">Best · Base · Worst</span>
            <span className="text-2xs text-slate-500 ml-auto">Variance shown vs Base</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800/50 text-2xs uppercase text-slate-500">
                  <th className="px-4 py-2 text-left font-semibold">Metric</th>
                  <th className="px-4 py-2 text-right font-semibold text-red-300">Worst</th>
                  <th className="px-4 py-2 text-right font-semibold text-slate-300">Base</th>
                  <th className="px-4 py-2 text-right font-semibold text-emerald-300">Best</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow label="Revenue"
                  worst={three.worst.summary.revenueCents} base={three.base.summary.revenueCents} best={three.best.summary.revenueCents}
                  vWorst={three.varianceVsBase.worst.revenueCents} vBest={three.varianceVsBase.best.revenueCents} />
                <MetricRow label="Gross margin" pct
                  worst={three.worst.summary.grossMarginBps} base={three.base.summary.grossMarginBps} best={three.best.summary.grossMarginBps}
                  vWorst={three.varianceVsBase.worst.grossMarginBps} vBest={three.varianceVsBase.best.grossMarginBps} />
                <MetricRow label="Net income"
                  worst={three.worst.summary.netIncomeCents} base={three.base.summary.netIncomeCents} best={three.best.summary.netIncomeCents}
                  vWorst={three.varianceVsBase.worst.netIncomeCents} vBest={three.varianceVsBase.best.netIncomeCents} />
                <MetricRow label="Ending cash" strong
                  worst={three.worst.summary.endingCashCents} base={three.base.summary.endingCashCents} best={three.best.summary.endingCashCents}
                  vWorst={three.varianceVsBase.worst.endingCashCents} vBest={three.varianceVsBase.best.endingCashCents} />
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-2xs text-slate-500 flex items-center gap-1 border-t border-slate-800/50">
            <Info size={11} /> Ending cash = beginning cash + net income (a net-income-to-cash proxy; working-capital timing is out of scope for what-if).
          </p>
        </div>
      )}

      {/* Sensitivity */}
      {sensitivity && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <SlidersHorizontal size={13} className="text-indigo-400" />
            <span className="text-xs font-semibold uppercase text-slate-400">One-driver sensitivity</span>
            <select value={axis} onChange={(e) => setAxis(e.target.value as SensitivityAxis)}
              className="ml-2 px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
              {(Object.keys(AXIS_LABEL) as SensitivityAxis[]).map((a) => <option key={a} value={a}>{AXIS_LABEL[a]}</option>)}
            </select>
            <span className="text-2xs text-slate-500 ml-auto">Holds Base overrides; sweeps one lever.</span>
          </div>

          <input type="range" min={0} max={sensitivity.points.length - 1} value={sensIndex}
            onChange={(e) => setSensIndex(parseInt(e.target.value, 10))}
            className="w-full accent-indigo-500 mb-3" />

          {(() => {
            const pt = sensitivity.points[sensIndex];
            const maxAbs = Math.max(1, ...sensitivity.points.map((p) => Math.abs(p.netIncomeCents)));
            const axisVal = axis === 'headcount' ? `${pt.value > 0 ? '+' : ''}${pt.value} heads` : `${(pt.value / 100).toFixed(1)}%`;
            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <SensStat label={AXIS_LABEL[axis]} value={axisVal} accent />
                  <SensStat label="Revenue" value={formatMoney(pt.revenueCents, { compact: true })} />
                  <SensStat label="Gross margin" value={`${(pt.grossMarginBps / 100).toFixed(1)}%`} />
                  <SensStat label="Net income" value={formatMoney(pt.netIncomeCents, { compact: true })} />
                </div>
                <div className="space-y-1">
                  {sensitivity.points.map((p, i) => {
                    const w = Math.round((Math.abs(p.netIncomeCents) / maxAbs) * 100);
                    const neg = p.netIncomeCents < 0;
                    const label = axis === 'headcount' ? `${p.value > 0 ? '+' : ''}${p.value}` : `${(p.value / 100).toFixed(0)}%`;
                    return (
                      <button key={i} onClick={() => setSensIndex(i)}
                        className={clsx('w-full flex items-center gap-2 text-2xs group', i === sensIndex && 'font-semibold')}>
                        <span className={clsx('w-12 text-right font-mono shrink-0', i === sensIndex ? 'text-white' : 'text-slate-500')}>{label}</span>
                        <span className="flex-1 h-4 bg-slate-800/40 rounded overflow-hidden relative">
                          <span className={clsx('absolute inset-y-0 rounded', neg ? 'right-1/2 bg-red-500/60' : 'left-1/2 bg-emerald-500/60', i === sensIndex && 'ring-1 ring-white/40')}
                            style={{ width: `${w / 2}%` }} />
                          <span className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
                        </span>
                        <span className={clsx('w-20 text-right font-mono shrink-0', i === sensIndex ? 'text-slate-200' : 'text-slate-500')}>{formatMoney(p.netIncomeCents, { compact: true })}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Saved scenarios */}
      {savedList.length > 0 && (
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase text-slate-500 mb-2">Saved scenarios ({savedList.length})</div>
          <div className="space-y-1.5">
            {savedList.map((s) => {
              // The saved record stores only the scenario definition; recompute the
              // three-case result from it (pure) so the row can preview net income.
              const result = buildThreeCase({
                name: s.name,
                baseDrivers: s.definition.baseDrivers,
                beginningCashCents: s.definition.beginningCashCents,
                cases: s.definition.cases,
              });
              return (
                <button key={s.id} onClick={() => loadSaved(s)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/30 hover:bg-slate-800/60 text-left transition-colors">
                  <Sparkles size={13} className="text-indigo-400 shrink-0" />
                  <span className="text-xs text-slate-200 font-medium">{s.name}</span>
                  <span className="ml-auto flex items-center gap-3 font-mono text-2xs">
                    <span className="text-red-300">{formatMoney(result.worst.summary.netIncomeCents, { compact: true })}</span>
                    <span className="text-slate-400">{formatMoney(result.base.summary.netIncomeCents, { compact: true })}</span>
                    <span className="text-emerald-300">{formatMoney(result.best.summary.netIncomeCents, { compact: true })}</span>
                  </span>
                  <span className="text-2xs text-slate-600 shrink-0">{new Date(s.savedAt).toLocaleDateString()}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const CASE_META: Record<CaseKey, { label: string; icon: typeof TrendingUp; ring: string; text: string }> = {
  best: { label: 'Best case', icon: TrendingUp, ring: 'border-emerald-500/30', text: 'text-emerald-400' },
  base: { label: 'Base case', icon: Minus, ring: 'border-slate-700', text: 'text-slate-300' },
  worst: { label: 'Worst case', icon: TrendingDown, ring: 'border-red-500/30', text: 'text-red-400' },
};

function CaseEditor({ caseKey, levers, onChange }: { caseKey: CaseKey; levers: CaseLevers; onChange: (p: Partial<CaseLevers>) => void }) {
  const meta = CASE_META[caseKey];
  const Icon = meta.icon;
  return (
    <div className={clsx('card p-3.5 border', meta.ring)}>
      <div className={clsx('flex items-center gap-1.5 text-xs font-semibold uppercase mb-3', meta.text)}>
        <Icon size={13} /> {meta.label}
      </div>
      <div className="space-y-2.5">
        <LeverInput label="Revenue growth" suffix="%" value={levers.revenueGrowthPct} onChange={(v) => onChange({ revenueGrowthPct: v })} placeholder="0" />
        <LeverInput label="Cost change (COGS+OPEX)" suffix="%" value={levers.costChangePct} onChange={(v) => onChange({ costChangePct: v })} placeholder="0" />
        <LeverInput label="Headcount change" suffix="heads" value={levers.headcountDelta} onChange={(v) => onChange({ headcountDelta: v })} placeholder="0" />
      </div>
    </div>
  );
}

function LeverInput({ label, value, onChange, placeholder, suffix }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string }) {
  return (
    <label className="block">
      <span className="block text-2xs uppercase text-slate-500 mb-1">{label}</span>
      <div className="relative">
        <input type="text" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-slate-900/60 border border-slate-800 rounded text-right font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50" />
        {suffix && <span className="absolute right-2 top-1.5 text-2xs text-slate-500">{suffix}</span>}
      </div>
    </label>
  );
}

function AssumptionInput({ icon: Icon, label, value, onChange, placeholder }: { icon?: typeof Wallet; label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-2xs uppercase text-slate-500 mb-1 flex items-center gap-1">{Icon && <Icon size={11} />}{label}</span>
      <input type="text" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-[150px] px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-right font-mono text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50" />
    </label>
  );
}

function MetricRow({ label, worst, base, best, vWorst, vBest, pct, strong }: {
  label: string; worst: number; base: number; best: number; vWorst: number; vBest: number; pct?: boolean; strong?: boolean;
}) {
  const fmt = (v: number) => (pct ? `${(v / 100).toFixed(1)}%` : formatMoney(v));
  const fmtVar = (v: number) => {
    const s = pct ? `${(v / 100).toFixed(1)} pts` : formatMoney(Math.abs(v), { compact: true });
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
  };
  const varColor = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-500');
  return (
    <tr className={clsx('border-b border-slate-800/40 hover:bg-slate-800/20', strong && 'bg-slate-800/10')}>
      <td className={clsx('px-4 py-2.5 text-slate-300', strong && 'font-semibold text-slate-200')}>{label}</td>
      <td className="px-4 py-2.5 text-right font-mono">
        <div className="text-slate-200">{fmt(worst)}</div>
        <div className={clsx('text-2xs', varColor(vWorst))}>{fmtVar(vWorst)}</div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(base)}</td>
      <td className="px-4 py-2.5 text-right font-mono">
        <div className="text-slate-200">{fmt(best)}</div>
        <div className={clsx('text-2xs', varColor(vBest))}>{fmtVar(vBest)}</div>
      </td>
    </tr>
  );
}

function SensStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={clsx('rounded-lg p-2.5 border', accent ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-slate-800/30 border-slate-800')}>
      <div className="text-2xs uppercase text-slate-500">{label}</div>
      <div className={clsx('text-sm font-mono font-semibold mt-0.5', accent ? 'text-indigo-300' : 'text-slate-200')}>{value}</div>
    </div>
  );
}
