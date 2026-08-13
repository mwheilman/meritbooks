'use client';

import { useState, useMemo, useCallback, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Building2, BookOpen, Scale, Landmark, Users, Rocket, Check, Loader2, AlertCircle,
  ArrowLeft, ArrowRight, Sparkles, Percent, CircleCheck, ChevronRight, Plus, ShieldCheck,
  Plug, Upload,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { PlaidLinkButton } from '@/components/integrations/plaid-link-button';
import { ConnectErpStep } from '@/components/integrations/connect-erp-step';
import ConversionClient from './conversion/conversion-client';
import { ReadinessChecklist } from './readiness-checklist';
import {
  SourceTile, ProposalCard, TieOutBanner, SetupHomeBoard,
} from '@/components/onboarding';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/company-scope';
import type { OnboardingStepKey, OnboardingStatus } from '@/lib/onboarding/status';
import { WIZARD_FLOW_SECTIONS } from '@/lib/onboarding/sections/registry';

// ── Shared shapes ─────────────────────────────────────────────────────────────
interface EntityRow {
  id: string;
  name: string;
  shortCode: string;
  industry: string | null;
  fiscalYearStartMonth: number;
  revRecMethod: string;
  isActive: boolean;
}
interface EntitiesMeta {
  baseCurrency: string;
  orgFiscalYearStartMonth: number;
  entities: EntityRow[];
}
interface CreateEntityResult { locationId: string; periodsCreated: number; accountCount: number }

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i).toLocaleString('en', { month: 'long' }),
}));

