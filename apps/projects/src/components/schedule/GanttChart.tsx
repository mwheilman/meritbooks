'use client';

/**
 * The timeline half of the Gantt: an SVG window over only the rows and days in view
 * (rowWindow × dayWindow), so 2,000 tasks draw like 40. Bars move (drag the middle), resize
 * (drag the right edge) and link (drag from an end dot to another bar); while dragging, the
 * parent's local CPM returns ghost bars for every successor that would move. Touch: long-press
 * a bar to drag it; one or two fingers anywhere else pan.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { shortDate } from '@meritbooks/merit-ui';
import { dayNum, isoOf, offDaysIn } from '@/lib/pm/schedule/calendar';
import { moveStart, resizeDuration } from '@/lib/pm/schedule/drag';
import type { MoveEdit } from '@/lib/pm/schedule/cpm';
import { barX, xOf, type RowWindow, type Scale } from '@/lib/pm/schedule/timeline';
import type { OutlineRow } from '@/lib/pm/schedule/tree';
import type { BaselineTask, SchedDep, WorkCalendar, Zoom } from '@/lib/pm/schedule/types';

export interface Ghost {
  start_on: string;
  due_on: string;
}

export interface PreviewResult {
  ghosts: ReadonlyMap<string, Ghost>;
  /** "Finish Nov 18 · job finish +3 days" */
  label: string;
}

type DragKind = 'move' | 'resize' | 'link';

interface Drag {
  kind: DragKind;
  taskId: string;
  pointerId: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  edit: MoveEdit | null;
  targetId: string | null;
  moved: boolean;
}

export interface GanttChartProps {
  rows: ReadonlyArray<OutlineRow>;
  win: RowWindow;
  dayWin: { from: number; to: number };
  scale: Scale;
  zoom: Zoom;
  rowH: number;
  cal: WorkCalendar;
  today: string;
  deps: ReadonlyArray<SchedDep>;
  critical: boolean;
  baseline: ReadonlyMap<string, BaselineTask> | null;
  selectedId: string | null;
  canEdit: boolean;
  field: boolean;
  scrollRef: RefObject<HTMLDivElement>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPreview: (edit: MoveEdit) => PreviewResult;
  onCommit: (edit: MoveEdit, kind: 'move' | 'resize') => void;
  onLink: (predId: string, succId: string) => void;
}

const LONG_PRESS_MS = 420;
const TOUCH_SLOP = 10;

