'use client';

/**
 * Budget grid editor (Wave 4B, AC-B20): department × account × month. Keyboard first —
 * arrows / Tab / Enter / Home / End move, typing or Enter / F2 edits, Enter commits and moves down,
 * Esc cancels, Ctrl/⌘+V pastes a block copied from Excel at the cursor. Edits are kept as dirty
 * cents until the parent saves them; a locked grid renders read-only.
 */
import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { moveCursor, parseCellToCents, parsePasteBlock, pasteEdits, type GridPos } from '@/lib/budgets/grid';
import { DRIVER_METHOD_LABEL, type GridRow } from '@/lib/budgets/types';
import { MONTH_LABELS, SECTION_LABEL, SECTION_OF_TYPE, centsToInput, gridMoney, pctText } from './budget-format';
import s from './budgets.module.css';

/** 12 months + adjustments (period 13). */
export const EDIT_COLS = 13;

export type DirtyMap = ReadonlyMap<string, number>;

export function dirtyKey(rowKey: string, period: number): string {
  return `${rowKey}#${period}`;
}

/** The row's 13 values with unsaved edits applied (index 12 = adjustments). */
export function effectiveValues(row: GridRow, dirty: DirtyMap): number[] {
  const base = [...row.months, row.adjustmentsCents];
  return base.map((v, i) => dirty.get(dirtyKey(row.key, i + 1)) ?? v);
}

export type RowAction = 'fill' | 'grow' | 'driver' | 'comment';

export interface BudgetGridProps {
  rows: readonly GridRow[];
  dirty: DirtyMap;
  editable: boolean;
  onEdit: (edits: Array<{ rowKey: string; period: number; cents: number }>) => void;
  onRowAction: (rowKey: string, action: RowAction, fromPeriod: number) => void;
  /** Announced in the live region ("Pasted 24 cells"). */
  onAnnounce?: (msg: string) => void;
  /** Months (1..12) whose fiscal period is closed — read-only even in an editable grid. */
  closedPeriods?: readonly number[];
}

type Section = 'revenue' | 'cogs' | 'opex' | 'other';
const ORDER: readonly Section[] = ['revenue', 'cogs', 'opex', 'other'];

