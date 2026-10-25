import Link from 'next/link';
import { count } from '@meritbooks/merit-ui';
import { cellLabel, cellState } from '@/lib/fieldservice/booking';
import type { BusinessUnitRow, CapacityCell, OnCallRow, TechEventRow, WindowRow } from '@/lib/fieldservice/types';
import { stamp } from '@/lib/time';

const WORD = { open: 'Open', tight: 'Last slot', full: 'Full', unlimited: 'No limit', closed: 'Closed' } as const;

/**
 * Above the dispatch board (FS-14/15/18): capacity used per business unit × arrival window for the
 * day, who is on call, and who is blocked (time off / training) — with the doors to the call desk,
 * capacity setup and scorecards. Server-rendered.
 */
export function DispatchFieldStrip({ cells, businessUnits, windows, onCall, events, employees, day }: {
  cells: CapacityCell[]; businessUnits: BusinessUnitRow[]; windows: WindowRow[]; onCall: OnCallRow[]; events: TechEventRow[];
  employees: Record<string, string>; day: string;
}) {
  const ws = windows.filter((w) => w.is_active);
  const bus = businessUnits.filter((b) => b.is_active && cells.some((c) => c.business_unit_id === b.id));
  return (
    <section className="fs-card" aria-label="Capacity and availability" style={{ marginBottom: 16 }}>
      <div className="fs-card-h">
        <h2 className="t-section">Capacity // {day}</h2><span className="sp" />
        <Link className="link t-cap" href="/calls">Call desk</Link>
        <Link className="link t-cap" href="/dispatch/capacity">Capacity setup</Link>
        <Link className="link t-cap" href="/dispatch/scorecards">Scorecards</Link>
      </div>
      {bus.length === 0 || ws.length === 0 ? (
        <div className="fs-card-b"><p className="t-cap">No capacity set for this day. <Link className="link" href="/dispatch/capacity">Set capacity</Link> so the call desk and online booking stop at what the board can run.</p></div>
      ) : (
        <table className="fs-table">
          <thead><tr><th>Business unit</th>{ws.map((w) => <th key={w.id}>{w.label}</th>)}</tr></thead>
          <tbody>
            {bus.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                {ws.map((w) => {
                  const c = cells.find((x) => x.business_unit_id === b.id && x.arrival_window_id === w.id);
                  if (!c) return <td key={w.id} className="fs-muted">—</td>;
                  const st = cellState(c);
                  return <td key={w.id}><span className={st === 'full' ? 'neg b' : st === 'tight' ? 'b' : ''}>{WORD[st]}</span><span className="l2 tnum">{cellLabel(c)}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(onCall.length > 0 || events.length > 0) && (
        <div className="fs-card-b">
          {onCall.length > 0 && <p className="t-ui"><b>On call:</b> {onCall.map((o) => `${employees[o.employee_id] ?? 'Technician'}${o.role === 'BACKUP' ? ' (backup)' : ''} until ${stamp(o.ends_at)}`).join(' · ')}</p>}
          {events.length > 0 && <p className="t-ui"><b>Blocked:</b> {count(events.length)} — {events.slice(0, 8).map((e) => `${employees[e.employee_id] ?? 'Technician'} (${e.kind.toLowerCase().replace('_', ' ')})`).join(' · ')}</p>}
        </div>
      )}
    </section>
  );
}
