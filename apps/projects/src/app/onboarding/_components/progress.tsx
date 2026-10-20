'use client';

import { Icon, StageMeter } from '@meritbooks/merit-ui';
import type { RunStep } from '@/lib/onboarding/types';

export const STEP_LABELS = ['Kind of work', 'Workspace', 'Bring your work', 'Team'] as const;

export function stepIndex(step: RunStep): number {
  switch (step) {
    case 'describe': return 0;
    case 'preview': return 1;
    case 'bring_work': return 2;
    case 'team': return 3;
    case 'done': return 4;
  }
}

/** The four steps for the company in hand (O-connect-source .steps). */
export function StepsBar({ step, mode }: { step: RunStep; mode: 'first' | 'change' }) {
  const labels = mode === 'change' ? STEP_LABELS.slice(0, 2) : STEP_LABELS;
  const at = stepIndex(step);
  return (
    <ol className="ob-steps" aria-label="Setup steps">
      {labels.map((l, i) => (
        <li key={l} className={i < at ? 'is-done' : undefined} aria-current={i === at ? 'step' : undefined}>
          <span className="no" aria-hidden="true">{i < at ? <Icon name="check" /> : i + 1}</span>
          <span className="lbl">{l}</span>
          <span className="sr">{i < at ? ', done' : i === at ? ', current' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TowerRow {
  id: string;
  name: string;
  step: RunStep;
  current: boolean;
  detail: string;
}

/** Several companies in one motion (O-control-tower): each company's step, the current one lit. */
export function CompanyTower({ rows }: { rows: TowerRow[] }) {
  if (rows.length < 2) return null;
  return (
    <div className="ob-tower" role="list" aria-label="Companies being set up">
      {rows.map((r) => (
        <div key={r.id} role="listitem" aria-current={r.current || undefined}>
          <span className="l1">{r.name}</span>
          <StageMeter stages={STEP_LABELS} current={stepIndex(r.step)} detail={r.detail} />
        </div>
      ))}
    </div>
  );
}
