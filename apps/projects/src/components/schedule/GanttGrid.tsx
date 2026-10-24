'use client';

/**
 * The spreadsheet half of the Gantt: only the rows in view are rendered (absolute rows inside
 * a full-height column). The active cell and the open editor are the parent's state; keys are
 * handled by the parent's grid element (Tab / Shift-Tab indent, Enter adds a row, arrows move).
 */
import { memo, type KeyboardEvent } from 'react';
import { Icon, shortDate } from '@meritbooks/merit-ui';
import type { RowWindow } from '@/lib/pm/schedule/timeline';
import type { OutlineRow } from '@/lib/pm/schedule/tree';
import type { CrewOption } from '@/lib/pm/schedule/types';

export type ColKey = 'no' | 'wbs' | 'title' | 'dur' | 'start' | 'finish' | 'pct' | 'crew' | 'pred' | 'var';

export interface Col {
  key: ColKey;
  label: string;
  width: number;
  align?: 'r';
  /** Editable on a leaf task (summaries: title only). */
  edit: boolean;
}

export const BASE_COLS: readonly Col[] = [
  { key: 'no', label: '#', width: 40, align: 'r', edit: false },
  { key: 'wbs', label: 'WBS', width: 56, edit: false },
  { key: 'title', label: 'Task', width: 240, edit: true },
  { key: 'dur', label: 'Days', width: 52, align: 'r', edit: true },
  { key: 'start', label: 'Start', width: 76, align: 'r', edit: true },
  { key: 'finish', label: 'Finish', width: 76, align: 'r', edit: true },
  { key: 'pct', label: '%', width: 48, align: 'r', edit: true },
  { key: 'crew', label: 'Crew', width: 120, edit: true },
  { key: 'pred', label: 'Predecessors', width: 112, edit: true },
];
export const VAR_COL: Col = { key: 'var', label: 'Var', width: 52, align: 'r', edit: false };

export interface Editing {
  taskId: string;
  col: ColKey;
  draft: string;
  error: string | null;
}

