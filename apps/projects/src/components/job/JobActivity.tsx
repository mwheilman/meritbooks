'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { WidgetState } from '@meritbooks/merit-ui';
import type { ActivityRow } from '@/lib/pm/types';
import { ActivityFeed } from '@/components/common/ActivityFeed';
import { ACTIVITY_KINDS, ACTIVITY_KIND_LABEL, activityKind, kindCounts, type ActivityKind } from './activity-kinds';
import './job.css';

/**
 * The job's activity: people, field, portal, AI, Books and system events in one stream, with
 * filter chips. `limit` trims it for the Overview; the Activity tab shows everything loaded.
 */
export function JobActivity({ rows, showMoney, limit, allHref }: { rows: ActivityRow[]; showMoney: boolean; limit?: number; allHref?: string }) {
  const [on, setOn] = useState<ReadonlySet<ActivityKind>>(new Set());
  const counts = useMemo(() => kindCounts(rows), [rows]);
  const shown = useMemo(() => {
    const f = on.size ? rows.filter((r) => on.has(activityKind(r))) : rows;
    return limit ? f.slice(0, limit) : f;
  }, [rows, on, limit]);
  const toggle = (k: ActivityKind) =>
    setOn((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  if (rows.length === 0) {
    return <WidgetState state={{ kind: 'empty', title: 'Nothing has happened on this job yet', body: 'Stage moves, changes, field work, billing and Books events land here as they happen.' }} />;
  }
  return (
    <div className="job-activity">
      <div className="job-chips" role="group" aria-label="Filter activity">
        <button type="button" className={on.size === 0 ? 'job-chip is-on' : 'job-chip'} aria-pressed={on.size === 0} onClick={() => setOn(new Set())}>
          All <span className="tnum">{rows.length}</span>
        </button>
        {ACTIVITY_KINDS.map((k) => (
          <button key={k} type="button" className={on.has(k) ? 'job-chip is-on' : 'job-chip'} aria-pressed={on.has(k)} disabled={counts[k] === 0} onClick={() => toggle(k)}>
            {ACTIVITY_KIND_LABEL[k]} <span className="tnum">{counts[k]}</span>
          </button>
        ))}
      </div>
      {shown.length ? <ActivityFeed rows={shown} showMoney={showMoney} /> : <p className="t-cap ink-3" style={{ padding: 16 }}>Nothing of that kind yet.</p>}
      {allHref && limit && rows.length > limit && <p style={{ padding: '8px 0' }}><Link className="link" href={allHref}>All activity</Link></p>}
    </div>
  );
}
