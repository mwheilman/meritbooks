'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Seg, Tag, WidgetState, count } from '@meritbooks/merit-ui';
import { INBOX_KIND } from '@/lib/commercial/labels';
import type { InboxRow } from '@/lib/commercial/types';
import { day } from './common';

/**
 * Ball in court (CGC-10): what waits on whom across RFIs, submittal reviews, sub pay apps,
 * PCOs with the owner, T&M to sign, forecasts, meeting items, observations and payment holds.
 * Rows come from pm.cm_ball_in_court (the caller's own visibility); "Mine" is what waits on you.
 */
export function BallInCourt({ items, today, jobLabels, kinds }: { items: InboxRow[]; today: string; jobLabels: Readonly<Record<string, string>>; kinds?: ReadonlyArray<string> }) {
  const scoped = kinds ? items.filter((i) => kinds.includes(i.kind)) : items;
  const [who, setWho] = useState<'mine' | 'all'>(scoped.some((i) => i.mine) ? 'mine' : 'all');
  const shown = scoped.filter((i) => who === 'all' || i.mine).sort((a, b) => (b.days_overdue ?? -999) - (a.days_overdue ?? -999) || (b.age_days ?? 0) - (a.age_days ?? 0));
  return (
    <section className="sec" aria-label="Ball in court">
      <div className="sec-h" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 className="t-section">Ball in court</h2>
        <span style={{ flex: 1 }} />
        <Seg aria-label="Whose items" value={who} onChange={setWho} items={[{ value: 'mine', label: 'Waiting on me', count: scoped.filter((i) => i.mine).length }, { value: 'all', label: 'Everything open', count: scoped.length }]} />
      </div>
      {shown.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: who === 'mine' ? 'Nothing is waiting on you' : 'Nothing is waiting on anyone', body: 'Open RFIs, submittal reviews, pay applications to approve, T&M to sign and meeting items show here with who holds them and how late they are.' }} />
      ) : (
        <ul className="feed">
          {shown.slice(0, 40).map((i) => (
            <li key={`${i.kind}:${i.item_id}`}>
              <span style={{ minWidth: 0 }}>
                <span className="l1">
                  <Tag>{INBOX_KIND[i.kind] ?? i.kind}</Tag>{' '}
                  {i.link ? <Link className="nlink" href={i.link}>{i.ref ? `${i.ref} · ` : ''}{i.title}</Link> : <>{i.ref ? `${i.ref} · ` : ''}{i.title}</>}
                  {(i.days_overdue ?? 0) > 0 && <> <Tag tone="neg">{count(i.days_overdue ?? 0)} {i.days_overdue === 1 ? 'day' : 'days'} late</Tag></>}
                </span>
                <span className="l2">{[i.job_id ? jobLabels[i.job_id] ?? null : null, i.waiting_on ? `Waiting on ${i.waiting_on}` : null, i.due_on ? `Due ${day(i.due_on, today)}` : null].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="t">{i.age_days != null ? `${i.age_days}d open` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 40 && <p className="t-cap">Showing the 40 most urgent of {count(shown.length)}.</p>}
    </section>
  );
}
