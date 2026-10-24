'use client';

/**
 * The job Gantt (WAVE1-SCHEDULE-SPEC §1): a virtualized spreadsheet grid beside a windowed SVG
 * timeline in one scroll container. Edits go to /api/jobs/[jobId]/schedule (1112 RPCs; the
 * server's CPM is authoritative) and the drawing reconciles to what comes back; the local CPM
 * only draws ghost bars while dragging (and the whole schedule when the engine isn't on yet).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, ConfirmDialog, InlineNotice, Keybar, Popover, PopoverFoot, PopoverHead, PopoverItem, PopoverList, Seg, Switch, shortDate, toast, useHotkey,
} from '@meritbooks/merit-ui';
import { workdaysBetween, workdaysInclusive, addWorkdays } from '@/lib/pm/schedule/calendar';
import { applyMove, cycleMessage, diffCpm, findLinkCycle, tryCpm, type MoveEdit } from '@/lib/pm/schedule/cpm';
import { parseDayInput, parseDurationInput, parsePctInput } from '@/lib/pm/schedule/dates';
import { finishDelta, moveSummary } from '@/lib/pm/schedule/drag';
import { exportFileName, scheduleCsv, scheduleMspXml } from '@/lib/pm/schedule/export';
import { formatLinks, parseLinks } from '@/lib/pm/schedule/links';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type GanttPrefs } from '@/lib/pm/schedule/prefs';
import { dayWindow, makeScale, rowWindow, ticks, widthPx, xOf } from '@/lib/pm/schedule/timeline';
import { indentTarget, refResolver, type OutlineRow } from '@/lib/pm/schedule/tree';
import { defaultScheduleView } from '@/lib/pm/schedule/views';
import type { BaselineTask, JobScheduleBundle, ScheduleView, Zoom } from '@/lib/pm/schedule/types';
import { BASE_COLS, GanttGrid, VAR_COL, cellEditable, cellText, type Col, type Editing } from './GanttGrid';
import { GanttChart, type Ghost, type PreviewResult } from './GanttChart';
import { TaskPanel, pushedStart } from './TaskPanel';
import { PrintSheet } from './PrintSheet';
import { Legend } from './Legend';
import { EmptySchedule } from './EmptySchedule';
import { cpmInputs, useSchedule, type OpResponse, type ScheduleOp } from './useSchedule';
import './gantt.css';

/** useLayoutEffect in the browser, nothing on the server (no SSR warning). */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface GanttProps {
  bundle: JobScheduleBundle;
  jobLabel: string;
  today: string;
  userId: string | null;
  /** projects.jobs:edit at the job's company, and not the read-only consolidated view. */
  canEdit: boolean;
  /** projects.contract_value at the job's company. */
  showBilling: boolean;
  archetype: string | null;
  jobTypeKey: string | null;
  jobTypeLabel: string | null;
}

const HEAD_H = 44;
const GANTT_COLS: ReadonlyArray<Col['key']> = ['no', 'title', 'dur', 'start', 'finish', 'pct', 'pred'];
const ZOOM_ITEMS: ReadonlyArray<{ value: Zoom; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];
const PRINT_WEEKS = [0, 4, 8, 12, 26] as const;

