'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Building2, CalendarDays, Percent, Check, Loader2, AlertCircle, ArrowLeft, ArrowRight,
  Sparkles, Landmark, ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';

interface EntitiesMeta {
  baseCurrency: string;
  orgFiscalYearStartMonth: number;
  entities: { shortCode: string }[];
}

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i).toLocaleString('en', { month: 'long' }),
}));

const REV_REC_METHODS: { value: string; label: string; help: string }[] = [
  { value: 'POINT_OF_SALE', label: 'Point of Sale', help: 'Recognize revenue when the sale closes. Retail, product sales.' },
  { value: 'AS_BILLED', label: 'As Billed', help: 'Recognize as invoices are issued. Time & materials.' },
  { value: 'PCT_COMPLETE', label: 'Percentage of Completion', help: 'Recognize as the job progresses. Long-term construction.' },
  { value: 'PCT_COSTS_INCURRED', label: '% Costs Incurred (Cost-to-Cost)', help: 'PoC measured by costs incurred vs. total estimated.' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed Contract', help: 'Recognize all revenue at completion. Short jobs.' },
  { value: 'MILESTONE', label: 'Milestone', help: 'Recognize at defined milestones. Phased delivery.' },
  { value: 'RATABLY', label: 'Ratably (Straight-Line)', help: 'Spread evenly over the service period.' },
  { value: 'SUBSCRIPTION', label: 'Subscription', help: 'Recurring recognition over the subscription term.' },
  { value: 'CASH', label: 'Cash Basis', help: 'Recognize when cash is received.' },
];

type StepKey = 'identity' | 'fiscal' | 'review';
const STEPS: { key: StepKey; label: string; icon: typeof Building2 }[] = [
  { key: 'identity', label: 'Identity', icon: Building2 },
  { key: 'fiscal', label: 'Fiscal & Accounting', icon: CalendarDays },
  { key: 'review', label: 'Review & Create', icon: Check },
];

interface CreateResult { locationId: string; periodsCreated: number; accountCount: number }

export function NewEntityWizard() {
  const { data: meta, isLoading: metaLoading } = useQuery<EntitiesMeta>('/api/settings/entities');

  const [step, setStep] = useState<StepKey>('identity');
  const [name, setName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [industry, setIndustry] = useState('');
  const [fiscalMonth, setFiscalMonth] = useState<number | null>(null);
  const [revRec, setRevRec] = useState('POINT_OF_SALE');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CreateResult | null>(null);

  const baseCurrency = meta?.baseCurrency ?? 'USD';
  const effectiveFiscalMonth = fiscalMonth ?? meta?.orgFiscalYearStartMonth ?? 1;

  const existingCodes = useMemo(
    () => new Set((meta?.entities ?? []).map((e) => e.shortCode.toUpperCase())),
    [meta],
  );

  const codeUpper = shortCode.toUpperCase();
  const codeValid = /^[A-Z0-9]{1,10}$/.test(codeUpper);
  const codeDuplicate = codeValid && existingCodes.has(codeUpper);
  const identityValid = name.trim().length > 0 && codeValid && !codeDuplicate;

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError('');
    const res = await fetch('/api/settings/entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        short_code: codeUpper,
        industry: industry.trim() || undefined,
        fiscal_year_start_month: effectiveFiscalMonth,
        rev_rec_method: revRec,
      }),
    });
    if (res.ok) {
      setResult(await res.json());
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to create entity');
    }
    setSubmitting(false);
  }, [name, codeUpper, industry, effectiveFiscalMonth, revRec]);

  const inputCls = 'w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50';
  const labelCls = 'block text-xs text-slate-500 mb-1.5 font-medium';

  // ── Success state ──────────────────────────────────────────
  if (result) {
    return (
      <div className="max-w-xl">
        <div className="card p-8 text-center space-y-5">
          <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto">
            <Check className="w-7 h-7 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">{name.trim()} is ready</h2>
            <p className="text-sm text-slate-400 mt-1">The entity, its fiscal calendar, and its chart of accounts are set up.</p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-left">
            <div className="rounded-lg bg-slate-800/50 border border-slate-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Short Code</p>
              <p className="text-sm font-mono text-white mt-0.5">{codeUpper}</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 border border-slate-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Fiscal Periods</p>
              <p className="text-sm text-white mt-0.5">{result.periodsCreated}</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 border border-slate-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">GL Accounts</p>
              <p className="text-sm text-white mt-0.5">{result.accountCount}</p>
            </div>
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link href="/settings" className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800/50 transition-colors">
              Back to Settings
            </Link>
            <button
              onClick={() => { setResult(null); setStep('identity'); setName(''); setShortCode(''); setIndustry(''); setFiscalMonth(null); setRevRec('POINT_OF_SALE'); }}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
            >
              Add Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const active = s.key === step;
          const done = i < stepIndex;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm',
                active ? 'bg-emerald-500/10 text-emerald-400 font-medium'
                  : done ? 'text-emerald-400/70' : 'text-slate-500')}>
                {done ? <Check size={15} /> : <Icon size={15} />}
                {s.label}
              </div>
              {i < STEPS.length - 1 && <ChevronRight size={14} className="text-slate-700" />}
            </div>
          );
        })}
      </div>

      {metaLoading ? (
        <div className="card p-6 flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : (
        <>
          {/* Step 1 — Identity */}
          {step === 'identity' && (
            <div className="card p-6 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Building2 size={18} className="text-emerald-400" /> Entity Identity</h2>
                <p className="text-xs text-slate-500 mt-1">Every company you track is its own book of record inside this tenant.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className={labelCls}>Company Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Acme Manufacturing LLC" autoFocus />
                </div>
                <div>
                  <label className={labelCls}>Short Code</label>
                  <input value={shortCode} onChange={(e) => setShortCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                    className={clsx(inputCls, 'font-mono', codeDuplicate && 'border-red-500/60')} placeholder="ACME" />
                  {codeDuplicate && <p className="text-[10px] text-red-400 mt-1">This short code is already in use.</p>}
                  {!codeDuplicate && <p className="text-[10px] text-slate-600 mt-1">Uppercase letters & numbers, used on GL entries.</p>}
                </div>
                <div>
                  <label className={labelCls}>Industry <span className="text-slate-600">(optional)</span></label>
                  <input value={industry} onChange={(e) => setIndustry(e.target.value)} className={inputCls} placeholder="Manufacturing" />
                </div>
              </div>
            </div>
          )}

          {/* Step 2 — Fiscal & Accounting */}
          {step === 'fiscal' && (
            <div className="card p-6 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2"><CalendarDays size={18} className="text-emerald-400" /> Fiscal & Accounting</h2>
                <p className="text-xs text-slate-500 mt-1">Drives the reporting calendar and how revenue is recognized for this entity.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Fiscal Year Start</label>
                  <select value={effectiveFiscalMonth} onChange={(e) => setFiscalMonth(Number(e.target.value))} className={inputCls}>
                    {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <p className="text-[10px] text-slate-600 mt-1">Report periods are numbered by the calendar year they start in.</p>
                </div>
                <div>
                  <label className={labelCls}>Base Currency</label>
                  <div className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700/60 rounded-lg text-sm text-slate-300 flex items-center gap-2">
                    <Landmark size={14} className="text-slate-500" />
                    {baseCurrency}
                    <span className="ml-auto text-[10px] text-slate-600">inherited from organization</span>
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">All entities post in the tenant&apos;s home currency today.</p>
                </div>
              </div>
              <div>
                <label className={labelCls}><Percent size={11} className="inline mr-1 -mt-0.5" /> Default Revenue Recognition</label>
                <select value={revRec} onChange={(e) => setRevRec(e.target.value)} className={inputCls}>
                  {REV_REC_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <div className="mt-2 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20 text-xs text-slate-400 flex gap-2">
                  <Sparkles size={13} className="text-indigo-400 shrink-0 mt-0.5" />
                  <span>{REV_REC_METHODS.find((m) => m.value === revRec)?.help} You can refine this per job type later in Settings → Revenue Recognition.</span>
                </div>
              </div>
            </div>
          )}

          {/* Step 3 — Review */}
          {step === 'review' && (
            <div className="card p-6 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Check size={18} className="text-emerald-400" /> Review & Create</h2>
                <p className="text-xs text-slate-500 mt-1">We&apos;ll create the entity, generate three years of fiscal periods, and seed its chart of accounts.</p>
              </div>
              <dl className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
                {[
                  ['Company', name.trim() || '—'],
                  ['Short Code', codeUpper || '—'],
                  ['Industry', industry.trim() || 'Uncategorized'],
                  ['Fiscal Year Start', MONTHS.find((m) => m.value === effectiveFiscalMonth)?.label ?? '—'],
                  ['Base Currency', `${baseCurrency} (inherited)`],
                  ['Revenue Recognition', REV_REC_METHODS.find((m) => m.value === revRec)?.label ?? revRec],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-4 py-2.5 bg-slate-800/20">
                    <dt className="text-xs text-slate-500">{k}</dt>
                    <dd className="text-sm text-white">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 text-xs text-slate-400 space-y-1">
                <p className="flex items-center gap-2"><CalendarDays size={12} className="text-emerald-400" /> Fiscal periods: prior, current, and next calendar year (36 months)</p>
                <p className="flex items-center gap-2"><Landmark size={12} className="text-emerald-400" /> Chart of accounts: standard template (shared org-wide, idempotent)</p>
              </div>
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 flex items-center gap-2">
                  <AlertCircle size={15} /> {error}
                </div>
              )}
            </div>
          )}

          {/* Nav */}
          <div className="flex items-center justify-between">
            {stepIndex > 0 ? (
              <button onClick={() => setStep(STEPS[stepIndex - 1].key)} disabled={submitting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800/50 transition-colors">
                <ArrowLeft size={14} /> Back
              </button>
            ) : (
              <Link href="/settings" className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors">
                <ArrowLeft size={14} /> Cancel
              </Link>
            )}

            {step === 'identity' && (
              <button onClick={() => setStep('fiscal')} disabled={!identityValid}
                className={clsx('flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                  identityValid ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-700 text-slate-500 cursor-not-allowed')}>
                Continue <ArrowRight size={14} />
              </button>
            )}
            {step === 'fiscal' && (
              <button onClick={() => setStep('review')}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors">
                Review <ArrowRight size={14} />
              </button>
            )}
            {step === 'review' && (
              <button onClick={submit} disabled={submitting || !identityValid}
                className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                  submitting || !identityValid ? 'bg-slate-700 text-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Create Entity
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
