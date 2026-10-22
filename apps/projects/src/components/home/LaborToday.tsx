'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ButtonLink, Pip, api, dayDate, shortDate, toast, type PipKind } from '@meritbooks/merit-ui';
import type { Assignment, LaborHomeData } from './persona-data';
import type { AssignmentStatus } from '@/lib/pm/ops/types';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import './field.css';

/** The one next move for a visit, in the technician's words. */
const NEXT: Partial<Record<AssignmentStatus, { to: AssignmentStatus; label: string; done: string }>> = {
  ASSIGNED: { to: 'EN_ROUTE', label: 'On my way', done: 'Marked on your way' },
  DISPATCHED: { to: 'EN_ROUTE', label: 'On my way', done: 'Marked on your way' },
  EN_ROUTE: { to: 'ON_SITE', label: 'I’m here', done: 'Marked on site' },
  ON_SITE: { to: 'DONE', label: 'Finish this visit', done: 'Finished the visit' },
};

const STATE: Record<AssignmentStatus, { word: string; pip: PipKind }> = {
  ASSIGNED: { word: 'Assigned', pip: 'open' },
  DISPATCHED: { word: 'Sent to you', pip: 'open' },
  EN_ROUTE: { word: 'On the way', pip: 'track' },
  ON_SITE: { word: 'On site', pip: 'risk' },
  DONE: { word: 'Done', pip: 'closed' },
  CANCELLED: { word: 'Cancelled', pip: 'soft' },
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hrs = (h: number) => (Math.round(h * 100) / 100).toLocaleString('en-US');

/**
 * Labor "Today" (spec §5): the current assignment with ONE big state button, the rest of today,
 * and this week's hours. No money anywhere on this screen.
 */
export function LaborToday({ data, readOnly }: { data: LaborHomeData; readOnly: boolean }) {
  const router = useRouter();
  const v = useVocab();
  const [busy, setBusy] = useState(false);
  const cur = data.current;
  const next = cur ? NEXT[cur.status] : undefined;
  const tasks = data.tasks.ok ? data.tasks.value : [];
  const logHref = '/time';

  const move = async (a: Assignment, to: AssignmentStatus, done: string) => {
    setBusy(true);
    const res = await api.post<{ ok: true }>(`/api/ops/assignments/${a.id}`, { status: to });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(done);
    router.refresh();
  };

  const maxDay = Math.max(8, ...(data.hours.ok ? data.hours.value.byDay.map((d) => d.hours) : [0]));

  return (
    <div className="fld">
      <div className="fld-body">
        <section className="fld-sec" aria-labelledby="fld-now">
          <div className="fld-sec-h">
            <h2 className="fld-h" id="fld-now">Now</h2>
            <span className="fld-eyebrow">{dayDate(data.today)}</span>
          </div>
          {data.assignments && !data.assignments.ok ? (
            <div className="fld-error" role="alert">
              <b>Your visits didn’t load.</b> {data.assignments.error} Reload the page in a minute.
            </div>
          ) : cur ? (
            <article className="fld-card" aria-labelledby="fld-cur">
              <span className="fld-eyebrow">{cur.window ?? 'Today'}</span>
              <span className="fld-title" id="fld-cur">{cur.title}</span>
              <span className="fld-sub">{[cur.job, cur.customer].filter(Boolean).join(' · ')}</span>
              <span className="fld-state">
                <Pip kind={STATE[cur.status].pip} />
                {STATE[cur.status].word}
              </span>
              <Link className="link" href={`/jobs/${cur.jobId}`}>Open the {lower(v.job)}</Link>
            </article>
          ) : tasks.length ? (
            <article className="fld-card" aria-labelledby="fld-cur">
              <span className="fld-eyebrow">On your {lower(v.jobs)} today</span>
              <span className="fld-title" id="fld-cur">{tasks[0]!.title}</span>
              <span className="fld-sub">{tasks[0]!.job}</span>
              <span className="fld-state">
                <Pip kind={tasks[0]!.status === 'IN_PROGRESS' ? 'track' : tasks[0]!.status === 'BLOCKED' ? 'blocked' : 'open'} />
                {tasks[0]!.status === 'IN_PROGRESS' ? 'In progress' : tasks[0]!.status === 'BLOCKED' ? 'Blocked' : 'To do'}
              </span>
              <Link className="link" href={`/jobs/${tasks[0]!.jobId}`}>Open the {lower(v.job)}</Link>
            </article>
          ) : (
            <div className="fld-empty">
              <b>Nothing is assigned to you today.</b> When the office books you on a visit or a task starts on your {lower(v.jobs)}, it shows here.
              {data.done ? ` You finished ${data.done} ${data.done === 1 ? 'visit' : 'visits'} today.` : ''}
            </div>
          )}
        </section>

        <section className="fld-sec" aria-labelledby="fld-rest">
          <div className="fld-sec-h">
            <h2 className="fld-h" id="fld-rest">Rest of today</h2>
          </div>
          {!data.tasks.ok ? (
            <div className="fld-error" role="alert"><b>Today’s tasks didn’t load.</b> {data.tasks.error}</div>
          ) : data.later.length === 0 && tasks.length <= (cur ? 0 : 1) ? (
            <p className="fld-empty">Nothing else today.</p>
          ) : (
            <ul className="fld-list">
              {data.later.map((a) => (
                <li key={a.id}>
                  <Link href={`/jobs/${a.jobId}`}>
                    <span className="t">{a.window?.split(' – ')[0] ?? 'Later'}</span>
                    <span>
                      <span className="m">{a.title}</span>
                      <span className="s">{[a.job, STATE[a.status].word].join(' · ')}</span>
                    </span>
                    <Pip kind={STATE[a.status].pip} />
                  </Link>
                </li>
              ))}
              {tasks.slice(cur ? 0 : 1).map((t) => (
                <li key={t.id}>
                  <Link href={`/jobs/${t.jobId}?tab=schedule`}>
                    <span className="t">Task</span>
                    <span>
                      <span className="m">{t.title}</span>
                      <span className="s">{t.job}</span>
                    </span>
                    <Pip kind={t.status === 'IN_PROGRESS' ? 'track' : t.status === 'BLOCKED' ? 'blocked' : 'open'} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="fld-sec" aria-labelledby="fld-week">
          <div className="fld-sec-h">
            <h2 className="fld-h" id="fld-week">This week</h2>
            <span className="fld-eyebrow">From {shortDate(data.weekStart)}</span>
          </div>
          {!data.hours.ok ? (
            <div className="fld-error" role="alert"><b>Your hours didn’t load.</b> {data.hours.error}</div>
          ) : (
            <>
              <div className="fld-hours">
                <span className="v">{hrs(data.hours.value.total)}</span>
                <span>hours logged{data.hours.value.drafts ? ` · ${data.hours.value.drafts} not submitted` : ''}</span>
              </div>
              <ul className="fld-week" aria-label="Hours by day">
                {data.hours.value.byDay.map((d) => {
                  const dow = DOW[new Date(`${d.day}T12:00:00Z`).getUTCDay()] ?? '';
                  return (
                    <li key={d.day} className={d.day === data.today ? 'is-today' : undefined} aria-label={`${dow}: ${hrs(d.hours)} hours`}>
                      <span className="bar" aria-hidden="true"><i style={{ height: `${Math.min(100, (d.hours / maxDay) * 100)}%` }} /></span>
                      <span aria-hidden="true">{dow}</span>
                      <span aria-hidden="true">{hrs(d.hours)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>

      {!readOnly && (
        <div className="fld-foot">
          {cur && next ? (
            <>
              <Button variant="primary" size="lg" onClick={() => void move(cur, next.to, next.done)} disabled={busy} aria-busy={busy || undefined}>
                {busy ? 'Saving…' : next.label}
              </Button>
              <ButtonLink size="lg" href={logHref}>Log my hours</ButtonLink>
            </>
          ) : (
            <ButtonLink variant="primary" size="lg" href={logHref}>Log my hours</ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}
