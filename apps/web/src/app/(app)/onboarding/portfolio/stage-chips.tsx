import { Check } from 'lucide-react';
import { clsx } from 'clsx';
import { TOWER_STAGES, TOWER_STAGE_LABEL, type TowerStage } from '@/lib/companies/portfolio/types';

/** Created → Balances uploaded → Matched → Checked → Live, as a compact chip row. */
export function StageChips({ stage }: { stage: TowerStage }) {
  const current = TOWER_STAGES.indexOf(stage);
  return (
    <ol className="flex items-center gap-1" aria-label={`Progress: ${TOWER_STAGE_LABEL[stage]}`}>
      {TOWER_STAGES.map((s, i) => {
        const done = i <= current;
        const next = i === current + 1;
        return (
          <li key={s} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className={clsx('h-px w-2', i <= current ? 'bg-emerald-500/60' : 'bg-slate-700')} />}
            <span
              title={TOWER_STAGE_LABEL[s]}
              aria-label={`${TOWER_STAGE_LABEL[s]}: ${done ? 'done' : next ? 'next' : 'not yet'}`}
              className={clsx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap',
                done && s === 'live' && 'bg-emerald-500 text-white',
                done && s !== 'live' && 'bg-emerald-500/10 text-emerald-400',
                next && 'ring-1 ring-amber-500/50 text-amber-300 bg-amber-500/5',
                !done && !next && 'bg-slate-800/60 text-slate-500',
              )}
            >
              {done && <Check size={10} aria-hidden />}
              {TOWER_STAGE_LABEL[s]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
