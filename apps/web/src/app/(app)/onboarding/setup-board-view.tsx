'use client';

import { ArrowLeft, Building2, CircleCheck, Loader2, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { SetupHomeBoard } from '@/components/onboarding';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import { OPENING_STATE_LABEL } from '@/lib/onboarding/wizard-progress';

/**
 * The setup board — reachable at ANY time from the wizard header (not only on the
 * last step), and the default view on a return visit after go-live. Shows each
 * company's honest go-live state, then the optional long tail (SetupHomeBoard).
 */
export function SetupBoardView({
  status, onBackToSteps, onSetUpCompany, onAddCompany,
}: {
  status: OnboardingStatus | null;
  onBackToSteps: () => void;
  onSetUpCompany: (companyId: string) => void;
  onAddCompany: () => void;
}) {
  if (!status) {
    return (
      <div className="card p-6 flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        <span className="sr-only">Loading your setup board</span>
      </div>
    );
  }

  const companies = status.companies ?? [];

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Your companies</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              A company is live once its opening balances are posted — or you&apos;ve chosen to start it fresh.
            </p>
          </div>
          <button type="button" onClick={onBackToSteps} className="shrink-0 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
            <ArrowLeft size={13} /> Guided steps
          </button>
        </div>

        {companies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 p-6 text-center">
            <Building2 className="w-7 h-7 mx-auto text-slate-500 mb-2" />
            <p className="text-sm text-slate-300">No companies yet</p>
            <button type="button" onClick={onAddCompany} className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
              <Plus size={14} /> Add your first company
            </button>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {companies.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface-900 border border-slate-800 px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-7 w-7 rounded-md bg-brand-500/10 flex items-center justify-center shrink-0">
                    <Building2 size={14} className="text-brand-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{c.name}</p>
                    <p className="text-[11px] text-slate-500">
                      <span className="font-mono">{c.shortCode}</span> · Opening balances: {OPENING_STATE_LABEL[c.opening]}
                    </p>
                  </div>
                </div>
                {c.live ? (
                  <span className="flex items-center gap-1 text-[11px] text-brand-400 shrink-0"><CircleCheck size={13} /> Live</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSetUpCompany(c.id)}
                    className={clsx('shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-brand-500 text-slate-900 hover:bg-brand-400 transition-colors')}
                  >
                    Finish setup
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {companies.length > 0 && (
          <button type="button" onClick={onAddCompany} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand-400 transition-colors">
            <Plus size={13} /> Add another company
          </button>
        )}
      </div>

      <div className="card p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-white">Everything else</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Add each when you&apos;re ready, or never if it doesn&apos;t apply. None of this blocks going live.
          </p>
        </div>
        <SetupHomeBoard status={status} />
      </div>
    </div>
  );
}
