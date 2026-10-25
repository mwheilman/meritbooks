'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, Input, QueueTable, Select, Status, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { proposeRoute, routeLength, type Stop } from '@/lib/dealer/routing';
import { m, type Opt } from './kit';

interface PlanStop { id: string; kind: string; purpose: string; seq: number | null; status: string; customer: string | null; unit: string | null; address_line1: string | null; city: string | null; lat: number | null; lng: number | null; window_start: string | null; window_end: string | null; work_order_id: string | null; notes: string | null }
interface Plan { day: string; origin: { lat: number | null; lng: number | null }; stops: PlanStop[] }

/** The truck's day: pickups and deliveries, a proposed order (nearest stop first, time windows kept), saved and worked. */
export function RoutesView({ companyId, today, customers }: { companyId: string; today: string; customers: Opt[] }) {
  const { readOnly } = useShell();
  const [d, setD] = useState(today);
  const p = useBoard<Plan>(`/api/dealer/service-desk?view=route&company=${companyId}&day=${d}`);
  const { run, busy, error } = useDo(p.reload);
  const [order, setOrder] = useState<string[] | null>(null);
  const [add, setAdd] = useState({ kind: 'DELIVERY', customerId: '', address: '', windowStart: '', windowEnd: '' });
  const stops = useMemo(() => {
    const s = p.data?.stops ?? [];
    if (!order) return s;
    const by = new Map(s.map((x) => [x.id, x]));
    return order.map((id) => by.get(id)).filter((x): x is PlanStop => !!x);
  }, [p.data, order]);
  const origin = { lat: p.data?.origin.lat != null ? Number(p.data.origin.lat) : null, lng: p.data?.origin.lng != null ? Number(p.data.origin.lng) : null };
  const asStops: Stop[] = stops.map((s) => ({ id: s.id, lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng), window_start: s.window_start, window_end: s.window_end }));
  const km = routeLength(origin, asStops) / 1000;
  const move = (i: number, dir: -1 | 1) => { const ids = stops.map((s) => s.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; setOrder(ids); };
  const cols: QueueColumn<PlanStop>[] = [
    { id: 'n', header: '#', width: 40, cell: (r) => count(stops.indexOf(r) + 1) },
    { id: 's', header: 'Stop', cell: (r) => <><span className="l1">{r.kind === 'PICKUP' ? 'Pick up' : 'Deliver'} · {r.customer ?? 'Customer'}</span><span className="l2">{[r.unit, r.address_line1, r.city].filter(Boolean).join(' · ') || 'No address'}{r.lat == null ? ' · not on the map' : ''}</span></> },
    { id: 'w', header: 'Window', width: 120, cell: (r) => r.window_start ? `${r.window_start.slice(0, 5)}${r.window_end ? `–${r.window_end.slice(0, 5)}` : ''}` : 'Any time' },
    { id: 'st', header: 'Status', width: 100, cell: (r) => <Status kind={r.status === 'DONE' ? 'ready' : 'track'} pip="open">{r.status.toLowerCase()}</Status> },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Order</span>, width: 230, cell: (r: PlanStop) => (
      <ButtonRow>
        <Button variant="quiet" aria-label="Earlier" onClick={() => move(stops.indexOf(r), -1)}>↑</Button>
        <Button variant="quiet" aria-label="Later" onClick={() => move(stops.indexOf(r), 1)}>↓</Button>
        {r.status === 'PLANNED' && <Button disabled={busy === r.id} onClick={() => void run(r.id, '/api/dealer/service-desk', { op: 'finish_stop', stopId: r.id }, 'Done')}>Done</Button>}
      </ButtonRow>) } satisfies QueueColumn<PlanStop>]),
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar"><Field label="Day"><Input type="date" value={d} onChange={(e) => { setD(e.target.value); setOrder(null); }} /></Field></div>
      <BoardState b={p} what="The route" />
      {p.data && (
        <Section title={`${count(stops.length)} stops`} meta={origin.lat == null ? 'Set the store location in store settings to measure the route' : `${km.toFixed(1)} km in this order`}
          actions={!readOnly && stops.length > 1 ? <ButtonRow>
            <Button variant="quiet" onClick={() => setOrder(proposeRoute(origin, asStops).map((s) => s.id))}>Propose an order</Button>
            <Button variant="primary" disabled={!order || busy === 'save'} onClick={() => void run('save', '/api/dealer/service-desk', { op: 'route_order', companyId, day: d, stops: stops.map((s) => s.id) }, 'Route saved').then(() => setOrder(null))}>Save this order</Button>
          </ButtonRow> : undefined}>
          {stops.length === 0 ? <Empty title="No stops this day" body="Bookings with a pickup add a stop; add deliveries below." /> :
            <div className="mp-table"><QueueTable aria-label="Route stops" columns={cols} rows={stops} getRowId={(r) => r.id} onOpen={(r) => { if (r.work_order_id) window.location.assign(`/work-orders/service?wo=${r.work_order_id}`); }} openOnClick rowState={(r) => ({ done: r.status === 'DONE' })} /></div>}
        </Section>
      )}
      {!readOnly && (
        <Section title="Add a stop">
          <div className="ops-toolbar">
            <Field label="Kind"><Select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}><option value="DELIVERY">Delivery</option><option value="PICKUP">Pickup</option></Select></Field>
            <Field label="Customer"><Select value={add.customerId} onChange={(e) => setAdd({ ...add, customerId: e.target.value })}><option value="">Pick the customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
            <Field label="Address (blank = the customer's)"><Input value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value })} /></Field>
            <Field label="From"><Input type="time" value={add.windowStart} onChange={(e) => setAdd({ ...add, windowStart: e.target.value })} /></Field>
            <Field label="To"><Input type="time" value={add.windowEnd} onChange={(e) => setAdd({ ...add, windowEnd: e.target.value })} /></Field>
          </div>
          <Button disabled={!add.customerId || busy === 'add'} onClick={() => void run('add', '/api/dealer/service-desk', { op: 'add_stop', companyId, kind: add.kind, stopOn: d, customerId: add.customerId, address: add.address || null, windowStart: add.windowStart || null, windowEnd: add.windowEnd || null }, 'Stop added')}>Add the stop</Button>
        </Section>
      )}
    </div>
  );
}

