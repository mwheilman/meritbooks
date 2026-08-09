'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Building2, BookOpen, Scale, Landmark, Sparkles, Check, Circle, RefreshCw, Loader2, ArrowRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { OnboardingStatus, OnboardingStepKey } from '@/lib/onboarding/status';

/**
 * First-run readiness checklist — the "Get Started" surface.
 *
 * A single glance tells a new customer / preparer exactly what is done and what is
 * left to stand up their book of record: company created, chart of accounts seeded,
 * opening balances tied out, bank connected, and a first transaction categorized.
 * Every row shows live status and a deep-link straight to where the work happens.
 *
 * Fully white-label — no tenant is named. Self-refreshing and degrade-safe: it reads
 * `/api/onboarding/status` and never hard-fails the surface it sits on.
 *
 * When rendered inside the wizard, pass `onJump` so in-flow items advance the wizard
 * step instead of navigating away; standalone it deep-links to the feature pages.
 */

interface ChecklistItem {
  key: string;
  icon: typeof Building2;
  label: string;
  tone: 'required' | 'recommended' | 'optional';
  done: boolean;
  detail: string;
  href: string;
  step?: OnboardingStepKey;
}

function buildItems(status: OnboardingStatus): ChecklistItem[] {
  const c = status.counts;
  return [
    {
      key: 'entity',
      icon: Building2,
      label: 'Company created',
      tone: 'required',
      done: c.entities > 0,
      detail: c.entities > 0 ? `${c.entities} compan${c.entities === 1 ? 'y' : 'ies'}` : 'Create your first company',
      href: '/onboarding',
      step: 'welcome',
    },
    {
      key: 'coa',
      icon: BookOpen,
      label: 'Chart of accounts seeded',
      tone: 'required',
      done: c.accounts > 0,
      detail: c.accounts > 0 ? `${c.accounts} accounts ready` : 'Seeded automatically when you create a company',
      href: '/chart-of-accounts',
      step: 'coa',
    },
    {
      key: 'opening',
      icon: Scale,
      label: 'Opening balances tied out',
      tone: 'optional',
      done: status.hasOpeningEntry,
      detail: status.hasOpeningEntry ? 'Posted — a balanced opening entry is live' : 'Convert prior books, or skip for a clean start',
      href: '/onboarding/conversion',
      step: 'opening',
    },
    {
      key: 'bank',
      icon: Landmark,
      label: 'Bank connected',
      tone: 'recommended',
      done: c.bankAccounts > 0,
      detail: c.bankAccounts > 0 ? `${c.bankAccounts} bank account${c.bankAccounts === 1 ? '' : 's'} linked` : 'Link a bank so transactions flow in automatically',
      href: '/bank-feed',
      step: 'bank',
    },
    {
      key: 'categorized',
      icon: Sparkles,
      label: 'First transaction categorized',
      tone: 'recommended',
      done: c.categorizedTransactions > 0,
      detail: c.categorizedTransactions > 0
        ? `${c.categorizedTransactions} transaction${c.categorizedTransactions === 1 ? '' : 's'} handled`
        : c.bankAccounts > 0 ? 'Review and approve items in the bank feed' : 'Available once a bank is connected',
      href: '/bank-feed',
    },
  ];
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
        <Loader2 size={15} className="animate-spin" /> Checking what&apos;s set up…
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

  const items = buildItems(status);
  const requiredItems = items.filter((i) => i.tone === 'required');
  const doneCount = items.filter((i) => i.done).length;
  const requiredDone = requiredItems.every((i) => i.done);
  const pct = Math.round((doneCount / items.length) * 100);

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Get started — {doneCount} of {items.length} done</p>
          <p className="text-xs text-slate-500 mt-0.5">
            {requiredDone
              ? 'The essentials are in place. Finish the recommended steps to get the most out of your books.'
              : 'A short checklist to stand up your book of record.'}
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

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="space-y-1.5">
        {items.map((item) => {
          const Icon = item.icon;
          const jumpable = onJump && item.step && !item.done;
          const inner = (
            <>
              <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
                item.done ? 'bg-brand-500/10' : 'bg-slate-800')}>
                {item.done
                  ? <Check size={15} className="text-brand-400" />
                  : <Icon size={15} className="text-slate-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={clsx('text-sm font-medium truncate', item.done ? 'text-slate-200' : 'text-white')}>{item.label}</p>
                  {!item.done && item.tone === 'required' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 shrink-0">Required</span>}
                  {!item.done && item.tone === 'recommended' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 shrink-0">Recommended</span>}
                  {!item.done && item.tone === 'optional' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 shrink-0">Optional</span>}
                </div>
                <p className="text-xs text-slate-500 truncate">{item.detail}</p>
              </div>
              {item.done
                ? <Circle size={7} className="fill-brand-400 text-brand-400 shrink-0" />
                : <ArrowRight size={14} className="text-slate-600 shrink-0" />}
            </>
          );

          const cls = clsx(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors text-left',
            item.done ? 'border-slate-800 bg-surface-900/60' : 'border-slate-800 bg-surface-900 hover:border-brand-500/40',
          );

          if (jumpable) {
            return (
              <button key={item.key} type="button" onClick={() => onJump!(item.step!)} className={cls}>
                {inner}
              </button>
            );
          }
          return (
            <Link key={item.key} href={item.href} className={cls}>
              {inner}
            </Link>
          );
        })}
      </div>

      {!compact && requiredDone && (
        <p className="text-xs text-slate-500">
          Everything essential is ready. You can revisit any item at any time — nothing here locks.
        </p>
      )}
    </div>
  );
}
