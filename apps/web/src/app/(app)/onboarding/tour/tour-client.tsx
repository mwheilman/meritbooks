'use client';

import Link from 'next/link';
import { Sparkles, ArrowRight, Loader2, Compass } from 'lucide-react';
import { useMe } from '@/lib/hooks/use-me';

/**
 * Placeholder guided-tour welcome (Wave 0). Reads the signed-in member's identity
 * from the shared `useMe()` context (the same source the app shell uses), so it
 * needs no extra fetch. Renders a warm, role-aware welcome + a Skip → dashboard.
 *
 * Degrade-safe: if identity is still loading it shows a spinner; if any field is
 * missing it falls back to friendly generic copy rather than an empty string.
 */
export function TourClient() {
  const { loading, user, orgName } = useMe();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
      </div>
    );
  }

  const name = user?.firstName?.trim() || 'there';
  const role = user?.roleLabel?.trim() || 'teammate';
  const company = orgName?.trim() || 'your company';

  return (
    <div className="max-w-2xl mx-auto py-12">
      <div className="card p-8 text-center space-y-5">
        <div className="mx-auto h-14 w-14 rounded-full bg-brand-500/15 flex items-center justify-center">
          <Compass size={28} className="text-brand-400" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center justify-center gap-2">
            <Sparkles size={18} className="text-brand-400" /> Welcome, {name}
          </h1>
          <p className="text-sm text-slate-400">
            You&apos;re a <span className="text-brand-300 font-medium">{role}</span> on{' '}
            <span className="text-white font-medium">{company}</span>. The books are already live —
            here&apos;s where a quick, role-aware tour will get you oriented.
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3 text-xs text-slate-500">
          A guided walkthrough of the areas you&apos;ll use most is coming soon. For now, jump
          straight into your dashboard.
        </div>

        <div className="flex items-center justify-center gap-3 pt-1">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-5 py-2 text-sm font-medium text-slate-900 hover:bg-brand-400 transition-colors"
          >
            Skip to dashboard <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
