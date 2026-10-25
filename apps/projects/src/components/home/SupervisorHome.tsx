'use client';

import { timeApprovalText, type TimeApprovalWire } from '@/lib/approvals/outcome';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, Dash, Keys, Pip, QueueTable, Widget, api, count, shortDate, toast,
  type QueueColumn, type WidgetStateSpec,
} from '@meritbooks/merit-ui';
import type { CrewTimeItem, Settled, SupervisorHomeData } from './persona-data';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { mondayOf } from '@/lib/pm/ops/week';

const hoursText = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString('en-US')} h`;

function failed<T>(s: Settled<T>, title: string, retry: () => void): WidgetStateSpec | undefined {
  return s.ok ? undefined : { kind: 'error', title, body: `${s.error} Try again; if it repeats, tell support.`, onRetry: retry, retryLabel: 'Try again' };
}

/** Supervisor "Today": who is on which site, crew time waiting on you, and open punch. Hours only — no dollars. */
export function SupervisorHome({ data, readOnly }: { data: SupervisorHomeData; readOnly: boolean }) {
  const router = useRouter();
  const v = useVocab();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const retry = () => router.refresh();
  const site = data.site.ok ? data.site.value : [];
  const crew = data.crewTime?.ok ? data.crewTime.value : [];
  const punch = data.punch?.ok ? data.punch.value : [];

  const approve = async (picked: CrewTimeItem[]) => {
    // Late phone taps are acknowledged one by one on the time sheet, never in a bulk approval.
    const rows = picked.filter((r) => !r.late);
    if (picked.length > rows.length) toast(`${count(picked.length - rows.length)} late ${picked.length - rows.length === 1 ? 'entry' : 'entries'} left for the time sheet: acknowledge each one there.`);
    if (!rows.length) return;
    setBusy(true);
    const res = await api.post<TimeApprovalWire>('/api/ops/time/approve', { ids: rows.map((r) => r.id) });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(timeApprovalText(res.data, rows.length));
    setSelected(new Set());
    router.refresh();
  };

  const timeCols: QueueColumn<CrewTimeItem>[] = [
    {
      id: 'who',
      header: 'Who',
      cell: (t) => (
        <Link href={`/time?week=${mondayOf(t.workDate)}`} className="nlink" style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">{t.person}</span>
          <span className="l2">{t.job}{t.late ? ` · ${t.late}` : ''}</span>
        </Link>
      ),
    },
    { id: 'day', header: 'Day', width: 96, cell: (t) => shortDate(t.workDate) },
    { id: 'hours', header: 'Hours', numeric: true, width: 88, cell: (t) => hoursText(t.hours) },
  ];
  const crewHours = crew.reduce((s, t) => s + t.hours, 0);

  return (
    <Dash flow="row">
      <Widget
        primary
        w={8}
        h={4}
        x={1}
        y={1}
        title="On site today"
        count={site.length || undefined}
        meta={site.length ? `${count(site.reduce((s, j) => s + j.tasks.length, 0))} tasks in progress or due` : undefined}
        state={
          failed(data.site, 'Today’s sites didn’t load', retry) ??
          (site.length === 0
            ? {
                kind: 'done',
                title: 'No task is scheduled on your sites today',
                body: `Tasks show here when they start, are due or are in progress today on your ${lower(v.jobs)}.`,
                action: <ButtonLink href="/schedule">Open schedule</ButtonLink>,
              }
            : undefined)
        }
      >
        <ul className="agenda">
          {site.map((s) => (
            <li key={s.job.job_id}>
              <Link href={`/jobs/${s.job.job_id}?tab=schedule`}>
                <span className="d tnum">{count(s.tasks.length)}</span>
                <span className="txt">
                  <span className="l1">{[s.job.job_number, s.job.name].filter(Boolean).join(' · ')}</span>
                  <span className="l2">
                    {s.tasks.slice(0, 2).map((t) => t.title).join(' · ')}
                    {s.tasks.length > 2 ? ` · ${count(s.tasks.length - 2)} more` : ''}
                    {s.punchOpen ? ` · ${count(s.punchOpen)} punch open` : ''}
                    {s.company ? ` · ${s.company}` : ''}
                  </span>
                </span>
                <Pip kind={s.tasks.some((t) => t.status === 'BLOCKED') ? 'blocked' : s.tasks.some((t) => t.due_on && t.due_on < data.today) ? 'overdue' : 'open'} />
              </Link>
            </li>
          ))}
        </ul>
      </Widget>

      {data.crewTime && (
        <Widget
          w={4}
          h={4}
          x={9}
          y={1}
          title="Crew time to approve"
          count={crew.length || undefined}
          meta={crew.length ? hoursText(crewHours) : undefined}
          foot={
            crew.length ? (
              <>
                <Keys chord="x">select</Keys>
                <Keys chord="enter">open</Keys>
              </>
            ) : undefined
          }
          state={
            failed(data.crewTime, 'Crew time didn’t load', retry) ??
            (crew.length === 0
              ? { kind: 'done', title: 'No time is waiting on you', body: 'Submitted hours from the last three weeks show here to approve.', action: <ButtonLink href="/time">Open time</ButtonLink> }
              : undefined)
          }
        >
          <QueueTable
            aria-label="Submitted crew time waiting for your approval"
            columns={timeCols}
            rows={crew}
            getRowId={(t) => t.id}
            selectable={!readOnly}
            selected={selected}
            onSelectedChange={setSelected}
            openOnClick
            onOpen={(t) => router.push(`/time?week=${mondayOf(t.workDate)}`)}
            bulkSummary={(rows) => [`${count(rows.length)} selected`, hoursText(rows.reduce((s, r) => s + r.hours, 0))]}
            bulkActions={(rows) => (
              <Button variant="primary" onClick={() => void approve(rows)} disabled={busy}>
                {busy ? 'Approving…' : `Approve ${count(rows.length)}`}
              </Button>
            )}
            flush
            compact
          />
        </Widget>
      )}

      {data.punch && (
        <Widget
          w={8}
          h={3}
          x={1}
          y={5}
          title="Open punch"
          count={punch.length || undefined}
          meta={punch.some((p) => p.late) ? `${count(punch.filter((p) => p.late).length)} past due` : undefined}
          foot={punch.length > 6 ? <Link className="link" href="/punch-list">All {count(punch.length)} open</Link> : undefined}
          state={
            failed(data.punch, 'The punch list didn’t load', retry) ??
            (punch.length === 0 ? { kind: 'done', title: 'No punch item is open', body: `Every item on your ${lower(v.jobs)} is closed.` } : undefined)
          }
        >
          <ul className="agenda">
            {punch.slice(0, 6).map((p) => (
              <li key={p.id}>
                <Link href={`/jobs/${p.jobId}?tab=punch`}>
                  <span className={p.late ? 'd neg' : 'd'}>{p.dueOn ? shortDate(p.dueOn) : '—'}</span>
                  <span className="txt">
                    <span className="l1">{p.title}</span>
                    <span className="l2">
                      {p.job} · {p.late ? 'past due' : p.status === 'READY_FOR_REVIEW' ? 'ready for review' : p.status === 'IN_PROGRESS' ? 'in progress' : 'open'}
                    </span>
                  </span>
                  <Pip kind={p.late ? 'overdue' : p.status === 'READY_FOR_REVIEW' ? 'track' : 'open'} />
                </Link>
              </li>
            ))}
          </ul>
        </Widget>
      )}
    </Dash>
  );
}