export function BudgetGrid({ rows, dirty, editable, onEdit, onRowAction, onAnnounce, closedPeriods }: BudgetGridProps) {
  const closed = useMemo(() => new Set(closedPeriods ?? []), [closedPeriods]);
  /** May this column (0-based) change? A closed month never does (mig 189 BUDGET_PERIOD_CLOSED). */
  const colEditable = useCallback((c: number) => editable && !closed.has(c + 1), [editable, closed]);
  const ordered = useMemo(
    () => [...rows].sort((a, b) => ORDER.indexOf(SECTION_OF_TYPE[a.accountType] ?? 'other') - ORDER.indexOf(SECTION_OF_TYPE[b.accountType] ?? 'other') || a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true })),
    [rows],
  );
  const [cursor, setCursor] = useState<GridPos>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ text: string } | null>(null);
  const [badInput, setBadInput] = useState(false);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const focusCell = useCallback((p: GridPos) => {
    setCursor(p);
    requestAnimationFrame(() => cellRefs.current.get(`${p.row}:${p.col}`)?.focus());
  }, []);

  const values = useMemo(() => ordered.map((r) => effectiveValues(r, dirty)), [ordered, dirty]);

  const commit = (text: string, then: string | null, shift = false) => {
    const row = ordered[cursor.row];
    if (!row) return;
    const cents = parseCellToCents(text);
    if (cents === null) {
      setBadInput(true);
      onAnnounce?.('That isn’t a number — the cell was not changed.');
      return;
    }
    setBadInput(false);
    setEditing(null);
    if (cents !== values[cursor.row][cursor.col]) onEdit([{ rowKey: row.key, period: cursor.col + 1, cents }]);
    if (then) focusCell(moveCursor(cursor, then, ordered.length, EDIT_COLS, shift));
    else focusCell(cursor);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'];
    if (nav.includes(e.key)) {
      if (e.key === 'Tab' && ((cursor.row === ordered.length - 1 && cursor.col === EDIT_COLS - 1 && !e.shiftKey) || (cursor.row === 0 && cursor.col === 0 && e.shiftKey))) return;
      e.preventDefault();
      focusCell(moveCursor(cursor, e.key, ordered.length, EDIT_COLS, e.shiftKey));
      return;
    }
    if (!colEditable(cursor.col)) {
      if (editable && closed.has(cursor.col + 1) && (e.key === 'Enter' || e.key === 'F2' || e.key === 'Delete' || e.key === 'Backspace')) onAnnounce?.('That month is closed — its budget can’t change.');
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      setEditing({ text: centsToInput(values[cursor.row]?.[cursor.col] ?? 0) });
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const row = ordered[cursor.row];
      if (row) onEdit([{ rowKey: row.key, period: cursor.col + 1, cents: 0 }]);
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[0-9.\-($]$/.test(e.key)) {
      e.preventDefault();
      setEditing({ text: e.key });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !editable) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const block = parsePasteBlock(text);
    const all = pasteEdits(block, cursor, ordered.length, EDIT_COLS);
    const edits = all.filter((x) => colEditable(x.col)).map((x) => ({ rowKey: ordered[x.row].key, period: x.col + 1, cents: x.cents }));
    const skippedClosed = all.length - edits.length;
    if (edits.length) onEdit(edits);
    onAnnounce?.(`Pasted ${edits.length} cell${edits.length === 1 ? '' : 's'}${block.invalid ? ` · ${block.invalid} not a number, skipped` : ''}${skippedClosed ? ` · ${skippedClosed} in closed months, skipped` : ''}.`);
  };

  const sections = ORDER.map((sec) => ({ sec, idx: ordered.map((r, i) => ({ r, i })).filter((x) => (SECTION_OF_TYPE[x.r.accountType] ?? 'other') === sec) })).filter((g) => g.idx.length > 0);
  const colTotals = (idx: number[]) => Array.from({ length: EDIT_COLS }, (_, c) => idx.reduce((t, i) => t + values[i][c], 0));
  const totalOf = (vals: number[]) => vals.reduce((t, v) => t + v, 0);
  const isIncome = (sec: Section) => sec === 'revenue';
  // Net row: income − everything else (other is treated as expense here; the BvA splits it exactly).
  const netCols = Array.from({ length: EDIT_COLS }, (_, c) => ordered.reduce((t, r, i) => t + (isIncome(SECTION_OF_TYPE[r.accountType] ?? 'other') ? values[i][c] : -values[i][c]), 0));
  const netPy = ordered.reduce((t, r) => t + (isIncome(SECTION_OF_TYPE[r.accountType] ?? 'other') ? r.pyActualCents : -r.pyActualCents), 0);
  let ariaRow = 1;

  return (
    <div className={s.gridWrap} role="grid" aria-label="Budget by account and month" aria-rowcount={ordered.length + sections.length * 2 + 2} aria-colcount={EDIT_COLS + 4} aria-readonly={!editable} onKeyDown={onGridKey} onPaste={onPaste}>
      <table className={s.grid} role="presentation">
        <thead>
          <tr role="row" aria-rowindex={ariaRow++}>
            <th className={s.acct} role="columnheader" aria-colindex={1}>Account</th>
            {MONTH_LABELS.map((m, i) => (
              <th key={m} className={s.num} role="columnheader" aria-colindex={i + 2} title={closed.has(i + 1) ? `${m} is closed — its budget can’t change` : undefined}>
                {m}{closed.has(i + 1) && <span className={s.muted}> · closed</span>}
              </th>
            ))}
            <th className={s.num} role="columnheader" aria-colindex={14} title="Period 13 — year-end adjustments">Adj</th>
            <th className={s.num} role="columnheader" aria-colindex={15}>Total</th>
            <th className={s.num} role="columnheader" aria-colindex={16}>Last year</th>
            <th className={s.num} role="columnheader" aria-colindex={17}>Δ%</th>
          </tr>
        </thead>
        <tbody>
          {sections.map(({ sec, idx }) => {
            const sub = colTotals(idx.map((x) => x.i));
            const subPy = idx.reduce((t, x) => t + x.r.pyActualCents, 0);
            return (
              <SectionRows key={sec}>
                <tr className={s.sectionRow} role="row" aria-rowindex={ariaRow++}>
                  <th className={s.acct} role="rowheader" colSpan={1}>{SECTION_LABEL[sec]}</th>
                  <td colSpan={EDIT_COLS + 3} />
                </tr>
                {idx.map(({ r, i }) => {
                  const vals = values[i];
                  const total = totalOf(vals);
                  const rowIndex = ariaRow++;
                  return (
                    <tr key={r.key} role="row" aria-rowindex={rowIndex}>
                      <th className={s.acct} role="rowheader" scope="row">
                        <span className={s.acctName} title={`${r.accountNumber} ${r.accountName}`}>
                          {r.accountNumber} {r.accountName}
                          {r.driver && r.driver.method !== 'MANUAL' && <span className={s.driverTag} title={DRIVER_METHOD_LABEL[r.driver.method]}>driver</span>}
                        </span>
                        <span className={s.acctSub}>
                          {r.groupName ?? ''}
                          <span className={s.rowActions}>
                            {editable && <button type="button" className={s.iconBtn} onClick={() => onRowAction(r.key, 'fill', cursor.row === i ? cursor.col + 1 : 1)} title="Copy the focused month into every later month">Fill →</button>}
                            {editable && <button type="button" className={s.iconBtn} onClick={() => onRowAction(r.key, 'grow', 1)} title="Apply a % change to the whole row">± %</button>}
                            <button type="button" className={s.iconBtn} onClick={() => onRowAction(r.key, 'driver', 1)} title="Build this row from a driver">Driver</button>
                            <button type="button" className={s.iconBtn} onClick={() => onRowAction(r.key, 'comment', 1)} title="Comments on this line">{r.comments ? `Notes ${r.comments}` : 'Notes'}</button>
                          </span>
                        </span>
                      </th>
                      {vals.map((v, c) => {
                        const isCur = cursor.row === i && cursor.col === c;
                        const isDirty = dirty.has(dirtyKey(r.key, c + 1));
                        if (isCur && editing) {
                          return (
                            <td key={c} className={s.numCell} role="gridcell" aria-colindex={c + 2}>
                              <input
                                autoFocus
                                className={s.cellInput}
                                aria-label={`${r.accountName}, ${c < 12 ? MONTH_LABELS[c] : 'Adjustments'}`}
                                aria-invalid={badInput || undefined}
                                value={editing.text}
                                inputMode="decimal"
                                onChange={(e) => setEditing({ text: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); commit(editing.text, 'Enter', e.shiftKey); }
                                  else if (e.key === 'Tab') { e.preventDefault(); commit(editing.text, 'Tab', e.shiftKey); }
                                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); setBadInput(false); focusCell(cursor); }
                                  e.stopPropagation();
                                }}
                                onBlur={() => editing && commit(editing.text, null)}
                              />
                            </td>
                          );
                        }
                        return (
                          <td key={c} className={s.numCell} role="gridcell" aria-colindex={c + 2} aria-selected={isCur}>
                            <button
                              type="button"
                              ref={(el) => {
                                if (el) cellRefs.current.set(`${i}:${c}`, el);
                                else cellRefs.current.delete(`${i}:${c}`);
                              }}
                              tabIndex={isCur ? 0 : -1}
                              aria-readonly={!colEditable(c)}
                              aria-label={`${r.accountName}, ${c < 12 ? MONTH_LABELS[c] : 'Adjustments'}: ${gridMoney(v)}${isDirty ? ' (unsaved)' : ''}${editable && closed.has(c + 1) ? ' (closed month)' : ''}`}
                              className={[s.cellBtn, isCur ? s.isCursor : '', isDirty ? s.isDirty : ''].join(' ')}
                              onClick={() => setCursor({ row: i, col: c })}
                              onDoubleClick={() => colEditable(c) && (setCursor({ row: i, col: c }), setEditing({ text: centsToInput(v) }))}
                            >
                              {gridMoney(v)}
                            </button>
                          </td>
                        );
                      })}
                      <td className={`${s.num} ${s.total}`} role="gridcell">{gridMoney(total)}</td>
                      <td className={`${s.num} ${s.muted}`} role="gridcell">{gridMoney(r.pyActualCents)}</td>
                      <td className={s.num} role="gridcell">{r.pyActualCents === 0 ? '—' : pctText((total - r.pyActualCents) / Math.abs(r.pyActualCents))}</td>
                    </tr>
                  );
                })}
                <tr className={s.sectionRow} role="row" aria-rowindex={ariaRow++}>
                  <th className={s.acct} role="rowheader">Total {SECTION_LABEL[sec].toLowerCase()}</th>
                  {sub.map((v, c) => <td key={c} className={s.num} role="gridcell">{gridMoney(v)}</td>)}
                  <td className={s.num} role="gridcell">{gridMoney(totalOf(sub))}</td>
                  <td className={s.num} role="gridcell">{gridMoney(subPy)}</td>
                  <td className={s.num} role="gridcell">{subPy === 0 ? '—' : pctText((totalOf(sub) - subPy) / Math.abs(subPy))}</td>
                </tr>
              </SectionRows>
            );
          })}
          {ordered.length > 0 && (
            <tr className={s.grandRow} role="row" aria-rowindex={ariaRow++}>
              <th className={s.acct} role="rowheader">{sections.some((x) => x.sec === 'revenue') ? 'Net contribution' : 'Net (spend shown negative)'}</th>
              {netCols.map((v, c) => <td key={c} className={s.num} role="gridcell">{gridMoney(v)}</td>)}
              <td className={s.num} role="gridcell">{gridMoney(totalOf(netCols))}</td>
              <td className={s.num} role="gridcell">{gridMoney(netPy)}</td>
              <td className={s.num} role="gridcell">{netPy === 0 ? '—' : pctText((totalOf(netCols) - netPy) / Math.abs(netPy))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
