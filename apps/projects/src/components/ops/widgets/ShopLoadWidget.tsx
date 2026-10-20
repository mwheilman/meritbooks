'use client';

import Link from 'next/link';
import { Widget, count } from '@meritbooks/merit-ui';
import { centerSentence, weeksText } from '@/lib/pm/ops/shop-math';
import type { ShopData } from '@/lib/pm/ops/widget-queries';
import { useWidget, type WidgetPlacement } from './useWidget';
import '../ops.css';

/** Shop load as a capacity statement: weeks of released work, the constraint, and what is late. */
export function ShopLoadWidget({ x, y, w = 4, h = 2, companyId, limit = 3 }: WidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useWidget<ShopData>('shop', companyId);
  const active = data?.centers.filter((c) => c.status !== 'INACTIVE') ?? [];
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Shop load"
      count={data?.load.weeks != null ? weeksText(data.load.weeks) : undefined}
      meta={data ? [data.released ? `${count(data.released)} on the floor` : null, data.late ? `${count(data.late)} past promise` : null].filter(Boolean).join(' · ') || undefined : undefined}
      state={
        error ? { kind: 'error', title: 'Shop load did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Adding up the shop…', lines: 3 }
            : data.centers.length === 0
              ? { kind: 'empty', title: 'Set up your work centers', body: 'Add each center with its weekly hours, and released work turns into weeks of load here.', action: <Link className="link" href="/production?view=setup">Shop setup</Link> }
              : undefined
      }
      foot={data && data.centers.length ? <Link className="link" href="/production">Production board</Link> : undefined}
    >
      {data && (
        <div>
          <p style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>{data.load.sentence}</p>
          <ul className="ops-centers" aria-label="Work centers, busiest first">
            {active.slice(0, limit).map((c) => {
              const fill = c.capacity_minutes_per_week > 0 ? c.open_std_minutes / c.capacity_minutes_per_week : 0;
              return (
                <li key={c.work_center_id}>
                  <span className="t-cap">{centerSentence(c)}</span>
                  <span className={fill > 2 ? 'load-bar over' : 'load-bar'} role="img" aria-label={c.capacity_minutes_per_week > 0 ? `${weeksText(fill)} of work` : 'No weekly capacity'}>
                    <i style={{ width: `${Math.min(100, (fill / 2) * 100)}%` }} />
                    <b style={{ left: '50%' }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Widget>
  );
}
