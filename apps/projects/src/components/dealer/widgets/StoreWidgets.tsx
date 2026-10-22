'use client';

import Link from 'next/link';
import { Pip, Widget, count, money, pct } from '@meritbooks/merit-ui';
import type { AgingData, DeskData, PartsBelowData, RentalsOutData } from '@/lib/pm/dealer/widget-queries';
import { useDealerWidget, type DealerWidgetPlacement } from './useDealerWidget';
import '@/components/ops/ops.css';

/**
 * The four store widgets for dealer homes. Each figure carries its comparison and where to act;
 * a widget for a company with no dealer side renders nothing (the dash reflows).
 */

export function AgedUnitsWidget({ x, y, w = 4, h = 2, companyId, limit = 4 }: DealerWidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useDealerWidget<AgingData>('aging', companyId);
  if (data && !data.applies) return null;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Units aging over 180 days"
      count={data ? count(data.aged) : undefined}
      meta={data && data.aged ? `${money(data.agedCostCents, { decimals: 0 })} at cost · of ${count(data.inStock)} in stock` : data ? `of ${count(data.inStock)} in stock` : undefined}
      state={
        error ? { kind: 'error', title: 'Aged units did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Aging the lot…', lines: 3 }
            : data.inStock === 0 ? { kind: 'empty', title: 'No units in stock yet', body: 'Receive units against their manufacturer invoices and their age shows here.', action: <Link className="link" href="/stock?new=1">Receive a unit</Link> }
              : data.aged === 0 ? { kind: 'done', title: 'Nothing over 180 days', body: `${count(data.coming)} unit${data.coming === 1 ? '' : 's'} between 91 and 180 days; price or demo them before they age.`, action: <Link className="link" href="/stock?age=90">Units over 90 days</Link> }
                : undefined
      }
      foot={data && data.aged ? <Link className="link" href="/stock?age=180">All aged units · {count(data.coming)} more turn 180 soon</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label="Oldest units">
        {data?.items.slice(0, limit).map((u) => (
          <li key={u.unitId}>
            <Link href={`/stock?unit=${u.unitId}`}>
              <span className="d">{count(u.days)} days</span>
              <span className="txt"><span className="l1">{u.stock ?? 'Unit'} · {u.title}</span><span className="l2">{money(u.costCents)} at cost{u.floored ? ' · floored, curtailments accrue' : ''}</span></span>
              <Pip kind={u.days > 365 ? 'overdue' : 'risk'} />
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function DealsToDeskWidget({ x, y, w = 4, h = 2, companyId, limit = 4 }: DealerWidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useDealerWidget<DeskData>('desk', companyId);
  if (data && !data.applies) return null;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Deals to desk"
      count={data ? count(data.toDesk) : undefined}
      meta={data ? `${money(data.toDeskGrossCents, { decimals: 0 })} gross · ${count(data.toFund)} to fund · ${count(data.toDeliver)} to deliver` : undefined}
      state={
        error ? { kind: 'error', title: 'Deals did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Reading the desk…', lines: 3 }
            : data.toDesk === 0 ? { kind: 'done', title: 'Nothing waiting on the desk', body: data.toFund + data.toDeliver ? `${count(data.toFund)} approved deal${data.toFund === 1 ? '' : 's'} waiting on funding, ${count(data.toDeliver)} ready to deliver.` : 'Written deals land here for manager approval.', action: <Link className="link" href="/deals">Open the pipeline</Link> }
              : undefined
      }
      foot={data && data.toDesk ? <Link className="link" href="/deals?stage=WRITTEN">All written deals</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label="Written deals, oldest first">
        {data?.items.slice(0, limit).map((d) => (
          <li key={d.dealId}>
            <Link href={`/deals/${d.dealId}`}>
              <span className="amt">{money(d.grossCents, { decimals: 0 })}</span>
              <span className="txt"><span className="l1">{d.number}{d.customer ? ` · ${d.customer}` : ''}</span><span className="l2">{d.pct == null ? 'no sale price yet' : `${pct(d.pct)} front`} · written {d.days === 0 ? 'today' : `${count(d.days)} day${d.days === 1 ? '' : 's'} ago`}</span></span>
              <Pip kind={d.grossCents < 0 ? 'overdue' : d.days > 2 ? 'risk' : 'track'} />
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function PartsBelowMinWidget({ x, y, w = 4, h = 2, companyId, limit = 4 }: DealerWidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useDealerWidget<PartsBelowData>('parts', companyId);
  if (data && !data.applies) return null;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Parts below minimum"
      count={data ? count(data.below) : undefined}
      meta={data ? `${count(data.covered)} covered by open orders · of ${count(data.stocked)} stocked` : undefined}
      state={
        error ? { kind: 'error', title: 'Parts did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Checking min and max…', lines: 3 }
            : data.stocked === 0 ? { kind: 'empty', title: 'No min/max set yet', body: 'Give stocked parts a bin and a minimum; the ones that drop below it show here.', action: <Link className="link" href="/parts?tab=catalog">Parts catalog</Link> }
              : data.below === 0 ? { kind: 'done', title: 'Every stocked part is at or above min', body: `${count(data.stocked)} parts have a minimum. Stock orders suggest what to buy as they sell.`, action: <Link className="link" href="/parts?tab=orders">Stock orders</Link> }
                : undefined
      }
      foot={data && data.below ? <Link className="link" href="/parts?tab=orders">Build a stock order from min/max</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label="Parts furthest below minimum">
        {data?.items.slice(0, limit).map((pt) => (
          <li key={pt.partId}>
            <Link href="/parts?tab=catalog&below=1">
              <span className="d">{count(pt.onHand)} / {count(pt.min)}</span>
              <span className="txt"><span className="l1">{pt.number}</span><span className="l2">{pt.description}{pt.bin ? ` · bin ${pt.bin}` : ''}{pt.onOrder ? ` · ${count(pt.onOrder)} on order` : ''}</span></span>
              <Pip kind={pt.onHand + pt.onOrder >= pt.min ? 'track' : pt.onHand <= 0 ? 'overdue' : 'risk'} />
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function RentalsOutWidget({ x, y, w = 4, h = 2, companyId, limit = 4 }: DealerWidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useDealerWidget<RentalsOutData>('rentals', companyId);
  if (data && !data.applies) return null;
  if (data && data.fleet === 0 && data.out === 0) return null;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Rentals out"
      count={data ? count(data.out) : undefined}
      meta={data ? `of ${count(data.fleet)} in the fleet · ${data.utilization == null ? 'no history yet' : `${pct(data.utilization)} on rent, 90 days`}` : undefined}
      state={
        error ? { kind: 'error', title: 'Rentals did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Reading the fleet…', lines: 3 }
            : data.out === 0 ? { kind: 'done', title: 'Nothing out on rent', body: `${count(data.fleet)} unit${data.fleet === 1 ? '' : 's'} free in the fleet.`, action: <Link className="link" href="/rentals">Reservation calendar</Link> }
              : undefined
      }
      foot={data && data.out ? <Link className="link" href="/rentals">{data.late ? `${count(data.late)} late back · ` : ''}{data.dueToday ? `${count(data.dueToday)} due today · ` : ''}Calendar</Link> : undefined}
    >
      <ul className="agenda ops-agenda" aria-label="Rentals out, late first">
        {data?.items.slice(0, limit).map((r) => (
          <li key={r.contractId}>
            <Link href={`/rentals?contract=${r.contractId}`}>
              <span className={r.late ? 'd neg' : 'd'}>{r.late ? 'Late' : r.dueBack ? new Date(r.dueBack).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</span>
              <span className="txt"><span className="l1">{r.unit}</span><span className="l2">{r.number}{r.customer ? ` · ${r.customer}` : ''}</span></span>
              <Pip kind={r.late ? 'overdue' : 'track'} />
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