interface WipRow { work_order_id: string; number: string; kind: string; status: string; stage: string | null; payer_type: string; unit: string; customer: string | null; opened: string; days_open: number; promised_on: string | null; clocked_hours: number; flag_hours: number; labor_cost_cents: number | null; parts_cost_cents: number | null; sublet_cost_cents: number | null; sell_cents: number; must_close: boolean }
interface Wip { cutoff: string; rows: WipRow[]; open: number; must_close: number; labor_cost_cents: number | null; parts_cost_cents: number | null; amounts_visible: boolean }
interface Storage { work_order_id: string; number: string; unit: string; customer: string | null; ready_at: string; days_waiting: number; billable_days: number; storage_cents: number; lien_notice_on: string; lien_notice_due: boolean }

/** Open ROs at cost with days open, the ones to close before the month-end cutoff, and units waiting for pickup. */
export function WipView({ companyId, today }: { companyId: string; today: string }) {
  const [cut, setCut] = useState('');
  const w = useBoard<Wip>(`/api/dealer/service-desk?view=wip&company=${companyId}${cut ? `&cutoff=${cut}` : ''}`);
  const s = useBoard<Storage[]>(`/api/dealer/service-desk?view=storage&company=${companyId}`);
  const open = (id: string) => window.location.assign(`/work-orders/service?wo=${id}`);
  const cols: QueueColumn<WipRow>[] = [
    { id: 'r', header: 'RO', cell: (r) => <><span className="l1">{r.number} · {r.unit}</span><span className="l2">{[r.customer, r.payer_type.toLowerCase(), r.stage?.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · ')}</span></> },
    { id: 'd', header: 'Days open', numeric: true, width: 100, cell: (r) => <Status kind={r.days_open > 14 ? 'overdue' : r.days_open > 7 ? 'risk' : 'track'} pip="open">{count(r.days_open)}</Status> },
    { id: 'h', header: 'Hours (clocked / flagged)', numeric: true, width: 170, cell: (r) => `${qty(r.clocked_hours)} / ${qty(r.flag_hours)}` },
    ...(w.data?.amounts_visible ? [{ id: 'c', header: 'Labor + parts cost', numeric: true, width: 150, cell: (r: WipRow) => m(Number(r.labor_cost_cents ?? 0) + Number(r.parts_cost_cents ?? 0) + Number(r.sublet_cost_cents ?? 0)) } satisfies QueueColumn<WipRow>] : []),
    { id: 'v', header: 'Sell', numeric: true, width: 110, cell: (r) => m(r.sell_cents) },
    { id: 'm', header: 'Cutoff', width: 110, cell: (r) => r.must_close ? <Status kind="risk" pip="open">close it</Status> : '—' },
  ];
  return (
    <div className="stack">
      <div className="ops-toolbar"><Field label="Month-end cutoff"><Input type="date" value={cut} onChange={(e) => setCut(e.target.value)} /></Field></div>
      <BoardState b={w} what="Work in process" />
      {w.data && (
        <Section title={`${count(w.data.open)} open ROs`} meta={`${count(w.data.must_close)} to close before ${day(w.data.cutoff, today)}${w.data.amounts_visible ? ` · ${m(Number(w.data.labor_cost_cents ?? 0) + Number(w.data.parts_cost_cents ?? 0))} at cost` : ''}`}>
          {w.data.rows.length === 0 ? <Empty title="No open ROs" body="Open repair orders and PDIs show here at cost, with the ones that should close before month end." /> :
            <div className="mp-table"><QueueTable aria-label="Service work in process" columns={cols} rows={w.data.rows} getRowId={(r) => r.work_order_id} onOpen={(r) => open(r.work_order_id)} openOnClick rowState={(r) => ({ attn: r.must_close })} /></div>}
          <p className="t-cap">Books values WIP at month end from the same ROs; this list is what the service manager closes first.</p>
        </Section>
      )}
      <Section title="Ready, not picked up" meta="Storage starts after the store's free days; the lien-notice date follows the store rule">
        <BoardState b={s} what="Storage" />
        {s.data && (s.data.length === 0 ? <Empty title="Nothing waiting" body="Units ready past the free days show here with their storage charge." /> : (
          <table className="ops-mini" aria-label="Storage">
            <thead><tr><th>RO</th><th className="n">Waiting</th><th className="n">Storage</th><th>Lien notice</th></tr></thead>
            <tbody>{s.data.map((r) => <tr key={r.work_order_id} onClick={() => open(r.work_order_id)} style={{ cursor: 'pointer' }}><td><Link className="nlink" href={`/work-orders/service?wo=${r.work_order_id}`}>{r.number} · {r.unit}</Link><div className="t-cap">{r.customer}</div></td><td className="n">{count(r.days_waiting)} days</td><td className="n">{m(r.storage_cents)}</td><td>{r.lien_notice_due ? <Status kind="overdue" pip="open">due {day(r.lien_notice_on, today)}</Status> : day(r.lien_notice_on, today)}</td></tr>)}</tbody>
          </table>
        ))}
      </Section>
    </div>
  );
}
