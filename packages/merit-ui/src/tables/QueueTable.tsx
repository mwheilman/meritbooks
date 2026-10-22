'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';
import { useHotkey, useHotkeyRegistry } from '../hotkeys/HotkeyProvider';
import { Button } from '../primitives/Button';
import { Check } from '../primitives/Choice';
import { joinSl } from '../primitives/Text';

export interface QueueColumn<T> {
  id: string;
  header: ReactNode;
  /** Column width (colgroup): number = px. */
  width?: number | string;
  /** Right-align as a figure (.n). */
  numeric?: boolean;
  cell: (row: T) => ReactNode;
  /** Sortable header: Electric label with caret. */
  sort?: { direction: 'asc' | 'desc' | null; onToggle: () => void; label?: string };
  className?: string;
}

export interface QueueGroup<T> {
  id: string;
  /** Tracked caps on Canvas: "Decide". */
  title: ReactNode;
  /** The group's count (tabular, 600) — defaults to rows.length. */
  count?: ReactNode;
  /** "Under 70, or the AI has a question". */
  caption?: ReactNode;
  rows: ReadonlyArray<T>;
}

export interface QueueRowState {
  /** 45% opacity — approved/posted this session. */
  done?: boolean;
  /** 3px brick left inset — needs attention. */
  attn?: boolean;
}

export interface QueueAction<T> {
  /** Single key: "a", "e", "f", "q". */
  key: string;
  label: string;
  /** Rows it acts on: the selection if any, else the cursor row. */
  run: (rows: T[]) => void;
}

export interface QueueTableProps<T> {
  /** Accessible name: "Heartland Heating & Cooling, change orders to review". */
  'aria-label': string;
  columns: ReadonlyArray<QueueColumn<T>>;
  /** Grouped rows (bands) … */
  groups?: ReadonlyArray<QueueGroup<T>>;
  /** … or a flat list. */
  rows?: ReadonlyArray<T>;
  getRowId: (row: T) => string;
  rowState?: (row: T) => QueueRowState;

  /** Show the select column and enable X / bulk bar. */
  selectable?: boolean;
  /** Controlled selection (row ids). */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;

  /** Controlled cursor (row id). The cursor is NOT the selection. */
  cursorId?: string | null;
  onCursorChange?: (id: string | null, row: T | null) => void;

  /** Enter / double-click. */
  onOpen?: (row: T) => void;
  /** Open the row on a single click (default: click moves the cursor, double-click/Enter opens). */
  openOnClick?: boolean;
  /** Single-key verbs (A approve, E edit, F flag …). */
  actions?: ReadonlyArray<QueueAction<T>>;

  /** Bulk bar: "3 selected // Ready band // (15,461.30)". */
  bulkSummary?: (rows: T[]) => ReadonlyArray<ReactNode>;
  /** Bulk verbs (one primary). */
  bulkActions?: (rows: T[]) => ReactNode;

  /** 40px rows. */
  compact?: boolean;
  /** 16px side padding (inside a widget). */
  flush?: boolean;
  /** Bind J/K/X/Esc/Enter and action keys (default true). One live queue per page. */
  hotkeys?: boolean;
  className?: string;
}

/**
 * .tbl.tbl-q — the dense queue. 48px rows, sticky header, groups on Canvas.
 * Hover Grey-100 · selected = Sky · cursor = white + 3px Electric inset +
 * 1px ring (painted on cells for WebKit, see next-adapter.css) · done 45% ·
 * attention = brick inset. Cursor and selection never look the same.
 *
 * Keys (through the one registry): J/K or ↓/↑ move · X select · ↵ open ·
 * action keys · Esc clears the selection.
 */
