'use client';

/**
 * The 3-week look-ahead: tasks starting or active in the window, grouped by crew or trade,
 * each with its days across the three weeks and its constraints (submittal not approved,
 * material not received, predecessor not done). A row opens its job's schedule.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ButtonLink, Keybar, QueueTable, Seg, Status, WidgetState, shortDate, type QueueColumn, type QueueGroup } from '@meritbooks/merit-ui';
import { DEFAULT_CALENDAR, type CrewOption, type LookaheadRow } from '@/lib/pm/schedule/types';
import { isWorkday } from '@/lib/pm/schedule/calendar';
import { addDays } from '@/lib/time';
import { taskStatus } from '@/lib/pm/stage';
import type { GlobalJob } from './GlobalSchedule';

type GroupBy = 'crew' | 'trade' | 'job';

export interface LookAheadProps {
  rows: ReadonlyArray<LookaheadRow>;
  jobs: ReadonlyArray<GlobalJob>;
  crews: ReadonlyArray<CrewOption>;
  from: string;
  today: string;
  engine: boolean;
  initialCrew: string | null;
  filtered: boolean;
}

/** Group look-ahead rows; groups with constraints first, then by name. Pure. */
export function groupLookahead(rows: ReadonlyArray<LookaheadRow>, by: GroupBy, jobLabel: (id: string) => string, crewName: (id: string | null) => string | null): Array<{ id: string; title: string; rows: LookaheadRow[]; blocked: number }> {
  const m = new Map<string, { id: string; title: string; rows: LookaheadRow[]; blocked: number }>();
  for (const r of rows) {
    const key = by === 'crew' ? r.crew_id ?? '' : by === 'trade' ? r.trade ?? '' : r.job_id;
    const title = by === 'crew' ? r.crew_name ?? crewName(r.crew_id) ?? 'No crew assigned' : by === 'trade' ? r.trade ?? 'No trade' : jobLabel(r.job_id);
    const g = m.get(key) ?? { id: key || '-', title, rows: [], blocked: 0 };
    g.rows.push(r);
    if (r.constraints.length) g.blocked += 1;
    m.set(key, g);
  }
  for (const g of m.values()) g.rows.sort((a, b) => (a.start_on ?? '').localeCompare(b.start_on ?? '') || a.title.localeCompare(b.title));
  return [...m.values()].sort((a, b) => (a.id === '-' ? 1 : 0) - (b.id === '-' ? 1 : 0) || a.title.localeCompare(b.title));
}

