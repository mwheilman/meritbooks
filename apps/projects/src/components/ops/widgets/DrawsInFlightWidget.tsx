'use client';

import Link from 'next/link';
import { Pip, Widget, count, money, type PipKind } from '@meritbooks/merit-ui';
import { DRAW_STATUS_WORDS } from '@/lib/pm/ops/draw-math';
import type { DrawFlightItem, DrawsFlightData } from '@/lib/pm/ops/widget-queries';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { useWidget, type WidgetPlacement } from './useWidget';
import '../ops.css';

function next(d: DrawFlightItem): { text: string; pip: PipKind } {
  switch (d.status) {
    case 'RETURNED': return { text: 'Returned by the lender, fix and resubmit', pip: 'blocked' };
    case 'DRAFT': return { text: d.missing ? `Draft, ${count(d.missing)} package ${d.missing === 1 ? 'item' : 'items'} missing` : 'Draft, ready to submit', pip: d.missing ? 'risk' : 'open' };
    case 'SUBMITTED': return { text: `With the lender ${d.daysOut === 1 ? '1 day' : `${count(d.daysOut ?? 0)} days`}${d.inspection === 'PENDING' ? ', waiting on the inspector' : ''}`, pip: (d.daysOut ?? 0) > 10 ? 'risk' : 'track' };
    case 'INSPECTION': return { text: `Inspected, waiting on approval (${count(d.daysOut ?? 0)} days out)`, pip: 'track' };
    case 'APPROVED': return { text: 'Approved, waiting on funding', pip: 'ready' };
    default: return { text: DRAW_STATUS_WORDS[d.status], pip: 'closed' };
  }
}

/** Draws in flight: what is with the lender, for how long, and what is stuck. */
export function DrawsInFlightWidget({ x, y, w = 4, h = 2, companyId, limit = 5 }: WidgetPlacement & { limit?: number }) {
  const v = useVocab();
  const { data, error, reload } = useWidget<DrawsFlightData>('draws', companyId);
  const title = `${v.draws} in flight`;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title={title}
      count={data?.items.length || undefined}
      meta={data && data.withLender ? `${money(data.outCents, { decimals: 0 })} with lenders` : undefined}
      state={
        error ? { kind: 'error', title: `${title} did not load`, body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: `Reading ${lower(v.draws)}…`, lines: 3 }
            : data.items.length === 0
              ? { kind: 'done', title: `No ${lower(v.draws)} open`, body: 'Every draw is funded or cancelled. Start the next one from its loan budget.', action: <Link className="link" href="/draws">Open {lower(v.draws)}</Link> }
              : undefined
      }
      foot={data && data.items.length ? <Link className="link" href="/draws">All {lower(v.draws)}</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label={title}>
        {data?.items.slice(0, limit).map((d) => {
          const n = next(d);
          return (
            <li key={d.drawId}>
              <Link href={`/draws?loan=${d.scheduleId}`}>
                <span className="amt">{money(d.amountCents, { decimals: 0 })}</span>
                <span className="txt">
                  <span className="l1">{`Draw ${d.number}`}{d.job ? ` · ${d.job}` : ''}</span>
                  <span className="l2">{n.text}</span>
                </span>
                <Pip kind={n.pip} />
              </Link>
            </li>
          );
        })}
      </ul>
    </Widget>
  );
}
