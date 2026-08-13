'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Circle, RefreshCw, Loader2, ArrowRight, ShieldCheck, CircleCheck } from 'lucide-react';
import { clsx } from 'clsx';
import type { OnboardingStatus, OnboardingStepKey } from '@/lib/onboarding/status';
import {
  ONBOARDING_SECTIONS,
  readyToOperateCriteria,
  goLiveReady,
  type SectionDefinition,
} from '@/lib/onboarding/sections/registry';

/**
 * Books health — the "Get Started" surface, reframed from "steps remaining" to a
 * two-tier health view (design spec §3):
 *
 *   • "Ready to operate" (REQUIRED tier): the only three things that gate go-live —
 *     a company exists, opening balances tie out, and a rev-rec method is chosen —
 *     celebrated at 100%.
 *   • "Fully set up" (OPTIONAL tier): everything else. Optional domains render neutral
 *     (never a red nag); recommended-but-not-done get a gentle amber prompt.
 *
 * The status of every row comes from the SAME source the wizard shell reads — each
 * section's `deriveStatus` in the registry — so the checklist and the shell can never
 * disagree about what is finished (a live-count `done` always wins over stale state).
 *
 * Fully white-label, self-refreshing, and degrade-safe: it reads `/api/onboarding/status`
 * and never hard-fails the surface it sits on. When rendered inside the wizard, pass
 * `onJump` so in-flow items advance the wizard step; standalone it deep-links.
 */

/** The required domain sections, in flow order (required tone). */
const REQUIRED_SECTIONS = ONBOARDING_SECTIONS.filter((s) => s.tone === 'required');
/** The optional/recommended domain sections. */
const OPTIONAL_SECTIONS = ONBOARDING_SECTIONS.filter((s) => s.tone !== 'required');

function toneBadge(section: SectionDefinition): { label: string; cls: string } | null {
  if (section.tone === 'required') return { label: 'Required', cls: 'bg-amber-500/15 text-amber-300' };
  if (section.tone === 'recommended') return { label: 'Recommended', cls: 'bg-slate-700/60 text-slate-400' };
  return { label: 'Optional', cls: 'bg-slate-700/60 text-slate-400' };
}

export function ReadinessChecklist({
  onJump,
  compact = false,
}: {
  onJump?: (step: OnboardingStepKey) => void;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/onboarding/status');
      if (!res.ok) throw new Error('status unavailable');
      const s = (await res.json()) as OnboardingStatus & { orgResolved?: boolean };
      setStatus(s);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  if (loading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-sm text-slate-500">
        <Loader2 size={15} className="animate-spin" /> Checking your books health…
      </div>
    );
  }

  if (failed || !status || !status.counts) {
    return (
      <div className="card p-5 text-sm text-slate-500">
        Setup status isn&apos;t available right now.{' '}
        <button onClick={() => load(true)} className="text-brand-400 hover:underline">Try again</button>.
      </div>
    );
  }

  const criteria = readyToOperateCriteria(status);
  const ready = goLiveReady(status);
  const criteriaDone = criteria.filter((c) => c.done).length;

  const renderSectionRow = (section: SectionDefinition) => {
    const done = section.deriveStatus(status) === 'done';
    const Icon = section.icon;
    const badge = !done ? toneBadge(section) : null;
    const jumpable = onJump && !done; // section keys are valid wizard step keys
    const neutral = section.tone !== 'required'; // optional domains stay neutral, never red

    const inner = (
      <>
        <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
          done ? 'bg-brand-500/10' : 'bg-slate-800')}>
          {done ? <Check size={15} className="text-brand-400" /> : <Icon size={15} className="text-slate-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={clsx('text-sm font-medium truncate', done ? 'text-slate-200' : 'text-white')}>{section.label}</p>
            {badge && <span className={clsx('text-[10px] px-1.5 py-0.5 rounded shrink-0', badge.cls)}>{badge.label}</span>}
          </div>
        </div>
        {done
          ? <Circle size={7} className="fill-brand-400 text-brand-400 shrink-0" />
          : <ArrowRight size={14} className="text-slate-600 shrink-0" />}
      </>
    );

    const cls = clsx(
      'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors text-left',
      done
        ? 'border-slate-800 bg-surface-900/60'
        : neutral
          ? 'border-slate-800 bg-surface-900 hover:border-slate-600'
          : 'border-slate-800 bg-surface-900 hover:border-brand-500/40',
    );

    if (jumpable) {
      return (
        <button key={section.key} type="button" onClick={() => onJump!(section.key)} className={cls}>
          {inner}
        </button>
      );
    }
    return (
      <Link key={section.key} href={section.href} className={cls}>
        {inner}
      </Link>
    );
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">
            {ready ? 'Ready to operate' : `Ready to operate — ${criteriaDone} of ${criteria.length}`}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {ready
              ? 'The essentials are in place. The steps below are optional — add them whenever you like.'
              : 'Three things get your book of record operating. Everything else is optional.'}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors shrink-0"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Ready-to-operate criteria — the required tier. */}
      <div className={clsx('rounded-xl border px-4 py-3 space-y-2',
        ready ? 'border-brand-500/25 bg-brand-500/5' : 'border-slate-800 bg-surface-900/60')}>
        <div className="flex items-center gap-2">
          {ready
            ? <CircleCheck size={15} className="text-brand-400" />
            : <ShieldCheck size={15} className="text-slate-400" />}
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {ready ? 'Your books are operating' : 'To operate'}
          </p>
        </div>
        <div className="space-y-1">
          {criteria.map((c) => (
            <div key={c.key} className="flex items-center gap-2.5">
              <span className={clsx('flex h-4 w-4 items-center justify-center rounded-full shrink-0',
                c.done ? 'bg-brand-500/80 text-slate-900' : 'bg-slate-800 text-slate-500')}>
                {c.done ? <Check size={10} /> : <Circle size={6} className="fill-slate-600 text-slate-600" />}
              </span>
              <span className={clsx('text-sm', c.done ? 'text-slate-300' : 'text-white')}>{c.label}</span>
              <span className="text-xs text-slate-500 truncate">— {c.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Required domain sections still to complete (company / COA / opening). */}
      {REQUIRED_SECTIONS.some((s) => s.deriveStatus(status) !== 'done') && (
        <div className="space-y-1.5">
          {REQUIRED_SECTIONS.map(renderSectionRow)}
        </div>
      )}

      {/* Optional / recommended — "Fully set up". Neutral, never a nag. */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Fully set up (optional)</p>
        {OPTIONAL_SECTIONS.map(renderSectionRow)}
      </div>

      {!compact && ready && (
        <p className="text-xs text-slate-500">
          Everything essential is ready. You can revisit any item at any time — nothing here locks.
        </p>
      )}
    </div>
  );
}
