'use client';

import { useState } from 'react';
import { Button, Field, Input, InlineNotice, QueueTable, Select, Status, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import type { AppointmentRow, BookingLinkRow, RepRow, Slot } from '@/app/api/residential/appointments/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, useBoard, useDo } from '@/components/dealer/common/depth';
import { slotLabel } from '@/lib/residential/routing';

interface Data { reps: RepRow[]; appointments: AppointmentRow[]; requests: AppointmentRow[]; slots: Slot[]; links?: BookingLinkRow[] }
type Kind = 'SALES' | 'MEASURE' | 'DISCOVERY' | 'DESIGN';

const STATUS_KIND: Readonly<Record<string, 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'>> = {
  REQUESTED: 'risk', BOOKED: 'track', CONFIRMED: 'ready', ON_MY_WAY: 'ready', ARRIVED: 'ready', DONE: 'ready', NO_SHOW: 'blocked', CANCELLED: 'blocked',
};

/**
 * In-home appointments (RES-10 / FLR-07 / ID-03): open slots ranked by skill, territory and drive
 * time; booking onto a rep (the rep gets the lead brief, the homeowner a confirmation); requests
 * from the self-booking page; on-my-way; reminders; the booking link to share.
 */
export function AppointmentsBoard({ companyId, timeZone, defaultKind = 'SALES' }: { companyId: string; timeZone: string; defaultKind?: Kind }) {
  const { readOnly } = useShell();
  const today = new Date().toISOString().slice(0, 10);
  const [find, setFind] = useState({ day: today, kind: defaultKind, skill: '', zip: '', lat: '', lng: '', minutes: '90', address: '', notes: '', requestId: '' });
  const [query, setQuery] = useState<string>('');
  const [link, setLink] = useState<string | null>(null);
  const b = useBoard<Data>(`/api/residential/appointments?company=${companyId}&days=14${query}`);
  const { run, busy, error } = useDo(b.reload);
  const state = <BoardState b={b} what="Appointments" />;
  const repName = (id: string | null) => b.data?.reps.find((r) => r.id === id)?.display_name ?? '—';
  const cols: QueueColumn<AppointmentRow>[] = [
    { id: 'w', header: 'When', width: 200, cell: (a) => <><span className="l1">{slotLabel(a.starts_at, timeZone)}</span><span className="l2">{a.minutes} min · {a.kind.toLowerCase()}</span></> },
    { id: 'r', header: 'Rep', width: 160, cell: (a) => repName(a.rep_id) },
    { id: 'c', header: 'Visit', cell: (a) => <><span className="l1">{a.requester_name ?? a.address ?? 'Visit'}</span><span className="l2">{[a.address, a.notes].filter(Boolean).join(' · ')}</span></> },
    { id: 's', header: 'Status', width: 140, cell: (a) => <Status kind={STATUS_KIND[a.status] ?? 'track'} pip="open">{a.status.toLowerCase().replace(/_/g, ' ')}</Status> },
    { id: 'a', header: '', width: 220, cell: (a) => (readOnly || ['DONE', 'CANCELLED', 'NO_SHOW', 'REQUESTED'].includes(a.status) ? null : <span className="btn-row">
      {a.status === 'BOOKED' && <Button onClick={() => run(`c${a.id}`, '/api/residential/appointments', { op: 'status', appointmentId: a.id, status: 'CONFIRMED' }, 'Confirmed')}>Confirm</Button>}
      <Button onClick={() => run(`o${a.id}`, '/api/residential/appointments', { op: 'status', appointmentId: a.id, status: 'ON_MY_WAY' }, 'Texted the homeowner')}>On my way</Button>
      <Button onClick={() => run(`d${a.id}`, '/api/residential/appointments', { op: 'status', appointmentId: a.id, status: 'DONE' }, 'Marked done')}>Done</Button></span>) },
  ];
  const search = () => {
    const p = new URLSearchParams({ slotsFor: find.day, kind: find.kind, minutes: find.minutes });
    if (find.skill) p.set('skill', find.skill);
    if (find.zip) p.set('zip', find.zip);
    if (find.lat && find.lng) { p.set('lat', find.lat); p.set('lng', find.lng); }
    setQuery(`&${p.toString()}`);
  };
  if (!b.data) return state;
  const d = b.data;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {d.reps.length === 0 && <InlineNotice tone="info" title="No reps yet.">Add salespeople, measurers or designers with their territory and hours in Settings → Reps; slots come from their calendars.</InlineNotice>}
      {d.requests.length > 0 && (
        <Section title="Requested online" meta={`${count(d.requests.length)} waiting for a rep`}>
          <ul className="ops-agenda">{d.requests.map((r) => <li key={r.id}><span className="d">{slotLabel(r.starts_at, timeZone)}</span>
            <span>{r.requester_name} · {r.requester_phone ?? ''} {r.address ? `· ${r.address}` : ''}{!readOnly && <> <Button onClick={() => setFind({ ...find, day: r.starts_at.slice(0, 10), requestId: r.id, address: r.address ?? '', notes: r.notes ?? '' })}>Find a rep</Button>
              <Button variant="quiet" onClick={() => run(`x${r.id}`, '/api/residential/appointments', { op: 'status', appointmentId: r.id, status: 'CANCELLED' }, 'Declined')}>Decline</Button></>}</span></li>)}</ul>
        </Section>
      )}
      {!readOnly && (
        <Section title="Find a slot" meta="Ranked by skill, territory and drive time from the rep's last stop">
          <div className="ops-toolbar">
            <Field label="Day"><Input type="date" value={find.day} min={today} onChange={(e) => setFind({ ...find, day: e.target.value })} /></Field>
            <Field label="Kind"><Select value={find.kind} onChange={(e) => setFind({ ...find, kind: e.target.value as Kind })}><option value="SALES">Sales</option><option value="MEASURE">Measure</option><option value="DISCOVERY">Discovery</option><option value="DESIGN">Design</option></Select></Field>
            <Field label="Skill"><Input value={find.skill} placeholder="kitchen" onChange={(e) => setFind({ ...find, skill: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="ZIP"><Input value={find.zip} inputMode="numeric" onChange={(e) => setFind({ ...find, zip: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Latitude"><Input value={find.lat} inputMode="decimal" onChange={(e) => setFind({ ...find, lat: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Longitude"><Input value={find.lng} inputMode="decimal" onChange={(e) => setFind({ ...find, lng: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Minutes"><Input value={find.minutes} inputMode="numeric" onChange={(e) => setFind({ ...find, minutes: e.target.value })} style={{ width: 70 }} /></Field>
            <Button variant="primary" onClick={search}>Find slots</Button>
          </div>
          <div className="ops-toolbar">
            <Field label="Address"><Input value={find.address} onChange={(e) => setFind({ ...find, address: e.target.value })} style={{ width: 280 }} /></Field>
            <Field label="Notes for the rep"><Textarea rows={2} value={find.notes} onChange={(e) => setFind({ ...find, notes: e.target.value })} /></Field>
          </div>
          {query && (d.slots.length === 0 ? <Empty title="No open slots that day" body="Every rep of that kind is booked or off. Try another day or kind." /> :
            <ul className="ops-agenda">{d.slots.map((s) => <li key={`${s.rep_id}${s.starts_at}`}><span className="d">{slotLabel(s.starts_at, timeZone)}</span>
              <span>{s.rep} · {s.drive_in_minutes} min drive{s.skill_match ? '' : ' · other skill'}{s.in_territory ? '' : ' · outside territory'} <Button disabled={busy === 'book'} onClick={() => run('book', '/api/residential/appointments', {
                op: 'book', companyId, repId: s.rep_id, startsAt: s.starts_at, minutes: Number(find.minutes) || 90, kind: find.kind, appointmentId: find.requestId || null,
                address: find.address || null, zip: find.zip || null, lat: find.lat ? Number(find.lat) : null, lng: find.lng ? Number(find.lng) : null, skill: find.skill || null, notes: find.notes || null,
              }, `Booked with ${s.rep}`).then((r) => { if (r) { setQuery(''); setFind({ ...find, requestId: '' }); } })}>Book</Button></span></li>)}</ul>)}
        </Section>
      )}
      <Section title="Next two weeks" actions={readOnly ? null : <span className="btn-row">
        <Button disabled={busy === 'rem'} onClick={() => run('rem', '/api/residential/appointments', { op: 'reminders', companyId }, (r: { reminded: number }) => `Reminded ${r.reminded}`)}>Send tomorrow's reminders</Button>
        <Button disabled={busy === 'link'} onClick={async () => { const r = await run<{ url: string }>('link', '/api/residential/appointments', { op: 'booking_link', companyId, kind: find.kind === 'DESIGN' ? 'DISCOVERY' : find.kind }, 'Booking link made'); if (r) setLink(r.url); }}>New booking link</Button></span>}>
        {link && <InlineNotice tone="info" title="Copy this link now.">It is shown once: <code>{link}</code></InlineNotice>}
        {(d.links ?? []).filter((l) => l.is_active && !l.revoked_at).map((l) => <p key={l.id} className="l2">Booking link “{l.label}” · {l.kind.toLowerCase()} · {l.expires_at ? `expires ${l.expires_at.slice(0, 10)}` : 'no expiry'}
          {!readOnly && <> <Button variant="quiet" disabled={busy === `rv${l.id}`} onClick={() => { if (window.confirm('Turn this booking link off? Anyone holding it can no longer book.')) void run(`rv${l.id}`, '/api/residential/appointments', { op: 'revoke_link', linkId: l.id }, 'Link turned off'); }}>Turn off</Button></>}</p>)}
        {d.appointments.length === 0 ? <Empty title="Nothing booked" body="Booked visits show here with their rep, address and status." /> :
          <div className="mp-table"><QueueTable aria-label="Appointments" columns={cols} rows={d.appointments} getRowId={(a) => a.id} rowState={(a) => ({ attn: a.status === 'REQUESTED' })} /></div>}
      </Section>
    </div>
  );
}
