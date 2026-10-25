'use client';

import { useMemo, useState } from 'react';
import { Field, Input, InlineNotice, Status, count } from '@meritbooks/merit-ui';
import type { CapacityRow } from '@/app/api/residential/capacity/route';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, useBoard } from '@/components/dealer/common/depth';

interface Data { from: string; to: string; rows: CapacityRow[]; flags: number }

/** Crews and key trades across every job by week (RES-49): busy days vs capacity, double-booked days flagged. */
export function CapacityBoard({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const b = useBoard<Data>(`/api/residential/capacity?company=${companyId}&from=${from}&weeks=8`);
  const grid = useMemo(() => {
    if (!b.data) return null;
    const weeks = [...new Set(b.data.rows.map((r) => r.week))].sort();
    const res = new Map<string, { label: string; kind: string; cells: Map<string, CapacityRow> }>();
    for (const r of b.data.rows) {
      const k = `${r.resource_kind}:${r.resource_id}`;
      if (!res.has(k)) res.set(k, { label: r.resource, kind: r.resource_kind, cells: new Map() });
      res.get(k)!.cells.set(r.week, r);
    }
    return { weeks, rows: [...res.entries()].sort((a, c) => a[1].label.localeCompare(c[1].label)) };
  }, [b.data]);
  const state = <BoardState b={b} what="Capacity" />;
  return (
    <div className="stack">
      <div className="ops-toolbar"><Field label="Week of"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field></div>
      {state}
      {b.data && grid && (b.data.flags > 0 && <InlineNotice tone="warn" title={`${count(b.data.flags)} week(s) over capacity.`}>A crew or trade is on two jobs the same day, or booked more days than it works. Move a task or add a crew.</InlineNotice>)}
      {b.data && grid && (grid.rows.length === 0 ? <Empty title="No assigned work in these weeks" body="Tasks with a crew, trade or person assigned show here by week across every open job." /> :
        <Section title="By week" meta="busy days / days available · ⚠ double-booked days">
          <table className="ops-mini" aria-label="Capacity by week">
            <thead><tr><th>Crew / trade</th>{grid.weeks.map((w) => <th key={w} className="n">{w.slice(5)}</th>)}</tr></thead>
            <tbody>{grid.rows.map(([k, r]) => <tr key={k}><td>{r.label}<span className="l2"> · {r.kind.toLowerCase()}</span></td>
              {grid.weeks.map((w) => { const c = r.cells.get(w); return <td key={w} className="n">{c ? (c.overloaded ? <Status kind="overdue" pip="overdue">{c.busy_days}/{c.capacity_days}{c.double_booked_days ? ` ⚠${c.double_booked_days}` : ''}</Status> : `${c.busy_days}/${c.capacity_days}`) : '—'}</td>; })}</tr>)}</tbody>
          </table>
        </Section>)}
    </div>
  );
}
