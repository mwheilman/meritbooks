'use client';

/**
 * All jobs stacked: one summary bar per job (start → finish, critical and late counts), each
 * expandable to its tasks (loaded on demand from the job's schedule). Rows are windowed like
 * the Gantt. A job's name opens its Schedule tab.
 */
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, Seg, WidgetState, api, shortDate } from '@meritbooks/merit-ui';
import { dayNum, offDaysIn, isoOf } from '@/lib/pm/schedule/calendar';
import { barX, dayWindow, makeScale, rowWindow, ticks, widthPx, xOf } from '@/lib/pm/schedule/timeline';
import { buildOutline } from '@/lib/pm/schedule/tree';
import { DEFAULT_CALENDAR, type JobScheduleBundle, type SchedTask, type ScheduleJobRow, type Zoom } from '@/lib/pm/schedule/types';
import type { GlobalJob } from './GlobalSchedule';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type StackRow =
  | { kind: 'job'; job: GlobalJob; sum: ScheduleJobRow | null; start: string | null; finish: string | null }
  | { kind: 'task'; jobId: string; task: SchedTask; depth: number; summary: boolean }
  | { kind: 'state'; jobId: string; text: string; retry: boolean };

const ROW = 32;
const HEAD = 44;
const GRID = 430;
const W_NAME = 240;
const W_FIN = 102;
const W_CRIT = 88;

