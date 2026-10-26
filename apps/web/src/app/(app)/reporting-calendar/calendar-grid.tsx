'use client';

import type { KeyboardEvent } from 'react';
import { dayName, monthName, monthShort, type CalendarCell, type CalendarResponse, type CalendarRow, type CellState } from './types';
import s from './reporting-calendar.module.css';

/** Word + class per state: every state reads without colour (word, fill, outline, hatch). */
export const CELL_WORDS: Record<CellState, { word: string; cls: string; long: string }> = {
  released: { word: 'Released', cls: s.released, long: 'Released to partners' },
  released_auto: { word: 'Auto', cls: s.releasedAuto, long: 'Released automatically' },
  ready: { word: 'Closed', cls: s.ready, long: 'Closed — not released yet' },
  soft_close: { word: 'Soft-closed', cls: s.soft, long: 'Soft-closed — can be released as preliminary' },
  withdrawn: { word: 'Withdrawn', cls: s.withdrawn, long: 'Taken back from partners' },
  open: { word: 'Open', cls: s.open, long: 'Open — still being worked' },
  not_ended: { word: 'In month', cls: s.open, long: 'The month has not ended' },
  no_period: { word: '—', cls: s.open, long: 'No fiscal period' },
  outside_group: { word: 'Before', cls: s.outside, long: 'Before the company joined the group' },
};

export function cellLabel(row: CalendarRow, cell: CalendarCell): string {
  const w = CELL_WORDS[cell.state].long;
  const auto = !cell.release.released && cell.release.autoReleaseOn ? `; releases automatically on ${dayName(cell.release.autoReleaseOn)}` : '';
  const rest = cell.restatementCount ? `; restated ${cell.restatementCount} time${cell.restatementCount === 1 ? '' : 's'}` : '';
  return `${row.name}, ${monthName(cell.key)}: ${w}${auto}${rest}`;
}

interface Props {
  calendar: CalendarResponse['calendar'];
  selected: { locationId: string; key: string } | null;
  onSelect: (row: CalendarRow, cell: CalendarCell) => void;
}

/** Arrow keys move between months and companies (a grid, not a tab stop per cell). */
function onGridKey(e: KeyboardEvent<HTMLButtonElement>) {
  const btn = e.currentTarget;
  const r = Number(btn.dataset.r);
  const c = Number(btn.dataset.c);
  const move: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
  const d = move[e.key];
  if (!d) return;
  const next = btn.closest('table')?.querySelector<HTMLButtonElement>(`button[data-r="${r + d[0]}"][data-c="${c + d[1]}"]`);
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

export function CalendarGrid({ calendar, selected, onSelect }: Props) {
  return (
    <div>
      <div className={s.gridWrap}>
        <table className={s.grid} aria-label="Release status by company and month">
          <thead>
            <tr>
              <th className={s.co} scope="col">Company</th>
              {calendar.months.map((k) => (
                <th key={k} scope="col" title={monthName(k)}>
                  {monthShort(k)}
                  {k.endsWith('-01') || k === calendar.months[0] ? <span className={s.coSub}>{k.slice(0, 4)}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendar.rows.map((row, ri) => (
              <tr key={row.locationId}>
                <th className={s.co} scope="row">
                  <span className={s.coName}>{row.name}</span>
                  <span className={s.coSub}>
                    Closed {monthName(row.closedThrough)} · Partners {monthName(row.releasedThrough)}
                    {row.hasOverride ? ' · own rule' : ''}
                  </span>
                </th>
                {row.cells.map((cell, ci) => {
                  const w = CELL_WORDS[cell.state];
                  const pressed = selected?.locationId === row.locationId && selected.key === cell.key;
                  return (
                    <td key={cell.key}>
                      <button
                        type="button"
                        className={`${s.mbtn} ${w.cls}`}
                        aria-label={cellLabel(row, cell)}
                        aria-pressed={pressed}
                        data-r={ri}
                        data-c={ci}
                        tabIndex={ri === 0 && ci === row.cells.length - 1 ? 0 : -1}
                        onKeyDown={onGridKey}
                        onClick={() => onSelect(row, cell)}
                        title={cellLabel(row, cell)}
                      >
                        <span className={s.mword}>{w.word}</span>
                        {cell.restatementCount > 0 && (
                          <span className={s.restated} aria-hidden="true">
                            R{cell.unacknowledgedRestatements ? '!' : ''}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className={s.legend} aria-hidden="true">
          <span><i className={`${s.swatch} ${s.released}`} />Released</span>
          <span><i className={`${s.swatch} ${s.releasedAuto}`} />Released automatically</span>
          <span><i className={`${s.swatch} ${s.ready}`} />Closed, not released</span>
          <span><i className={`${s.swatch} ${s.soft}`} />Soft-closed</span>
          <span><i className={`${s.swatch} ${s.outside}`} />Before joining the group</span>
          <span><b>R</b> restated · <b>R!</b> restated, not yet explained</span>
        </div>
      </div>
      <p className={s.muted} style={{ marginTop: 8 }}>
        Use the arrow keys to move between months; Enter opens a month.
      </p>
    </div>
  );
}
