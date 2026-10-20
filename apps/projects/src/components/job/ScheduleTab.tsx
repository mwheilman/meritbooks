'use client';

import { useMemo, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Input, Keybar, QueueTable, Select, Status, WidgetState, shortDate,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { TaskRow, TaskStatus } from '@/lib/pm/types';
import { taskStatus } from '@/lib/pm/stage';
import { useShell } from '@/components/shell/ShellContext';
import { useAction } from './useAction';

const MS_DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_DAY;

/** Where a task's bar sits on the job's span (percent of the visible range). Pure. */
export function barGeometry(t: Pick<TaskRow, 'start_on' | 'due_on'>, from: number, to: number): { left: number; width: number } | null {
  const s = t.start_on ? day(t.start_on) : t.due_on ? day(t.due_on) : null;
  const e = t.due_on ? day(t.due_on) : s;
  if (s == null || e == null) return null;
  const span = Math.max(1, to - from + 1);
  const left = ((s - from) / span) * 100;
  const width = Math.max(((e - s + 1) / span) * 100, 1.2);
  return { left: Math.max(0, left), width: Math.min(width, 100 - Math.max(0, left)) };
}

export function ScheduleTab({ jobId, tasks, today }: { jobId: string; tasks: TaskRow[]; today: string }) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const url = `/api/jobs/${jobId}/tasks`;
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [due, setDue] = useState('');
  const [milestone, setMilestone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [del, setDel] = useState<TaskRow | null>(null);

  const range = useMemo(() => {
    const ds = tasks.flatMap((t) => [t.start_on, t.due_on]).filter((x): x is string => !!x).map(day);
    if (!ds.length) return null;
    const from = Math.min(...ds, day(today));
    const to = Math.max(...ds, day(today));
    return { from, to };
  }, [tasks, today]);

  const setStatus = (t: TaskRow, status: TaskStatus) =>
    run(`t:${t.id}`, 'patch', `${url}/${t.id}`, { status }, status === 'DONE' ? `Completed ${t.title}` : `Reopened ${t.title}`);

  const columns: QueueColumn<TaskRow>[] = [
    {
      id: 'done',
      header: <span className="sr">Done</span>,
      width: 48,
      cell: (t) => (
        <Check
          aria-label={t.status === 'DONE' ? `Reopen ${t.title}` : `Complete ${t.title}`}
          checked={t.status === 'DONE'}
          disabled={readOnly || busy === `t:${t.id}` || t.status === 'CANCELLED'}
          onChange={() => void setStatus(t, t.status === 'DONE' ? 'TODO' : 'DONE')}
        />
      ),
    },
    {
      id: 'title',
      header: 'Task',
      cell: (t) => (
        <>
          <span className="l1">{t.is_milestone ? '◆ ' : ''}{t.title}</span>
          <span className="l2">{t.duration_days != null ? `${t.duration_days} days` : t.is_milestone ? 'Milestone' : ' '}</span>
        </>
      ),
    },
    { id: 'start', header: 'Start', width: 88, cell: (t) => (t.start_on ? shortDate(t.start_on) : '—') },
    { id: 'due', header: 'Due', width: 88, cell: (t) => (t.due_on ? <span className={t.due_on < today && t.status !== 'DONE' ? 'neg b' : undefined}>{shortDate(t.due_on)}</span> : '—') },
    {
      id: 'status',
      header: 'Status',
      width: 140,
      cell: (t) => {
        const s = taskStatus(t.status, !!t.due_on && t.due_on < today);
        return readOnly ? (
          <Status kind={s.kind} pip={s.pip}>{s.word}</Status>
        ) : (
          <Select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => void setStatus(t, e.target.value as TaskStatus)}>
            <option value="TODO">To do</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="BLOCKED">Blocked</option>
            <option value="DONE">Done</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        );
      },
    },
    {
      id: 'tl',
      header: range ? `${shortDate(new Date(range.from * MS_DAY).toISOString().slice(0, 10))} – ${shortDate(new Date(range.to * MS_DAY).toISOString().slice(0, 10))}` : 'Timeline',
      width: 280,
      cell: (t) => {
        const g = range ? barGeometry(t, range.from, range.to) : null;
        const late = !!t.due_on && t.due_on < today && t.status !== 'DONE' && t.status !== 'CANCELLED';
        const cls = t.status === 'DONE' ? 'done' : t.status === 'BLOCKED' ? 'blocked' : late ? 'late' : '';
        const todayLeft = range ? ((day(today) - range.from) / Math.max(1, range.to - range.from + 1)) * 100 : null;
        return (
          <div className="tl" role="img" aria-label={g ? `${t.title}: ${t.start_on ?? t.due_on} to ${t.due_on ?? t.start_on}` : `${t.title}: no dates`}>
            {g && <i className={cls} style={{ left: `${g.left}%`, width: `${g.width}%` }} />}
            {todayLeft != null && <b style={{ left: `${todayLeft}%` }} title="Today" />}
          </div>
        );
      },
    },
    ...(readOnly ? [] : [{ id: 'del', header: <span className="sr">Remove</span>, width: 48, cell: (t: TaskRow) => <Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${t.title}`} onClick={() => setDel(t)} /> }]),
  ];

  const add = async () => {
    if (!title.trim()) return setErr('Name the task.');
    if (start && due && due < start) return setErr('The due date is before the start date.');
    setErr(null);
    const r = await run('add', 'post', url, { title: title.trim(), startOn: start || null, dueOn: due || null, isMilestone: milestone }, `Added ${title.trim()}`);
    if (!r.error) {
      setTitle('');
      setStart('');
      setDue('');
      setMilestone(false);
    }
  };

  const open = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  return (
    <div className="stack">
      <div className="mp-table">
        {tasks.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'No tasks yet', body: 'Add tasks with start and due dates; the bar shows each one against today.' }} />
        ) : (
          <QueueTable
            aria-label="Tasks"
            columns={columns}
            rows={tasks}
            getRowId={(t) => t.id}
            rowState={(t) => ({ done: t.status === 'DONE' || t.status === 'CANCELLED', attn: !!t.due_on && t.due_on < today && t.status !== 'DONE' && t.status !== 'CANCELLED' })}
            actions={readOnly ? [] : [{ key: 'd', label: 'complete', run: (rs) => rs.forEach((t) => void setStatus(t, t.status === 'DONE' ? 'TODO' : 'DONE')) }]}
            compact
          />
        )}
        {!readOnly && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="New task" error={err ?? undefined}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Rough-in inspection" maxLength={200} style={{ width: 280 }} /></Field>
            <Field label="Start"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            <Check label="Milestone" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} />
            <Button type="submit" icon="plus" disabled={busy === 'add'}>Add task</Button>
          </form>
        )}
      </div>
      {tasks.length > 0 && (
        <Keybar
          hints={[{ chord: 'j k', label: 'move' }, ...(readOnly ? [] : [{ chord: 'd', label: 'complete' }])]}
          note={`${open.length} open · ${tasks.length - open.length} done or cancelled · the line marks today`}
        />
      )}
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        tone="danger"
        title="Remove this task"
        confirmLabel="Remove task"
        onConfirm={async () => {
          if (!del) return;
          const r = await run('del', 'delete', `${url}/${del.id}`, undefined, `Removed ${del.title}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        {del?.title}
      </ConfirmDialog>
    </div>
  );
}
