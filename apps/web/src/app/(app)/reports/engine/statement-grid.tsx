'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@meritbooks/merit-ui';
import { formatCell, isNonMoneyRow, isPercentColumn, ROUNDING_UNIT_LABEL } from '@/lib/reports/engine/format';
import type { DrillScope, ReportColumn, ReportResult, ReportRow } from '@/lib/reports/engine/types';
import s from './engine.module.css';

export interface CellDrill {
  row: ReportRow;
  column: ReportColumn;
  scope: DrillScope;
  value: number;
}

/** The drill scope for one cell, or null when the cell is not drillable. */
export function cellScope(row: ReportRow, col: ReportColumn, i: number): DrillScope | null {
  if (!row.accountIds?.length) return null;
  if (isNonMoneyRow(row) || isPercentColumn(col) || col.kind === 'variance_amount') return null;
  const override = row.cellDrill?.[i];
  if (row.cellDrill) return override ?? null;
  return col.drill ?? null;
}

function rowClass(r: ReportRow): string {
  switch (r.kind) {
    case 'header': return s.rHead;
    case 'spacer': return s.rSpacer;
    case 'group': return s.rGroup;
    case 'subtotal': return s.rSub;
    case 'total': return s.rTotal;
    case 'formula': return s.rFormula;
    case 'check': return s.rCheck;
    default: return r.synthetic ? s.rSynthetic : '';
  }
}

function cellText(r: ReportRow, c: ReportColumn, v: number | null, rounding: ReportResult['rounding']): string {
  return formatCell(r, c, v, rounding);
}

export interface StatementGridProps {
  result: ReportResult;
  onDrill: (d: CellDrill) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (rowId: string) => void;
}

/**
 * The statement table: sticky header + first column, collapsible groups, every account
 * cell a drill button. Keyboard: j / k (or ↓ ↑) move between rows, Enter drills the
 * current period cell, ← / → collapse / expand a group, [ / ] collapse / expand all
 * (handled by the viewer).
 */
export function StatementGrid({ result, onDrill, collapsed, onToggle }: StatementGridProps) {
  const { columns, rows, rounding } = result;
  const hidden = useMemo(() => {
    const out = new Set<string>();
    for (const r of rows) if (r.parentId && (collapsed.has(r.parentId) || out.has(r.parentId))) out.add(r.id);
    return out;
  }, [rows, collapsed]);
  const visible = useMemo(() => rows.filter((r) => !hidden.has(r.id)), [rows, hidden]);
  const hasChildren = useMemo(() => new Set(rows.filter((r) => r.parentId).map((r) => r.parentId as string)), [rows]);
  const focusable = useMemo(() => visible.filter((r) => r.kind !== 'header' && r.kind !== 'spacer'), [visible]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const currentIdx = useMemo(() => {
    const i = columns.findIndex((c) => c.current);
    return i >= 0 ? i : columns.findIndex((c) => c.kind === 'amount' || c.kind === 'total');
  }, [columns]);

  useEffect(() => {
    if (focusId && !focusable.some((r) => r.id === focusId)) setFocusId(null);
  }, [focusable, focusId]);

  const move = useCallback((delta: number) => {
    if (!focusable.length) return;
    const i = focusId ? focusable.findIndex((r) => r.id === focusId) : -1;
    const next = focusable[Math.max(0, Math.min(focusable.length - 1, i + delta))];
    setFocusId(next.id);
    wrapRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusable, focusId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && focusId && hasChildren.has(focusId)) {
      const isCollapsed = collapsed.has(focusId);
      if ((e.key === 'ArrowLeft') !== isCollapsed) { e.preventDefault(); onToggle(focusId); }
    } else if (e.key === 'Enter' && focusId) {
      const r = rows.find((x) => x.id === focusId);
      const c = columns[currentIdx];
      if (r && c) {
        const sc = cellScope(r, c, currentIdx);
        const v = r.values[currentIdx];
        if (sc && v != null) { e.preventDefault(); onDrill({ row: r, column: c, scope: sc, value: v }); }
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      className={s.gridWrap}
      tabIndex={0}
      role="region"
      aria-label={`${result.title} — use j and k to move between rows, Enter to open the lines behind a figure`}
      onKeyDown={onKeyDown}
    >
      <table className={s.grid} aria-label={result.title}>
        <thead>
          <tr>
            <th scope="col" className={s.lbl}>{ROUNDING_UNIT_LABEL[rounding]}</th>
            {columns.map((c) => (
              <th key={c.id} scope="col" className={c.current ? s.cur : undefined} title={c.status === 'preliminary' ? 'Preliminary — the period is not hard-closed' : c.status === 'partial' ? 'In progress — the period has not ended' : undefined}>
                {c.label}
                {(c.status === 'preliminary' || c.status === 'partial') && <span className={s.statusP} aria-label={c.status === 'partial' ? 'in progress' : 'preliminary'}>{c.status === 'partial' ? '*' : 'P'}</span>}
                {c.sublabel && <span className={s.sub}>{c.sublabel}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const isParent = hasChildren.has(r.id);
            const indent = r.depth >= 3 ? s.indent3 : r.depth === 2 ? s.indent2 : r.depth === 1 ? s.indent1 : '';
            if (r.kind === 'spacer') return <tr key={r.id} className={s.rSpacer} aria-hidden="true"><td className={s.lbl} /><td colSpan={columns.length} /></tr>;
            return (
              <tr
                key={r.id}
                data-row={r.id}
                className={`${rowClass(r)} ${focusId === r.id ? s.focused : ''}`}
                onClick={() => r.kind !== 'header' && setFocusId(r.id)}
                aria-selected={focusId === r.id || undefined}
              >
                <td className={`${s.lbl} ${indent}`} title={r.label}>
                  {isParent ? (
                    <button type="button" className={s.tw} aria-expanded={!collapsed.has(r.id)} aria-label={`${collapsed.has(r.id) ? 'Expand' : 'Collapse'} ${r.label}`} onClick={(e) => { e.stopPropagation(); onToggle(r.id); }}>
                      <Icon name={collapsed.has(r.id) ? 'right' : 'down'} />
                    </button>
                  ) : r.kind !== 'header' && r.depth > 0 ? <span className={s.twSpace} /> : null}
                  {r.label}
                </td>
                {r.kind === 'header'
                  ? <td colSpan={columns.length} />
                  : columns.map((c, i) => {
                      const v = r.values[i];
                      const text = cellText(r, c, v, rounding);
                      const sc = v != null && v !== 0 ? cellScope(r, c, i) : null;
                      const fu = r.fu?.[i];
                      return (
                        <td key={c.id} className={`num ${c.current ? s.cur : ''}`}>
                          {sc ? (
                            <button
                              type="button"
                              className={s.cellBtn}
                              aria-label={`${r.label}, ${c.label}: ${text}. Open the lines.`}
                              onClick={(e) => { e.stopPropagation(); setFocusId(r.id); onDrill({ row: r, column: c, scope: sc, value: v as number }); }}
                            >
                              {text}
                            </button>
                          ) : text}
                          {fu && <span className={`${s.fu} ${fu === 'F' ? s.fuF : s.fuU}`} aria-label={fu === 'F' ? 'favorable' : 'unfavorable'}>{fu}</span>}
                        </td>
                      );
                    })}
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr><td className={s.lbl} colSpan={columns.length + 1}>Nothing to show.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
