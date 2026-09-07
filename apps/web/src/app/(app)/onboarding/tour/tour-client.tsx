'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Loader2,
  X,
} from 'lucide-react';
import { useMe } from '@/lib/hooks/use-me';
import { buildTourSteps, type TourContext } from './tour-steps';

const TOUR_SEEN_KEY = 'meritbooks.tour.seen';

/**
 * Best-effort "remember the tour was seen" — purely cosmetic, wrapped so a
 * disabled/blocked localStorage (private mode, preview surface) never breaks the
 * tour. Absence is always treated as "not seen."
 */
function markTourSeen(): void {
  try {
    window.localStorage.setItem(TOUR_SEEN_KEY, new Date().toISOString());
  } catch {
    /* preview / privacy mode — remembering is optional, correctness is not */
  }
}

/**
 * Role-aware first-session guided tour. Reads identity from the shared `useMe()`
 * context (no extra fetch), tailors the steps to the member's role, and walks
 * them through the areas they'll actually use as a stepped card carousel.
 *
 * Accessibility: the carousel is a labelled group; each dot is a real button with
 * an aria-current on the active step; Left/Right arrows move between steps and Esc
 * skips to the dashboard. Degrade-safe: still-loading shows a spinner; missing
 * identity fields fall back to friendly generic copy rather than blanks.
 */
export function TourClient() {
  const { loading, user, orgName, isAdmin } = useMe();
  const [index, setIndex] = useState(0);

  const ctx: TourContext = useMemo(
    () => ({
      firstName: user?.firstName?.trim() || '',
      role: user?.role ?? null,
      roleLabel: user?.roleLabel?.trim() || '',
      orgName: orgName?.trim() || '',
      isAdmin,
      canManageUsers: user?.canManageUsers ?? false,
      canEditSystemSettings: user?.canEditSystemSettings ?? false,
    }),
    [user, orgName, isAdmin]
  );

  const steps = useMemo(() => buildTourSteps(ctx), [ctx]);
  const total = steps.length;

  // Keep the index in range if the step set changes (e.g. identity resolves).
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, total - 1)));
  }, [total]);

  const goNext = useCallback(() => {
    setIndex((i) => Math.min(i + 1, total - 1));
  }, [total]);

  const goBack = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  // Mark seen once identity has resolved and the tour is actually shown.
  useEffect(() => {
    if (!loading && total > 0) markTourSeen();
  }, [loading, total]);

  // Keyboard: Left/Right to navigate, Esc to skip to the dashboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        window.location.assign('/dashboard');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goBack]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-live="polite">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        <span className="sr-only">Loading your tour…</span>
      </div>
    );
  }

  const step = steps[index] ?? steps[0];
  const StepIcon = step.icon;
  const isFirst = index === 0;
  const isFinal = step.isFinal === true || index === total - 1;

  return (
    <div className="max-w-2xl mx-auto py-12">
      <section
        aria-roledescription="carousel"
        aria-label="Getting started tour"
        className="card p-8 space-y-6"
      >
        {/* Header: progress + skip */}
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Getting started
            <span className="text-slate-600"> · </span>
            <span className="text-slate-400">
              Step {index + 1} of {total}
            </span>
          </p>
          <Link
            href="/dashboard"
            onClick={markTourSeen}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Skip tour <X size={12} />
          </Link>
        </div>

        {/* Live-updating step body */}
        <div
          role="group"
          aria-roledescription="slide"
          aria-label={`${index + 1} of ${total}: ${step.title}`}
          aria-live="polite"
          className="text-center space-y-5"
        >
          <div className="mx-auto h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
            <StepIcon size={28} className="text-brand-400" aria-hidden="true" />
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center justify-center gap-2">
              {isFinal && <Sparkles size={18} className="text-brand-400" aria-hidden="true" />}
              {step.title}
            </h1>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-slate-400">
              {step.body}
            </p>
          </div>

          {step.cta && !isFinal && (
            <Link
              href={step.cta.href}
              onClick={markTourSeen}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-400 hover:text-brand-300 transition-colors"
            >
              {step.cta.label} <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>

        {/* Progress dots */}
        <div
          className="flex items-center justify-center gap-2"
          role="tablist"
          aria-label="Tour steps"
        >
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-label={`Step ${i + 1}: ${s.title}`}
              aria-selected={i === index}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => setIndex(i)}
              className={`h-2 rounded-full transition-all ${
                i === index
                  ? 'w-6 bg-brand-500'
                  : 'w-2 bg-slate-700 hover:bg-slate-600'
              }`}
            />
          ))}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            onClick={goBack}
            disabled={isFirst}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back
          </button>

          {isFinal ? (
            <Link
              href={step.cta?.href ?? '/dashboard'}
              onClick={markTourSeen}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-5 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 transition-colors"
            >
              {step.cta?.label ?? 'Start using MeritBooks'}{' '}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={goNext}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-5 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 transition-colors"
            >
              Next <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
