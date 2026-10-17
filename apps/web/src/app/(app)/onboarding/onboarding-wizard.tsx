'use client';

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Building2, BookOpen, Scale, Landmark, Rocket, Check, Loader2, AlertCircle,
  ArrowLeft, ArrowRight, Sparkles, Percent, CircleCheck, Plus, ShieldCheck,
  Plug, Upload, LayoutGrid,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { PlaidLinkButton } from '@/components/integrations/plaid-link-button';
import { ConnectErpStep } from '@/components/integrations/connect-erp-step';
import { InviteHelper } from '@/components/onboarding/invite-helper';
import ConversionClient from './conversion/conversion-client';
import { ReadinessChecklist } from './readiness-checklist';
import { SmartIntake } from './smart-intake';
import { FormationIntake } from './formation-intake';
import { SourceTile, ProposalCard, TieOutBanner } from '@/components/onboarding';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/company-scope';
import type { CompanyOnboarding, OnboardingStepKey, OnboardingStatus, SectionStatusValue } from '@/lib/onboarding/status';
import { WIZARD_FLOW_SECTIONS } from '@/lib/onboarding/sections/registry';
import {
  stepDisplayState, pickActiveCompanyId, findCompany, canFinish, opensOnBoard,
  type StepDisplayState,
} from '@/lib/onboarding/wizard-progress';
import { lastDayOfPreviousMonth } from '@/lib/onboarding/org-setup';
import { WizardStepper } from './wizard-stepper';
import { TeamStep } from './team-step';
import { LaunchStep } from './launch-step';
import { SetupBoardView } from './setup-board-view';
import { OpeningChoice, recordOpeningChoice } from './opening-choice';
import {
  QuickBooksConnectPanel, GuidedExportPanel, isQboReturnCode, type QboReturnCode,
} from './books-source-panel';

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


const inputCls = 'w-full px-3 py-2 bg-surface-900 border border-slate-700 rounded-lg text-sm text-ink-hi placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50';
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


// The wizard flow is DRIVEN BY THE SECTION REGISTRY: the ordered domain sections come
// from `WIZARD_FLOW_SECTIONS` (single source of truth for key/label/icon), plus the
// terminal `launch` step which is a flow step, not a setup domain.
const STEPS: { key: OnboardingStepKey; label: string; icon: typeof Building2 }[] = [
  ...WIZARD_FLOW_SECTIONS.map((s) => ({ key: s.key as OnboardingStepKey, label: s.label, icon: s.icon })),
  { key: 'launch', label: 'Launch', icon: Rocket },
];

/** Optional steps: moving past one without finishing records it as Skipped. */
const SKIPPABLE_STEPS: ReadonlySet<OnboardingStepKey> = new Set<OnboardingStepKey>(['bank', 'erp', 'team']);

/** What the bookkeeper would be finishing, per step (InviteHelper context). */
const STEP_TASK: Record<OnboardingStepKey, string> = {
  welcome: 'Company setup',
  coa: 'Chart of accounts review',
  opening: 'Opening balances',
  bank: 'Bank connection',
  erp: 'Connecting existing systems',
  team: 'Team invitations',
  launch: 'Go-live review',
};

/** The role an invited bookkeeper gets — one that can run onboarding (settings_acct:edit). */
const BOOKKEEPER_ROLE = 'accounting_manager';

/** Persist a section transition (best-effort; never blocks navigation). */
function persistSection(section: OnboardingStepKey, status: SectionStatusValue) {
  void fetch('/api/onboarding/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, status }),
  }).catch(() => { /* best-effort */ });
}

type WizardView = 'steps' | 'board';

/** A `?step=` value from the URL, when it names a real wizard step. */
function parseStepParam(v: string | null): OnboardingStepKey | null {
  if (!v) return null;
  return STEPS.some((s) => s.key === v) ? (v as OnboardingStepKey) : null;
}

/** A Smart Intake storage path from `?intake=` (the TB route re-validates the org prefix). */
function parseIntakeParam(v: string | null): string | null {
  return v && v.startsWith('intake/') && !v.includes('..') ? v : null;
}

/** Drop the one-shot OAuth return params (`qbo`, `qbo_reason`) so a refresh doesn't replay the message. */
function stripQboParams() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('qbo') && !url.searchParams.has('qbo_reason')) return;
    url.searchParams.delete('qbo');
    url.searchParams.delete('qbo_reason');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* non-fatal */ }
}