export function JobStack({ jobs, summaries, today, filtered, engine }: { jobs: ReadonlyArray<GlobalJob>; summaries: ReadonlyArray<ScheduleJobRow>; today: string; filtered: boolean; engine: boolean }) {
  const [zoom, setZoom] = useState<Zoom>('month');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [tasks, setTasks] = useState<ReadonlyMap<string, SchedTask[] | 'loading' | 'error'>>(() => new Map());
  const sumBy = useMemo(() => new Map(summaries.map((s) => [s.job_id, s])), [summaries]);

  const ordered = useMemo(
    () =>
      jobs
        .map((j) => {
          const s = sumBy.get(j.id) ?? null;
          return { job: j, sum: s, start: s?.start_on ?? j.plannedStart, finish: s?.finish_on ?? j.plannedFinish };
        })
        .sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999') || a.job.label.localeCompare(b.job.label)),
    [jobs, sumBy],
  );

  const rows: StackRow[] = useMemo(() => {
    const out: StackRow[] = [];
    for (const o of ordered) {
      out.push({ kind: 'job', ...o });
      if (!open.has(o.job.id)) continue;
      const t = tasks.get(o.job.id);
      if (t === 'loading' || t === undefined) out.push({ kind: 'state', jobId: o.job.id, text: 'Loading tasks…', retry: false });
      else if (t === 'error') out.push({ kind: 'state', jobId: o.job.id, text: 'The tasks didn’t load. Try again.', retry: true });
      else if (!t.length) out.push({ kind: 'state', jobId: o.job.id, text: 'No tasks yet. Open the job to build its schedule.', retry: false });
      else for (const r of buildOutline(t)) out.push({ kind: 'task', jobId: o.job.id, task: r.task, depth: r.depth, summary: r.hasChildren });
    }
    return out;
  }, [ordered, open, tasks]);

  const load = useCallback(async (id: string) => {
    setTasks((m) => new Map(m).set(id, 'loading'));
    const res = await api.get<JobScheduleBundle>(`/api/jobs/${id}/schedule`);
    setTasks((m) => new Map(m).set(id, res.data ? res.data.tasks : 'error'));
  }, []);
  const toggle = (id: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        if (!tasks.has(id) || tasks.get(id) === 'error') void load(id);
      }
      return n;
    });
  };

  const scale = useMemo(() => makeScale(ordered.flatMap((o) => [o.start, o.finish]), today, zoom, 7), [ordered, today, zoom]);
  const width = widthPx(scale);
  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, left: 0, w: 1200, h: 600 });
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setVp({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
  }, []);
  useIsoLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (el) el.scrollLeft = Math.max(0, xOf(scale, today) - 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  const win = rowWindow(Math.max(0, vp.top - HEAD), vp.h - HEAD, ROW, rows.length);
  const dw = dayWindow(scale, vp.left, vp.w - GRID);
  const tk = ticks(scale, zoom, dw);
  const off = zoom === 'month' ? [] : offDaysIn(DEFAULT_CALENDAR, isoOf(Math.max(dw.from, scale.origin)), isoOf(Math.min(dw.to, scale.origin + scale.days)));
  const x0 = Math.max(0, (dw.from - scale.origin) * scale.ppd);
  const x1 = Math.min(width, (dw.to - scale.origin + 1) * scale.ppd);
  const y0 = win.offset;
  const y1 = Math.min(rows.length * ROW, win.end * ROW);
  const visible = rows.slice(win.start, win.end);
  const todayX = xOf(scale, today) + scale.ppd / 2;

  if (!jobs.length) {
    return (
      <div className="surface">
        <WidgetState state={filtered ? { kind: 'empty', title: 'No jobs match these filters', body: 'Clear a filter to see more jobs.' } : { kind: 'empty', title: 'No open jobs', body: 'Jobs you start show here with their schedule, earliest first.' }} />
      </div>
    );
  }

  return (
    <div className="stack gs-stack">
      <div className="gx-bar">
        <Seg<Zoom> aria-label="Zoom" items={[{ value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} value={zoom} onChange={setZoom} />
        <span className="t-cap">{jobs.length} jobs, earliest start first · expand a job to see its tasks{engine ? '' : ' · bars from task dates'}</span>
      </div>
      <div ref={ref} className="gx-scroll" onScroll={measure} style={{ height: `min(72vh, ${Math.max(240, HEAD + rows.length * ROW + 2)}px)` }} role="treegrid" aria-label="Jobs and their schedules" aria-rowcount={rows.length}>
        <div className="gx-inner" style={{ width: GRID + width, height: HEAD + rows.length * ROW }}>
          <div className="gx-head" style={{ height: HEAD, width: GRID + width }}>
            <div className="gx-hgrid" style={{ width: GRID }}>
              <div style={{ width: W_NAME }}>Job / task</div>
              <div className="r" style={{ width: W_FIN }}>Finish</div>
              <div className="r" style={{ width: W_CRIT }}>Critical</div>
            </div>
            <svg className="gx-scale" width={width} height={HEAD} aria-hidden="true">
              {tk.top.map((t) => (
                <g key={`t${t.x}`}>
                  {t.major && <line x1={t.x} x2={t.x} y1={0} y2={HEAD} />}
                  <text className="top" x={t.x + 4} y={16}>{t.label}</text>
                </g>
              ))}
              {tk.bottom.map((t) => (
                <text key={`b${t.x}`} x={t.x + 3} y={38}>{t.label}</text>
              ))}
            </svg>
          </div>
          <div className="gx-body" style={{ height: rows.length * ROW }}>
            <div className="gx-grid" style={{ width: GRID, height: rows.length * ROW }}>
              {visible.map((r, k) => {
                const i = win.start + k;
                const style = { top: i * ROW, height: ROW };
                if (r.kind === 'job') {
                  const exp = open.has(r.job.id);
                  return (
                    <div key={`j${r.job.id}`} className="gx-row sum" style={style} role="row" aria-level={1} aria-expanded={exp}>
                      <div className="job" style={{ width: W_NAME }}>
                        <button type="button" className="tw" aria-label={exp ? `Collapse ${r.job.label}` : `Expand ${r.job.label}`} onClick={() => toggle(r.job.id)}>
                          <Icon name={exp ? 'down' : 'right'} />
                        </button>
                        <Link className="nlink tt" href={`/jobs/${r.job.id}?tab=schedule`} title={[r.job.label, r.job.company, r.job.pm, r.job.stage].filter(Boolean).join(' · ')}>
                          {r.job.label}
                        </Link>
                      </div>
                      <div className="r" style={{ width: W_FIN }}>{r.finish ? shortDate(r.finish, today) : '—'}</div>
                      <div className="r" style={{ width: W_CRIT }} title={r.sum ? `${r.sum.critical_count} critical, ${r.sum.late_count} late` : undefined}>
                        {r.sum ? (r.sum.late_count ? `${r.sum.critical_count} · ${r.sum.late_count} late` : r.sum.critical_count) : '—'}
                      </div>
                    </div>
                  );
                }
                if (r.kind === 'state') {
                  return (
                    <div key={`s${r.jobId}`} className="gx-row" style={style} role="row">
                      <div className="ro" style={{ width: GRID, paddingLeft: 30 }}>
                        {r.text}
                        {r.retry && (
                          <button type="button" className="nlink" style={{ marginLeft: 8, background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void load(r.jobId)}>
                            Retry
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={`t${r.task.id}`} className={`gx-row${r.summary ? ' sum' : ''}${r.task.status === 'DONE' ? ' done' : ''}`} style={style} role="row" aria-level={r.depth + 2}>
                    <div style={{ width: W_NAME, paddingLeft: 30 + r.depth * 14 }}>
                      <Link className="tt" href={`/jobs/${r.jobId}?tab=schedule`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {r.task.is_milestone && <i className="ms" aria-label="Milestone" />}
                        {r.task.title}
                      </Link>
                    </div>
                    <div className="r" style={{ width: W_FIN }}>{r.task.due_on ? shortDate(r.task.due_on, today) : '—'}</div>
                    <div className="r" style={{ width: W_CRIT }}>{r.task.is_critical ? 'Critical' : ''}</div>
                  </div>
                );
              })}
            </div>
            <div className="gx-chart" style={{ width, height: rows.length * ROW, touchAction: 'auto' }}>
              <svg style={{ left: x0, top: y0 }} width={Math.max(0, x1 - x0)} height={Math.max(0, y1 - y0)} viewBox={`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)}`} aria-hidden="true">
                {off.map((d) => (
                  <rect key={d.day} className="gx-off" x={xOf(scale, d.day)} y={y0} width={scale.ppd} height={y1 - y0} />
                ))}
                {visible.map((r, k) => {
                  const i = win.start + k;
                  const y = i * ROW;
                  const line = <line key="l" className="gx-rowline" x1={x0} x2={x1} y1={y + ROW - 0.5} y2={y + ROW - 0.5} />;
                  if (r.kind === 'job') {
                    if (!r.start || !r.finish) return <g key={`j${r.job.id}`}>{line}</g>;
                    const g = barX(scale, r.start, r.finish);
                    const crit = (r.sum?.critical_count ?? 0) > 0;
                    const pct = Math.max(0, Math.min(1, r.sum?.pct_complete ?? 0));
                    return (
                      <g key={`j${r.job.id}`} style={{ cursor: 'pointer' }} onClick={() => toggle(r.job.id)}>
                        {line}
                        <rect className={`gx-task${crit ? '' : ' dim'}`} x={g.x} y={y + 9} width={g.w} height={14} />
                        {pct > 0 && <rect className="gx-prog" x={g.x} y={y + 19} width={g.w * pct} height={4} />}
                        {r.sum?.baseline_finish && <path className="gx-ms" d={`M${xOf(scale, r.sum.baseline_finish) + scale.ppd / 2},${y + 6}l4,4l-4,4l-4,-4z`} />}
                        <text className="gx-label" x={g.x + g.w + 6} y={y + 20}>{`${r.job.label}${r.sum?.task_count ? ` · ${r.sum.task_count} tasks` : ''}`}</text>
                      </g>
                    );
                  }
                  if (r.kind === 'state' || !r.task.start_on || !r.task.due_on) return <g key={`s${i}`}>{line}</g>;
                  const g = barX(scale, r.task.start_on, r.task.due_on);
                  return (
                    <g key={`t${r.task.id}`}>
                      {line}
                      {r.task.is_milestone ? (
                        <path className={`gx-ms${r.task.is_critical ? ' crit' : ''}`} d={`M${g.x + scale.ppd / 2},${y + 9}l7,7l-7,7l-7,-7z`} />
                      ) : r.summary ? (
                        <rect className="gx-sum" x={g.x} y={y + 13} width={g.w} height={6} />
                      ) : (
                        <rect className={`gx-task${r.task.status === 'DONE' ? ' done' : r.task.is_critical ? ' crit' : ''}`} x={g.x} y={y + 10} width={g.w} height={12} />
                      )}
                    </g>
                  );
                })}
                {dayNum(today) >= dw.from && dayNum(today) <= dw.to && <line className="gx-today" x1={todayX} x2={todayX} y1={y0} y2={y1} />}
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div className="gx-legend">
        <span><i />Job with critical work</span>
        <span><i className="done" />Job (no critical tasks)</span>
        <span><i className="ms" />Baseline finish / milestone</span>
        <span><i className="today" />Today</span>
      </div>
    </div>
  );
}