const REV_REC_METHODS: { value: string; label: string; help: string }[] = [
  { value: 'POINT_OF_SALE', label: 'Point of sale', help: 'Retail, restaurants, e-commerce — recognize revenue the moment you invoice.' },
  { value: 'AS_BILLED', label: 'Billing-based (as billed)', help: 'Time & materials — revenue equals what you bill, as each invoice goes out.' },
  { value: 'PCT_COSTS_INCURRED', label: '% of costs incurred (cost-to-cost)', help: 'Construction and long jobs — recognize as costs are incurred. The contractor default.' },
  { value: 'PCT_COMPLETE', label: '% complete (physical)', help: 'Recognize by measured physical progress rather than by cost.' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed contract', help: 'Short or uncertain jobs — hold all revenue until the job is complete.' },
  { value: 'MILESTONE', label: 'Milestone / point-in-time', help: 'Recognize in chunks as each defined milestone is accepted.' },
  { value: 'RATABLY', label: 'Straight-line / ratable', help: 'Retainers and fixed-term agreements — spread evenly across the term.' },
  { value: 'SUBSCRIPTION', label: 'Subscription (ratable)', help: 'SaaS and memberships — recognize evenly across each billing period.' },
  { value: 'CASH', label: 'Cash basis', help: 'Recognize revenue only when the payment lands.' },
];

const TEAM_ROLES: { value: string; label: string; desc: string }[] = [
  { value: 'company_admin', label: 'Admin', desc: 'Full access to everything' },
  { value: 'cfo', label: 'CFO', desc: 'Financial oversight; approves COA changes' },
  { value: 'merit_controller', label: 'Controller', desc: 'Owns the close and controls' },
  { value: 'assistant_cfo', label: 'Assistant CFO', desc: 'Financial oversight support' },
  { value: 'accounting_manager', label: 'Accounting Manager', desc: 'Day-to-day accounting, review' },
  { value: 'accounting_specialist', label: 'Accounting Specialist', desc: 'Data entry, categorize, receipts' },
  { value: 'check_processor', label: 'Check Processor', desc: 'Print and manage checks only' },
  { value: 'general_admin', label: 'General Admin', desc: 'Administrative access' },
  { value: 'business_user', label: 'Business User', desc: 'Read-only dashboards and reports' },
];

// The wizard flow is now DRIVEN BY THE SECTION REGISTRY: the ordered domain sections
// come from `ONBOARDING_SECTIONS` (single source of truth for key/label/icon), plus
// the terminal `launch` step which is a flow step, not a setup domain. The values are
// identical to what was hard-coded here, so the Stepper renders exactly as before.
const STEPS: { key: OnboardingStepKey; label: string; icon: typeof Building2 }[] = [
  ...WIZARD_FLOW_SECTIONS.map((s) => ({ key: s.key as OnboardingStepKey, label: s.label, icon: s.icon })),
  { key: 'launch', label: 'Launch', icon: Rocket },
];

const inputCls = 'w-full px-3 py-2 bg-surface-900 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50';
const labelCls = 'block text-xs text-slate-500 mb-1.5 font-medium';

/**
 * Pin the active company by writing the documented company-scope cookie. The name
 * comes from `lib/company-scope.ts` (single source of truth) so the header selector,
 * useQuery auto-scoping, server components, and the processing-page guard all read
 * the same value. Mirrors the client mechanism in use-active-company's writeCookie.
 */
function writeActiveCompanyCookie(id: string) {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${ACTIVE_COMPANY_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${oneYear}; samesite=lax`;
  } catch {
    /* document unavailable (SSR) — ignore */
  }
}

// ════════════════════════════════════════════════════════════════════════════
export function OnboardingWizard() {
  const { data: meta, isLoading: metaLoading, refetch: refetchMeta } = useQuery<EntitiesMeta>('/api/settings/entities');

  const [step, setStep] = useState<OnboardingStepKey>('welcome');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [createdAccounts, setCreatedAccounts] = useState<number | null>(null);
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  // Source-first entry: which source the user chose on the opening screen. Drives the
  // tailored copy + the forward route (connect / upload / start-fresh). Local-only —
  // it steers the flow, it is not itself a persisted setup fact.
  const [source, setSource] = useState<BookSource | null>(null);

  // Load status once → resume the saved/derived step.
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/status');
      if (res.ok) {
        const s = (await res.json()) as OnboardingStatus & { orgResolved?: boolean };
        setStatus(s);
        if (!statusLoaded && s.currentStep && !s.complete) setStep(s.currentStep);
      }
    } catch {
      /* status is best-effort; the wizard still runs from step 1 */
    } finally {
      setStatusLoaded(true);
    }
  }, [statusLoaded]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const entities = meta?.entities ?? [];
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // The company the user will ENTER on finish: the one created in this session,
  // else the tenant's single/first company. Onboarding then pins it and drops the
  // user into that company's workspace so processing is already company-scoped.
  const enterCompany = useMemo(
    () => entities.find((e) => e.id === createdCompanyId) ?? entities[0] ?? null,
    [entities, createdCompanyId],
  );

  // Persist the step as the user advances (degrade-safe; never blocks navigation).
  const persistStep = useCallback((next: OnboardingStepKey) => {
    void fetch('/api/onboarding/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStep: next }),
    }).catch(() => { /* best-effort */ });
  }, []);

  const goTo = useCallback((next: OnboardingStepKey) => {
    setStep(next);
    persistStep(next);
  }, [persistStep]);

  const goNext = useCallback(() => {
    const ni = Math.min(stepIndex + 1, STEPS.length - 1);
    goTo(STEPS[ni].key);
  }, [stepIndex, goTo]);

  const goBack = useCallback(() => {
    const pi = Math.max(stepIndex - 1, 0);
    goTo(STEPS[pi].key);
  }, [stepIndex, goTo]);

  const finish = useCallback(async () => {
    setFinishing(true);
    try {
      await fetch('/api/onboarding/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complete: true, currentStep: 'launch' }),
      });

      // Pin the freshly-created company as ACTIVE and drop the user straight into
      // its workspace, so they land already company-scoped (the control that
      // processing happens inside exactly one company). A hard navigation forces
      // the app shell + providers to re-init from the cookie with the new company
      // now present in /api/me — avoiding a stale-locations reconcile that would
      // otherwise reset the scope to consolidated.
      if (enterCompany) {
        writeActiveCompanyCookie(enterCompany.id);
        addToast('success', `You are live — entering ${enterCompany.name}.`);
        window.location.assign('/bank-feed');
        return;
      }

      addToast('success', 'You are live — your book of record is set up.');
      window.location.assign('/dashboard');
    } catch {
      addToast('error', 'Could not finish onboarding. Please try again.');
      setFinishing(false);
    }
  }, [enterCompany]);

  // GENERIC SHELL: each registered section (+ the terminal launch step) maps to its
  // body here, and the shell renders the one for the active step. The existing step
  // components are WRAPPED unchanged — no step's logic is rebuilt — so the wizard
  // renders identically to before while being driven by the registry-derived STEPS.
  const stepBodies: Record<OnboardingStepKey, ReactNode> = {
    welcome: (
      <SourceStep
        meta={meta ?? null}
        entities={entities}
        source={source}
        onPickSource={setSource}
        onGoTo={goTo}
        onContinue={goNext}
        onCreated={async (r) => {
          setCreatedAccounts(r.accountCount);
          setCreatedCompanyId(r.locationId);
          await refetchMeta();
          await loadStatus();
        }}
      />
    ),
    coa: <CoaStep accountCount={createdAccounts ?? status?.counts.accounts ?? 0} />,
    opening: (
      <OpeningStep
        companyId={enterCompany?.id ?? null}
        hasOpeningEntry={status?.hasOpeningEntry ?? false}
      />
    ),
    bank: <BankStep entities={entities} />,
    erp: <ErpStep onSkip={goNext} onDone={goNext} />,
    team: <TeamStep entities={entities} />,
    launch: (
      <LaunchStep
        status={status}
        entities={entities}
        enterCompanyName={enterCompany?.name ?? null}
        accountCount={createdAccounts ?? status?.counts.accounts ?? 0}
        teamMembers={status?.counts.teamMembers ?? 0}
        hasOpeningEntry={status?.hasOpeningEntry ?? false}
        onRefresh={loadStatus}
      />
    ),
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-2">
            <Sparkles size={20} className="text-brand-400" /> Set up your book of record
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            A guided path from an empty tenant to a live general ledger — create your company, load a chart of
            accounts, bring in opening balances that tie out, connect your bank, and invite your team.
          </p>
        </div>
        <Link href="/dashboard" className="shrink-0 text-xs text-slate-500 hover:text-slate-300 transition-colors mt-1">
          Skip for now
        </Link>
      </div>

      {status?.complete && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
          <CircleCheck size={15} /> This tenant is already live. You can revisit any step to add companies, balances, banks, or teammates.
        </div>
      )}

      {/* First-run readiness checklist — live status + deep-links to what's left */}
      <ReadinessChecklist onJump={goTo} compact />

      {/* Progress */}
      <Stepper step={step} stepIndex={stepIndex} onJump={(k, i) => { if (i <= stepIndex) goTo(k); }} />

      {/* Body */}
      {metaLoading || !statusLoaded ? (
        <div className="card p-6 flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        </div>
      ) : (
        <>
          {stepBodies[step]}

          {/* Nav */}
          <div className="flex items-center justify-between pt-2">
            {stepIndex > 0 ? (
              <button onClick={goBack} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800/50 transition-colors">
                <ArrowLeft size={14} /> Back
              </button>
            ) : (
              <span />
            )}

            {step === 'launch' ? (
              <button
                onClick={finish}
                disabled={finishing}
                className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                  finishing ? 'bg-slate-700 text-slate-500' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
              >
                {finishing ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                {enterCompany ? `Finish & enter ${enterCompany.shortCode || enterCompany.name}` : 'Finish & go to dashboard'}
              </button>
            ) : step === 'welcome' ? (
              // The source-first entry step owns its own forward navigation (connect /
              // upload / start-fresh), so the generic Continue is suppressed here.
              <span />
            ) : (
              <button
                onClick={goNext}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium transition-colors bg-brand-500 text-slate-900 hover:bg-brand-400"
              >
                Continue <ArrowRight size={14} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Progress indicator ────────────────────────────────────────────────────────
function Stepper({
  step, stepIndex, onJump,
}: {
  step: OnboardingStepKey;
  stepIndex: number;
  onJump: (key: OnboardingStepKey, index: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const active = s.key === step;
        const done = i < stepIndex;
        const reachable = i <= stepIndex;
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <button
              onClick={() => onJump(s.key, i)}
              disabled={!reachable}
              className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
                active ? 'bg-brand-500/10 text-brand-300 font-medium'
                  : done ? 'text-brand-400/80 hover:bg-slate-800/50'
                    : 'text-slate-500 cursor-default')}
            >
              <span className={clsx('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
                active ? 'bg-brand-500 text-slate-900' : done ? 'bg-brand-500/80 text-slate-900' : 'bg-slate-800 text-slate-500')}>
                {done ? <Check size={12} /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
              <Icon size={14} className="sm:hidden" />
            </button>
            {i < STEPS.length - 1 && <ChevronRight size={13} className="text-slate-700" />}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Source-first entry ("Where do your books live today?") ─────────────
// The first thing onboarding asks is not a field, it's a SOURCE (design spec §1).
// The choice steers the forward route: connect an ERP, upload a trial balance, or
// start clean. Whatever the source, a company must exist to hold the book of record,
// so we still confirm/create it — framed as confirm-not-configure.

/** The sources a customer's books can live in today. */
type BookSource = 'quickbooks' | 'xero' | 'sage' | 'upload' | 'fresh';

interface SourceTileConfig {
  kind: BookSource;
  icon: ReactNode;
  title: string;
  subtitle: string;
}

const SOURCE_TILES: SourceTileConfig[] = [
  { kind: 'quickbooks', icon: <span className="font-mono">qb</span>, title: 'QuickBooks', subtitle: 'Connect & import' },
  { kind: 'xero', icon: <span className="font-mono">X</span>, title: 'Xero', subtitle: 'Connect & import' },
  { kind: 'sage', icon: <span className="font-mono">S</span>, title: 'Sage', subtitle: 'Connect & import' },
  { kind: 'upload', icon: <Upload size={16} />, title: 'Upload files', subtitle: 'Trial balance / exports' },
  { kind: 'fresh', icon: <Sparkles size={16} />, title: 'Start fresh', subtitle: 'New books, no import' },
];

const ERP_SOURCES: BookSource[] = ['quickbooks', 'xero', 'sage'];
const SOURCE_LABEL: Record<BookSource, string> = {
  quickbooks: 'QuickBooks', xero: 'Xero', sage: 'Sage', upload: 'your files', fresh: 'a clean start',
};

/** Persist an explicit "no prior balances" so the readiness gate treats opening as met. */
async function markOpeningSkipped() {
  try {
    await fetch('/api/onboarding/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'opening', status: 'skipped' }),
    });
  } catch { /* best-effort — the tie-out gate still governs any later import */ }
}

function SourceStep({
  meta, entities, source, onPickSource, onCreated, onGoTo, onContinue,
}: {
  meta: EntitiesMeta | null;
  entities: EntityRow[];
  source: BookSource | null;
  onPickSource: (s: BookSource) => void;
  onCreated: (r: CreateEntityResult) => Promise<void>;
  onGoTo: (step: OnboardingStepKey) => void;
  onContinue: () => void;
}) {
  const hasCompany = entities.length > 0;
  const companyName = entities[0]?.name;

  // The forward action for the chosen source. Enabled only once a company exists.
  const forward = useMemo(() => {
    if (!source) return null;
    if (ERP_SOURCES.includes(source)) {
      return { label: `Connect ${SOURCE_LABEL[source]} & bring your books over`, run: () => onGoTo('erp') };
    }
    if (source === 'upload') {
      return { label: 'Upload your trial balance', run: () => onGoTo('opening') };
    }
    // fresh — no import; record the explicit clean start, then continue.
    return {
      label: 'Start clean — no import',
      run: async () => { await markOpeningSkipped(); onContinue(); },
    };
  }, [source, onGoTo, onContinue]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Where do your books live today?</h2>
        <p className="text-sm text-slate-400 mt-1.5 max-w-2xl">
          First question — and almost the only one. Connect your system or drop your files and we&apos;ll bring
          everything over. You review; you don&apos;t re-enter. Starting a brand-new business? Begin clean.
        </p>
      </div>

      <div role="radiogroup" aria-label="Where your books live today" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SOURCE_TILES.map((t) => (
          <SourceTile
            key={t.kind}
            icon={t.icon}
            title={t.title}
            subtitle={t.subtitle}
            selected={source === t.kind}
            onSelect={() => onPickSource(t.kind)}
          />
        ))}
      </div>

      {source && (
        <div className="space-y-4 pt-1">
          {/* Confirm-or-create the company that will hold the book of record. */}
          <CompanyConfirm meta={meta} entities={entities} source={source} onCreated={onCreated} />

          {/* Source-tailored forward action — gated on a company existing. */}
          {forward && (
            <div className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-3.5 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {hasCompany
                  ? <>Next{companyName ? <> for <span className="text-slate-300">{companyName}</span></> : ''}: {ERP_SOURCES.includes(source) ? 'connect and we’ll propose a complete, tied-out setup.' : source === 'upload' ? 'drop your trial balance and tie out to the penny.' : 'your ledger starts empty — add anything later on your setup board.'}</>
                  : 'Create your company above to continue.'}
              </p>
              <button
                type="button"
                onClick={() => void forward.run()}
                disabled={!hasCompany}
                className={clsx('shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  hasCompany ? 'bg-brand-500 text-slate-900 hover:bg-brand-400' : 'bg-slate-700 text-slate-500 cursor-not-allowed')}
              >
                {forward.label} <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Company confirm/create — framed as confirm-not-configure (reuses /api/settings/entities) ──
function CompanyConfirm({
  meta, entities, source, onCreated,
}: {
  meta: EntitiesMeta | null;
  entities: EntityRow[];
  source: BookSource;
  onCreated: (r: CreateEntityResult) => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(entities.length === 0);
  const [name, setName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [industry, setIndustry] = useState('');
  const [fiscalMonth, setFiscalMonth] = useState<number | null>(null);
  const [revRec, setRevRec] = useState('POINT_OF_SALE');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const baseCurrency = meta?.baseCurrency ?? 'USD';
  const effectiveFiscalMonth = fiscalMonth ?? meta?.orgFiscalYearStartMonth ?? 1;

  const existingCodes = useMemo(() => new Set(entities.map((e) => e.shortCode.toUpperCase())), [entities]);
  const codeUpper = shortCode.toUpperCase();
  const codeValid = /^[A-Z0-9]{1,10}$/.test(codeUpper);
  const codeDuplicate = codeValid && existingCodes.has(codeUpper);
  const valid = name.trim().length > 0 && codeValid && !codeDuplicate;

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError('');
    try {
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
      const body = (await res.json().catch(() => ({}))) as CreateEntityResult & { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Failed to create the company');
      } else {
        addToast('success', `${name.trim()} created — ${body.accountCount} accounts seeded.`);
        setName(''); setShortCode(''); setIndustry(''); setFiscalMonth(null); setRevRec('POINT_OF_SALE');
        setShowForm(false);
        await onCreated(body);
      }
    } catch {
      setError('Network error creating the company');
    } finally {
      setSubmitting(false);
    }
  }, [name, codeUpper, industry, effectiveFiscalMonth, revRec, onCreated]);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-2">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Building2 size={18} className="text-brand-400" />
          {entities.length > 0 ? 'Your company' : source === 'fresh' ? 'Name your company' : 'Confirm your company'}
        </h2>
        <p className="text-xs text-slate-500">
          {source === 'fresh'
            ? 'Each company is its own book of record — its own general ledger, bank accounts, and statements. We generate three years of fiscal periods and seed the chart of accounts.'
            : 'This company will hold the book of record we bring your data into. Confirm the details below — everything else comes from your import.'}
        </p>
      </div>

      {entities.length > 0 && (
        <div className="card p-5 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Companies in this tenant</p>
          <div className="space-y-1.5">
            {entities.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-lg bg-surface-900 border border-slate-800 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-md bg-brand-500/10 flex items-center justify-center">
                    <Building2 size={14} className="text-brand-400" />
                  </div>
                  <div>
                    <p className="text-sm text-white">{e.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono">{e.shortCode}{e.industry ? ` · ${e.industry}` : ''}</p>
                  </div>
                </div>
                <span className="flex items-center gap-1 text-[11px] text-brand-400"><Check size={12} /> Ready</span>
              </div>
            ))}
          </div>
          {!showForm && (
            <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand-400 transition-colors">
              <Plus size={13} /> Add another company
            </button>
          )}
        </div>
      )}

      {showForm && (
        <div className="card p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={labelCls}>Company name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Acme Manufacturing LLC" autoFocus />
            </div>
            <div>
              <label className={labelCls}>Short code</label>
              <input
                value={shortCode}
                onChange={(e) => setShortCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                className={clsx(inputCls, 'font-mono', codeDuplicate && 'border-danger/60')}
                placeholder="ACME"
              />
              {codeDuplicate
                ? <p className="text-[10px] text-danger-fg mt-1">That short code is already in use.</p>
                : <p className="text-[10px] text-slate-600 mt-1">Uppercase letters & numbers; shown on GL entries.</p>}
            </div>
            <div>
              <label className={labelCls}>Industry <span className="text-slate-600">(optional)</span></label>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} className={inputCls} placeholder="Manufacturing" />
            </div>
            <div>
              <label className={labelCls}>Fiscal year start</label>
              <select value={effectiveFiscalMonth} onChange={(e) => setFiscalMonth(Number(e.target.value))} className={inputCls}>
                {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Base currency</label>
              <div className="w-full px-3 py-2 bg-surface-900/50 border border-slate-700/60 rounded-lg text-sm text-slate-300 flex items-center gap-2">
                <Landmark size={14} className="text-slate-500" /> {baseCurrency}
                <span className="ml-auto text-[10px] text-slate-600">from organization</span>
              </div>
            </div>
          </div>
          <div>
            <label className={labelCls}><Percent size={11} className="inline mr-1 -mt-0.5" /> Default revenue recognition</label>
            <select value={revRec} onChange={(e) => setRevRec(e.target.value)} className={inputCls}>
              {REV_REC_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <div className="mt-2 p-3 rounded-lg bg-ai/5 border border-ai/20 text-xs text-slate-400 flex gap-2">
              <Sparkles size={13} className="text-ai-fg shrink-0 mt-0.5" />
              <span>{REV_REC_METHODS.find((m) => m.value === revRec)?.help} Refine it per job type later in Settings → Revenue Recognition.</span>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger-fg flex items-center gap-2">
              <AlertCircle size={15} /> {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={!valid || submitting}
              className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                !valid || submitting ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Create company
            </button>
            {entities.length > 0 && (
              <button onClick={() => setShowForm(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
            )}
          </div>
        </div>
      )}

      {entities.length === 0 && !showForm && (
        <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
          <Plus size={14} /> Add your first company
        </button>
      )}
    </div>
  );
}

// ── Step 2: Chart of accounts (review, don't build) ────────────────────────────
function CoaStep({ accountCount }: { accountCount: number }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <BookOpen size={18} className="text-brand-400" /> Chart of accounts
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            A comprehensive, standardized chart is seeded automatically when you create a company — 7 account
            types, 11 sub-types, 71 groups. Every account carries a role the posting engine understands.
          </p>
        </div>

        {accountCount > 0 ? (
          <>
            <ProposalCard
              title={<>We set up a complete chart — <span className="font-mono tabular-nums">{accountCount}</span> accounts, every one role-mapped.</>}
              subtitle="Why: a standardized, posting-engine-ready chart so your reports work on day one. Bringing your own? You map it onto this chart when you import opening balances — no re-keying."
              confidence="high"
              accepted={accepted}
              onAccept={() => setAccepted(true)}
              onEdit={() => { window.location.assign('/chart-of-accounts'); }}
            />
            <div className="rounded-xl border border-brand-500/20 bg-brand-500/5 p-6 text-center">
              <CircleCheck className="w-10 h-10 mx-auto text-brand-400 mb-2" />
              <p className="text-2xl font-mono font-semibold text-white tabular-nums">{accountCount}</p>
              <p className="text-sm text-slate-400 mt-0.5">accounts ready</p>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-warning/25 bg-warning/5 p-5 text-sm text-warning-fg flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>No accounts yet. Create a company on the previous step — that seeds the standard chart automatically.</span>
          </div>
        )}

        <div className="rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3 text-xs text-slate-400 space-y-2">
          <p className="flex items-start gap-2">
            <Sparkles size={13} className="text-ai-fg shrink-0 mt-0.5" />
            <span>Bringing your own chart? You don&apos;t re-key it. In the next step you upload your prior trial
              balance and map each of your accounts onto this chart — that mapping is how your account names and
              balances come across.</span>
          </p>
          <p className="text-slate-500">
            Need extra accounts or renamed ones? Add or edit them any time in{' '}
            <Link href="/chart-of-accounts" className="text-brand-400 hover:underline">Chart of Accounts</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Opening balances (reuses the historical-conversion pipeline) ────────
interface TbRow { total_debits: number | null; total_credits: number | null }

function OpeningStep({ companyId, hasOpeningEntry }: { companyId: string | null; hasOpeningEntry: boolean }) {
  // Crown the tie-out with the real, posted totals once opening balances exist. The
  // books balance by construction (the DB trigger rejects an unbalanced entry), so
  // summing the live trial balance is an HONEST "balanced to the penny" — no dollar
  // is authored here, only read back. Degrade-safe: on any error the banner simply
  // isn't shown and the conversion tool below (with its own live numbers) governs.
  const [tbTotals, setTbTotals] = useState<{ debitsCents: number; creditsCents: number } | null>(null);

  useEffect(() => {
    if (!hasOpeningEntry || !companyId) { setTbTotals(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/gl/trial-balance?location_id=${encodeURIComponent(companyId)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { data?: TbRow[] };
        const rows = body.data ?? [];
        const debitsCents = rows.reduce((s, r) => s + (r.total_debits ?? 0), 0);
        const creditsCents = rows.reduce((s, r) => s + (r.total_credits ?? 0), 0);
        if (!cancelled) setTbTotals({ debitsCents, creditsCents });
      } catch { /* best-effort crown; conversion tool below still shows live numbers */ }
    })();
    return () => { cancelled = true; };
  }, [hasOpeningEntry, companyId]);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-2">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Scale size={18} className="text-brand-400" /> Opening balances
        </h2>
        <p className="text-xs text-slate-500">
          Upload your prior trial balance. AI proposes how each account maps onto your chart — it never sees or
          changes a balance — then you tie out and post one balanced opening entry. Go-live is blocked until
          debits equal credits and a person has confirmed the tie-out.
        </p>
        <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-1">
          <ShieldCheck size={13} className="text-brand-400" />
          Brand-new business with no history? Skip this — just continue, and your ledger starts clean.
        </div>
      </div>

      {/* The "Balanced to the penny ✓" crown — shown once opening balances are posted. */}
      {hasOpeningEntry && tbTotals && (
        <TieOutBanner
          state={tbTotals.debitsCents === tbTotals.creditsCents ? 'balanced' : 'off'}
          debitsCents={tbTotals.debitsCents}
          creditsCents={tbTotals.creditsCents}
          note="Your opening books are posted and proven — total debits = total credits."
        />
      )}

      {/* The full, existing conversion flow — reused verbatim. */}
      <div className="card p-6">
        <ConversionClient />
      </div>
    </div>
  );
}

// ── Step 4: Connect bank feed (Plaid; degrade-safe) ────────────────────────────
function BankStep({ entities }: { entities: EntityRow[] }) {
  const plaidEntities = useMemo(() => entities.map((e) => ({ id: e.id, name: e.name })), [entities]);
  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Landmark size={18} className="text-brand-400" /> Connect your bank
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Link a bank so transactions flow into the feed automatically, ready for AI categorization. You can
            always connect later from a company&apos;s Bank Feed.
          </p>
        </div>

        {plaidEntities.length === 0 ? (
          <div className="rounded-lg border border-warning/25 bg-warning/5 p-4 text-sm text-warning-fg flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>Create a company first — a bank connection is linked to a specific company.</span>
          </div>
        ) : (
          <PlaidLinkButton variant="full" entities={plaidEntities} />
        )}

        <p className="text-[11px] text-slate-600">
          If bank connections aren&apos;t enabled for this tenant yet, connecting is safe to skip — continue and
          set it up later.
        </p>
      </div>
    </div>
  );
}

// ── Step 5: Connect an existing system (ERP; optional, degrade-safe) ────────────
function ErpStep({ onSkip, onDone }: { onSkip: () => void; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-2">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Plug size={18} className="text-brand-400" /> Connect your existing systems
        </h2>
        <p className="text-xs text-slate-500">
          Already run an operational system — field service, project management, POS, an existing accounting
          package? Link it so customers, jobs, invoices, bills, and costs flow into your book of record
          automatically. This is optional — you can connect or change systems any time under Integrations.
        </p>
      </div>

      {/* The reusable connector surface, mounted in embedded mode (compact chrome,
          its own search / catalog / connected-status / CSV path / degrade notice). */}
      <div className="card p-6">
        <ConnectErpStep embedded onSkip={onSkip} onDone={onDone} />
      </div>
    </div>
  );
}

// ── Step 6: Invite team ────────────────────────────────────────────────────────
interface TeamMember { id: string; firstName: string; lastName: string; email: string | null; roleLabel: string; isActive: boolean }
interface TeamMembersResponse { data: TeamMember[]; summary: { total: number; active: number; invited: number } }

function TeamStep({ entities }: { entities: EntityRow[] }) {
  const { data, isLoading, error, refetch } = useQuery<TeamMembersResponse>('/api/team/members');
  const members = data?.data ?? [];

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState('accounting_specialist');
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const invite = useCallback(async () => {
    setSubmitting(true);
    setFormError('');
    try {
      const res = await fetch('/api/team/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          role,
          companyIds,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setFormError(body.error ?? 'Could not add that member');
      } else {
        addToast('success', `${email.trim()} added — they finish sign-in on first login.`);
        setEmail(''); setFirstName(''); setLastName(''); setRole('accounting_specialist'); setCompanyIds([]);
        await refetch();
      }
    } catch {
      setFormError('Network error adding the member');
    } finally {
      setSubmitting(false);
    }
  }, [email, firstName, lastName, role, companyIds, refetch]);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Users size={18} className="text-brand-400" /> Invite your team
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Add teammates with a role and (for scoped roles) company access. They claim the invite by signing in
            with the same email. Optional — you can do this later in Team &amp; Access.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="teammate@company.com" />
          </div>
          <div>
            <label className={labelCls}>First name <span className="text-slate-600">(optional)</span></label>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Last name <span className="text-slate-600">(optional)</span></label>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              {TEAM_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <p className="text-[10px] text-slate-600 mt-1">{TEAM_ROLES.find((r) => r.value === role)?.desc}</p>
          </div>
          {entities.length > 1 && (
            <div className="col-span-2">
              <label className={labelCls}>Company access <span className="text-slate-600">(leave empty for all)</span></label>
              <div className="flex flex-wrap gap-2">
                {entities.map((e) => {
                  const on = companyIds.includes(e.id);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setCompanyIds((p) => on ? p.filter((x) => x !== e.id) : [...p, e.id])}
                      className={clsx('px-2.5 py-1 rounded-lg text-xs border transition-colors',
                        on ? 'bg-brand-500/10 border-brand-500/30 text-brand-300' : 'bg-surface-900 border-slate-700 text-slate-500 hover:text-slate-300')}
                    >
                      {e.shortCode || e.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {formError && (
          <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger-fg flex items-center gap-2">
            <AlertCircle size={15} /> {formError}
          </div>
        )}

        <button
          onClick={invite}
          disabled={!emailValid || submitting}
          className={clsx('flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            !emailValid || submitting ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add member
        </button>
      </div>

      {/* Current roster */}
      <div className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Team ({members.length})</p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-4"><Loader2 size={14} className="animate-spin" /> Loading team…</div>
        ) : error ? (
          <div className="text-xs text-slate-500 py-2">Team roster isn&apos;t available with your permissions — that&apos;s fine, you can skip this step.</div>
        ) : members.length === 0 ? (
          <div className="text-sm text-slate-500 py-4">No teammates yet. Add one above, or continue and invite people later.</div>
        ) : (
          <div className="space-y-1.5">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg bg-surface-900 border border-slate-800 px-3 py-2">
                <div>
                  <p className="text-sm text-white">{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'Member'}</p>
                  <p className="text-[11px] text-slate-500">{m.email ?? '—'}</p>
                </div>
                <span className="text-[11px] text-slate-400">{m.roleLabel}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 7: Launch ─────────────────────────────────────────────────────────────
function LaunchStep({
  status, entities, enterCompanyName, accountCount, teamMembers, hasOpeningEntry, onRefresh,
}: {
  status: OnboardingStatus | null;
  entities: EntityRow[];
  enterCompanyName: string | null;
  accountCount: number;
  teamMembers: number;
  hasOpeningEntry: boolean;
  onRefresh: () => Promise<void>;
}) {
  useEffect(() => { void onRefresh(); }, [onRefresh]);

  const rows: { icon: typeof Building2; label: string; value: string; done: boolean }[] = [
    { icon: Building2, label: 'Companies', value: `${entities.length} created`, done: entities.length > 0 },
    { icon: BookOpen, label: 'Chart of accounts', value: `${accountCount} accounts`, done: accountCount > 0 },
    { icon: Scale, label: 'Opening balances', value: hasOpeningEntry ? 'Posted — you are live' : 'None (clean start)', done: true },
    { icon: Users, label: 'Team', value: teamMembers > 0 ? `${teamMembers} member${teamMembers === 1 ? '' : 's'}` : 'Just you (invite later)', done: true },
  ];

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-5">
        <div className="text-center">
          <div className="mx-auto mb-3 h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
            <Rocket size={28} className="text-brand-400" />
          </div>
          <h2 className="text-xl font-semibold text-white">You&apos;re ready to launch</h2>
          <p className="text-sm text-slate-400 mt-1">
            Here&apos;s what&apos;s set up. Finishing marks onboarding complete
            {enterCompanyName ? <> and drops you into <span className="text-brand-300 font-medium">{enterCompanyName}</span> to start processing.</> : ' and opens your dashboard.'}
          </p>
        </div>

        <div className="space-y-2">
          {rows.map((r) => {
            const Icon = r.icon;
            return (
              <div key={r.label} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-900 border border-slate-800">
                <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
                  r.done ? 'bg-brand-500/10' : 'bg-slate-800')}>
                  <Icon size={15} className={r.done ? 'text-brand-400' : 'text-slate-500'} />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-white font-medium">{r.label}</p>
                  <p className="text-xs text-slate-500">{r.value}</p>
                </div>
                {r.done && <Check size={16} className="text-brand-400 shrink-0" />}
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3 text-xs text-slate-400">
          After launch: connect more banks, invite additional teammates, and start capturing bills, invoices, and
          receipts. Everything from onboarding remains editable in Settings.
        </div>
      </div>

      {/* Setup Home board — the optional long tail. Everything here is add-anytime;
          nothing blocks going live. Reachable again from the readiness checklist. */}
      {status && (
        <div className="card p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-white">Your setup board</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Your books are live and tied out. Here&apos;s everything else — add each when you&apos;re ready, or
                never if it doesn&apos;t apply.
              </p>
            </div>
          </div>
          <SetupHomeBoard status={status} />
        </div>
      )}
    </div>
  );
}
