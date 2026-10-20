'use client';

import Link from 'next/link';
import { Pip, Widget, count, money, shortDate } from '@meritbooks/merit-ui';
import { SELECTION_STATUS } from '@/lib/pm/ops/labels';
import { variance, varianceText } from '@/lib/pm/ops/selection-math';
import type { SelectionsDueData } from '@/lib/pm/ops/widget-queries';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import { useWidget, type WidgetPlacement } from './useWidget';
import '../ops.css';

/** Selections due in the next two weeks (and any past due), soonest first. */
export function SelectionsDueWidget({ x, y, w = 4, h = 2, companyId, limit = 5 }: WidgetPlacement & { limit?: number }) {
  const v = useVocab();
  const { data, error, reload } = useWidget<SelectionsDueData>('selections', companyId);
  const today = todayIso();
  const title = `${v.selections} due`;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title={title}
      count={data?.items.length || undefined}
      meta={data ? [data.overdue ? `${count(data.overdue)} past due` : null, data.withClient ? `${count(data.withClient)} with the client` : null].filter(Boolean).join(' · ') || 'Next 14 days' : undefined}
      state={
        error ? { kind: 'error', title: `${title} did not load`, body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: `Reading ${lower(v.selections)}…`, lines: 3 }
            : data.items.length === 0
              ? { kind: 'done', title: `No ${lower(v.selections)} due before ${shortDate(data.horizon, today)}`, body: 'Give each open decision a due date, and the ones coming up show here.', action: <Link className="link" href="/selections">Open {lower(v.selections)}</Link> }
              : undefined
      }
      foot={data && data.items.length ? <Link className="link" href="/selections">All {lower(v.selections)}</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label={title}>
        {data?.items.slice(0, limit).map((s) => {
          const mark = SELECTION_STATUS[s.status];
          const chosen = s.chosenCents != null && s.allowanceCents != null ? varianceText(variance(s.chosenCents, s.allowanceCents)) : s.allowanceCents != null ? `${money(s.allowanceCents, { decimals: 0 })} allowance` : null;
          return (
            <li key={s.selectionId}>
              <Link href={`/selections?job=${s.jobId}&selection=${s.selectionId}`}>
                <span className={s.overdue ? 'd neg' : 'd'}>{s.dueOn === today ? 'Today' : shortDate(s.dueOn, today)}</span>
                <span className="txt">
                  <span className="l1">{s.title}</span>
                  <span className="l2">{[s.job, s.overdue ? 'Past due' : mark.word, chosen].filter(Boolean).join(' · ')}</span>
                </span>
                <Pip kind={s.overdue ? 'overdue' : mark.pip} />
              </Link>
            </li>
          );
        })}
      </ul>
    </Widget>
  );
}
