'use client';

/**
 * The crew board: crews (and vendors with scheduled work) × the next two weeks, each cell the
 * scheduled hours against the crew's capacity. Over capacity says "over" (never colour alone).
 * A cell opens the look-ahead for that crew.
 */
import Link from 'next/link';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ButtonLink, WidgetState, dayDate } from '@meritbooks/merit-ui';
import { isWorkday } from '@/lib/pm/schedule/calendar';
import { DEFAULT_CALENDAR, type CrewOption, type LoadCell } from '@/lib/pm/schedule/types';
import { addDays } from '@/lib/time';

export interface BoardRow {
  id: string;
  kind: LoadCell['resource_kind'];
  name: string;
  capacity: number;
  cells: Map<string, LoadCell>;
  total: number;
}

/** Crews × days from the load cells; crews with nothing booked still get a row. Pure. */
export function boardRows(crews: ReadonlyArray<CrewOption>, load: ReadonlyArray<LoadCell>): BoardRow[] {
  const m = new Map<string, BoardRow>();
  for (const c of crews) m.set(`crew:${c.id}`, { id: c.id, kind: 'crew', name: c.name, capacity: c.capacity_hours, cells: new Map(), total: 0 });
  for (const l of load) {
    const key = `${l.resource_kind}:${l.resource_id}`;
    const r = m.get(key) ?? { id: l.resource_id, kind: l.resource_kind, name: l.resource_name, capacity: l.capacity_hours, cells: new Map<string, LoadCell>(), total: 0 };
    const prev = r.cells.get(l.day);
    r.cells.set(l.day, prev ? { ...prev, hours: prev.hours + l.hours, task_count: prev.task_count + l.task_count } : l);
    r.total += l.hours;
    m.set(key, r);
  }
  const order = { crew: 0, vendor: 1, employee: 2 } as const;
  return [...m.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

const fmtH = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

export function CrewBoard({ crews, load, from, today, engine }: { crews: ReadonlyArray<CrewOption>; load: ReadonlyArray<LoadCell>; from: string; today: string; engine: boolean }) {
  const router = useRouter();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(from, i)), [from]);
  const rows = useMemo(() => boardRows(crews, load), [crews, load]);
  const over = rows.reduce((a, r) => a + [...r.cells.values()].filter((c) => c.hours > (c.capacity_hours || r.capacity)).length, 0);

  if (!rows.length) {
    return (
      <div className="surface">
        <WidgetState
          state={
            engine
              ? { kind: 'empty', title: 'No crews yet', body: 'Add crews in Settings, then assign them to tasks on a job’s schedule. Their booked hours show here by day.' }
              : { kind: 'empty', title: 'The crew board needs the schedule engine', body: 'Your administrator switches it on with the schedule update; crews and their booked hours then show here by day.' }
          }
          />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="gx-bar">
        <span className="t-cap">
          {rows.length} crews and trades · hours booked against a day’s capacity{over ? ` · ${over} over-booked days` : ''}
        </span>
        <span className="sp" />
        <button type="button" className="btn btn--quiet" onClick={() => router.push(`/schedule?view=crews&from=${addDays(from, -14)}`)}>Earlier two weeks</button>
        <ButtonLink variant="quiet" href="/schedule?view=crews">This week</ButtonLink>
        <button type="button" className="btn btn--quiet" onClick={() => router.push(`/schedule?view=crews&from=${addDays(from, 14)}`)}>Later two weeks</button>
      </div>
      <div className="cb">
        <table aria-label="Crew board">
          <thead>
            <tr>
              <th className="res" scope="col">Crew</th>
              {days.map((d) => (
                <th key={d} scope="col" className={[isWorkday(DEFAULT_CALENDAR, d) ? '' : 'off', d === today ? 'today' : ''].filter(Boolean).join(' ') || undefined}>
                  {dayDate(d)}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}:${r.id}`}>
                <th className="res" scope="row">
                  {r.kind === 'crew' ? (
                    <Link className="nlink" href={`/schedule?view=lookahead&from=${from}&crew=${r.id}`}>{r.name}</Link>
                  ) : (
                    <span>{r.name}</span>
                  )}
                  <div className="t-cap">{r.kind === 'crew' ? `${fmtH(r.capacity)} h a day` : r.kind === 'vendor' ? 'Trade partner' : 'Person'}</div>
                </th>
                {days.map((d) => {
                  const c = r.cells.get(d);
                  const cap = c?.capacity_hours || r.capacity;
                  const workday = isWorkday(DEFAULT_CALENDAR, d);
                  const cls = [c && c.hours > cap ? 'over' : c && c.hours >= cap ? 'full' : '', workday ? '' : 'off'].filter(Boolean).join(' ') || undefined;
                  const href = `/schedule?view=lookahead&from=${from}${r.kind === 'crew' ? `&crew=${r.id}` : ''}`;
                  return (
                    <td key={d} className={cls}>
                      <Link href={href} aria-label={`${r.name}, ${dayDate(d)}: ${c ? `${fmtH(c.hours)} of ${fmtH(cap)} hours` : 'nothing booked'}`}>
                        {c ? (
                          <>
                            <span>{fmtH(c.hours)}</span>
                            <span className="u">{c.hours > cap ? `over by ${fmtH(c.hours - cap)}` : `of ${fmtH(cap)}`}</span>
                          </>
                        ) : (
                          <span className="u">{workday ? 'open' : ''}</span>
                        )}
                      </Link>
                    </td>
                  );
                })}
                <td>
                  <span style={{ padding: '0 8px' }}>{fmtH(r.total)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
