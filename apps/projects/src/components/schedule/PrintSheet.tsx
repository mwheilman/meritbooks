'use client';

/**
 * The 11×17 landscape print of a schedule (print CSS in gantt.css): pages of 42 rows, each with
 * the job, the date scale fitted to N weeks (or the whole job), and the legend. Hidden on screen.
 */
import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { shortDate } from '@meritbooks/merit-ui';
import { dayNum, isoOf, offDaysIn } from '@/lib/pm/schedule/calendar';
import { barX, fitPpd, ticks, xOf, type Scale } from '@/lib/pm/schedule/timeline';
import type { OutlineRow } from '@/lib/pm/schedule/tree';
import type { BaselineTask, WorkCalendar } from '@/lib/pm/schedule/types';
import { Legend } from './Legend';

const PAGE_ROWS = 42;
const ROW = 20;
const HEAD = 40;
const GRID = 420;
const CHART = 1130; // 16.2in at 96dpi, less the grid

export interface PrintSheetProps {
  jobLabel: string;
  rows: ReadonlyArray<OutlineRow>;
  cal: WorkCalendar;
  today: string;
  /** 0 = the whole job. */
  weeks: number;
  critical: boolean;
  baseline: ReadonlyMap<string, BaselineTask> | null;
}

function PrintSheetImpl({ jobLabel, rows, cal, today, weeks, critical, baseline }: PrintSheetProps) {
  const dates = rows.flatMap((r) => [r.task.start_on, r.task.due_on]).filter((d): d is string => !!d);
  const monday = (iso: string) => {
    const n = dayNum(iso);
    return n - ((new Date(n * 86_400_000).getUTCDay() + 6) % 7);
  };
  const lo = weeks ? monday(today) : monday(dates.reduce((a, b) => (b < a ? b : a), today));
  const hi = weeks ? lo + weeks * 7 - 1 : dayNum(dates.reduce((a, b) => (b > a ? b : a), today)) + 3;
  const span = Math.max(7, hi - lo + 1);
  const scale: Scale = { origin: lo, ppd: fitPpd(CHART, span / 7), days: span };
  const zoom = scale.ppd >= 18 ? 'day' : scale.ppd >= 5 ? 'week' : 'month';
  const t = ticks(scale, zoom, { from: lo, to: lo + span });
  const off = offDaysIn(cal, isoOf(lo), isoOf(lo + span - 1)).filter((d) => zoom !== 'month' || d.holiday);
  const pages: OutlineRow[][] = [];
  for (let i = 0; i < rows.length; i += PAGE_ROWS) pages.push(rows.slice(i, i + PAGE_ROWS));
  if (!pages.length) pages.push([]);
  const todayX = xOf(scale, today) + scale.ppd / 2;
  const range = `${shortDate(isoOf(lo))} – ${shortDate(isoOf(lo + span - 1), today)}`;

  return (
    <div className="gx-print" aria-hidden="true">
      {pages.map((page, pi) => {
        const h = HEAD + page.length * ROW;
        return (
          <section key={pi} className="gx-print-row" style={{ breakAfter: pi < pages.length - 1 ? 'page' : 'auto' }}>
            <div className="gx-print-h">
              <div>
                <div className="t-head">{jobLabel} · Schedule</div>
                <div className="t-cap">{range} · printed {shortDate(today, today)} · page {pi + 1} of {pages.length}</div>
              </div>
              <Legend critical={critical} baseline={!!baseline} />
            </div>
            <svg width={GRID + CHART} height={h} viewBox={`0 0 ${GRID + CHART} ${h}`} className="gx-scale">
              <g transform={`translate(${GRID},0)`}>
                {off.map((d) => (
                  <rect key={d.day} className={d.holiday ? 'gx-hol' : 'gx-off'} x={xOf(scale, d.day)} y={HEAD} width={scale.ppd} height={h - HEAD} />
                ))}
                {t.top.map((k) => (
                  <g key={`t${k.x}`}>
                    <line x1={k.x} x2={k.x} y1={0} y2={h} className="gx-rule" />
                    <text className="top" x={k.x + 4} y={14}>{k.label}</text>
                  </g>
                ))}
                {t.bottom.map((k) => (
                  <text key={`b${k.x}`} x={k.x + 2} y={32}>{k.label}</text>
                ))}
                {dayNum(today) >= lo && dayNum(today) < lo + span && <line className="gx-today" x1={todayX} x2={todayX} y1={HEAD} y2={h} />}
              </g>
              <text className="top" x={4} y={32}>#  Task</text>
              <text className="top" x={GRID - 160} y={32}>Days</text>
              <text className="top" x={GRID - 110} y={32}>Start</text>
              <text className="top" x={GRID - 56} y={32}>Finish</text>
              <line x1={0} x2={GRID + CHART} y1={HEAD - 0.5} y2={HEAD - 0.5} className="gx-rowline" />
              {page.map((r, i) => {
                const y = HEAD + i * ROW;
                const task = r.task;
                const crit = critical && task.is_critical;
                const b = baseline?.get(task.id);
                let bar: JSX.Element | null = null;
                if (task.start_on && task.due_on && dayNum(task.due_on) >= lo && dayNum(task.start_on) <= lo + span) {
                  const g = barX(scale, task.start_on, task.due_on);
                  const x = Math.max(0, g.x);
                  const w = Math.min(CHART, g.x + g.w) - x;
                  bar = r.hasChildren ? (
                    <rect className={`gx-sum${crit ? ' crit' : ''}`} x={x} y={y + 7} width={w} height={5} />
                  ) : task.is_milestone ? (
                    <path className={`gx-ms${crit ? ' crit' : ''}`} d={`M${g.x + scale.ppd / 2},${y + 3}l7,7l-7,7l-7,-7z`} />
                  ) : (
                    <rect className={`gx-task${task.status === 'DONE' ? ' done' : crit ? ' crit' : ''}`} x={x} y={y + 5} width={Math.max(1, w)} height={9} />
                  );
                }
                const bg = b?.start_on && b.due_on ? barX(scale, b.start_on, b.due_on) : null;
                return (
                  <g key={task.id}>
                    <text x={4} y={y + 14} className={r.hasChildren ? 'top' : undefined}>
                      {`${r.rowNo}  ${'  '.repeat(r.depth)}${task.title.length > 36 - r.depth * 2 ? `${task.title.slice(0, 34 - r.depth * 2)}…` : task.title}`}
                    </text>
                    <text x={GRID - 150} y={y + 14}>{task.is_milestone ? '0' : task.duration_days ?? ''}</text>
                    <text x={GRID - 110} y={y + 14}>{task.start_on ? shortDate(task.start_on) : ''}</text>
                    <text x={GRID - 56} y={y + 14}>{task.due_on ? shortDate(task.due_on) : ''}</text>
                    <g transform={`translate(${GRID},0)`}>
                      {bg && <rect className="gx-base-f" x={Math.max(0, bg.x)} y={y + 15} width={Math.max(0, Math.min(CHART, bg.x + bg.w) - Math.max(0, bg.x))} height={3} />}
                      {bar}
                    </g>
                    <line x1={0} x2={GRID + CHART} y1={y + ROW - 0.5} y2={y + ROW - 0.5} className="gx-rowline" />
                  </g>
                );
              })}
            </svg>
          </section>
        );
      })}
    </div>
  );
}

const Sheet = memo(PrintSheetImpl);

/** Rendered straight under <body> (a portal) so the print never inherits the app shell's scroll box. */
export function PrintSheet(props: PrintSheetProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    document.body.classList.add('gx-printing');
    setHost(document.body);
    return () => document.body.classList.remove('gx-printing');
  }, []);
  return host ? createPortal(<Sheet {...props} />, host) : null;
}
