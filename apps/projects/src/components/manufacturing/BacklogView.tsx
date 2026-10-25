'use client';

import { useState } from 'react';
import { Field, Select, count } from '@meritbooks/merit-ui';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, pctText, qty, useBoard } from '@/components/dealer/common/depth';

interface Week { week_start: string; capacity_hours: number; load_hours: number; pct: number | null }
interface Center { work_center_id: string; code: string; name: string; status: string; weekly_capacity_hours: number; booked_hours: number; unreleased_hours: number; quoted_weighted_hours: number; weeks_of_backlog: number | null; overflow_hours: number; weeks: Week[] }
interface Backlog { week_start: string; weeks: number; win_probability: number | null; centers: Center[] }

/** Shop backlog in hours against each work center's capacity, week by week (booked plus weighted quotes). */
export function BacklogView({ companyId, today }: { companyId: string; today: string }) {
  const [weeks, setWeeks] = useState(12);
  const b = useBoard<Backlog>(`/api/mfg/backlog?company=${companyId}&weeks=${weeks}`);
  const state = <BoardState b={b} what="The backlog" />;
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="Weeks"><Select value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))}>{[4, 8, 12, 26].map((w) => <option key={w} value={w}>{w}</option>)}</Select></Field>
        {b.data?.win_probability != null && <span className="t-cap">Quotes counted at {pctText(b.data.win_probability, 0)} win probability</span>}
      </div>
      {state}
      {b.data && (b.data.centers.length === 0 ? <Empty title="No work centers" body="Add work centers with hours per day, days per week and efficiency in Production setup; their capacity is what the backlog is measured against." /> : (
        <Section title="Load vs capacity" meta={`From ${day(b.data.week_start, today)} · hours`}>
          <div style={{ overflowX: 'auto' }}>
            <table className="ops-mini" aria-label="Backlog by work center and week">
              <thead><tr><th>Work center</th><th className="n">Booked</th><th className="n">Not released</th><th className="n">Quoted</th><th className="n">Weeks</th><th className="n">Past horizon</th>{b.data.centers[0]!.weeks.map((w) => <th key={w.week_start} className="n">{day(w.week_start, today)}</th>)}</tr></thead>
              <tbody>{b.data.centers.map((c) => (
                <tr key={c.work_center_id}>
                  <td><b>{c.name}</b><div className="t-cap">{c.code} · {qty(c.weekly_capacity_hours)} h a week</div></td>
                  <td className="n">{qty(c.booked_hours)}</td><td className="n">{qty(c.unreleased_hours)}</td><td className="n">{qty(c.quoted_weighted_hours)}</td>
                  <td className={`n${(c.weeks_of_backlog ?? 0) > weeks ? ' neg b' : ''}`}>{qty(c.weeks_of_backlog)}</td>
                  <td className={`n${c.overflow_hours > 0 ? ' neg b' : ''}`}>{qty(c.overflow_hours)}</td>
                  {c.weeks.map((w) => <td key={w.week_start} className={`n${(w.pct ?? 0) >= 1 ? ' b' : ''}`} title={`${qty(w.load_hours)} of ${qty(w.capacity_hours)} hours`}>{pctText(w.pct, 0)}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="t-cap" style={{ marginTop: 8 }}>{count(b.data.centers.filter((c) => c.overflow_hours > 0).length)} centers have work past the {weeks}-week horizon. Each week shows the share of that week's capacity the backlog fills, in order.</p>
        </Section>
      ))}
    </div>
  );
}