export interface GanttGridProps {
  rows: ReadonlyArray<OutlineRow>;
  win: RowWindow;
  rowH: number;
  cols: ReadonlyArray<Col>;
  width: number;
  active: { row: number; col: number };
  editing: Editing | null;
  collapsed: ReadonlySet<string>;
  preds: ReadonlyMap<string, string>;
  crews: ReadonlyArray<CrewOption>;
  variance: ReadonlyMap<string, number>;
  canEdit: boolean;
  onCell: (row: number, col: number) => void;
  onEdit: (row: number, col: number) => void;
  onOpen: (taskId: string) => void;
  onToggle: (taskId: string) => void;
  onDraft: (draft: string) => void;
  onEditorKey: (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onCommit: () => void;
}

/** A cell's text when not editing. */
export function cellText(r: OutlineRow, key: ColKey, preds: ReadonlyMap<string, string>, crews: ReadonlyArray<CrewOption>, variance: ReadonlyMap<string, number>): string {
  const t = r.task;
  switch (key) {
    case 'no':
      return String(r.rowNo);
    case 'wbs':
      return r.wbs;
    case 'title':
      return t.title;
    case 'dur':
      return t.is_milestone ? '0' : t.duration_days != null ? String(t.duration_days) : '';
    case 'start':
      return t.start_on ? shortDate(t.start_on) : '';
    case 'finish':
      return t.due_on ? shortDate(t.due_on) : '';
    case 'pct':
      return t.pct_complete != null ? `${Math.round(t.pct_complete * 100)}` : '';
    case 'crew':
      return crews.find((c) => c.id === t.assigned_crew_id)?.name ?? '';
    case 'pred':
      return preds.get(t.id) ?? '';
    case 'var': {
      const v = variance.get(t.id);
      return v == null ? '' : v === 0 ? '0' : v > 0 ? `+${v}` : `(${Math.abs(v)})`;
    }
  }
}

/** Whether the column is editable on this row. */
export function cellEditable(r: OutlineRow, col: Col, canEdit: boolean): boolean {
  if (!canEdit || !col.edit) return false;
  if (r.hasChildren) return col.key === 'title';
  if (r.task.is_milestone && col.key === 'dur') return false;
  if (col.key === 'start' && r.task.actual_start) return false;
  return true;
}

function GanttGridImpl(p: GanttGridProps) {
  const { rows, win, rowH, cols, width, active, editing, collapsed, preds, crews, variance, canEdit } = p;
  const visible = rows.slice(win.start, win.end);
  return (
    <div className="gx-grid-rows" style={{ position: 'relative', width, height: rows.length * rowH }}>
      {visible.map((r, k) => {
        const i = win.start + k;
        const t = r.task;
        const sel = i === active.row;
        return (
          <div
            key={t.id}
            className={`gx-row${r.hasChildren ? ' sum' : ''}${sel ? ' sel' : ''}${t.status === 'DONE' ? ' done' : ''}`}
            style={{ top: i * rowH, height: rowH }}
            role="row"
            aria-rowindex={i + 2}
            aria-level={r.depth + 1}
            aria-expanded={r.hasChildren ? !collapsed.has(t.id) : undefined}
            aria-selected={sel}
          >
            {cols.map((c, ci) => {
              const isActive = sel && ci === active.col;
              const isEditing = !!editing && editing.taskId === t.id && editing.col === c.key;
              const editable = cellEditable(r, c, canEdit);
              const cls = [c.align === 'r' ? 'r' : '', c.key === 'no' ? 'n' : '', isActive ? 'act' : '', isEditing && editing?.error ? 'err' : '', !editable && c.edit && canEdit ? 'ro' : ''].filter(Boolean).join(' ');
              return (
                <div
                  key={c.key}
                  role="gridcell"
                  aria-colindex={ci + 1}
                  aria-readonly={!editable}
                  className={cls || undefined}
                  style={{ width: c.width, ...(c.key === 'title' ? { paddingLeft: 6 + r.depth * 16 } : null) }}
                  title={isEditing && editing?.error ? editing.error : undefined}
                  onMouseDown={(e) => {
                    if (isEditing) return;
                    e.preventDefault();
                    p.onCell(i, ci);
                  }}
                  onDoubleClick={() => (editable ? p.onEdit(i, ci) : p.onOpen(t.id))}
                >
                  {isEditing && editing ? (
                    c.key === 'crew' ? (
                      <select
                        autoFocus
                        aria-label={`Crew for ${t.title}`}
                        value={editing.draft}
                        onChange={(e) => p.onDraft(e.target.value)}
                        onKeyDown={p.onEditorKey}
                        onBlur={p.onCommit}
                      >
                        <option value="">No crew</option>
                        {crews.map((cr) => (
                          <option key={cr.id} value={cr.id}>
                            {cr.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        autoFocus
                        className={c.align === 'r' ? 'r' : undefined}
                        aria-label={`${c.label} for ${t.title}`}
                        aria-invalid={!!editing.error}
                        value={editing.draft}
                        onChange={(e) => p.onDraft(e.target.value)}
                        onKeyDown={p.onEditorKey}
                        onBlur={p.onCommit}
                        onFocus={(e) => e.currentTarget.select()}
                        maxLength={c.key === 'title' ? 200 : 300}
                      />
                    )
                  ) : c.key === 'title' ? (
                    <>
                      {r.hasChildren ? (
                        <button
                          type="button"
                          className="tw"
                          tabIndex={-1}
                          aria-label={collapsed.has(t.id) ? `Expand ${t.title}` : `Collapse ${t.title}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => p.onToggle(t.id)}
                        >
                          <Icon name={collapsed.has(t.id) ? 'right' : 'down'} />
                        </button>
                      ) : t.is_milestone ? (
                        <i className="ms" aria-label="Milestone" />
                      ) : null}
                      <span className="tt">{t.title}</span>
                    </>
                  ) : (
                    cellText(r, c.key, preds, crews, variance)
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export const GanttGrid = memo(GanttGridImpl);