function download(name: string, type: string, text: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Gantt(props: GanttProps) {
  const { bundle, jobLabel, today, userId, showBilling } = props;
  const router = useRouter();
  const canEdit = props.canEdit && bundle.engine;
  const s = useSchedule(bundle, today, canEdit);
  const { rows, outline, deps, cal } = s;

  // ---- preferences (per user, this browser) ------------------------------------------
  const [prefs, setPrefs] = useState<GanttPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const p = loadPrefs(userId);
    // a tablet with no saved choice opens in field mode
    let coarse = false;
    try {
      coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    } catch {
      coarse = false;
    }
    let stored = false;
    try {
      stored = window.localStorage?.getItem(`mp.schedule.prefs.v1:${userId ?? ''}`) != null;
    } catch {
      stored = false;
    }
    setPrefs(stored ? p : { ...p, field: coarse });
    setLoaded(true);
  }, [userId]);
  const update = useCallback(
    (patch: Partial<GanttPrefs>) => {
      setPrefs((p) => {
        const n = { ...p, ...patch };
        savePrefs(userId, n);
        return n;
      });
    },
    [userId],
  );
  const view: ScheduleView = prefs.views[bundle.jobId] ?? defaultScheduleView(props.archetype);
  const setView = (v: ScheduleView) => update({ views: { ...prefs.views, [bundle.jobId]: v } });
  const hasBaseline = !!bundle.baseline && bundle.baselineTasks.length > 0;
  const showBaseline = prefs.baseline && hasBaseline;
  const rowH = prefs.field ? 56 : 28;

  const cols: Col[] = useMemo(() => {
    const base = view === 'gantt' ? BASE_COLS.filter((c) => GANTT_COLS.includes(c.key)) : [...BASE_COLS];
    return showBaseline ? [...base, VAR_COL] : base;
  }, [view, showBaseline]);
  const gridW = cols.reduce((a, c) => a + c.width, 0);

  // ---- derived -----------------------------------------------------------------------
  const baseline = useMemo<ReadonlyMap<string, BaselineTask> | null>(() => (showBaseline ? new Map(bundle.baselineTasks.map((b) => [b.task_id, b])) : null), [showBaseline, bundle.baselineTasks]);
  const variance = useMemo(() => {
    const m = new Map<string, number>();
    if (!baseline) return m;
    for (const r of outline) {
      const b = baseline.get(r.task.id);
      if (b?.due_on && r.task.due_on) m.set(r.task.id, workdaysBetween(cal, b.due_on, r.task.due_on));
    }
    return m;
  }, [baseline, outline, cal]);
  const byRowNo = useMemo(() => new Map(outline.map((r) => [r.task.id, r])), [outline]);
  const preds = useMemo(() => {
    const m = new Map<string, string>();
    const group = new Map<string, typeof deps[number][]>();
    for (const d of deps) {
      const l = group.get(d.succ_id);
      if (l) l.push(d);
      else group.set(d.succ_id, [d]);
    }
    for (const [id, list] of group) m.set(id, formatLinks(list, (x) => (byRowNo.has(x) ? String(byRowNo.get(x)!.rowNo) : null), (x) => byRowNo.get(x)?.rowNo ?? 0));
    return m;
  }, [deps, byRowNo]);
  const resolve = useMemo(() => refResolver(outline), [outline]);
  const scale = useMemo(
    () => makeScale([...outline.flatMap((r) => [r.task.start_on, r.task.due_on]), ...bundle.baselineTasks.flatMap((b) => [b.start_on, b.due_on])], today, prefs.zoom),
    [outline, bundle.baselineTasks, today, prefs.zoom],
  );
  const chartW = view === 'gantt' ? widthPx(scale) : 0;
  const shownFinish = useMemo(() => outline.reduce<string | null>((a, r) => (!r.hasChildren && r.task.due_on && (!a || r.task.due_on > a) ? r.task.due_on : a), null), [outline]);
  const criticalCount = outline.filter((r) => !r.hasChildren && r.task.is_critical && r.task.status !== 'DONE').length;

  // ---- viewport + windowing ----------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, left: 0, w: 1200, h: 640 });
  const vpRaf = useRef<number | null>(null);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setVp((v) => (v.top === el.scrollTop && v.left === el.scrollLeft && v.w === el.clientWidth && v.h === el.clientHeight ? v : { top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight }));
  }, []);
  const onScroll = useCallback(() => {
    if (vpRaf.current != null) return;
    vpRaf.current = requestAnimationFrame(() => {
      vpRaf.current = null;
      measure();
    });
  }, [measure]);
  useIsoLayoutEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, view]);
  const win = rowWindow(Math.max(0, vp.top - HEAD_H), vp.h - HEAD_H, rowH, rows.length);
  const dayWin = dayWindow(scale, Math.max(0, vp.left), Math.max(0, vp.w - gridW));
  const tk = useMemo(() => ticks(scale, prefs.zoom, dayWin), [scale, prefs.zoom, dayWin.from, dayWin.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToDay = useCallback(
    (iso: string) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, xOf(scale, iso) - Math.max(80, (el.clientWidth - gridW) / 4));
    },
    [scale, gridW],
  );
  // open on today (or the job's first date when it starts later)
  const opened = useRef(false);
  useEffect(() => {
    if (!loaded || opened.current || view !== 'gantt') return;
    opened.current = true;
    const first = outline.find((r) => r.task.start_on)?.task.start_on;
    scrollToDay(first && first > today ? first : today);
  }, [loaded, view, outline, today, scrollToDay]);

  // ---- selection, editing ------------------------------------------------------------
  const [active, setActive] = useState({ row: 0, col: Math.max(0, cols.findIndex((c) => c.key === 'title')) });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'neg' | 'warn' | 'info'; title: string; body: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeRow: OutlineRow | undefined = rows[Math.min(active.row, rows.length - 1)];
  const selectedId = activeRow?.task.id ?? null;

  const ensureVisible = useCallback(
    (row: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = HEAD_H + row * rowH;
      if (top - HEAD_H < el.scrollTop) el.scrollTop = top - HEAD_H;
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
    },
    [rowH],
  );
  const selectId = useCallback(
    (id: string) => {
      const i = rows.findIndex((r) => r.task.id === id);
      if (i >= 0) {
        setActive((a) => ({ ...a, row: i }));
        ensureVisible(i);
      }
    },
    [rows, ensureVisible],
  );
  const openPanel = useCallback(
    (id: string) => {
      selectId(id);
      setPanelId(id);
    },
    [selectId],
  );
  useEffect(() => {
    if (active.col >= cols.length) setActive((a) => ({ ...a, col: cols.length - 1 }));
  }, [cols.length, active.col]);

  // ---- server ops --------------------------------------------------------------------
  const fail = useCallback(
    (e: { error: string; code: string }) => {
      if (e.code === 'PM_DEP_CYCLE') setNotice({ tone: 'neg', title: 'That link would make a loop.', body: `${e.error.replace(/\.$/, '')}. Remove one of these links.` });
      toast.error(e.error);
      void s.reload();
    },
    [s],
  );
  const op = useCallback(
    async (body: ScheduleOp, ok?: string | ((d: OpResponse) => string | null), undo?: () => void | Promise<void>): Promise<OpResponse | null> => {
      const res = await s.send(body);
      if (res.error) {
        fail(res.error);
        return null;
      }
      const msg = typeof ok === 'function' ? ok(res.data as OpResponse) : ok;
      if (msg) toast(msg, undo ? { undo, duration: 10_000 } : undefined);
      return res.data;
    },
    [s, fail],
  );

  // The ghost baseline: the local CPM over the tasks exactly as drawn, so a preview differs from it
  // only where the drag moves something.
  const previewBase = useMemo(() => tryCpm(cpmInputs(s.shown, deps), deps, cal, s.anchor, s.statusDate), [s.shown, deps, cal, s.anchor, s.statusDate]);
  const baseOut = previewBase.ok ? previewBase.out : null;

  /** Move and/or resize one task: optimistic ghosts now, the server's CPM on return, undo for 10 s. */
  const reschedule = useCallback(
    async (edit: MoveEdit, verb: 'Moved' | 'Resized' | 'Updated') => {
      const t = s.tasks.find((x) => x.id === edit.taskId);
      if (!t) return;
      const before = { start: t.start_on, duration: t.duration_days };
      // optimistic: the local CPM's answer, until the server's arrives
      const base = baseOut;
      const next = tryCpm(applyMove(cpmInputs(s.shown, deps), edit), deps, cal, s.anchor, s.statusDate);
      if (base && next.ok) {
        const diff = diffCpm(base, next.out);
        const ch = new Set(diff.changed);
        s.setTasks((ts) => ts.map((x) => {
          const r = next.out.results.get(x.id);
          if (!r || !ch.has(x.id)) return x.id === edit.taskId && edit.duration != null ? { ...x, duration_days: edit.duration } : x;
          return { ...x, start_on: r.start_on, due_on: r.due_on, duration_days: x.id === edit.taskId && edit.duration != null ? edit.duration : x.duration_days };
        }));
      }
      const res = await s.send({ op: 'reschedule', taskId: edit.taskId, start: edit.start, duration: edit.duration });
      if (res.error) return fail(res.error);
      const r = res.data?.result;
      const delta = finishDelta(cal, r?.finish_before ?? null, r?.finish_after ?? null);
      toast(moveSummary(verb, r?.moved_count ?? 1, delta), {
        duration: 10_000,
        undo: async () => {
          const u = await s.send({ op: 'reschedule', taskId: edit.taskId, start: edit.start ? before.start : null, duration: edit.duration != null ? before.duration : null });
          if (u.error) fail(u.error);
          else toast(`Undid the change to ${t.title}`);
        },
      });
    },
    [s, deps, cal, fail, baseOut],
  );

  const preview = useCallback(
    (edit: MoveEdit): PreviewResult => {
      const base = baseOut;
      const next = tryCpm(applyMove(cpmInputs(s.shown, deps), edit), deps, cal, s.anchor, s.statusDate);
      if (!base || !next.ok) return { ghosts: new Map(), label: next.ok ? '' : cycleMessage(next.cycle) };
      const diff = diffCpm(base, next.out);
      const ghosts = new Map<string, Ghost>();
      for (const id of diff.changed) {
        const r = next.out.results.get(id);
        if (r?.start_on && r.due_on) ghosts.set(id, { start_on: r.start_on, due_on: r.due_on });
      }
      const own = next.out.results.get(edit.taskId);
      const delta = finishDelta(cal, diff.finishBefore, diff.finishAfter);
      const moved = Math.max(0, diff.movedLeaves - 1);
      return {
        ghosts,
        label: `${own?.due_on ? `Finish ${shortDate(own.due_on, today)}` : ''}${moved ? ` · ${moved} more ${moved === 1 ? 'task moves' : 'tasks move'}` : ''} · job finish ${delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'day' : 'days'}`}`,
      };
    },
    [baseOut, s.shown, s.anchor, s.statusDate, deps, cal, today],
  );

  const setLinks = useCallback(
    async (taskId: string, links: Array<{ pred_id: string; dep_type: string; lag_days: number }>, verb: string): Promise<boolean> => {
      const prev = deps.filter((d) => d.succ_id === taskId).map((d) => ({ pred_id: d.pred_id, dep_type: d.dep_type, lag_days: d.lag_days }));
      const finBefore = shownFinish;
      const out = await op({ op: 'links', taskId, links }, (d) => {
        const after = (d.tasks ?? []).reduce<string | null>((a, t) => (!t.is_summary && t.due_on && (!a || t.due_on > a) ? t.due_on : a), null);
        return `${verb}; finish ${(() => {
          const n = finishDelta(cal, finBefore, after);
          return n === 0 ? 'unchanged' : `${n > 0 ? '+' : '−'}${Math.abs(n)} ${Math.abs(n) === 1 ? 'day' : 'days'}`;
        })()}`;
      }, async () => {
        const u = await s.send({ op: 'links', taskId, links: prev });
        if (u.error) fail(u.error);
        else toast('Restored the links');
      });
      return !!out;
    },
    [deps, op, s, fail, cal, shownFinish],
  );

  const onLink = useCallback(
    (predId: string, succId: string) => {
      const name = (id: string) => byRowNo.get(id)?.task.title ?? 'a task';
      if (deps.some((d) => d.pred_id === predId && d.succ_id === succId)) return toast(`${name(succId)} already follows ${name(predId)}`);
      const loop = findLinkCycle(deps, predId, succId);
      if (loop) {
        const msg = cycleMessage(loop.map(name));
        setNotice({ tone: 'neg', title: 'That link would make a loop.', body: msg });
        return toast.error(msg);
      }
      setNotice(null);
      const links = [...deps.filter((d) => d.succ_id === succId).map((d) => ({ pred_id: d.pred_id, dep_type: d.dep_type, lag_days: d.lag_days })), { pred_id: predId, dep_type: 'FS', lag_days: 0 }];
      void setLinks(succId, links, `Linked ${name(predId)} → ${name(succId)}`);
    },
    [deps, byRowNo, setLinks],
  );

  const addRow = useCallback(
    async (after: OutlineRow | undefined) => {
      if (!canEdit) return;
      const out = await op({ op: 'create', title: 'New task', afterTaskId: after?.task.id ?? null, parentId: after?.parentId ?? null, duration: 1 }, 'Added a task');
      if (out?.taskId) {
        const id = out.taskId;
        // the new row arrives with the response; open its name for typing
        setTimeout(() => {
          setEditing({ taskId: id, col: 'title', draft: 'New task', error: null });
        }, 0);
        setPendingFocus(id);
      }
    },
    [canEdit, op],
  );
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    const i = rows.findIndex((r) => r.task.id === pendingFocus);
    if (i < 0) return;
    setPendingFocus(null);
    setActive((a) => ({ row: i, col: Math.max(0, cols.findIndex((c) => c.key === 'title')) || a.col }));
    ensureVisible(i);
  }, [pendingFocus, rows, cols, ensureVisible]);

  const indent = useCallback(
    async (row: OutlineRow, dir: 'in' | 'out') => {
      if (!canEdit) return;
      const target = indentTarget(outline, row.task.id, dir);
      if (!target) return toast(dir === 'in' ? `${row.task.title} is first at its level, so there is nothing to put it under` : `${row.task.title} is already at the top level`);
      await op({ op: 'indent', taskId: row.task.id, direction: dir }, dir === 'in' ? `Indented ${row.task.title}` : `Outdented ${row.task.title}`, async () => {
        const u = await s.send({ op: 'indent', taskId: row.task.id, direction: dir === 'in' ? 'out' : 'in' });
        if (u.error) fail(u.error);
      });
    },
    [canEdit, outline, op, s, fail],
  );

  const moveOrder = useCallback(
    async (row: OutlineRow, dir: -1 | 1) => {
      if (!canEdit) return;
      const sibs = outline.filter((r) => r.parentId === row.parentId);
      const k = sibs.findIndex((r) => r.task.id === row.task.id);
      const j = k + dir;
      if (j < 0 || j >= sibs.length) return;
      const after = dir === 1 ? sibs[j]!.task.id : j - 1 >= 0 ? sibs[j - 1]!.task.id : null;
      await op({ op: 'order', taskId: row.task.id, afterTaskId: after }, `Moved ${row.task.title} ${dir === 1 ? 'down' : 'up'}`);
    },
    [canEdit, outline, op],
  );

  // ---- cell commit -------------------------------------------------------------------
  const commit = useCallback(
    async (e: Editing): Promise<boolean> => {
      const r = outline.find((x) => x.task.id === e.taskId);
      if (!r) return true;
      const t = r.task;
      const draft = e.draft.trim();
      const err = (msg: string) => {
        setEditing({ ...e, error: msg });
        return false;
      };
      switch (e.col) {
        case 'title':
          if (!draft) return err('Name the task.');
          if (draft !== t.title) void op({ op: 'update', taskId: t.id, patch: { title: draft } }, `Renamed to ${draft}`);
          return true;
        case 'dur': {
          const n = parseDurationInput(draft);
          if (n == null || n < 1) return err('Type working days, like 5 or 2w.');
          if (n !== t.duration_days) void reschedule({ taskId: t.id, start: null, duration: n }, 'Resized');
          return true;
        }
        case 'start': {
          const d = parseDayInput(draft, today);
          if (!d) return err('Type a date, like 11/18 or Nov 18.');
          if (d !== t.start_on) void reschedule({ taskId: t.id, start: d, duration: null }, 'Moved');
          return true;
        }
        case 'finish': {
          const d = parseDayInput(draft, today);
          if (!d) return err('Type a date, like 11/18 or Nov 18.');
          if (!t.start_on) return err('Set the start first.');
          if (d < t.start_on) return err('The finish is before the start. Move the start, or type a later finish.');
          const n = Math.max(1, workdaysInclusive(cal, addWorkdays(cal, t.start_on, 0), d));
          if (d !== t.due_on && n !== t.duration_days) void reschedule({ taskId: t.id, start: null, duration: n }, 'Resized');
          return true;
        }
        case 'pct': {
          const v = parsePctInput(draft || '0');
          if (v == null) return err('Type a percent from 0 to 100.');
          if (v !== t.pct_complete) void op({ op: 'update', taskId: t.id, patch: { pct_complete: v, ...(v === 1 ? { status: 'DONE' as const } : v > 0 && t.status === 'TODO' ? { status: 'IN_PROGRESS' as const } : {}) } }, `Set ${t.title} to ${Math.round(v * 100)}%`);
          return true;
        }
        case 'crew':
          if ((draft || null) !== t.assigned_crew_id) {
            const crew = bundle.crews.find((c) => c.id === draft);
            void op({ op: 'update', taskId: t.id, patch: { assigned_crew_id: draft || null } }, crew ? `Assigned ${crew.name}` : 'Removed the crew');
          }
          return true;
        case 'pred': {
          const parsed = parseLinks(draft, t.id, resolve);
          if (!parsed.ok) return err(parsed.error);
          const others = deps.filter((d) => d.succ_id !== t.id);
          for (const l of parsed.links) {
            const loop = findLinkCycle(others, l.pred_id, t.id);
            if (loop) return err(cycleMessage(loop.map((id) => byRowNo.get(id)?.task.title ?? 'a task')));
          }
          if (draft !== (preds.get(t.id) ?? '')) void setLinks(t.id, parsed.links, `Updated links on ${t.title}`);
          return true;
        }
        default:
          return true;
      }
    },
    [outline, op, reschedule, today, cal, bundle.crews, resolve, deps, byRowNo, preds, setLinks],
  );

  const startEdit = useCallback(
    (row: number, col: number, seed?: string) => {
      const r = rows[row];
      const c = cols[col];
      if (!r || !c || !cellEditable(r, c, canEdit)) {
        if (r && c && canEdit && c.edit && r.hasChildren) toast('A phase’s dates come from its tasks. Edit the tasks inside it.');
        return;
      }
      const t = r.task;
      const current =
        c.key === 'start' ? t.start_on ?? '' : c.key === 'finish' ? t.due_on ?? '' : c.key === 'crew' ? t.assigned_crew_id ?? '' : cellText(r, c.key, preds, bundle.crews, variance);
      setActive({ row, col });
      setEditing({ taskId: t.id, col: c.key, draft: seed ?? current, error: null });
    },
    [rows, cols, canEdit, preds, bundle.crews, variance],
  );

  const finishEdit = useCallback(
    async (move: { dr: number; dc: number } | null) => {
      if (!editing) return;
      const ok = await commit(editing);
      if (!ok) return;
      setEditing(null);
      if (move) setActive((a) => ({ row: Math.max(0, Math.min(rows.length - 1, a.row + move.dr)), col: Math.max(0, Math.min(cols.length - 1, a.col + move.dc)) }));
      requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
    },
    [editing, commit, rows.length, cols.length],
  );

  const onEditorKey = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
      gridRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void finishEdit({ dr: 1, dc: 0 });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      void finishEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 });
    }
  };

  const [confirmDelete, setConfirmDelete] = useState<OutlineRow | null>(null);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== gridRef.current) return;
    const r = activeRow;
    const last = rows.length - 1;
    const move = (row: number, col = active.col) => {
      const nr = Math.max(0, Math.min(last, row));
      setActive({ row: nr, col: Math.max(0, Math.min(cols.length - 1, col)) });
      ensureVisible(nr);
    };
    const k = e.key;
    if (k === 'ArrowDown' && e.altKey && r) return e.preventDefault(), void moveOrder(r, 1);
    if (k === 'ArrowUp' && e.altKey && r) return e.preventDefault(), void moveOrder(r, -1);
    if (k === 'ArrowDown') return e.preventDefault(), move(active.row + 1);
    if (k === 'ArrowUp') return e.preventDefault(), move(active.row - 1);
    if (k === 'ArrowRight') {
      e.preventDefault();
      if (r?.hasChildren && s.collapsed.has(r.task.id) && active.col === cols.findIndex((c) => c.key === 'title')) return s.toggle(r.task.id);
      return move(active.row, active.col + 1);
    }
    if (k === 'ArrowLeft') {
      e.preventDefault();
      if (r?.hasChildren && !s.collapsed.has(r.task.id) && active.col === cols.findIndex((c) => c.key === 'title')) return s.toggle(r.task.id);
      return move(active.row, active.col - 1);
    }
    if (k === 'PageDown') return e.preventDefault(), move(active.row + Math.floor(vp.h / rowH) - 1);
    if (k === 'PageUp') return e.preventDefault(), move(active.row - Math.floor(vp.h / rowH) + 1);
    if (k === 'Home') return e.preventDefault(), move(e.ctrlKey || e.metaKey ? 0 : active.row, 0);
    if (k === 'End') return e.preventDefault(), move(e.ctrlKey || e.metaKey ? last : active.row, cols.length - 1);
    if (k === 'Tab' && canEdit && r) return e.preventDefault(), void indent(r, e.shiftKey ? 'out' : 'in');
    if (k === 'Enter' && e.shiftKey && r) return e.preventDefault(), openPanel(r.task.id);
    if (k === 'Enter' && canEdit) return e.preventDefault(), void addRow(r);
    if (k === 'Enter' && r) return e.preventDefault(), openPanel(r.task.id);
    if (k === 'F2' && r) return e.preventDefault(), startEdit(active.row, active.col);
    if (k === ' ' && r) return e.preventDefault(), openPanel(r.task.id);
    if ((k === 'Delete' || k === 'Backspace') && canEdit && r) {
      e.preventDefault();
      if (r.hasChildren) return toast(`${r.task.title} has tasks inside it. Outdent or remove those first.`);
      return setConfirmDelete(r);
    }
    if (k === 'Escape') return gridRef.current?.blur();
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && canEdit && r) {
      e.preventDefault();
      startEdit(active.row, active.col, k);
    }
  };

  // ---- hotkeys (one registry) --------------------------------------------------------
  useHotkey('c', () => update({ critical: !prefs.critical }), { owner: 'Gantt', description: 'Critical path', enabled: view === 'gantt' });
  useHotkey('b', () => (hasBaseline ? update({ baseline: !prefs.baseline }) : false), { owner: 'Gantt', description: 'Baseline', enabled: view === 'gantt' && hasBaseline });
  useHotkey('t', () => scrollToDay(today), { owner: 'Gantt', description: 'Scroll to today', enabled: view === 'gantt' });
  useHotkey('z', () => update({ zoom: prefs.zoom === 'day' ? 'week' : prefs.zoom === 'week' ? 'month' : 'day' }), { owner: 'Gantt', description: 'Zoom', enabled: view === 'gantt' });

  // keep today in view when zoom changes
  const zoomRef = useRef(prefs.zoom);
  useEffect(() => {
    if (zoomRef.current === prefs.zoom) return;
    zoomRef.current = prefs.zoom;
    scrollToDay(selectedId ? byRowNo.get(selectedId)?.task.start_on ?? today : today);
  }, [prefs.zoom, scrollToDay, today, selectedId, byRowNo]);

  // ---- print, export ------------------------------------------------------------------
  const [printWeeks, setPrintWeeks] = useState<number | null>(null);
  const [printPick, setPrintPick] = useState<number>(0);
  useEffect(() => {
    if (printWeeks == null) return;
    const done = () => setPrintWeeks(null);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 150);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printWeeks]);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  const crewName = useCallback((id: string | null) => bundle.crews.find((c) => c.id === id)?.name ?? null, [bundle.crews]);
  const exportInput = () => ({ jobLabel, rows: outline, deps, crewName, baseline: hasBaseline ? new Map(bundle.baselineTasks.map((b) => [b.task_id, b])) : undefined, includeBilling: showBilling });
  const doCsv = () => {
    download(exportFileName(jobLabel, 'csv'), 'text/csv;charset=utf-8', scheduleCsv(exportInput()));
    setExportOpen(false);
    toast(`Exported ${outline.length} tasks to CSV`);
  };
  const doXml = () => {
    download(exportFileName(jobLabel, 'xml'), 'application/xml', scheduleMspXml({ ...exportInput(), calendar: cal, start: s.anchor }));
    setExportOpen(false);
    toast(`Exported ${outline.length} tasks for Microsoft Project`);
  };

  const panelRow = panelId ? outline.find((r) => r.task.id === panelId) ?? null : null;
  useEffect(() => {
    if (panelId && !panelRow) setPanelId(null);
  }, [panelId, panelRow]);

  // ---- render --------------------------------------------------------------------------
  if (!outline.length) {
    return (
      <div className="gx">
        <EmptySchedule
          templates={bundle.templates}
          jobTypeKey={props.jobTypeKey}
          jobTypeLabel={props.jobTypeLabel}
          defaultStart={bundle.plannedStart && bundle.plannedStart > today ? bundle.plannedStart : today}
          today={today}
          canEdit={canEdit || (props.canEdit && !bundle.engine)}
          engine={bundle.engine}
          busy={!!s.busy}
          onApply={(templateId, start, name) => void op({ op: 'template', templateId, start }, (d) => `Started from ${name}: ${d.tasks?.length ?? 0} tasks`)}
          onAdd={() => void addRow(undefined)}
        />
      </div>
    );
  }

  const totalH = HEAD_H + rows.length * rowH;
  return (
    <div className={`gx${prefs.field ? ' field' : ''}`}>
      <div className="gx-bar" role="toolbar" aria-label="Schedule tools">
        <Seg<ScheduleView> aria-label="View" items={[{ value: 'gantt', label: 'Gantt' }, { value: 'list', label: 'List' }]} value={view} onChange={setView} />
        {view === 'gantt' && <Seg<Zoom> aria-label="Zoom" items={ZOOM_ITEMS} value={prefs.zoom} onChange={(z) => update({ zoom: z })} />}
        {view === 'gantt' && <Switch label="Critical path" checked={prefs.critical} onChange={(e) => update({ critical: e.target.checked })} />}
        {view === 'gantt' && hasBaseline && <Switch label={`Baseline (${bundle.baseline?.name ?? ''})`} checked={prefs.baseline} onChange={(e) => update({ baseline: e.target.checked })} />}
        <Switch label="Field mode" checked={prefs.field} onChange={(e) => update({ field: e.target.checked })} />
        <span className="sp" />
        {view === 'gantt' && (
          <Button variant="quiet" icon="calendar" chord="t" onClick={() => scrollToDay(today)}>
            Today
          </Button>
        )}
        {canEdit && (
          <Button variant="quiet" icon="flag" disabled={!!s.busy} onClick={() => void op({ op: 'baseline', name: `Baseline ${shortDate(today, today)}` }, `Set baseline ${shortDate(today, today)}`).then((d) => d && router.refresh())}>
            {hasBaseline ? 'Re-baseline' : 'Set baseline'}
          </Button>
        )}
        <Button ref={exportRef} variant="quiet" icon="upload" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}>
          Export
        </Button>
        <Button variant="quiet" icon="file-text" onClick={() => setPrintWeeks(printPick)}>
          Print 11×17
        </Button>
        {canEdit && (
          <Button icon="plus" disabled={!!s.busy} onClick={() => void addRow(activeRow)}>
            Add task
          </Button>
        )}
      </div>

      <Popover open={exportOpen} onClose={() => setExportOpen(false)} anchorRef={exportRef} aria-label="Export the schedule" width={360} placement="bottom-end" role="menu">
        <PopoverHead>Export {outline.length} tasks</PopoverHead>
        <PopoverList role="menu">
          <PopoverItem role="menuitem" tabIndex={0} onClick={doCsv} onKeyDown={(e) => e.key === 'Enter' && doCsv()} right=".csv">Spreadsheet (CSV)</PopoverItem>
          <PopoverItem role="menuitem" tabIndex={0} onClick={doXml} onKeyDown={(e) => e.key === 'Enter' && doXml()} right=".xml">Microsoft Project (XML)</PopoverItem>
        </PopoverList>
        <PopoverFoot>
          <span className="t-cap">Coming next: Primavera P6 (.xer) export, and importing Project or P6 files.{showBilling ? ' Billing amounts are included in the CSV.' : ''}</span>
        </PopoverFoot>
      </Popover>

      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="t-cap">
          {shownFinish ? <>Finishes <b>{shortDate(shownFinish, today)}</b> · </> : null}
          {outline.filter((r) => !r.hasChildren).length} tasks · {criticalCount} critical
          {s.busy ? ' · saving…' : bundle.header?.cpm_at ? ' · scheduled by the engine' : ''}
        </span>
        <label className="t-cap row" style={{ gap: 4, alignItems: 'center' }}>
          Print fits
          <select aria-label="Print fits" value={printPick} onChange={(e) => setPrintPick(Number(e.target.value))} style={{ font: 'inherit', border: '1px solid var(--line-2)', background: 'var(--white)', padding: '0 4px' }}>
            {PRINT_WEEKS.map((w) => (
              <option key={w} value={w}>
                {w ? `${w} weeks from this week` : 'the whole job'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!bundle.engine && (
        <InlineNotice tone="info" title="Read-only preview.">
          Dates and the critical path are calculated in your browser from the tasks as entered. Editing, links and templates switch on when your administrator applies the schedule update.
        </InlineNotice>
      )}
      {bundle.engine && !props.canEdit && (
        <InlineNotice tone="info" title="View only.">
          You can see this schedule; the project manager or superintendent changes it.
        </InlineNotice>
      )}
      {!s.local.ok && (
        <InlineNotice tone="neg" title="This schedule has a loop.">
          {cycleMessage(s.local.cycle)}
        </InlineNotice>
      )}
      {notice && (
        <InlineNotice tone={notice.tone} title={notice.title}>
          {notice.body}{' '}
          <button type="button" className="nlink" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </InlineNotice>
      )}

      <div className={`gx-frame${panelRow ? ' gx-frame--panel' : ''}`}>
        <div
          ref={scrollRef}
          className="gx-scroll"
          onScroll={onScroll}
          style={view === 'list' ? { height: `min(72vh, ${Math.max(320, totalH + 2)}px)` } : undefined}
        >
          <div className="gx-inner" style={{ width: gridW + chartW, height: totalH }}>
            <div className="gx-head" style={{ height: HEAD_H, width: gridW + chartW }}>
              <div className="gx-hgrid" style={{ width: gridW }} role="row">
                {cols.map((c) => (
                  <div key={c.key} role="columnheader" className={c.align === 'r' ? 'r' : undefined} style={{ width: c.width }}>
                    {c.label}
                  </div>
                ))}
              </div>
              {view === 'gantt' && (
                <svg className="gx-scale" width={chartW} height={HEAD_H} aria-hidden="true">
                  {tk.top.map((t) => (
                    <g key={`t${t.x}`}>
                      {t.major && <line x1={t.x} x2={t.x} y1={0} y2={HEAD_H} />}
                      <text className="top" x={t.x + 4} y={16}>{t.label}</text>
                    </g>
                  ))}
                  {tk.bottom.map((t) => (
                    <g key={`b${t.x}`}>
                      <line x1={t.x} x2={t.x} y1={24} y2={HEAD_H} />
                      <text x={t.x + 3} y={38}>{t.label}</text>
                    </g>
                  ))}
                </svg>
              )}
            </div>
            <div className="gx-body" style={{ height: rows.length * rowH }}>
              <div
                ref={gridRef}
                className="gx-grid"
                style={{ width: gridW, height: rows.length * rowH }}
                role="treegrid"
                aria-label={`Schedule for ${jobLabel}`}
                aria-rowcount={rows.length + 1}
                aria-colcount={cols.length}
                aria-readonly={!canEdit}
                tabIndex={0}
                onKeyDown={onGridKey}
              >
                <GanttGrid
                  rows={rows}
                  win={win}
                  rowH={rowH}
                  cols={cols}
                  width={gridW}
                  active={active}
                  editing={editing}
                  collapsed={s.collapsed}
                  preds={preds}
                  crews={bundle.crews}
                  variance={variance}
                  canEdit={canEdit}
                  onCell={(row, col) => {
                    if (editing) void finishEdit(null);
                    setActive({ row, col });
                    gridRef.current?.focus({ preventScroll: true });
                  }}
                  onEdit={(row, col) => startEdit(row, col)}
                  onOpen={openPanel}
                  onToggle={s.toggle}
                  onDraft={(draft) => setEditing((e) => (e ? { ...e, draft, error: null } : e))}
                  onEditorKey={onEditorKey}
                  onCommit={() => void finishEdit(null)}
                />
              </div>
              {view === 'gantt' && (
                <GanttChart
                  rows={rows}
                  win={win}
                  dayWin={dayWin}
                  scale={scale}
                  zoom={prefs.zoom}
                  rowH={rowH}
                  cal={cal}
                  today={today}
                  deps={deps}
                  critical={prefs.critical}
                  baseline={baseline}
                  selectedId={selectedId}
                  canEdit={canEdit}
                  field={prefs.field}
                  scrollRef={scrollRef}
                  onSelect={selectId}
                  onOpen={openPanel}
                  onPreview={preview}
                  onCommit={(edit, kind) => void reschedule(edit, kind === 'move' ? 'Moved' : 'Resized')}
                  onLink={onLink}
                />
              )}
            </div>
          </div>
        </div>
        {panelRow && (
          <TaskPanel
            row={panelRow}
            rows={outline}
            deps={deps}
            crews={bundle.crews}
            cal={cal}
            today={today}
            baseline={bundle.baselineTasks.find((b) => b.task_id === panelRow.task.id) ?? null}
            canEdit={canEdit}
            field={prefs.field}
            showBilling={showBilling}
            busy={!!s.busy}
            onClose={() => {
              setPanelId(null);
              gridRef.current?.focus({ preventScroll: true });
            }}
            onSelect={openPanel}
            onUpdate={async (patch, verb) => !!(await op({ op: 'update', taskId: panelRow.task.id, patch }, verb))}
            onLinks={async (text) => {
              const parsed = parseLinks(text, panelRow.task.id, resolve);
              if (!parsed.ok) return parsed.error;
              const others = deps.filter((d) => d.succ_id !== panelRow.task.id);
              for (const l of parsed.links) {
                const loop = findLinkCycle(others, l.pred_id, panelRow.task.id);
                if (loop) return cycleMessage(loop.map((id) => byRowNo.get(id)?.task.title ?? 'a task'));
              }
              return (await setLinks(panelRow.task.id, parsed.links, `Updated links on ${panelRow.task.title}`)) ? null : 'The links were not saved. Check the message above.';
            }}
            onPush={(n) => {
              const st = panelRow.task.start_on;
              if (st) void reschedule({ taskId: panelRow.task.id, start: pushedStart(cal, st, n), duration: null }, 'Moved');
            }}
            onDelete={async () => {
              const t = panelRow.task;
              const ok = await op({ op: 'delete', taskId: t.id }, `Removed ${t.title}`);
              if (ok) setPanelId(null);
            }}
          />
        )}
      </div>

      {view === 'gantt' && <Legend critical={prefs.critical} baseline={showBaseline} ghosts={canEdit} />}
      <Keybar
        hints={[
          { chord: '↑ ↓', label: 'move' },
          ...(canEdit
            ? [
                { chord: 'enter', label: 'new row' },
                { chord: 'tab', label: 'indent' },
                { chord: 'shift+tab', label: 'outdent' },
                { chord: 'f2', label: 'edit' },
                { chord: 'alt+↑', label: 'reorder' },
              ]
            : []),
          { chord: 'space', label: 'details' },
          ...(view === 'gantt' ? [{ chord: 'c', label: 'critical' }, { chord: 'z', label: 'zoom' }, { chord: 't', label: 'today' }] : []),
          ...(view === 'gantt' && hasBaseline ? [{ chord: 'b', label: 'baseline' }] : []),
        ]}
        note={canEdit ? (prefs.field ? 'Long-press a bar to drag it · two fingers pan' : 'Drag a bar to move it, its right edge to change days, its end dot to link') : 'View only'}
      />

      {confirmDelete && (
        <DeleteConfirm
          title={confirmDelete.task.title}
          onClose={() => {
            setConfirmDelete(null);
            gridRef.current?.focus({ preventScroll: true });
          }}
          onConfirm={async () => {
            await op({ op: 'delete', taskId: confirmDelete.task.id }, `Removed ${confirmDelete.task.title}`);
            setConfirmDelete(null);
          }}
        />
      )}

      {printWeeks != null && <PrintSheet jobLabel={jobLabel} rows={rows} cal={cal} today={today} weeks={printWeeks} critical={prefs.critical} baseline={baseline} />}
    </div>
  );
}

function DeleteConfirm({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <ConfirmDialog open onClose={onClose} tone="danger" title="Remove this task" confirmLabel="Remove task" onConfirm={onConfirm}>
      {title}
    </ConfirmDialog>
  );
}
