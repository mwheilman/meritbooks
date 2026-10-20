'use client';

import Link from 'next/link';
import { Pip, Widget, count } from '@meritbooks/merit-ui';
import { ASSIGNMENT_STATUS, woVocab } from '@/lib/pm/ops/labels';
import type { VisitsData } from '@/lib/pm/ops/widget-queries';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { useWidget, type WidgetPlacement } from './useWidget';
import '../ops.css';

/** Today's visits (repair orders, install tickets): who is where, in time order, and what is running late. */
export function TodaysVisitsWidget({ x, y, w = 4, h = 2, companyId, limit = 5 }: WidgetPlacement & { limit?: number }) {
  const v = useVocab();
  const wv = woVocab(v);
  const { data, error, reload } = useWidget<VisitsData>('visits', companyId);
  const late = data?.items.filter((i) => i.late).length ?? 0;
  const left = data?.items.filter((i) => i.status !== 'DONE').length ?? 0;
  const title = `Today's ${lower(wv.many)}`;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title={title}
      count={data?.items.length || undefined}
      meta={data ? [late ? `${count(late)} running late` : null, data.items.length ? `${count(left)} still to do` : null].filter(Boolean).join(' · ') || undefined : undefined}
      state={
        error ? { kind: 'error', title: `${title} did not load`, body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Reading the board…', lines: 3 }
            : data.items.length === 0
              ? {
                  kind: data.waiting ? 'empty' : 'done',
                  title: `Nothing on the board today`,
                  body: data.waiting
                    ? `${count(data.waiting)} ${data.waiting === 1 ? lower(wv.one) : lower(wv.many)} waiting to be scheduled${data.overdueWaiting ? `, ${count(data.overdueWaiting)} past due` : ''}.`
                    : 'No one is booked and nothing is waiting to be scheduled.',
                  action: <Link className="link" href="/dispatch">Open the dispatch board</Link>,
                }
              : undefined
      }
      foot={data && data.items.length ? (
        <>
          <span>{data.waiting ? `${count(data.waiting)} waiting to be scheduled${data.overdueWaiting ? `, ${count(data.overdueWaiting)} past due` : ''}` : 'Nothing waiting to be scheduled'}</span>
          <Link className="link" href="/dispatch">Dispatch board</Link>
        </>
      ) : undefined}
    >
      <ul className="agenda ops-agenda" aria-label={title}>
        {data?.items.slice(0, limit).map((i) => (
          <li key={i.assignmentId}>
            <Link href={`/dispatch?wo=${i.workOrderId}`}>
              <span className={i.late ? 'd neg' : 'd'}>{i.when.split('–')[0]}</span>
              <span className="txt">
                <span className="l1">{[i.number, i.summary].filter(Boolean).join(' · ')}</span>
                <span className="l2">{[i.tech, i.job, i.late ? 'Running late' : ASSIGNMENT_STATUS[i.status].word].filter(Boolean).join(' · ')}</span>
              </span>
              <Pip kind={i.late ? 'overdue' : ASSIGNMENT_STATUS[i.status].pip} />
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