// ════════════════════════════════════════════════════════════════════════════
export function OnboardingWizard() {
  const {
    data: meta, isLoading: metaLoading, error: metaError, refetch: refetchMeta,
  } = useQuery<EntitiesMeta>('/api/settings/entities');

  // Deep links: `?step=opening&intake=<path>` (Smart Intake handoff), `?sessionId=`,
  // and the QuickBooks OAuth return `?qbo=<code>&qbo_reason=…`.
  const searchParams = useSearchParams();
  const urlStep = parseStepParam(searchParams?.get('step') ?? null);
  const urlIntake = parseIntakeParam(searchParams?.get('intake') ?? null);
  const urlQboRaw = searchParams?.get('qbo') ?? null;
  const urlQbo: QboReturnCode | null = isQboReturnCode(urlQboRaw) ? urlQboRaw : null;
  const urlQboReason = searchParams?.get('qbo_reason') ?? null;
  // Where the URL asked to open (wins over the saved step on the FIRST status load).
  const urlOpenStep = useRef<OnboardingStepKey | null>(urlStep ?? (urlQbo ? 'welcome' : null));

  const [step, setStep] = useState<OnboardingStepKey>(urlOpenStep.current ?? 'welcome');
  const [view, setView] = useState<WizardView>('steps');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [createdAccounts, setCreatedAccounts] = useState<number | null>(null);
  const [preferredCompanyId, setPreferredCompanyId] = useState<string | null>(null);
  // Furthest step index reached — steps before it that aren't done read "Skipped".
  const [furthest, setFurthest] = useState(0);
  const [skippedSteps, setSkippedSteps] = useState<Set<OnboardingStepKey>>(() => new Set());
  const [finishing, setFinishing] = useState(false);
  // Source-first entry: which source the user chose on the opening screen. Local-only —
  // it steers the flow, it is not itself a persisted setup fact.
  const [source, setSource] = useState<BookSource | null>(urlQbo ? 'quickbooks' : null);
  // Smart Intake handoff + a session staged by the live QuickBooks pull → the Opening step.
  const [intakePath, setIntakePath] = useState<string | null>(urlIntake);
  const [stagedSessionId, setStagedSessionId] = useState<string | null>(null);
  const [qboReturn, setQboReturn] = useState<{ code: QboReturnCode; reason: string | null } | null>(
    urlQbo ? { code: urlQbo, reason: urlQboReason } : null,
  );
  const initialized = useRef(false);

  // Load status → on the FIRST load decide where to open: the setup board on a return
  // visit after go-live, else resume the saved/derived step.
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/status');
      if (!res.ok) throw new Error('status unavailable');
      const s = (await res.json()) as OnboardingStatus & { orgResolved?: boolean };
      setStatus(s);
      setStatusError(false);
      if (!initialized.current) {
        initialized.current = true;
        const stored = new Set<OnboardingStepKey>();
        SKIPPABLE_STEPS.forEach((k) => { if (s.sections?.[k as keyof typeof s.sections]?.status === 'skipped') stored.add(k); });
        setSkippedSteps(stored);
        if (urlOpenStep.current) {
          // A deep link (Smart Intake handoff / OAuth return) chose the step — honor it.
          setFurthest((f) => Math.max(f, STEPS.findIndex((x) => x.key === urlOpenStep.current)));
        } else if (opensOnBoard(s)) {
          setView('board');
        } else if (s.currentStep) {
          setStep(s.currentStep);
          setFurthest(Math.max(0, STEPS.findIndex((x) => x.key === s.currentStep)));
        }
      }
    } catch {
      setStatusError(true);
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const entities = useMemo(() => meta?.entities ?? [], [meta]);
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // The company the wizard is working on (per-company onboarding): the one just
  // created / explicitly picked, else the first not-yet-live company, else the first.
  const activeCompanyId = useMemo(() => {
    const list = status?.companies && status.companies.length > 0
      ? status.companies
      : entities.map((e) => ({ id: e.id, live: false }));
    return pickActiveCompanyId(list, preferredCompanyId);
  }, [status, entities, preferredCompanyId]);
  const activeCompany: CompanyOnboarding | null = findCompany(status, activeCompanyId);
  const activeEntity = entities.find((e) => e.id === activeCompanyId) ?? null;
  const activeName = activeCompany?.name ?? activeEntity?.name ?? null;

  // Persist the step as the user advances (degrade-safe; never blocks navigation).
  const persistStep = useCallback((next: OnboardingStepKey) => {
    void fetch('/api/onboarding/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStep: next }),
    }).catch(() => { /* best-effort */ });
  }, []);

  const goTo = useCallback((next: OnboardingStepKey) => {
    setView('steps');
    setStep(next);
    setFurthest((f) => Math.max(f, STEPS.findIndex((s) => s.key === next)));
    persistStep(next);
  }, [persistStep]);

  // In-page navigation to a deep link (e.g. a Smart Intake card's "Use for opening
  // balances" while already on /onboarding) — react to the new query string.
  const lastUrlKey = useRef(`${urlStep ?? ''}|${urlIntake ?? ''}`);
  useEffect(() => {
    const key = `${urlStep ?? ''}|${urlIntake ?? ''}`;
    if (key === lastUrlKey.current) return;
    lastUrlKey.current = key;
    if (urlIntake) { setIntakePath(urlIntake); setStagedSessionId(null); }
    if (urlStep) goTo(urlStep);
  }, [urlStep, urlIntake, goTo]);

  // OAuth return: show the message once, on the QuickBooks tile, then clean the URL.
  useEffect(() => {
    if (!urlQbo) return;
    setQboReturn({ code: urlQbo, reason: urlQboReason });
    setSource('quickbooks');
    setView('steps');
    setStep('welcome');
    stripQboParams();
  }, [urlQbo, urlQboReason]);

  /** The REAL status of a step — never "done" because the user clicked past it. */
  const stepStatus = useCallback((key: OnboardingStepKey): SectionStatusValue => {
    if (!status) return 'not_started';
    if (key === 'launch') return status.flag?.complete === true && canFinish(activeCompany) ? 'done' : 'not_started';
    if (key === 'opening') {
      // Per company: posted = done; an explicit fresh start skipped the import.
      if (activeCompany?.opening === 'posted') return 'done';
      if (activeCompany?.opening === 'started_fresh') return 'skipped';
      return 'not_started';
    }
    const section = WIZARD_FLOW_SECTIONS.find((s) => s.key === key);
    const derived = section ? section.deriveStatus(status) : 'not_started';
    if (derived !== 'done' && skippedSteps.has(key)) return 'skipped';
    return derived;
  }, [status, activeCompany, skippedSteps]);

  const stepStates = useMemo(() => {
    const out = {} as Record<OnboardingStepKey, StepDisplayState>;
    STEPS.forEach((s, i) => {
      out[s.key] = stepDisplayState({ isCurrent: view === 'steps' && s.key === step, status: stepStatus(s.key), passed: i < furthest });
    });
    return out;
  }, [step, view, furthest, stepStatus]);

  const goNext = useCallback(() => {
    // Moving past an optional step without finishing it records it as SKIPPED.
    if (SKIPPABLE_STEPS.has(step) && stepStatus(step) !== 'done') {
      persistSection(step, 'skipped');
      setSkippedSteps((prev) => new Set(prev).add(step));
    }
    const ni = Math.min(stepIndex + 1, STEPS.length - 1);
    goTo(STEPS[ni].key);
  }, [step, stepIndex, stepStatus, goTo]);

  const goBack = useCallback(() => {
    const pi = Math.max(stepIndex - 1, 0);
    goTo(STEPS[pi].key);
  }, [stepIndex, goTo]);

  const finishAllowed = canFinish(activeCompany);

  const finish = useCallback(async () => {
    if (!canFinish(activeCompany)) {
      addToast('error', 'Post opening balances or choose “Start fresh with no history” first.');
      return;
    }
    setFinishing(true);
    try {
      const res = await fetch('/api/onboarding/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complete: true, currentStep: 'launch' }),
      });
      if (!res.ok) throw new Error('finish failed');

      // Pin the company as ACTIVE and drop the user straight into its workspace (a
      // hard navigation so the app shell re-inits from the cookie).
      if (activeCompany) {
        writeActiveCompanyCookie(activeCompany.id);
        addToast('success', `${activeCompany.name} is live — let’s get to work.`);
        window.location.assign('/bank-feed');
        return;
      }
      addToast('success', 'You are live — your book of record is set up.');
      window.location.assign('/dashboard');
    } catch {
      addToast('error', 'Could not finish onboarding. Please try again.');
      setFinishing(false);
    }
  }, [activeCompany]);

  // GENERIC SHELL: each registered section (+ the terminal launch step) maps to its body.
  const stepBodies: Record<OnboardingStepKey, ReactNode> = {
    welcome: (
      <SourceStep
        meta={meta ?? null}
        entities={entities}
        activeCompany={activeCompany}
        activeCompanyId={activeCompanyId}
        source={source}
        onPickSource={setSource}
        qboReturn={qboReturn}
        onDismissQboReturn={() => setQboReturn(null)}
        onStaged={(sessionId) => { setStagedSessionId(sessionId); setIntakePath(null); goTo('opening'); }}
        onGoTo={goTo}
        onContinue={goNext}
        onStatusChanged={loadStatus}
        onCreated={async (r) => {
          setCreatedAccounts(r.accountCount);
          setPreferredCompanyId(r.locationId);
          await refetchMeta();
          await loadStatus();
        }}
      />
    ),
    coa: <CoaStep accountCount={createdAccounts ?? status?.counts?.accounts ?? 0} />,
    opening: (
      <OpeningStep
        company={activeCompany}
        companyId={activeCompanyId}
        intakePath={intakePath}
        sessionId={stagedSessionId}
        onChanged={loadStatus}
      />
    ),
    bank: <BankStep entities={entities} />,
    erp: <ErpStep onSkip={goNext} onDone={goNext} />,
    team: <TeamStep companies={entities.map((e) => ({ id: e.id, name: e.name, shortCode: e.shortCode }))} />,
    launch: (
      <LaunchStep
        status={status}
        company={activeCompany}
        accountCount={createdAccounts ?? status?.counts?.accounts ?? 0}
        skippedSteps={skippedSteps}
        onRefresh={loadStatus}
        onGoTo={goTo}
        onOpenBoard={() => setView('board')}
      />
    ),
  };

  const loading = metaLoading || !statusLoaded;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-hi tracking-tight flex items-center gap-2">
            <Sparkles size={20} className="text-brand-400" /> Set up your books
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Connect or drop what you have — we build your books, you approve them. Every step can be handed to your
            bookkeeper, and nothing here is ever marked done until it really is.
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2 mt-1">
          <button
            type="button"
            onClick={() => setView((v) => (v === 'board' ? 'steps' : 'board'))}
            aria-pressed={view === 'board'}
            className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              view === 'board' ? 'border-brand-500/40 bg-brand-500/10 text-brand-300' : 'border-slate-700 text-slate-300 hover:border-slate-500')}
          >
            <LayoutGrid size={13} /> {view === 'board' ? 'Back to guided steps' : 'Setup board'}
          </button>
          {/* ?stay=1 — the dashboard's first-run redirect never bounces you back here. */}
          <Link href="/dashboard?stay=1" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Go to dashboard
          </Link>
        </div>
      </div>

      {statusError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/5 px-4 py-2.5 text-sm text-warning-fg" role="status">
          <span className="flex items-center gap-2"><AlertCircle size={15} /> We couldn&apos;t load your setup progress — what you see may be out of date.</span>
          <button type="button" onClick={() => void loadStatus()} className="text-xs underline hover:no-underline">Retry</button>
        </div>
      )}

      {metaError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger-fg" role="alert">
          <span className="flex items-center gap-2"><AlertCircle size={15} /> We couldn&apos;t load your companies.</span>
          <button type="button" onClick={() => void refetchMeta()} className="text-xs underline hover:no-underline">Retry</button>
        </div>
      )}

      {/* Which company we're setting up (per-company onboarding). */}
      {entities.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="wizard-company" className="text-slate-500">Setting up</label>
          <select
            id="wizard-company"
            value={activeCompanyId ?? ''}
            onChange={(e) => setPreferredCompanyId(e.target.value || null)}
            className="px-2.5 py-1.5 bg-surface-900 border border-slate-700 rounded-lg text-sm text-ink-hi focus:outline-none focus:border-brand-500/50"
          >
            {entities.map((e) => {
              const c = findCompany(status, e.id);
              return <option key={e.id} value={e.id}>{e.name}{c?.live ? ' — live' : ''}</option>;
            })}
          </select>
        </div>
      )}

      {loading ? (
        <div className="card p-6 flex items-center justify-center py-20" aria-busy="true">
          <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
          <span className="sr-only">Loading your setup</span>
        </div>
      ) : view === 'board' ? (
        <SetupBoardView
          status={status}
          onBackToSteps={() => setView('steps')}
          onSetUpCompany={(id) => { setPreferredCompanyId(id); goTo('opening'); }}
          onAddCompany={() => { setSource(null); goTo('welcome'); }}
        />
      ) : (
        <>
          {status?.complete && (
            <div className="flex items-center gap-2 rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              <CircleCheck size={15} /> Every company is live. Revisit any step to add companies, balances, banks, or teammates.
            </div>
          )}

          {/* Books-health checklist — live status + jumps to what's left. */}
          <ReadinessChecklist onJump={goTo} compact />

          {/* Honest progress — skipped reads Skipped; every step is jumpable. */}
          <WizardStepper steps={STEPS} states={stepStates} onJump={goTo} />

          {/* Step header — every step can be delegated. */}
          <div className="flex items-center justify-between gap-3 border-b border-slate-800/60 pb-3">
            <p className="text-xs text-slate-500">
              Step {stepIndex + 1} of {STEPS.length}
              {activeName ? <> · <span className="text-slate-300">{activeName}</span></> : null}
            </p>
            <InviteHelper
              context={`${STEP_TASK[step]}${activeName ? ` for ${activeName}` : ''}`}
              companyId={activeCompanyId}
              defaultRole={BOOKKEEPER_ROLE}
              compact
            />
          </div>

          {stepBodies[step]}

          {/* Nav */}
          <div className="flex items-center justify-between pt-2">
            {stepIndex > 0 ? (
              <button type="button" onClick={goBack} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-ink-hi hover:bg-slate-800/50 transition-colors">
                <ArrowLeft size={14} /> Back
              </button>
            ) : (
              <span />
            )}

            {step === 'launch' ? (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => void finish()}
                  disabled={finishing || !finishAllowed}
                  aria-describedby={!finishAllowed ? 'finish-blocked' : undefined}
                  className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                    finishing || !finishAllowed ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-white hover:bg-brand-400')}
                >
                  {finishing ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                  {activeCompany ? `Finish & enter ${activeCompany.shortCode || activeCompany.name}` : 'Finish'}
                </button>
                {!finishAllowed && (
                  <p id="finish-blocked" className="text-[11px] text-slate-500">
                    Post opening balances or choose “Start fresh with no history” to finish.
                  </p>
                )}
              </div>
            ) : step === 'welcome' ? (
              // The source-first entry step owns its own forward navigation.
              <span />
            ) : (
              <button
                type="button"
                onClick={goNext}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium transition-colors bg-brand-500 text-white hover:bg-brand-400"
              >
                {SKIPPABLE_STEPS.has(step) && stepStatus(step) !== 'done' ? 'Skip for now' : 'Continue'} <ArrowRight size={14} />
              </button>
            )}
          </div>
        </>
      )}
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
  { kind: 'xero', icon: <span className="font-mono">X</span>, title: 'Xero', subtitle: 'One-minute export' },
  { kind: 'sage', icon: <span className="font-mono">S</span>, title: 'Sage', subtitle: 'One-minute export' },
  { kind: 'upload', icon: <Upload size={16} />, title: 'Upload files', subtitle: 'Trial balance / exports' },
  { kind: 'fresh', icon: <Sparkles size={16} />, title: 'Start fresh', subtitle: 'New books, no import' },
];

