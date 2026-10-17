'use client';

import { Check, ChevronRight, Minus } from 'lucide-react';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { OnboardingStepKey } from '@/lib/onboarding/status';
import type { StepDisplayState } from '@/lib/onboarding/wizard-progress';

/**
 * Honest progress bar: done steps get a check, steps the user moved past without
 * finishing say "Skipped" (never a check), and every step is jumpable — forward too —
 * so there is never a locked dead end.
 */
export function WizardStepper({
  steps, states, onJump,
}: {
  steps: { key: OnboardingStepKey; label: string; icon: LucideIcon }[];
  states: Record<OnboardingStepKey, StepDisplayState>;
  onJump: (key: OnboardingStepKey) => void;
}) {
  return (
    <nav aria-label="Setup progress">
      <ol className="flex items-center gap-1.5 flex-wrap">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const st = states[s.key];
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onJump(s.key)}
                aria-current={st === 'current' ? 'step' : undefined}
                aria-label={`${s.label}${st === 'done' ? ' — done' : st === 'skipped' ? ' — skipped' : ''}`}
                className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
                  st === 'current' ? 'bg-brand-500/10 text-brand-300 font-medium'
                    : st === 'done' ? 'text-brand-400/80 hover:bg-slate-800/50'
                      : st === 'skipped' ? 'text-amber-300/80 hover:bg-slate-800/50'
                        : 'text-slate-500 hover:bg-slate-800/40')}
              >
                <span className={clsx('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
                  st === 'current' ? 'bg-brand-500 text-white'
                    : st === 'done' ? 'bg-brand-500 text-white'
                      : st === 'skipped' ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                        : 'bg-slate-800 text-slate-500')}>
                  {st === 'done' ? <Check size={12} /> : st === 'skipped' ? <Minus size={12} /> : i + 1}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
                {st === 'skipped' && <span className="hidden md:inline text-[10px] uppercase tracking-wide text-amber-300/70">Skipped</span>}
                <Icon size={14} className="sm:hidden" aria-hidden />
              </button>
              {i < steps.length - 1 && <ChevronRight size={13} className="text-slate-700" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
