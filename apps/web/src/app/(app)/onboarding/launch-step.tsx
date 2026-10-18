'use client';

import { useEffect } from 'react';
import { Building2, BookOpen, Scale, Landmark, Users, Rocket, Check, Minus, Circle, LayoutGrid } from 'lucide-react';
import { clsx } from 'clsx';
import type { CompanyOnboarding, OnboardingStatus, OnboardingStepKey } from '@/lib/onboarding/status';
import { launchSummary, canFinish, type LaunchRow } from '@/lib/onboarding/wizard-progress';
import { OpeningChoice } from './opening-choice';

const ROW_ICON: Record<LaunchRow['key'], typeof Building2> = {
  companies: Building2, coa: BookOpen, opening: Scale, bank: Landmark, team: Users,
};
const ROW_STEP: Record<LaunchRow['key'], OnboardingStepKey> = {
  companies: 'welcome', coa: 'coa', opening: 'opening', bank: 'bank', team: 'team',
};

/**
 * Launch — a summary of REAL state (lib/onboarding/wizard-progress launchSummary):
 * nothing reads as done unless it is, skipped reads "Skipped", and opening balances
 * read Not started / Started fresh / Posted. Finishing is gated by the shell on
 * `canFinish`; when blocked, the explicit start-fresh choice is offered right here.
 */
export function LaunchStep({
  status, company, accountCount, skippedSteps, onRefresh, onGoTo, onOpenBoard,
}: {
  status: OnboardingStatus | null;
  company: CompanyOnboarding | null;
  accountCount: number;
  skippedSteps: ReadonlySet<OnboardingStepKey>;
  onRefresh: () => Promise<void>;
  onGoTo: (step: OnboardingStepKey) => void;
  onOpenBoard: () => void;
}) {
  useEffect(() => { void onRefresh(); }, [onRefresh]);

  const rows = launchSummary(status, company, { accountCount, skippedSteps });
  const ready = canFinish(company);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-5">
        <div className="text-center">
          <div className={clsx('mx-auto mb-3 h-14 w-14 rounded-full flex items-center justify-center',
            ready ? 'bg-brand-500/15' : 'bg-slate-800')}>
            <Rocket size={28} className={ready ? 'text-brand-400' : 'text-slate-500'} />
          </div>
          <h2 className="text-xl font-semibold text-white">
            {ready ? `${company?.name ?? 'Your company'} is ready to go live` : 'Almost there'}
          </h2>
          <p className="text-sm text-slate-400 mt-1 max-w-lg mx-auto">
            {ready
              ? 'Here’s exactly what’s set up. Finishing drops you into this company to start working.'
              : 'One thing left before going live: bring in opening balances, or tell us this company is starting fresh.'}
          </p>
        </div>

        <ul className="space-y-2">
          {rows.map((r) => {
            const Icon = ROW_ICON[r.key];
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => onGoTo(ROW_STEP[r.key])}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-900 border border-slate-800 hover:border-slate-600 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                >
                  <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
                    r.state === 'done' ? 'bg-brand-500/10' : 'bg-slate-800')}>
                    <Icon size={15} className={r.state === 'done' ? 'text-brand-400' : 'text-slate-500'} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{r.label}</p>
                    <p className={clsx('text-xs', r.state === 'skipped' ? 'text-amber-300/80' : 'text-slate-500')}>{r.value}</p>
                  </div>
                  {r.state === 'done' && <Check size={16} className="text-brand-400 shrink-0" aria-label="Done" />}
                  {r.state === 'skipped' && <Minus size={16} className="text-amber-300/80 shrink-0" aria-label="Skipped" />}
                  {r.state === 'not_started' && <Circle size={10} className="text-slate-600 shrink-0" aria-label="Not started" />}
                </button>
              </li>
            );
          })}
        </ul>

        {!ready && <OpeningChoice company={company} onChanged={onRefresh} />}
      </div>

      <button
        type="button"
        onClick={onOpenBoard}
        className="w-full card px-5 py-4 flex items-center justify-between gap-3 hover:border-slate-600 transition-colors text-left"
      >
        <span className="flex items-center gap-3">
          <LayoutGrid size={18} className="text-brand-400" />
          <span>
            <span className="block text-sm font-medium text-white">Open your setup board</span>
            <span className="block text-xs text-slate-500">Loans, customers, vendors, fixed assets, leases — add each whenever you&apos;re ready.</span>
          </span>
        </span>
        <span className="text-xs text-slate-400">Open →</span>
      </button>
    </div>
  );
}