export function LookAhead(p: LookAheadProps) {
  const router = useRouter();
  const [by, setBy] = useState<GroupBy>('crew');
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [crew, setCrew] = useState<string | null>(p.initialCrew);
  const days = useMemo(() => Array.from({ length: 21 }, (_, i) => addDays(p.from, i)), [p.from]);
  const jobBy = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const crewName = (id: string | null) => (id ? p.crews.find((c) => c.id === id)?.name ?? null : null);
  const rows = p.rows.filter((r) => (!onlyBlocked || r.constraints.length > 0) && (!crew || r.crew_id === crew));
  const groups: QueueGroup<LookaheadRow>[] = groupLookahead(rows, by, (id) => jobBy.get(id)?.label ?? 'Job', crewName).map((g) => ({
    id: g.id,
    title: g.title,
    caption: g.blocked ? `${g.blocked} held by a constraint` : 'Ready to work',
    rows: g.rows,
  }));
  const blocked = p.rows.filter((r) => r.constraints.length).length;
  const end = addDays(p.from, 20);

  const columns: QueueColumn<LookaheadRow>[] = [
    {
      id: 'task',
      header: 'Task',
      cell: (r) => (
        <Link className="nlink" href={`/jobs/${r.job_id}?tab=schedule`} style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">{r.title}{r.is_critical ? ' · critical' : ''}</span>
          <span className="l2">{[jobBy.get(r.job_id)?.label, by !== 'crew' ? r.crew_name ?? crewName(r.crew_id) : r.trade].filter(Boolean).join(' · ')}</span>
        </Link>
      ),
    },
    { id: 'start', header: 'Start', width: 80, cell: (r) => (r.start_on ? shortDate(r.start_on) : '—') },
    { id: 'finish', header: 'Finish', width: 80, cell: (r) => (r.due_on ? shortDate(r.due_on) : '—') },
    {
      id: 'days',
      header: `${shortDate(p.from)} – ${shortDate(end)}`,
      width: 200,
      cell: (r) => (
        <span className="la-days" role="img" aria-label={`${r.title}: ${r.start_on ?? '?'} to ${r.due_on ?? '?'}`}>
          {days.map((d) => {
            const on = !!r.start_on && !!r.due_on && d >= r.start_on && d <= r.due_on && isWorkday(DEFAULT_CALENDAR, d);
            const cls = [on ? (r.is_critical ? 'crit' : 'on') : !isWorkday(DEFAULT_CALENDAR, d) ? 'off' : '', d === p.today ? 'today' : ''].filter(Boolean).join(' ');
            return <i key={d} className={cls || undefined} />;
          })}
        </span>
      ),
    },
    {
      id: 'constraints',
      header: 'Constraints',
      width: 260,
      cell: (r) =>
        r.constraints.length ? (
          <span title={r.constraints.map((c) => c.label).join(' · ')}>
            <Status kind="blocked" pip="blocked">
              {r.constraints[0]!.label}
              {r.constraints.length > 1 ? ` +${r.constraints.length - 1} more` : ''}
            </Status>
          </span>
        ) : p.engine ? (
          <Status kind="ready" pip="ready">Clear</Status>
        ) : (
          <span className="t-cap">Not checked yet</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 150,
      cell: (r) => {
        const s = taskStatus(r.status, !!r.due_on && r.due_on < p.today && r.status !== 'DONE');
        return <Status kind={s.kind} pip={s.pip}>{r.pct_complete ? `${s.word} · ${Math.round(r.pct_complete * 100)}%` : s.word}</Status>;
      },
    },
  ];

  const shift = (weeks: number) => router.push(`/schedule?view=lookahead&from=${addDays(p.from, weeks * 7)}${crew ? `&crew=${crew}` : ''}`);

  return (
    <div className="stack">
      <div className="gx-bar">
        <Seg<GroupBy> aria-label="Group by" items={[{ value: 'crew', label: 'By crew' }, { value: 'trade', label: 'By trade' }, { value: 'job', label: 'By job' }]} value={by} onChange={setBy} />
        <Seg<'all' | 'blocked'>
          aria-label="Show"
          items={[{ value: 'all', label: 'All', count: p.rows.length }, { value: 'blocked', label: 'Held by a constraint', count: blocked, disabled: !p.engine }]}
          value={onlyBlocked ? 'blocked' : 'all'}
          onChange={(v) => setOnlyBlocked(v === 'blocked')}
        />
        {crew && (
          <button type="button" className="btn btn--quiet" onClick={() => setCrew(null)}>
            {`Showing ${crewName(crew) ?? 'one crew'} · show every crew`}
          </button>
        )}
        <span className="sp" />
        <button type="button" className="btn btn--quiet" onClick={() => shift(-1)}>Earlier week</button>
        <ButtonLink variant="quiet" href="/schedule?view=lookahead">This week</ButtonLink>
        <button type="button" className="btn btn--quiet" onClick={() => shift(1)}>Later week</button>
      </div>
      {rows.length === 0 ? (
        <div className="surface">
          <WidgetState
            state={
              onlyBlocked
                ? { kind: 'done', title: 'Nothing is held up', body: 'No task in these three weeks is waiting on a submittal, material or a predecessor.' }
                : { kind: 'empty', title: 'Nothing scheduled in these three weeks', body: p.filtered || crew ? 'Clear a filter, or look at a later week.' : 'Tasks with dates in the window show here, grouped by crew. Add dates on a job’s Schedule tab.' }
            }
          />
        </div>
      ) : (
        <div className="mp-table">
          <QueueTable
            aria-label={`Look-ahead, ${shortDate(p.from)} to ${shortDate(end)}`}
            columns={columns}
            groups={groups}
            getRowId={(r) => r.task_id}
            rowState={(r) => ({ attn: r.constraints.length > 0, done: r.status === 'DONE' })}
            onOpen={(r) => router.push(`/jobs/${r.job_id}?tab=schedule`)}
            compact
          />
        </div>
      )}
      <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open the job’s schedule' }]} note={`${shortDate(p.from)} to ${shortDate(end)} · tasks starting or under way`} />
    </div>
  );
}