function GanttChartImpl(p: GanttChartProps) {
  const { rows, win, dayWin, scale, rowH, cal, today, deps, critical, baseline, selectedId, canEdit, field } = p;
  const width = Math.ceil(scale.days * scale.ppd);
  const height = rows.length * rowH;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [, setFrame] = useState(0);
  const raf = useRef<number | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const lastEdit = useRef<string>('');

  const index = useMemo(() => new Map(rows.map((r, i) => [r.task.id, i])), [rows]);
  const barH = Math.max(10, Math.round(rowH * (field ? 0.46 : 0.5)));
  const top = (i: number) => i * rowH + (rowH - barH) / 2;
  const x0 = Math.max(0, (dayWin.from - scale.origin) * scale.ppd);
  const x1 = Math.min(width, (dayWin.to - scale.origin + 1) * scale.ppd);
  const y0 = win.offset;
  const y1 = Math.min(height, win.end * rowH);
  const visible = rows.slice(win.start, win.end);

  // ---- geometry ------------------------------------------------------------------------
  const geo = useCallback(
    (id: string): { x: number; w: number; y: number; ms: boolean; sum: boolean } | null => {
      const i = index.get(id);
      if (i === undefined) return null;
      const t = rows[i]!.task;
      if (!t.start_on || !t.due_on) return null;
      const g = barX(scale, t.start_on, t.due_on);
      return { ...g, y: top(i), ms: t.is_milestone, sum: rows[i]!.hasChildren };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, rows, scale, rowH, barH],
  );

  // ---- drag ----------------------------------------------------------------------------
  /** Keep the pointer's events while it drags or pans (throws for a pointer that already ended). */
  const capture = (id: number) => {
    try {
      ref.current?.setPointerCapture(id);
    } catch {
      // the pointer is gone; the drag ends on the next pointerup / cancel
    }
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };

  const schedule = () => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'link') {
        const i = Math.floor(d.y / rowH);
        const r = rows[i];
        d.targetId = r && r.task.id !== d.taskId && !r.hasChildren ? r.task.id : null;
      } else {
        const t = rows[index.get(d.taskId) ?? -1]?.task;
        if (t?.start_on && t.due_on) {
          const dx = d.x - d.x0;
          const edit: MoveEdit | null =
            d.kind === 'move'
              ? (() => {
                  const s = moveStart(cal, t.start_on, dx, scale.ppd);
                  return s ? { taskId: t.id, start: s, duration: null } : null;
                })()
              : (() => {
                  const n = resizeDuration(cal, t.start_on, t.due_on, dx, scale.ppd);
                  return n ? { taskId: t.id, start: null, duration: n } : null;
                })();
          d.edit = edit;
          const key = edit ? `${edit.start}|${edit.duration}` : '';
          if (key !== lastEdit.current) {
            lastEdit.current = key;
            setPreview(edit ? p.onPreview(edit) : null);
          }
        }
      }
      setFrame((f) => f + 1);
    });
  };

  const begin = (e: { pointerId: number; clientX: number; clientY: number }, kind: DragKind, taskId: string) => {
    const at = local(e);
    drag.current = { kind, taskId, pointerId: e.pointerId, x0: at.x, y0: at.y, x: at.x, y: at.y, edit: null, targetId: null, moved: false };
    lastEdit.current = '';
    setHover(null);
    capture(e.pointerId);
    setFrame((f) => f + 1);
  };

  const justDragged = useRef(false);
  const end = (cancel: boolean) => {
    const d = drag.current;
    drag.current = null;
    justDragged.current = !!d?.moved;
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPreview(null);
    setFrame((f) => f + 1);
    if (!d || cancel) return;
    if (d.kind === 'link') {
      if (d.targetId) p.onLink(d.taskId, d.targetId);
    } else if (d.edit) {
      p.onCommit(d.edit, d.kind);
    }
  };

  // touch: pan with one or two fingers; a long press on a bar starts a drag
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; id: number; kind: DragKind; taskId: string; x: number; y: number; e: { pointerId: number; clientX: number; clientY: number } } | null>(null);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const onBarDown = (e: ReactPointerEvent, kind: DragKind, taskId: string) => {
    p.onSelect(taskId);
    if (!canEdit || e.button > 0) return;
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(e.pointerId);
      cancelPress();
      const ev = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
      press.current = {
        id: e.pointerId, kind, taskId, x: e.clientX, y: e.clientY, e: ev,
        timer: setTimeout(() => {
          const pr = press.current;
          press.current = null;
          if (!pr || touches.current.size !== 1) return;
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(10);
          begin(pr.e, pr.kind, pr.taskId);
        }, LONG_PRESS_MS),
      };
      return;
    }
    e.preventDefault();
    begin(e, kind, taskId);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e.pointerId);
    if (touches.current.size > 1) cancelPress();
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      const at = local(e);
      d.x = at.x;
      d.y = at.y;
      d.moved = d.moved || Math.abs(at.x - d.x0) > 2 || Math.abs(at.y - d.y0) > 2;
      schedule();
      return;
    }
    if (e.pointerType !== 'touch') return;
    const prev = touches.current.get(e.pointerId);
    if (!prev) return;
    const pr = press.current;
    if (pr && pr.id === e.pointerId && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > TOUCH_SLOP) cancelPress();
    if (press.current) return; // still deciding: long press or pan
    const n = touches.current.size;
    const dx = (e.clientX - prev.x) / n;
    const dy = (e.clientY - prev.y) / n;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    p.scrollRef.current?.scrollBy({ left: -dx, top: -dy });
  };

  const onUp = (e: ReactPointerEvent) => {
    touches.current.delete(e.pointerId);
    if (press.current?.id === e.pointerId) cancelPress();
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) end(e.type === 'pointercancel');
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        e.preventDefault();
        end(true);
      }
    };
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('keydown', k);
      cancelPress();
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- shading, rules, today ------------------------------------------------------------
  const shading = useMemo(() => {
    const from = isoOf(Math.max(scale.origin, dayWin.from));
    const to = isoOf(Math.min(scale.origin + scale.days, dayWin.to));
    return offDaysIn(cal, from, to).filter((d) => p.zoom !== 'month' || d.holiday);
  }, [cal, scale, dayWin, p.zoom]);
  const todayX = xOf(scale, today) + scale.ppd / 2;

  // ---- links ---------------------------------------------------------------------------
  const links = useMemo(() => {
    const out: Array<{ key: string; d: string; ax: number; ay: number; dir: 1 | -1; crit: boolean }> = [];
    const seen = new Set<string>();
    const ids = new Set(visible.map((r) => r.task.id));
    const crit = new Map(rows.map((r) => [r.task.id, r.task.is_critical]));
    for (const dep of deps) {
      if (!ids.has(dep.succ_id) && !ids.has(dep.pred_id)) continue;
      const key = `${dep.pred_id}>${dep.succ_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = geo(dep.pred_id);
      const b = geo(dep.succ_id);
      if (!a || !b) continue;
      const fromEnd = dep.dep_type === 'FS' || dep.dep_type === 'FF';
      const toStart = dep.dep_type === 'FS' || dep.dep_type === 'SS';
      const ax = fromEnd ? a.x + (a.ms ? scale.ppd / 2 + 5 : a.w) : a.x - (a.ms ? -scale.ppd / 2 + 5 : 0);
      const ay = a.y + barH / 2;
      const bx = toStart ? b.x - (b.ms ? -scale.ppd / 2 + 5 : 0) : b.x + (b.ms ? scale.ppd / 2 + 5 : b.w);
      const by = b.y + barH / 2;
      const midY = by > ay ? b.y - (rowH - barH) / 2 : b.y + barH + (rowH - barH) / 2;
      let d: string;
      if (dep.dep_type === 'SS') d = `M${ax},${ay}H${Math.min(ax, bx) - 6}V${by}H${bx}`;
      else if (dep.dep_type === 'FF') d = `M${ax},${ay}H${Math.max(ax, bx) + 6}V${by}H${bx}`;
      else if (dep.dep_type === 'FS') d = ax + 6 <= bx ? `M${ax},${ay}h6V${by}H${bx}` : `M${ax},${ay}h6V${midY}H${bx - 6}V${by}H${bx}`;
      else d = ax - 6 >= bx ? `M${ax},${ay}h-6V${by}H${bx}` : `M${ax},${ay}h-6V${midY}H${bx + 6}V${by}H${bx}`;
      out.push({ key, d, ax: bx, ay: by, dir: toStart ? 1 : -1, crit: critical && !!crit.get(dep.pred_id) && !!crit.get(dep.succ_id) });
    }
    return out;
  }, [deps, visible, rows, geo, scale.ppd, barH, rowH, critical]);

  // ---- bars ----------------------------------------------------------------------------
  const d = drag.current;
  const ghosts = preview?.ghosts;
  const handle = field ? 24 : 8;
  const bars = visible.map((r, k) => {
    const i = win.start + k;
    const t = r.task;
    const y = top(i);
    const sel = t.id === selectedId;
    const b = baseline?.get(t.id);
    const items: JSX.Element[] = [];
    if (sel) items.push(<rect key="sel" className="gx-selrow" x={x0} y={i * rowH} width={x1 - x0} height={rowH} />);
    if (b?.start_on && b.due_on) {
      const g = barX(scale, b.start_on, b.due_on);
      items.push(<rect key="bl" className="gx-base-f" x={g.x} y={y + barH + 1} width={g.w} height={Math.max(3, Math.round(barH / 3))} />);
      items.push(<rect key="bo" className="gx-base" x={g.x + 0.5} y={y + barH + 1.5} width={Math.max(0, g.w - 1)} height={Math.max(2, Math.round(barH / 3) - 1)} />);
    }
    if (!t.start_on || !t.due_on) return <g key={t.id}>{items}</g>;
    const g = barX(scale, t.start_on, t.due_on);
    const crit = critical && t.is_critical;
    const dim = critical && !t.is_critical;
    const label = (x: number) => (
      <text key="lbl" className={`gx-label${r.hasChildren ? ' b' : ''}`} x={x + 6} y={i * rowH + rowH / 2 + 4}>
        {t.title}
      </text>
    );
    const ghost = ghosts?.get(t.id);
    if (ghost && !(d && d.taskId === t.id)) {
      const gg = barX(scale, ghost.start_on, ghost.due_on);
      items.push(<rect key="gh" className="gx-ghost-f" x={gg.x} y={y} width={gg.w} height={barH} />);
      items.push(<rect key="gho" className="gx-ghost" x={gg.x + 0.75} y={y + 0.75} width={Math.max(0, gg.w - 1.5)} height={barH - 1.5} />);
    }
    if (r.hasChildren) {
      const h = Math.max(5, Math.round(barH / 2.5));
      items.push(
        <path key="sum" className={`gx-sum${crit ? ' crit' : ''}`} d={`M${g.x},${y}h${g.w}v${h + 4}l-5,-4H${g.x + 5}l-5,4z`} onClick={() => p.onSelect(t.id)} onDoubleClick={() => p.onOpen(t.id)} />,
      );
      items.push(label(g.x + g.w));
      return <g key={t.id}>{items}</g>;
    }
    if (t.is_milestone) {
      const cx = g.x + scale.ppd / 2;
      const cy = y + barH / 2;
      const s = barH / 2 + 2;
      const dragX = d && d.taskId === t.id && d.kind === 'move' ? d.x - d.x0 : 0;
      items.push(
        <g key="ms" className={`bar${sel ? ' sel' : ''}`}>
          <path className={`gx-ms${crit ? ' crit' : ''}`} d={`M${cx + dragX},${cy - s}l${s},${s}l${-s},${s}l${-s},${-s}z`} />
          <rect
            className={`gx-hit${canEdit ? '' : ' ro'}`}
            x={cx - s - 4} y={y - 4} width={2 * s + 8} height={barH + 8}
            onPointerDown={(e) => onBarDown(e, 'move', t.id)}
            onDoubleClick={() => p.onOpen(t.id)}
            onPointerEnter={(e) => !drag.current && e.pointerType === 'mouse' && setHover({ id: t.id, ...local(e) })}
            onPointerLeave={() => setHover(null)}
          />
          {canEdit && <circle className="gx-dot" cx={cx + s + 6} cy={cy} r={field ? 9 : 4} onPointerDown={(e) => onBarDown(e, 'link', t.id)} />}
        </g>,
      );
      items.push(label(cx + s + (canEdit ? 10 : 2)));
      return <g key={t.id}>{items}</g>;
    }
    let bx = g.x;
    let bw = g.w;
    if (d && d.taskId === t.id && d.kind !== 'link') {
      if (d.kind === 'move') bx += d.x - d.x0;
      else bw = Math.max(scale.ppd, bw + d.x - d.x0);
    }
    const pct = Math.max(0, Math.min(1, t.pct_complete ?? 0));
    const cls = `gx-task${t.status === 'DONE' ? ' done' : crit ? ' crit' : dim ? ' dim' : ''}${t.constraint_conflict ? ' conf' : ''}`;
    items.push(
      <g key="bar" className={`bar${sel ? ' sel' : ''}`}>
        <rect className={d && d.taskId === t.id ? 'gx-drag' : cls} x={bx} y={y} width={bw} height={barH} />
        {pct > 0 && t.status !== 'DONE' && <rect className="gx-prog" x={bx} y={y + barH - Math.max(3, Math.round(barH / 4))} width={bw * pct} height={Math.max(3, Math.round(barH / 4))} />}
        <rect
          className={`gx-hit${canEdit && !t.actual_start && t.status !== 'DONE' ? '' : ' ro'}`}
          x={bx} y={y - 3} width={Math.max(4, bw - handle)} height={barH + 6}
          onPointerDown={(e) => (t.actual_start || t.status === 'DONE' ? p.onSelect(t.id) : onBarDown(e, 'move', t.id))}
          onDoubleClick={() => p.onOpen(t.id)}
          onPointerEnter={(e) => !drag.current && e.pointerType === 'mouse' && setHover({ id: t.id, ...local(e) })}
          onPointerMove={(e) => hover && !drag.current && e.pointerType === 'mouse' && setHover({ id: t.id, ...local(e) })}
          onPointerLeave={() => setHover(null)}
        />
        {canEdit && t.status !== 'DONE' && <rect className="gx-grip" x={bx + bw - handle} y={y - 3} width={handle + 4} height={barH + 6} onPointerDown={(e) => onBarDown(e, 'resize', t.id)} onDoubleClick={() => p.onOpen(t.id)} />}
        {canEdit && <circle className="gx-dot" cx={bx + bw + (field ? 14 : 7)} cy={y + barH / 2} r={field ? 9 : 4} onPointerDown={(e) => onBarDown(e, 'link', t.id)} />}
      </g>,
    );
    items.push(label(bx + bw + (canEdit ? (field ? 22 : 12) : 2)));
    return <g key={t.id}>{items}</g>;
  });

  // ---- tooltip -------------------------------------------------------------------------
  const tipTask = hover ? rows[index.get(hover.id) ?? -1]?.task : undefined;
  const dragTask = d ? rows[index.get(d.taskId) ?? -1]?.task : undefined;
  let tip: JSX.Element | null = null;
  if (d && d.moved && dragTask) {
    const tx = d.x + 14;
    const ty = d.y + 16;
    const target = d.kind === 'link' && d.targetId ? rows[index.get(d.targetId) ?? -1]?.task : undefined;
    tip = (
      <div className="gx-tip" style={{ left: tx, top: ty }} role="status">
        {d.kind === 'link' ? (target ? <>Link <b>{dragTask.title}</b> → <b>{target.title}</b> (finish to start)</> : 'Drop on the task that follows') : preview ? preview.label : 'Drag a whole day to move'}
      </div>
    );
  } else if (tipTask && hover) {
    const fl = tipTask.total_float;
    tip = (
      <div className="gx-tip" style={{ left: hover.x + 14, top: hover.y + 16 }}>
        <b>{tipTask.title}</b>
        <br />
        {tipTask.start_on ? shortDate(tipTask.start_on) : '—'} – {tipTask.due_on ? shortDate(tipTask.due_on) : '—'}
        {tipTask.is_milestone ? ' · milestone' : tipTask.duration_days != null ? ` · ${tipTask.duration_days} working days` : ''}
        <br />
        {tipTask.is_critical ? 'Critical · ' : ''}
        {fl == null ? 'Float not calculated yet' : `Float ${fl} ${Math.abs(fl) === 1 ? 'day' : 'days'}${fl < 0 ? ' (late)' : ''}`}
      </div>
    );
  }

  let linking: JSX.Element | null = null;
  if (d && d.kind === 'link') {
    const a = geo(d.taskId);
    if (a) linking = <path className="gx-linking" d={`M${a.ms ? a.x + scale.ppd / 2 : a.x + a.w},${a.y + barH / 2}L${d.x},${d.y}`} />;
  }

  return (
    <div
      ref={ref}
      className={`gx-chart${field ? ' field' : ''}`}
      style={{ width, height }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={(e) => {
        if (drag.current?.pointerId === e.pointerId) end(false);
      }}
      onClick={(e) => {
        if (drag.current || justDragged.current) {
          justDragged.current = false;
          return;
        }
        const r = rows[Math.floor(local(e).y / rowH)];
        if (r) p.onSelect(r.task.id);
      }}
      onDoubleClick={(e) => {
        const r = rows[Math.floor(local(e).y / rowH)];
        if (r) p.onOpen(r.task.id);
      }}
      aria-hidden="true"
    >
      <svg style={{ left: x0, top: y0 }} width={Math.max(0, x1 - x0)} height={Math.max(0, y1 - y0)} viewBox={`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)}`}>
        {shading.map((s) => (
          <rect key={s.day} className={s.holiday ? 'gx-hol' : 'gx-off'} x={xOf(scale, s.day)} y={y0} width={scale.ppd} height={y1 - y0}>
            {s.name ? <title>{s.name}</title> : null}
          </rect>
        ))}
        {visible.map((r, k) => {
          const yy = (win.start + k + 1) * rowH - 0.5;
          return <line key={r.task.id} className="gx-rowline" x1={x0} x2={x1} y1={yy} y2={yy} />;
        })}
        {bars}
        {links.map((l) => (
          <g key={l.key}>
            <path className={`gx-link${l.crit ? ' crit' : critical ? ' dim' : ''}`} d={l.d} />
            <path className={`gx-arrow${l.crit ? ' crit' : critical ? ' dim' : ''}`} d={l.dir === 1 ? `M${l.ax},${l.ay}l-5,-3.5v7z` : `M${l.ax},${l.ay}l5,-3.5v7z`} />
          </g>
        ))}
        {dayNum(today) >= dayWin.from && dayNum(today) <= dayWin.to && <line className="gx-today" x1={todayX} x2={todayX} y1={y0} y2={y1} />}
        {linking}
      </svg>
      {tip}
    </div>
  );
}

export const GanttChart = memo(GanttChartImpl);