export function QueueTable<T>({
  columns,
  groups,
  rows,
  getRowId,
  rowState,
  selectable = false,
  selected,
  onSelectedChange,
  cursorId,
  onCursorChange,
  onOpen,
  openOnClick = false,
  actions = [],
  bulkSummary,
  bulkActions,
  compact,
  flush,
  hotkeys = true,
  className,
  ...aria
}: QueueTableProps<T>) {
  const uid = useId();
  const blocks: ReadonlyArray<QueueGroup<T>> = useMemo(() => groups ?? [{ id: 'all', title: null, rows: rows ?? [] }], [groups, rows]);
  const flat = useMemo(() => blocks.flatMap((g) => g.rows), [blocks]);
  const ids = useMemo(() => flat.map(getRowId), [flat, getRowId]);

  // Uncontrolled fallbacks.
  const [ownSel, setOwnSel] = useState<Set<string>>(() => new Set());
  const sel = selected ?? ownSel;
  const setSel = useCallback(
    (next: Set<string>) => {
      if (onSelectedChange) onSelectedChange(next);
      if (selected === undefined) setOwnSel(next);
    },
    [onSelectedChange, selected],
  );
  const [ownCursor, setOwnCursor] = useState<string | null>(null);
  const cursor = cursorId !== undefined ? cursorId : ownCursor;
  const setCursor = useCallback(
    (id: string | null) => {
      if (cursorId === undefined) setOwnCursor(id);
      const idx = id == null ? -1 : ids.indexOf(id);
      onCursorChange?.(id, idx >= 0 ? (flat[idx] as T) : null);
    },
    [cursorId, ids, flat, onCursorChange],
  );

  // Drop a cursor that no longer exists (row approved and removed).
  useEffect(() => {
    if (cursor != null && !ids.includes(cursor)) setCursor(ids[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|')]);

  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    if (cursor) rowRefs.current.get(cursor)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const move = (delta: number) => {
    if (ids.length === 0) return;
    const i = cursor == null ? -1 : ids.indexOf(cursor);
    const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + delta));
    setCursor(ids[next] ?? null);
  };
  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  };
  const cursorRow = cursor == null ? null : (flat[ids.indexOf(cursor)] ?? null);
  const selectedRows = useMemo(() => flat.filter((r) => sel.has(getRowId(r))), [flat, sel, getRowId]);
  const targets = (): T[] => (selectedRows.length > 0 ? selectedRows : cursorRow ? [cursorRow] : []);

  // Arrows and Enter act only when focus is on the table (or nowhere), so a
  // focused button keeps its own Enter and the page keeps arrow scrolling.
  const tableRef = useRef<HTMLTableElement>(null);
  const focusHere = () => {
    if (typeof document === 'undefined') return true;
    const a = document.activeElement;
    return a == null || a === document.body || (tableRef.current?.contains(a) ?? false);
  };
  const on = hotkeys && flat.length > 0;
  useHotkey('j', () => move(1), { enabled: on, owner: 'QueueTable', description: 'Next row' });
  useHotkey('k', () => move(-1), { enabled: on, owner: 'QueueTable', description: 'Previous row' });
  useHotkey('arrowdown', () => move(1), { enabled: on, when: focusHere, owner: 'QueueTable' });
  useHotkey('arrowup', () => move(-1), { enabled: on, when: focusHere, owner: 'QueueTable' });
  useHotkey('x', () => (cursor ? toggle(cursor) : false), { enabled: on && selectable, owner: 'QueueTable', description: 'Select row' });
  useHotkey('enter', () => (cursorRow && onOpen ? onOpen(cursorRow) : false), { enabled: on && !!onOpen, when: focusHere, owner: 'QueueTable', description: 'Open row' });
  useHotkey('escape', () => (sel.size > 0 ? setSel(new Set()) : false), { enabled: hotkeys && selectable, owner: 'QueueTable', description: 'Clear selection' });

  // Action keys (A approve, E edit …) — registered together, re-registered
  // only when the key list changes; the latest handlers are read via a ref.
  const registry = useHotkeyRegistry();
  const latest = useRef({ actions, targets });
  latest.current = { actions, targets };
  const actionKeys = actions.map((a) => a.key).join(',');
  useEffect(() => {
    if (!on || !actionKeys) return undefined;
    const offs = actionKeys.split(',').map((key) =>
      registry.register({
        chord: key,
        owner: 'QueueTable',
        description: latest.current.actions.find((a) => a.key === key)?.label,
        handler: () => {
          const a = latest.current.actions.find((x) => x.key === key);
          const rows = latest.current.targets();
          if (!a || rows.length === 0) return false;
          a.run(rows);
          return true;
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, [registry, on, actionKeys]);

  const allIds = ids;
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => sel.has(id));
  const someSelected = selectable && !allSelected && allIds.some((id) => sel.has(id));
  const colCount = columns.length + (selectable ? 1 : 0);

  return (
    <>
      {selectable && selectedRows.length > 0 && (
        <div className="bulk" role="status">
          {joinSl([<b key="n"><span className="tnum">{selectedRows.length}</span> selected</b>, ...(bulkSummary?.(selectedRows) ?? [])])}
          <span className="sp" />
          {bulkActions?.(selectedRows)}
          <Button variant="quiet" chord="escape" onClick={() => setSel(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <table
        ref={tableRef}
        className={cx('tbl', 'tbl-q', compact && 'tbl-q--compact', flush && 'tbl-q--flush', className)}
        role="grid"
        aria-label={aria['aria-label']}
        aria-multiselectable={selectable || undefined}
        aria-activedescendant={cursor ? `${uid}-r-${cursor}` : undefined}
        tabIndex={0}
      >
        <colgroup>
          {selectable && <col style={{ width: 56 }} />}
          {columns.map((c) => (
            <col key={c.id} style={c.width != null ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <th scope="col">
                <Check
                  aria-label="Select all"
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={() => setSel(allSelected ? new Set() : new Set(allIds))}
                />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                className={cx(c.numeric && 'n', c.className)}
                aria-sort={c.sort?.direction === 'asc' ? 'ascending' : c.sort?.direction === 'desc' ? 'descending' : undefined}
              >
                {c.sort ? (
                  <button className="th-sort" type="button" onClick={c.sort.onToggle} aria-label={c.sort.label}>
                    {c.header}
                    {c.sort.direction === 'asc' ? ' ↑' : c.sort.direction === 'desc' ? ' ↓' : ''}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((g) => (
            <QueueBlock key={g.id} group={g} colCount={colCount} showHeader={groups != null}>
              {g.rows.map((r) => {
                const id = getRowId(r);
                const st = rowState?.(r) ?? {};
                const isSel = sel.has(id);
                return (
                  <tr
                    key={id}
                    id={`${uid}-r-${id}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(id, el);
                      else rowRefs.current.delete(id);
                    }}
                    className={cx('q-row', isSel && 'is-selected', cursor === id && 'is-cursor', st.done && 'is-done', st.attn && 'is-attn')}
                    aria-selected={selectable ? isSel : undefined}
                    onClick={(e) => {
                      setCursor(id);
                      // One click opens the row (users expect it); modifier-clicks and clicks on
                      // links, buttons or inputs inside the row keep their own behavior.
                      if (!onOpen || !openOnClick || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      const t = e.target as HTMLElement;
                      if (t.closest('a,button,input,select,textarea,label,[role="checkbox"]')) return;
                      onOpen(r);
                    }}
                    onDoubleClick={() => { if (!openOnClick) onOpen?.(r); }}
                    style={onOpen && openOnClick ? { cursor: 'pointer' } : undefined}
                  >
                    {selectable && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <Check aria-label="Select row" checked={isSel} onChange={() => toggle(id)} />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.id} className={cx(c.numeric && 'n', c.className)}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </QueueBlock>
          ))}
        </tbody>
      </table>
    </>
  );
}

function QueueBlock<T>({ group, colCount, showHeader, children }: { group: QueueGroup<T>; colCount: number; showHeader: boolean; children: ReactNode }) {
  return (
    <>
      {showHeader && group.rows.length > 0 && (
        <tr className="q-group">
          <td colSpan={colCount}>
            <span className="q-group-t">{group.title}</span>
            <span className="tnum b">{group.count ?? group.rows.length}</span>
            {group.caption != null && (
              <span className="ink-3" style={{ marginLeft: 12 }}>
                {group.caption}
              </span>
            )}
          </td>
        </tr>
      )}
      {children}
    </>
  );
}

export interface BulkBarProps {
  count: number;
  /** "Ready band", "(15,461.30)". */
  summary?: ReadonlyArray<ReactNode>;
  children?: ReactNode;
  onClear: () => void;
}

/** .bulk — standalone bulk bar (QueueTable renders its own when selectable). */
export function BulkBar({ count, summary = [], children, onClear }: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="bulk" role="status">
      {joinSl([<b key="n"><span className="tnum">{count}</span> selected</b>, ...summary])}
      <span className="sp" />
      {children}
      <Button variant="quiet" chord="escape" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