const ERP_SOURCES: BookSource[] = ['quickbooks', 'xero', 'sage'];

function SourceStep({
  meta, entities, activeCompany, activeCompanyId, source, onPickSource, qboReturn, onDismissQboReturn, onStaged,
  onCreated, onGoTo, onContinue, onStatusChanged,
}: {
  meta: EntitiesMeta | null;
  entities: EntityRow[];
  activeCompany: CompanyOnboarding | null;
  activeCompanyId: string | null;
  source: BookSource | null;
  onPickSource: (s: BookSource) => void;
  qboReturn: { code: QboReturnCode; reason: string | null } | null;
  onDismissQboReturn: () => void;
  onStaged: (sessionId: string) => void;
  onCreated: (r: CreateEntityResult) => Promise<void>;
  onGoTo: (step: OnboardingStepKey) => void;
  onContinue: () => void;
  onStatusChanged: () => Promise<void>;
}) {
  const hasCompany = entities.length > 0;
  const companyName = activeCompany?.name ?? entities.find((e) => e.id === activeCompanyId)?.name ?? entities[0]?.name;
  const [savingFresh, setSavingFresh] = useState(false);
  // Default cutover (FPB §2.3): the last day of the prior month.
  const cutoverDate = useMemo(() => lastDayOfPreviousMonth(), []);

  // The forward action for the chosen source. Enabled only once a company exists.
  // QuickBooks / Xero / Sage get their own panel below (connect, or the guided export).
  const forward = useMemo(() => {
    if (!source) return null;
    if (ERP_SOURCES.includes(source)) return null;
    if (source === 'upload') {
      return { label: 'Upload your trial balance', run: () => onGoTo('opening') };
    }
    // fresh — an EXPLICIT, per-company "no prior history" choice. On a revisit it never
    // overwrites the truth: posted balances stay posted; an existing fresh start stays.
    if (activeCompany?.opening === 'posted') {
      return { label: 'Continue — opening balances are already posted', run: () => onContinue() };
    }
    if (activeCompany?.opening === 'started_fresh') {
      return { label: 'Continue — starting fresh', run: () => onContinue() };
    }
    return {
      label: 'Start fresh with no history',
      run: async () => {
        if (!activeCompanyId) return;
        setSavingFresh(true);
        const r = await recordOpeningChoice(activeCompanyId, 'fresh');
        setSavingFresh(false);
        if (!r.ok) { addToast('error', r.error ?? 'Could not save that choice.'); return; }
        await onStatusChanged();
        onContinue();
      },
    };
  }, [source, activeCompany, activeCompanyId, onGoTo, onContinue, onStatusChanged]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-ink-hi tracking-tight">Where do your books live today?</h2>
        <p className="text-sm text-slate-400 mt-1.5 max-w-2xl">
          First question — and almost the only one. Connect your system or drop your files and we&apos;ll bring
          everything over. You review; you don&apos;t re-enter. Starting a brand-new business? Begin clean.
        </p>
        <Link
          href="/onboarding/portfolio"
          className="mt-2 inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 underline-offset-2 hover:underline"
        >
          Setting up several companies? Onboard them all at once <ArrowRight size={12} />
        </Link>
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
                  ? <>Next{companyName ? <> for <span className="text-slate-300">{companyName}</span></> : ''}: {source === 'upload' ? 'drop your trial balance and tie out to the penny.' : 'the books start at zero — no balances carried over. You can still import history later.'}</>
                  : 'Create your company above to continue.'}
              </p>
              <button
                type="button"
                onClick={() => void forward.run()}
                disabled={!hasCompany || savingFresh}
                className={clsx('shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  hasCompany && !savingFresh ? 'bg-brand-500 text-white hover:bg-brand-400' : 'bg-slate-700 text-slate-500 cursor-not-allowed')}
              >
                {savingFresh && <Loader2 size={14} className="animate-spin" />} {forward.label} <ArrowRight size={14} />
              </button>
            </div>
          )}

          {/* QuickBooks: connect + live pull when the platform has Intuit keys, else the
              guided one-minute export. Xero / Sage: guided export → upload. */}
          {source === 'quickbooks' && (
            <QuickBooksConnectPanel
              companyId={hasCompany ? activeCompanyId : null}
              companyName={companyName ?? null}
              defaultCutoverDate={cutoverDate}
              returnCode={qboReturn?.code ?? null}
              returnReason={qboReturn?.reason ?? null}
              onDismissReturn={onDismissQboReturn}
              onStaged={onStaged}
              onUpload={() => onGoTo('opening')}
            />
          )}
          {(source === 'xero' || source === 'sage') && (
            <GuidedExportPanel system={source} cutoverDate={cutoverDate} hasCompany={hasCompany} onUpload={() => onGoTo('opening')} />
          )}
        </div>
      )}

      {/* "Drop everything you have" — one drop zone for every document (FPB principle 5).
          Each file is uploaded once and handed to the right parser by storage path. */}
      <div className="pt-1">
        <div className="flex items-center gap-3 text-2xs text-slate-600 mb-3">
          <span className="h-px flex-1 bg-slate-800" /> {source ? 'and' : 'or'} drop your files <span className="h-px flex-1 bg-slate-800" />
        </div>
        <SmartIntake companyId={activeCompanyId ?? undefined} cutoverDate={cutoverDate} />
        {hasCompany && (
          <div className="mt-3">
            <FormationIntake companyId={activeCompanyId ?? entities[0]?.id ?? null} />
          </div>
        )}
      </div>
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
        <h2 className="text-lg font-semibold text-ink-hi flex items-center gap-2">
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
                    <p className="text-sm text-ink-hi">{e.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono">{e.shortCode}{e.industry ? ` · ${e.industry}` : ''}</p>
                  </div>
                </div>
                <span className="flex items-center gap-1 text-[11px] text-slate-400"><Check size={12} /> Created</span>
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
                !valid || submitting ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-white hover:bg-brand-400')}
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
          <h2 className="text-lg font-semibold text-ink-hi flex items-center gap-2">
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
              <p className="text-2xl font-mono font-semibold text-ink-hi tabular-nums">{accountCount}</p>
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

function OpeningStep({
  company, companyId, intakePath, sessionId, onChanged,
}: {
  company: CompanyOnboarding | null;
  companyId: string | null;
  /** A TB / GL file already dropped in Smart Intake (storage path) — read, never re-upload. */
  intakePath: string | null;
  /** A session already staged (live QuickBooks pull) — open straight into review. */
  sessionId: string | null;
  onChanged: () => Promise<void>;
}) {
  const posted = company?.opening === 'posted';
  // Default cutover (FPB §2.3): MeritBooks takes over from the last day of the prior month.
  const defaultAsOfDate = useMemo(() => lastDayOfPreviousMonth(), []);

  // Crown the tie-out with the real, posted totals once THIS company's opening balances
  // exist. The books balance by construction (the DB trigger rejects an unbalanced
  // entry), so summing the live trial balance is an HONEST "balanced to the penny".
  const [tbTotals, setTbTotals] = useState<{ debitsCents: number; creditsCents: number } | null>(null);

  useEffect(() => {
    if (!posted || !companyId) { setTbTotals(null); return; }
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
  }, [posted, companyId]);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold text-ink-hi flex items-center gap-2">
          <Scale size={18} className="text-brand-400" /> Opening balances
        </h2>
        <p className="text-xs text-slate-500">
          Upload your trial balance as of the day before MeritBooks takes over. AI proposes how each account maps onto
          your chart — it never sees or changes a balance — then you tie out and post one balanced opening entry.
        </p>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <ShieldCheck size={13} className="text-brand-400" />
          Going live needs either posted opening balances or your explicit choice to start fresh.
        </div>
        <OpeningChoice company={company} onChanged={onChanged} />
      </div>

      {/* The "Balanced to the penny" crown — shown once opening balances are posted. */}
      {posted && tbTotals && (
        <TieOutBanner
          state={tbTotals.debitsCents === tbTotals.creditsCents ? 'balanced' : 'off'}
          debitsCents={tbTotals.debitsCents}
          creditsCents={tbTotals.creditsCents}
          note="Your opening books are posted and proven — total debits = total credits."
        />
      )}

      {/* The full conversion flow, prefilled with this company and the default cutover. */}
      <div className="card p-6">
        {/* Keyed by company + handoff so switching company or a new handoff re-seeds the prefill. */}
        <ConversionClient
          key={`${companyId ?? 'none'}|${intakePath ?? ''}|${sessionId ?? ''}`}
          defaultCompanyId={companyId}
          defaultAsOfDate={defaultAsOfDate}
          initialStoragePath={posted ? null : intakePath}
          initialSessionId={sessionId}
        />
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
          <h2 className="text-lg font-semibold text-ink-hi flex items-center gap-2">
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
        <h2 className="text-lg font-semibold text-ink-hi flex items-center gap-2">
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
