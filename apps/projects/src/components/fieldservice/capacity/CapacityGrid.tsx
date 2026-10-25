'use client';

import { shortDate } from '@meritbooks/merit-ui';
import { cellLabel, cellState, clock } from '@/lib/fieldservice/booking';
import type { CapacityCell, WindowRow } from '@/lib/fieldservice/types';

export interface CapacityPick {
  day: string;
  windowId: string;
}

export interface CapacityGridProps {
  cells: ReadonlyArray<CapacityCell>;
  windows: ReadonlyArray<WindowRow>;
  businessUnitId: string | null;
  days: ReadonlyArray<string>;
  today: string;
  value?: CapacityPick | null;
  onPick?: (p: CapacityPick) => void;
  /** A dispatcher may pick a full cell (booking then asks for an override reason). */
  allowFull?: boolean;
  caption?: string;
}

const WORD: Record<ReturnType<typeof cellState>, string> = { open: 'Open', tight: 'Last slot', full: 'Full', unlimited: 'No limit', closed: 'Closed' };

/**
 * Capacity by arrival window for one business unit (FS-15): days down, windows across. Every cell
 * says its state in words (never colour alone) and how many are booked against the limit.
 */
export function CapacityGrid({ cells, windows, businessUnitId, days, today, value, onPick, allowFull, caption }: CapacityGridProps) {
  const ws = windows.filter((w) => w.is_active);
  const byKey = new Map(cells.filter((c) => c.business_unit_id === businessUnitId).map((c) => [`${c.service_day}|${c.arrival_window_id}`, c]));
  if (!businessUnitId) return <p className="t-cap">Pick the business unit to see open windows.</p>;
  if (!ws.length) return <p className="t-cap">No arrival windows yet. Add them under Dispatch → Capacity.</p>;
  return (
    <div className="fs-cap" role="grid" aria-label={caption ?? 'Capacity by arrival window'} style={{ ['--cols' as string]: ws.length }}>
      <div className="fs-cap-row" role="row">
        <span className="fs-cap-h" role="columnheader">Day</span>
        {ws.map((w) => (
          <span key={w.id} className="fs-cap-h" role="columnheader">{w.label}<br /><span className="fs-muted">{clock(w.start_time)}–{clock(w.end_time)}</span></span>
        ))}
      </div>
      {days.map((d) => (
        <div key={d} className="fs-cap-row" role="row">
          <span className="fs-cap-h" role="rowheader">{d === today ? 'Today' : shortDate(d, today)}</span>
          {ws.map((w) => {
            const c = byKey.get(`${d}|${w.id}`);
            if (!c) {
              return <span key={w.id} className="fs-cap-cell fs-cap-cell--closed" role="gridcell" aria-label={`${w.label} not offered`}>Not offered</span>;
            }
            const st = cellState(c);
            const picked = value?.day === d && value.windowId === w.id;
            const disabled = !onPick || (st === 'full' && !allowFull);
            return (
              <button
                key={w.id}
                type="button"
                role="gridcell"
                className={`fs-cap-cell fs-cap-cell--${st}`}
                aria-pressed={picked}
                disabled={disabled}
                onClick={() => onPick?.({ day: d, windowId: w.id })}
                aria-label={`${d} ${w.label}: ${WORD[st]}, ${cellLabel(c)}`}
              >
                <span className="l1 b" style={{ display: 'block' }}>{WORD[st]}</span>
                <span className="l2 tnum">{cellLabel(c)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
