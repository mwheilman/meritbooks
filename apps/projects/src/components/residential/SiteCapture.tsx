'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, Status, Textarea } from '@meritbooks/merit-ui';
import type { SiteCaptureRow } from '@/app/api/residential/jobs/[jobId]/capture/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface RoomDraft { name: string; length: string; width: string; height: string }
const ftIn = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/.exec(t);
  if (!m) return null;
  return Math.round((Number(m[1]) * 12 + Number(m[2] ?? 0)) * 100) / 100;
};

/** In-home measure and site capture (RES-11): rooms (feet and inches), utilities, existing conditions; final → a measure and, pre-1978, the RRP record. */
export function SiteCapture({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const url = `/api/residential/jobs/${jobId}/capture`;
  const b = useBoard<{ captures: SiteCaptureRow[] }>(url);
  const { run, busy, error } = useDo(b.reload);
  const [rooms, setRooms] = useState<RoomDraft[]>([{ name: 'Kitchen', length: '', width: '', height: '' }]);
  const [cond, setCond] = useState({ year_built: '', panel_amps: '', water_heater_age: '', asbestos_risk: false, lead_risk: false, notes: '' });
  const [util, setUtil] = useState({ water_shutoff: '', gas_shutoff: '', panel_location: '' });
  const bad = rooms.some((r) => r.name.trim() && ((r.length && ftIn(r.length) == null) || (r.width && ftIn(r.width) == null)));
  const save = async () => {
    const data = {
      rooms: rooms.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), length_in: ftIn(r.length), width_in: ftIn(r.width), height_in: ftIn(r.height) })),
      utilities: Object.fromEntries(Object.entries(util).filter(([, v]) => v.trim())),
      conditions: { year_built: cond.year_built ? Number(cond.year_built) : null, panel_amps: cond.panel_amps ? Number(cond.panel_amps) : null,
        water_heater_age: cond.water_heater_age ? Number(cond.water_heater_age) : null, asbestos_risk: cond.asbestos_risk, lead_risk: cond.lead_risk || (Number(cond.year_built) > 0 && Number(cond.year_built) < 1978), notes: cond.notes || null },
    };
    return run<{ captureId: string }>('save', url, { op: 'save', data }, 'Saved the capture');
  };
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="New site capture" meta={`Feet and inches (12' 6")`}>
          {rooms.map((r, i) => <div key={i} className="ops-toolbar">
            <Field label="Room"><Input value={r.name} onChange={(e) => setRooms(rooms.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} /></Field>
            <Field label="Length" error={r.length && ftIn(r.length) == null ? 'Like 12\' 6"' : undefined}><Input value={r.length} onChange={(e) => setRooms(rooms.map((x, k) => (k === i ? { ...x, length: e.target.value } : x)))} style={{ width: 90 }} /></Field>
            <Field label="Width" error={r.width && ftIn(r.width) == null ? 'Like 10\'' : undefined}><Input value={r.width} onChange={(e) => setRooms(rooms.map((x, k) => (k === i ? { ...x, width: e.target.value } : x)))} style={{ width: 90 }} /></Field>
            <Field label="Ceiling"><Input value={r.height} onChange={(e) => setRooms(rooms.map((x, k) => (k === i ? { ...x, height: e.target.value } : x)))} style={{ width: 80 }} /></Field>
            <span className="l2">{ftIn(r.length) && ftIn(r.width) ? `${qty(Math.round(((ftIn(r.length)! * ftIn(r.width)!) / 144) * 100) / 100)} SF` : ''}</span>
          </div>)}
          <Button onClick={() => setRooms([...rooms, { name: '', length: '', width: '', height: '' }])}>Add a room</Button>
          <div className="ops-toolbar">
            <Field label="Year built"><Input inputMode="numeric" value={cond.year_built} onChange={(e) => setCond({ ...cond, year_built: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Panel amps"><Input inputMode="numeric" value={cond.panel_amps} onChange={(e) => setCond({ ...cond, panel_amps: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Water heater age"><Input inputMode="numeric" value={cond.water_heater_age} onChange={(e) => setCond({ ...cond, water_heater_age: e.target.value })} style={{ width: 90 }} /></Field>
            <Check checked={cond.asbestos_risk} onChange={(e) => setCond({ ...cond, asbestos_risk: e.target.checked })} label="Possible asbestos" />
            <Check checked={cond.lead_risk} onChange={(e) => setCond({ ...cond, lead_risk: e.target.checked })} label="Lead paint risk" />
          </div>
          <div className="ops-toolbar">
            <Field label="Water shut-off"><Input value={util.water_shutoff} onChange={(e) => setUtil({ ...util, water_shutoff: e.target.value })} /></Field>
            <Field label="Gas shut-off"><Input value={util.gas_shutoff} onChange={(e) => setUtil({ ...util, gas_shutoff: e.target.value })} /></Field>
            <Field label="Panel location"><Input value={util.panel_location} onChange={(e) => setUtil({ ...util, panel_location: e.target.value })} /></Field>
          </div>
          <Field label="Existing conditions"><Textarea rows={3} value={cond.notes} onChange={(e) => setCond({ ...cond, notes: e.target.value })} /></Field>
          <span className="btn-row"><Button disabled={bad || busy === 'save'} onClick={save}>Save draft</Button>
            <Button variant="primary" disabled={bad || busy === 'save' || busy === 'fin'} onClick={async () => { const r = await save(); if (r) await run('fin', url, { op: 'finalize', captureId: r.captureId }, (x: { rrp_required: boolean }) => (x.rrp_required ? 'Final — pre-1978 home: RRP record opened' : 'Final — rooms are now a measure')); }}>Save and finalize</Button></span>
        </Section>
      )}
      <BoardState b={b} what="Site captures" />
      {b.data && (b.data.captures.length === 0 ? <Empty title="No site captures yet" body="Capture rooms, utilities and existing conditions at the first visit; finalizing turns the rooms into a measure." /> :
        <Section title="Captures">
          <ul className="ops-agenda">{b.data.captures.map((c) => <li key={c.id}><span className="d">{day(c.created_at, today)}</span><span>{c.rooms.length} room(s) · {c.conditions.year_built ? `built ${c.conditions.year_built}` : 'year unknown'} · <Status kind={c.status === 'FINAL' ? 'ready' : 'track'} pip="open">{c.status.toLowerCase()}</Status>
            {!readOnly && c.status === 'DRAFT' && <> <Button onClick={() => run(`f${c.id}`, url, { op: 'finalize', captureId: c.id }, 'Finalized')}>Finalize</Button></>}</span></li>)}</ul>
        </Section>)}
    </div>
  );
}
