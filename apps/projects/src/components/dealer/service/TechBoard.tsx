'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, Input, QueueTable, Select, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, pctText, qty, useBoard, useDo } from '../common/depth';

interface Tech {
  employee_id: string; name: string; clocked_hours: number; indirect_hours: number; attendance_hours: number; flagged_hours: number;
  efficiency: number | null; productivity: number | null; lines_over_flat_rate: number;
  open_punch: { punch_id: string; kind: string; started_at: string; work_order_id: string | null; work_order_line_id: string | null } | null;
}
interface Data {
  from: string; to: string; all_techs: boolean; techs: Tech[];
  ros: Array<{ id: string; number: string; summary: string; status: string }>;
  lines: Array<{ id: string; work_order_id: string; description: string; flag_hours: number | null; labor_minutes: number | null; status: string }>;
}

const INDIRECT: Array<[string, string]> = [['SHOP', 'Shop time'], ['WAITING_PARTS', 'Waiting on parts'], ['TRAINING', 'Training'], ['CLEANUP', 'Clean-up'], ['IDLE', 'Idle']];

/** Clock on an RO line (one open punch per tech), indirect time, flag hours, and the productivity board. */
export function TechBoard({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [range, setRange] = useState({ from: today.slice(0, 8) + '01', to: today });
  const b = useBoard<Data>(`/api/dealer/tech?company=${companyId}&from=${range.from}&to=${range.to}`);
  const { run, busy, error } = useDo(b.reload);
  const [line, setLine] = useState('');
  const [flag, setFlag] = useState<Record<string, string>>({});

  const state = <BoardState b={b} what="The tech board" />;
  if (!b.data) return state;
  const d = b.data;
  const roOf = (id: string | null) => d.ros.find((r) => r.id === id)?.number ?? 'RO';
  const lineOf = (id: string | null) => d.lines.find((l) => l.id === id)?.description ?? 'line';

  const cols: QueueColumn<Tech>[] = [
    { id: 'n', header: 'Tech', cell: (t) => <><span className="l1">{t.name}</span><span className="l2">{t.open_punch ? (t.open_punch.kind === 'LINE' ? `On ${roOf(t.open_punch.work_order_id)} · ${lineOf(t.open_punch.work_order_line_id)}` : INDIRECT.find((i) => i[0] === t.open_punch!.kind)?.[1] ?? t.open_punch.kind) : 'Not clocked on'}</span></> },
    { id: 'c', header: 'Clocked', numeric: true, width: 90, cell: (t) => qty(t.clocked_hours, 'h') },
    { id: 'f', header: 'Flagged', numeric: true, width: 90, cell: (t) => qty(t.flagged_hours, 'h') },
    { id: 'i', header: 'Indirect', numeric: true, width: 90, cell: (t) => qty(t.indirect_hours, 'h') },
    { id: 'e', header: 'Efficiency', numeric: true, width: 100, cell: (t) => <span className={t.efficiency != null && t.efficiency < 0.8 ? 'neg b' : undefined}>{pctText(t.efficiency, 0)}</span> },
    { id: 'p', header: 'Productivity', numeric: true, width: 110, cell: (t) => pctText(t.productivity, 0) },
    { id: 'o', header: 'Over flat rate', numeric: true, width: 120, cell: (t) => count(t.lines_over_flat_rate) },
  ];

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Clock" meta="One open punch per tech; clocking on closes the last one">
          <div className="ops-toolbar">
            <Field label="Repair order line">
              <Select value={line} onChange={(e) => setLine(e.target.value)} style={{ minWidth: 340 }}>
                <option value="">Pick a labor line</option>
                {d.ros.map((r) => (
                  <optgroup key={r.id} label={`${r.number} · ${r.summary}`}>
                    {d.lines.filter((l) => l.work_order_id === r.id).map((l) => <option key={l.id} value={l.id}>{l.description}{l.flag_hours != null ? ` · ${l.flag_hours} h flat` : ''}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Button variant="primary" disabled={!line || busy === 'on'} onClick={() => void run('on', '/api/dealer/tech', { op: 'clock_on', lineId: line }, 'Clocked on')}>Clock on</Button>
            <Button disabled={busy === 'off'} onClick={() => void run('off', '/api/dealer/tech', { op: 'clock_off', companyId }, 'Clocked off')}>Clock off</Button>
            <span className="sp" />
            <ButtonRow>{INDIRECT.map(([k, label]) => <Button key={k} variant="quiet" disabled={busy === k} onClick={() => void run(k, '/api/dealer/tech', { op: 'indirect', companyId, kind: k }, `On ${label.toLowerCase()}`)}>{label}</Button>)}</ButtonRow>
          </div>
          {d.lines.length === 0 && <p className="t-cap">No labor lines on open repair orders. Add labor to an RO first.</p>}
        </Section>
      )}
      <Section title="Productivity" meta={d.all_techs ? 'Every tech at this store' : 'Your hours'} actions={
        <div className="ops-toolbar">
          <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        </div>
      }>
        {d.techs.length === 0
          ? <Empty title="No tech time in this period" body="Techs clock on repair-order lines here or at the kiosk; clocked, flagged and indirect hours roll up by tech." />
          : <div className="mp-table"><QueueTable aria-label="Techs" columns={cols} rows={d.techs} getRowId={(t) => t.employee_id} rowState={(t) => ({ attn: t.efficiency != null && t.efficiency < 0.8 })} /></div>}
        <p className="t-cap" style={{ marginTop: 8 }}>{day(d.from, today)} to {day(d.to, today)}. Efficiency = flagged ÷ clocked on lines; productivity = clocked on lines ÷ attendance.</p>
      </Section>
      {!readOnly && d.lines.length > 0 && (
        <Section title="Flag hours" meta="Flat-rate hours a line pays the tech">
          <table className="ops-mini" aria-label="Flag hours by line">
            <thead><tr><th>Repair order</th><th>Line</th><th className="n">Flagged</th><th /></tr></thead>
            <tbody>{d.lines.slice(0, 60).map((l) => (
              <tr key={l.id}>
                <td><Link className="nlink" href={`/work-orders?wo=${l.work_order_id}`}>{roOf(l.work_order_id)}</Link></td><td>{l.description}</td>
                <td className="n"><Input aria-label={`Flag hours for ${l.description}`} inputMode="decimal" value={flag[l.id] ?? (l.flag_hours == null ? '' : String(l.flag_hours))} onChange={(e) => setFlag({ ...flag, [l.id]: e.target.value })} style={{ width: 80 }} /></td>
                <td><Button variant="quiet" disabled={flag[l.id] == null || !Number.isFinite(Number(flag[l.id])) || busy === `f${l.id}`} onClick={() => void run(`f${l.id}`, '/api/dealer/tech', { op: 'flag', lineId: l.id, flagHours: Number(flag[l.id]) }, 'Flagged the line')}>Save</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </Section>
      )}
    </div>
  );
}
