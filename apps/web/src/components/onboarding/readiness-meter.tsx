'use client';

/**
 * ReadinessMeter — "Books health" (design spec §3): reframes onboarding from "steps
 * remaining" to two tiers of health, reading the SAME source the wizard shell and
 * readiness checklist read (each section's registry `deriveStatus`, and the
 * `readyToOperateCriteria` / `goLiveReady` predicates):
 *
 *   • REQUIRED tier — "Ready to operate": the three criticals (company exists,
 *     opening balances tie out, rev-rec chosen), celebrated at 100%.
 *   • OPTIONAL tier — "Fully set up": the long-tail domains. Neutral, never a nag.
 *
 * Presentational — the caller supplies a loaded `OnboardingStatus`. Accessible: each
 * tier bar is a `role="progressbar"` with aria-valuenow/max; progress is conveyed by
 * text + the count, not color alone.
 */

import { CircleCheck, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import {
  ONBOARDING_SECTIONS,
  readyToOperateCriteria,
  goLiveReady,
} from '@/lib/onboarding/sections/registry';

export interface ReadinessMeterProps {
  status: OnboardingStatus;
  className?: string;
}

function Tier({
  label, done, total, ready, tone,
}: {
  label: string;
  done: number;
  total: number;
  ready: boolean;
  tone: 'required' | 'optional';
}) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className={clsx('font-medium', tone === 'required' ? 'text-white' : 'text-slate-300')}>{label}</span>
        <span className="font-mono tabular-nums text-slate-500">{done}/{total}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-950"
      >
        <div
          className={clsx('h-full rounded-full transition-all duration-slow',
            tone === 'required' ? (ready ? 'bg-brand-500' : 'bg-brand-500/70') : 'bg-slate-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ReadinessMeter({ status, className }: ReadinessMeterProps) {
  const criteria = readyToOperateCriteria(status);
  const requiredDone = criteria.filter((c) => c.done).length;
  const ready = goLiveReady(status);

  const optionalSections = ONBOARDING_SECTIONS.filter((s) => s.tone !== 'required');
  const optionalDone = optionalSections.filter((s) => s.deriveStatus(status) === 'done').length;

  return (
    <div className={clsx('space-y-3', className)}>
      <div className="flex items-center gap-2">
        {ready
          ? <CircleCheck size={15} className="text-brand-400" aria-hidden />
          : <ShieldCheck size={15} className="text-slate-400" aria-hidden />}
        <p className="text-sm font-semibold text-white">
          {ready ? 'Your books are operating' : 'Books health'}
        </p>
      </div>
      <Tier
        label="Ready to operate"
        done={requiredDone}
        total={criteria.length}
        ready={ready}
        tone="required"
      />
      <Tier
        label="Fully set up (optional)"
        done={optionalDone}
        total={optionalSections.length}
        ready={optionalDone === optionalSections.length}
        tone="optional"
      />
    </div>
  );
}
