'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@meritbooks/merit-ui';
import type { MonthCloseState } from '@/lib/period/closed';
import { addMonths, fiscalYearName, monthLabel, monthShort, type MonthKey, type PeriodBasis, type PeriodContext } from '@/lib/period/resolve';
import { cellRole, fiscalYearSpan, gridMonths, isSelectable, maxFiscalYear, previewWindow } from '@/lib/period/picker-model';
import s from './period-picker.module.css';

export interface MonthGridProps {
  /** Fiscal year on show (end-year convention). */
  fiscalYear: number;
  onFiscalYear: (fy: number) => void;
  basis: PeriodBasis;
  /** The committed window (highlighted when nothing is being previewed). */
  window: { start: MonthKey; end: MonthKey };
  context: PeriodContext & { months: Record<MonthKey, MonthCloseState> };
  /** First click of a range, waiting for the second. */
  rangeAnchor: MonthKey | null;
  onPick: (month: MonthKey) => void;
  /** Focus the selected month on mount (keyboard users land in the grid). */
  autoFocus?: boolean;
}

const CLOSE_WORD: Record<MonthCloseState, string> = { closed: 'closed', soft: 'soft-closed', open: 'open' };

/**
 * 4 × 3 month grid for one fiscal year (fiscal order), with year arrows. ARIA grid with a roving
 * tab stop: arrows move a month (wrapping across years), ↑↓ a row, PageUp/PageDown a year,
 * Home/End the year's first/last month, Enter/Space picks. Future months are inert.
 */
export function MonthGrid({ fiscalYear, onFiscalYear, basis, window: win, context, rangeAnchor, onPick, autoFocus }: MonthGridProps) {
  const months = useMemo(() => gridMonths(fiscalYear, context.fyStartMonth), [fiscalYear, context.fyStartMonth]);
  const maxFy = maxFiscalYear(context);
  const [focusKey, setFocusKey] = useState<MonthKey>(() => (months.includes(win.end) ? win.end : months[0]));
  const [hover, setHover] = useState<MonthKey | null>(null);
  const refs = useRef(new Map<MonthKey, HTMLButtonElement>());
  const wantFocus = useRef(Boolean(autoFocus));

  // Keep the roving stop inside the year on show.
  useEffect(() => {
    if (!months.includes(focusKey)) setFocusKey(months.includes(win.end) ? win.end : months[0]);
  }, [months, focusKey, win.end]);

  useEffect(() => {
    if (!wantFocus.current) return;
    const el = refs.current.get(focusKey);
    if (el) {
      el.focus({ preventScroll: true });
      wantFocus.current = false;
    }
  }, [focusKey, months]);

  const move = useCallback(
    (to: MonthKey) => {
      const fyOf = (k: MonthKey) => {
        // which shown year holds k: shift the grid if k left it
        if (months.includes(k)) return fiscalYear;
        return k < months[0] ? fiscalYear - 1 : fiscalYear + 1;
      };
      const nextFy = fyOf(to);
      if (nextFy > maxFy) return;
      wantFocus.current = true;
      if (nextFy !== fiscalYear) onFiscalYear(nextFy);
      setFocusKey(to);
    },
    [months, fiscalYear, maxFy, onFiscalYear],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = focusKey;
    const at = months.indexOf(k);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        move(addMonths(k, -1));
        break;
      case 'ArrowRight':
        move(addMonths(k, 1));
        break;
      case 'ArrowUp':
        move(addMonths(k, -3));
        break;
      case 'ArrowDown':
        move(addMonths(k, 3));
        break;
      case 'PageUp':
        move(addMonths(k, -12));
        break;
      case 'PageDown':
        move(addMonths(k, 12));
        break;
      case 'Home':
        move(months[0]);
        break;
      case 'End':
        move(months[11]);
        break;
      case 'Enter':
      case ' ':
        if (at >= 0 && isSelectable(k, basis, context)) onPick(k);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const preview = hover && isSelectable(hover, basis, context) ? previewWindow(hover, basis, context, rangeAnchor) : null;
  const shown = preview ?? (rangeAnchor ? { start: rangeAnchor, end: rangeAnchor } : win);
  const fyName = fiscalYearName(fiscalYear, context.fyStartMonth);

  const rows: MonthKey[][] = [months.slice(0, 3), months.slice(3, 6), months.slice(6, 9), months.slice(9, 12)];

  return (
    <div>
      <div className={s.yearHead}>
        <Button variant="quiet" iconOnly icon="left" aria-label={`Previous fiscal year (${fiscalYearName(fiscalYear - 1, context.fyStartMonth)})`} onClick={() => onFiscalYear(fiscalYear - 1)} />
        <div className={s.yearName} aria-live="polite">
          <b>{fyName}</b>
          <small>{fiscalYearSpan(fiscalYear, context.fyStartMonth)}</small>
        </div>
        <Button
          variant="quiet"
          iconOnly
          icon="right"
          aria-label={`Next fiscal year (${fiscalYearName(fiscalYear + 1, context.fyStartMonth)})`}
          disabled={fiscalYear >= maxFy}
          onClick={() => onFiscalYear(fiscalYear + 1)}
        />
      </div>
      <div role="grid" aria-label={`Months of ${fyName}`} className={s.grid} onKeyDown={onKeyDown} onMouseLeave={() => setHover(null)} style={{ marginTop: 8 }}>
        {rows.map((row, ri) => (
          <div role="row" key={ri} className={s.gridRow}>
            {row.map((m) => {
              const ok = isSelectable(m, basis, context);
              const role = cellRole(m, shown);
              const close = context.months[m];
              const isToday = m === context.currentMonth;
              const isSel = cellRole(m, win) !== 'out';
              const cls = [
                s.cell,
                !ok ? s.cellOff : role === 'end' ? s.cellEnd : role === 'in' ? s.cellIn : '',
                preview && role !== 'out' ? s.cellPreview : '',
                rangeAnchor === m ? s.cellAnchor : '',
                isToday ? s.cellToday : '',
              ]
                .filter(Boolean)
                .join(' ');
              const desc = [monthLabel(m), close ? CLOSE_WORD[close] : null, isToday ? 'current month' : null, !ok ? 'not available yet' : null]
                .filter(Boolean)
                .join(', ');
              return (
                <div role="gridcell" key={m} aria-selected={isSel} className={s.gc}>
                  <button
                    ref={(el) => {
                      if (el) refs.current.set(m, el);
                      else refs.current.delete(m);
                    }}
                    type="button"
                    className={cls}
                    tabIndex={m === focusKey ? 0 : -1}
                    aria-disabled={!ok || undefined}
                    aria-label={desc}
                    onMouseEnter={() => setHover(m)}
                    onFocus={() => setFocusKey(m)}
                    onClick={() => ok && onPick(m)}
                  >
                    {monthShort(m)}
                    {close === 'closed' && <i className={`${s.mark} ${s.markClosed}`} aria-hidden="true" />}
                    {close === 'soft' && <i className={`${s.mark} ${s.markSoft}`} aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
