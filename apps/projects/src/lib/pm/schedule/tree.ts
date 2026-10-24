/**
 * The outline: tasks in display order (parent_task_id + sort), WBS numbers, row numbers,
 * collapse, and the local half of indent/outdent (pm.indent_task is authoritative). Pure.
 */
import type { SchedTask } from './types';

export interface OutlineRow {
  task: SchedTask;
  depth: number;
  /** 1-based, in full outline order (the # column and the predecessor ref). */
  rowNo: number;
  /** pm.tasks.wbs_code when the engine set one, else computed ("1.2.3"). */
  wbs: string;
  hasChildren: boolean;
  parentId: string | null;
}

type OutlineTask = Pick<SchedTask, 'id' | 'parent_task_id' | 'sort' | 'title' | 'wbs_code'>;

/** Full outline (every row, collapsed or not). Orphans (parent not loaded) sit at the top level. */
export function buildOutline<T extends OutlineTask>(tasks: ReadonlyArray<T>): Array<Omit<OutlineRow, 'task'> & { task: T }> {
  const ids = new Set(tasks.map((t) => t.id));
  const kids = new Map<string | null, T[]>();
  for (const t of tasks) {
    const p = t.parent_task_id && ids.has(t.parent_task_id) ? t.parent_task_id : null;
    const list = kids.get(p);
    if (list) list.push(t);
    else kids.set(p, [t]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const out: Array<Omit<OutlineRow, 'task'> & { task: T }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, prefix: string) => {
    const list = kids.get(parent) ?? [];
    list.forEach((t, i) => {
      if (seen.has(t.id)) return; // parent loop in bad data: show once
      seen.add(t.id);
      const wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ task: t, depth, rowNo: out.length + 1, wbs: t.wbs_code || wbs, hasChildren: (kids.get(t.id)?.length ?? 0) > 0, parentId: parent });
      walk(t.id, depth + 1, wbs);
    });
  };
  walk(null, 0, '');
  // anything unreached (a parent loop) goes last, flat
  for (const t of tasks) if (!seen.has(t.id)) out.push({ task: t, depth: 0, rowNo: out.length + 1, wbs: t.wbs_code || String(out.length + 1), hasChildren: false, parentId: null });
  return out;
}

/** Rows shown with these summaries collapsed. */
export function visibleOutline<R extends { task: { id: string }; parentId: string | null }>(rows: ReadonlyArray<R>, collapsed: ReadonlySet<string>): R[] {
  if (!collapsed.size) return [...rows];
  const hidden = new Set<string>();
  const out: R[] = [];
  for (const r of rows) {
    if (r.parentId && (hidden.has(r.parentId) || collapsed.has(r.parentId))) {
      hidden.add(r.task.id);
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * Where a row goes on Tab (in: under the previous sibling, which becomes a phase) or Shift-Tab
 * (out: a sibling of its parent, right after it). null when it can't move that way.
 */
export function indentTarget(rows: ReadonlyArray<{ task: { id: string }; depth: number; parentId: string | null }>, taskId: string, dir: 'in' | 'out'): { parentId: string | null } | null {
  const i = rows.findIndex((r) => r.task.id === taskId);
  if (i < 0) return null;
  const row = rows[i]!;
  if (dir === 'out') {
    if (!row.parentId) return null;
    const parent = rows.find((r) => r.task.id === row.parentId);
    return { parentId: parent?.parentId ?? null };
  }
  for (let k = i - 1; k >= 0; k--) {
    const r = rows[k]!;
    if (r.depth < row.depth) return null; // first child: nothing above at its level
    if (r.depth === row.depth) return { parentId: r.task.id };
  }
  return null;
}

/** Lookup for the predecessor parser: "12" → row 12, "1.2" → WBS 1.2. */
export function refResolver(rows: ReadonlyArray<{ task: { id: string }; rowNo: number; wbs: string; hasChildren: boolean }>) {
  const byNo = new Map(rows.map((r) => [String(r.rowNo), r]));
  const byWbs = new Map(rows.map((r) => [r.wbs, r]));
  return (ref: string) => {
    const r = ref.includes('.') ? byWbs.get(ref) : byNo.get(ref) ?? byWbs.get(ref);
    return r ? { id: r.task.id, summary: r.hasChildren } : null;
  };
}
