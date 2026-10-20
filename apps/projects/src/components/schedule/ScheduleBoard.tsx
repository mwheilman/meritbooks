'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Keybar, QueueTable, Status, WidgetState, shortDate, type QueueColumn, type QueueGroup } from '@meritbooks/merit-ui';
import { taskStatus } from '@/lib/pm/stage';
import type { TaskRow } from '@/lib/pm/types';

export interface BoardTask extends TaskRow {
  jobLabel: string;
  company: string | null;
}

/** Open tasks across jobs: overdue, this week, later, undated. Each row opens its job's schedule. */
export function ScheduleBoard({ tasks, today, weekEnd, multi }: { tasks: BoardTask[]; today: string; weekEnd: string; multi: boolean }) {
  const router = useRouter();
  const groups: QueueGroup<BoardTask>[] = [
    { id: 'overdue', title: 'Overdue', caption: 'Past the due date', rows: tasks.filter((t) => t.due_on && t.due_on < today) },
    { id: 'week', title: 'This week', caption: `Due by ${shortDate(weekEnd)}`, rows: tasks.filter((t) => t.due_on && t.due_on >= today && t.due_on <= weekEnd) },
    { id: 'later', title: 'Later', rows: tasks.filter((t) => t.due_on && t.due_on > weekEnd) },
    { id: 'undated', title: 'No due date', rows: tasks.filter((t) => !t.due_on) },
  ].filter((g) => g.rows.length > 0);
  const columns: QueueColumn<BoardTask>[] = [
    {
      id: 'task',
      header: 'Task',
      cell: (t) => (
        <Link className="nlink" href={`/jobs/${t.job_id}?tab=schedule`} style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">{t.title}</span>
          <span className="l2">{[t.jobLabel, t.company].filter(Boolean).join(' · ')}</span>
        </Link>
      ),
    },
    { id: 'start', header: 'Start', width: 96, cell: (t) => (t.start_on ? shortDate(t.start_on) : '—') },
    { id: 'due', header: 'Due', width: 96, cell: (t) => (t.due_on ? <span className={t.due_on < today ? 'neg b' : undefined}>{shortDate(t.due_on)}</span> : '—') },
    { id: 'st', header: 'Status', width: 140, cell: (t) => { const s = taskStatus(t.status, !!t.due_on && t.due_on < today); return <Status kind={s.kind} pip={s.pip}>{s.word}</Status>; } },
  ];
  if (tasks.length === 0) {
    return <div className="surface"><WidgetState state={{ kind: 'done', title: 'No open tasks', body: `Tasks you add on a job's Schedule tab show up here by due date${multi ? ', across companies' : ''}.` }} /></div>;
  }
  return (
    <div className="stack">
      <div className="mp-table">
        <QueueTable aria-label="Open tasks by due date" columns={columns} groups={groups} getRowId={(t) => t.id} rowState={(t) => ({ attn: !!t.due_on && t.due_on < today })} onOpen={(t) => router.push(`/jobs/${t.job_id}?tab=schedule`)} />
      </div>
      <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open the job' }]} note="Complete tasks on the job's schedule" />
    </div>
  );
}
