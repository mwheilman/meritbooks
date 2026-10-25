'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { PhotoButton, SignaturePad, m, type Opt } from './kit';

interface BoardRow { work_order_id: string; number: string; status: string; stage: string; stage_at: string | null; unit: string; customer: string | null; summary: string; promised_on: string | null; checked_in_at: string | null; qc_passed: boolean; tag: string | null; signed: boolean; findings_draft: number; awaiting_approval: number; last_text: { status: string; at: string; kind: string } | null; days_open: number }
interface Day { day: string; capacity_hours: number; booked_hours: number; appointments: number; pickups: number; deliveries: number; free_hours: number }
interface Calendar { days: Day[]; backlog_hours: number; backlog_days: number | null; next_ready_on: string; appointments: Array<{ id: string; number: string; appt_on: string; window_start: string | null; est_hours: number; status: string; customer: string | null; unit: string | null; complaint: string | null; pickup: boolean; quoted_ready_on: string | null; work_order_id: string | null }> }
interface Finding { id: string; description: string; tech_note: string | null; labor_hours: number; amount_cents: number | null; parts: Array<{ part_number: string | null; description: string; qty: number; unit_price_cents: number }>; status: string; estimate_id: string | null; photos: number; decided_by_name: string | null; decision_method: string | null }
interface Desk {
  work_order_id: string; number: string; status: string; job_id: string; unit: string;
  state: { stage: string; qc_passed_at: string | null; ready_at: string | null; picked_up_at: string | null } | null;
  checkin: { id: string; tag_number: string | null; meter: number | null; auth_limit_cents: number | null; complaints: Array<{ text: string } | string>; signed_at: string | null; signature_method: string | null; signer_name: string | null; envelope_id: string | null; photos: number } | null;
  findings: Finding[]; estimates: Array<{ id: string; number: string; status: string; total_cents: number | null; envelope_id: string | null; sent_at: string }>;
  sublets: Array<{ id: string; vendor: string; description: string; status: string; price_cents: number | null; cost_cents: number | null; vendor_bill_ref: string | null }>;
  internal_lines: Array<{ id: string; description: string; pay_type: string; internal_route: string | null }>;
  texts: Array<{ kind: string; status: string; reason: string | null; body: string; at: string }>;
  close_check: { blockers: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; can_close: boolean };
  amounts_visible: boolean;
}

const STAGES = ['CHECKED_IN', 'DIAGNOSING', 'WAITING_APPROVAL', 'WAITING_PARTS', 'IN_PROGRESS', 'QC', 'READY', 'PICKED_UP'] as const;
const STAGE_WORDS: Record<string, string> = { CHECKED_IN: 'Checked in', DIAGNOSING: 'Diagnosing', WAITING_APPROVAL: 'Waiting on the customer', WAITING_PARTS: 'Waiting on parts', IN_PROGRESS: 'In progress', QC: 'QC', READY: 'Ready for pickup', PICKED_UP: 'Picked up' };
const STAGE_KIND: Record<string, 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'> = { WAITING_APPROVAL: 'risk', WAITING_PARTS: 'risk', READY: 'ready', PICKED_UP: 'ready' };
const API = '/api/dealer/service-desk';

type Tab = 'board' | 'book' | 'checkin';

/** The service lane: open ROs by stage, the appointment book against shop capacity, and check-in. */
export function ServiceDesk({ companyId, today, focusWo, customers, units, jobs, vendors }: { companyId: string; today: string; focusWo: string | null; customers: Opt[]; units: Opt[]; jobs: Opt[]; vendors: Opt[] }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('board');
  const [open, setOpen] = useState<string | null>(focusWo);
  const b = useBoard<BoardRow[]>(`${API}?view=board&company=${companyId}`);
  const cols: QueueColumn<BoardRow>[] = [
    { id: 'r', header: 'RO', cell: (r) => <><span className="l1">{r.number} · {r.unit}</span><span className="l2">{[r.customer, r.tag && `tag ${r.tag}`, r.summary].filter(Boolean).join(' · ')}</span></> },
    { id: 's', header: 'Stage', width: 190, cell: (r) => <Status kind={STAGE_KIND[r.stage] ?? 'track'} pip="open">{STAGE_WORDS[r.stage] ?? r.stage}</Status> },
    { id: 'a', header: 'Customer', width: 170, cell: (r) => <>{r.awaiting_approval ? <span className="l1">{r.awaiting_approval} item(s) to approve</span> : r.findings_draft ? <span className="l1">{r.findings_draft} finding(s) to send</span> : <span className="l2">{r.signed ? 'Signed' : 'Not signed'}</span>}{r.last_text && <span className="l2">Text {r.last_text.status} {day(r.last_text.at, today)}</span>}</> },
    { id: 'p', header: 'Promised', width: 100, cell: (r) => day(r.promised_on, today) },
    { id: 'd', header: 'Days', numeric: true, width: 70, cell: (r) => count(r.days_open) },
  ];
  return (
    <div className="stack">
      <Tabs aria-label="Service" value={tab} onChange={setTab} items={[{ value: 'board', label: 'Open ROs', count: b.data ? count(b.data.length) : undefined }, { value: 'book', label: 'Appointments' }, ...(readOnly ? [] : [{ value: 'checkin' as const, label: 'Check in' }])]} />
      {tab === 'board' && (
        <>
          <BoardState b={b} what="Open ROs" />
          {b.data && (b.data.length === 0 ? <Empty title="No open ROs" body="Check a unit in to open its RO; it shows here by stage until the customer picks it up." /> :
            <div className="mp-table"><QueueTable aria-label="Open repair orders" columns={cols} rows={b.data} getRowId={(r) => r.work_order_id} onOpen={(r) => setOpen(r.work_order_id)} openOnClick rowState={(r) => ({ attn: r.stage === 'WAITING_APPROVAL' || (r.promised_on != null && r.promised_on < today) })} /></div>)}
        </>
      )}
      {tab === 'book' && <Appointments companyId={companyId} today={today} customers={customers} units={units} readOnly={readOnly} onOpenRo={setOpen} />}
      {tab === 'checkin' && <CheckIn companyId={companyId} today={today} customers={customers} units={units} jobs={jobs} onDone={(wo) => { b.reload(); setTab('board'); setOpen(wo); }} />}
      {open && <RoDrawer woId={open} today={today} vendors={vendors} onClose={() => { setOpen(null); b.reload(); }} />}
    </div>
  );
}

function Appointments({ companyId, today, customers, units, readOnly, onOpenRo }: { companyId: string; today: string; customers: Opt[]; units: Opt[]; readOnly: boolean; onOpenRo: (wo: string) => void }) {
  const c = useBoard<Calendar>(`${API}?view=calendar&company=${companyId}`);
  const { run, busy, error } = useDo(c.reload);
  const [f, setF] = useState({ apptOn: today, estHours: '1', customerId: '', assetId: '', windowStart: '', complaint: '', pickup: false, address: '' });
  const [last, setLast] = useState<{ over: boolean; ready: string } | null>(null);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={c} what="The appointment book" />
      {c.data && (
        <>
          <p className="t-cap">{qty(c.data.backlog_hours)} hours of approved work in the shop{c.data.backlog_days != null ? ` (about ${c.data.backlog_days} days)` : ''} · next promise date {day(c.data.next_ready_on, today)}</p>
          <table className="ops-mini" aria-label="Shop capacity by day">
            <thead><tr><th>Day</th><th className="n">Tech hours</th><th className="n">Booked</th><th className="n">Free</th><th className="n">Pickups / deliveries</th></tr></thead>
            <tbody>{c.data.days.map((d) => <tr key={d.day} className={Number(d.booked_hours) > Number(d.capacity_hours) ? 'neg' : undefined}><td>{day(d.day, today)}</td><td className="n">{qty(d.capacity_hours)}</td><td className="n">{qty(d.booked_hours)}</td><td className="n">{qty(d.free_hours)}</td><td className="n">{count(d.pickups)} / {count(d.deliveries)}</td></tr>)}</tbody>
          </table>
          <Section title="Booked">
            {c.data.appointments.length === 0 ? <Empty title="Nothing booked" body="Book a drop-off below; the promise date accounts for the shop backlog." /> : (
              <table className="ops-mini" aria-label="Appointments">
                <thead><tr><th>When</th><th>Customer / unit</th><th className="n">Hours</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
                <tbody>{c.data.appointments.map((a) => <tr key={a.id}><td>{day(a.appt_on, today)}{a.window_start ? ` ${a.window_start.slice(0, 5)}` : ''}{a.pickup && <div className="t-cap">we pick it up</div>}</td><td>{a.customer ?? '—'}<div className="t-cap">{[a.unit, a.complaint].filter(Boolean).join(' · ')}</div></td><td className="n">{qty(a.est_hours)}</td><td>{a.status.toLowerCase().replace('_', ' ')}{a.quoted_ready_on ? <div className="t-cap">ready by {day(a.quoted_ready_on, today)}</div> : null}</td>
                  <td>{a.work_order_id ? <Button variant="quiet" onClick={() => onOpenRo(a.work_order_id!)}>Open RO</Button> : !readOnly && a.status !== 'CANCELLED' && (
                    <ButtonRow>
                      {a.status === 'BOOKED' && <Button variant="quiet" disabled={busy === a.id} onClick={() => void run(a.id, API, { op: 'update_appointment', appointmentId: a.id, status: 'CONFIRMED' }, 'Confirmed')}>Confirm</Button>}
                      <Button variant="quiet" disabled={busy === a.id} onClick={() => void run(a.id, API, { op: 'update_appointment', appointmentId: a.id, status: 'NO_SHOW' }, 'Marked no-show')}>No-show</Button>
                      <Button variant="quiet" disabled={busy === a.id} onClick={() => void run(a.id, API, { op: 'update_appointment', appointmentId: a.id, status: 'CANCELLED' }, 'Cancelled')}>Cancel</Button>
                    </ButtonRow>)}</td></tr>)}</tbody>
              </table>
            )}
          </Section>
        </>
      )}
      {!readOnly && (
        <Section title="Book a drop-off" meta="Over the day's tech hours is allowed; the promise date moves out">
          <div className="ops-toolbar">
            <Field label="Day"><Input type="date" value={f.apptOn} min={today} onChange={(e) => setF({ ...f, apptOn: e.target.value })} /></Field>
            <Field label="Time"><Input type="time" value={f.windowStart} onChange={(e) => setF({ ...f, windowStart: e.target.value })} /></Field>
            <Field label="Hours"><Input inputMode="decimal" value={f.estHours} onChange={(e) => setF({ ...f, estHours: e.target.value })} style={{ width: 70 }} /></Field>
            <Field label="Customer"><Select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Pick the customer</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
            <Field label="Unit"><Select value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })}><option value="">Unit (optional)</option>{units.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
          </div>
          <Field label="What it needs"><Input value={f.complaint} onChange={(e) => setF({ ...f, complaint: e.target.value })} /></Field>
          <div className="ops-toolbar">
            <Field label="We pick it up"><Select value={f.pickup ? 'y' : 'n'} onChange={(e) => setF({ ...f, pickup: e.target.value === 'y' })}><option value="n">No, they drop it off</option><option value="y">Yes, add a truck stop</option></Select></Field>
            {f.pickup && <Field label="Pickup address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} style={{ width: 260 }} /></Field>}
          </div>
          <Button variant="primary" disabled={!f.apptOn || busy === 'book'} onClick={async () => {
            const r = await run<{ over_capacity: boolean; quoted_ready_on: string }>('book', API, { op: 'book', companyId, apptOn: f.apptOn, estHours: Number(f.estHours) > 0 ? Number(f.estHours) : 1, customerId: f.customerId || null, assetId: f.assetId || null,
              windowStart: f.windowStart || null, complaint: f.complaint || null, pickup: f.pickup, address: f.address || null }, (d) => `Booked; ready by ${d.quoted_ready_on}`);
            if (r) { setLast({ over: r.over_capacity, ready: r.quoted_ready_on }); setF({ ...f, complaint: '', assetId: '' }); }
          }}>Book it</Button>
          {last?.over && <InlineNotice tone="warn" title="That day is over capacity.">The shop is booked past its tech hours; the promise date is {day(last.ready, today)}. Offer another day if the customer is flexible.</InlineNotice>}
        </Section>
      )}
    </div>
  );
}

function CheckIn({ companyId, today, customers, units, jobs, onDone }: { companyId: string; today: string; customers: Opt[]; units: Opt[]; jobs: Opt[]; onDone: (wo: string) => void }) {
  const { run, busy, error } = useDo(() => undefined);
  const [f, setF] = useState({ unitId: '', customerId: '', jobId: '', complaints: '', meter: '', tag: '', limit: '', deposit: '', promisedOn: '', payer: 'CUSTOMER', photos: [] as string[] });
  const lines = f.complaints.split('\n').map((s) => s.trim()).filter(Boolean);
  return (
    <Section title="Check a unit in" meta="Opens the RO with one line per complaint, records the meter and tag, and texts the customer that it is in">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="Unit"><Select value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}><option value="">Pick the unit</option>{units.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        <Field label="Customer"><Select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">The unit's owner</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        <Field label="RO job"><Select value={f.jobId} onChange={(e) => setF({ ...f, jobId: e.target.value })}><option value="">Open a new service job</option>{jobs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        <Field label="Paid by"><Select value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })}><option value="CUSTOMER">Customer</option><option value="OEM">Warranty (OEM)</option><option value="INTERNAL">Internal</option></Select></Field>
      </div>
      <Field label="Complaints (one per line)"><Textarea rows={3} value={f.complaints} onChange={(e) => setF({ ...f, complaints: e.target.value })} placeholder={'Deck vibrates at full throttle\nAnnual service'} /></Field>
      <div className="ops-toolbar">
        <Field label="Meter (hours)"><Input inputMode="decimal" value={f.meter} onChange={(e) => setF({ ...f, meter: e.target.value })} style={{ width: 100 }} /></Field>
        <Field label="Tag"><Input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} style={{ width: 80 }} /></Field>
        <Field label="OK to spend up to ($)"><Input inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} style={{ width: 110 }} /></Field>
        <Field label="Deposit ($)"><Input inputMode="decimal" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} style={{ width: 100 }} /></Field>
        <Field label="Promised"><Input type="date" min={today} value={f.promisedOn} onChange={(e) => setF({ ...f, promisedOn: e.target.value })} /></Field>
        <PhotoButton url="/api/dealer/uploads" label={`Walk-around photo${f.photos.length ? ` (${f.photos.length})` : ''}`} onFiled={(id) => setF({ ...f, photos: [...f.photos, id] })} />
      </div>
      <Button variant="primary" disabled={!f.unitId || !lines.length || busy === 'ci'} onClick={async () => {
        const r = await run<{ work_order_id: string }>('ci', API, { op: 'check_in', companyId, unitId: f.unitId, customerId: f.customerId || null, jobId: f.jobId || null, complaints: lines.map((text) => ({ text })),
          meter: f.meter ? Number(f.meter) : null, tagNumber: f.tag || null, authLimitCents: centsFrom(f.limit), depositCents: centsFrom(f.deposit), promisedOn: f.promisedOn || null, payerType: f.payer, photoIds: f.photos }, 'Checked in; the RO is open');
        if (r) onDone(r.work_order_id);
      }}>Check in</Button>
    </Section>
  );
}

function RoDrawer({ woId, today, vendors, onClose }: { woId: string; today: string; vendors: Opt[]; onClose: () => void }) {
  const { readOnly } = useShell();
  const d = useBoard<Desk>(`${API}?view=ro&wo=${woId}`);
  const { run, busy, error } = useDo(d.reload);
  const [txt, setTxt] = useState('');
  const [sig, setSig] = useState<{ name: string; phone: string; doc: string | null }>({ name: '', phone: '', doc: null });
  const [fd, setFd] = useState({ description: '', hours: '', rate: '', parts: '', photos: [] as string[] });
  const [sub, setSub] = useState({ vendorId: '', description: '', cost: '', price: '' });
  const [qc, setQc] = useState('Test run\nFluids topped\nWash');
  const [pickup, setPickup] = useState('');
  const x = d.data;
  const draft = x?.findings.filter((f) => f.status === 'DRAFT') ?? [];
  const sentEst = x?.estimates.find((e) => e.status === 'SENT') ?? null;
  return (
    <Drawer open onClose={onClose} width={720} title={x ? `RO ${x.number}` : 'Repair order'} meta={x ? `${x.unit} · ${x.status.toLowerCase()}` : undefined}>
      <div className="stack" style={{ padding: 16 }}>
        {error && <Failure text={error} />}
        <BoardState b={d} what="The RO" />
        {x && (
          <>
            <Section title="Stage" meta={x.state ? STAGE_WORDS[x.state.stage] : 'Checked in'}>
              {!readOnly && <ButtonRow>{STAGES.filter((s) => s !== x.state?.stage && s !== 'PICKED_UP' && s !== 'QC').map((s) => <Button key={s} variant="quiet" disabled={busy === s} onClick={() => void run(s, API, { op: 'set_stage', woId, stage: s }, `${STAGE_WORDS[s]}${s === 'READY' || s === 'WAITING_PARTS' || s === 'WAITING_APPROVAL' ? ' (texted)' : ''}`)}>{STAGE_WORDS[s]}</Button>)}</ButtonRow>}
              {!readOnly && (
                <ButtonRow>
                  <Input aria-label="Text the customer" value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="Text the customer" style={{ minWidth: 320 }} />
                  <Button disabled={!txt.trim() || busy === 'txt'} onClick={() => void run('txt', API, { op: 'text_customer', woId, body: txt.trim() }, 'Text queued').then(() => setTxt(''))}>Send</Button>
                  <Button variant="quiet" onClick={async () => { const r = await fetch(`${API}?view=reply&wo=${woId}`).then((y) => y.json() as Promise<{ reply?: string }>); if (r.reply) setTxt(r.reply); }}>Draft a status reply</Button>
                </ButtonRow>
              )}
              {x.texts.length > 0 && <ul className="t-cap">{x.texts.slice(0, 5).map((t, i) => <li key={i}>{day(t.at, today)} · {t.kind.toLowerCase()} · {t.status}{t.reason ? ` (${t.reason})` : ''}: {t.body}</li>)}</ul>}
            </Section>
            {x.checkin && (
              <Section title="Check-in" meta={x.checkin.signed_at ? `Signed by ${x.checkin.signer_name ?? 'the customer'} ${day(x.checkin.signed_at, today)}` : x.checkin.envelope_id ? 'Signature link sent' : 'Not signed'}>
                <p className="t-cap">{[x.checkin.tag_number && `Tag ${x.checkin.tag_number}`, x.checkin.meter != null && `${qty(x.checkin.meter)} hours`, x.checkin.auth_limit_cents != null && `OK to ${m(x.checkin.auth_limit_cents)}`, `${count(x.checkin.photos)} photos`].filter(Boolean).join(' · ')}</p>
                {!readOnly && !x.checkin.signed_at && (
                  <div className="stack">
                    <Field label="Customer name"><Input value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} /></Field>
                    <SignaturePad url="/api/dealer/uploads" onFiled={(doc) => setSig({ ...sig, doc })} />
                    <ButtonRow>
                      <Button variant="primary" disabled={!sig.name.trim() || busy === 'sig'} onClick={() => void run('sig', API, { op: 'counter_signature', checkinId: x.checkin!.id, signer: sig.name.trim(), documentId: sig.doc }, 'Signed at the counter')}>Signed at the counter</Button>
                      <Input aria-label="Mobile number" value={sig.phone} onChange={(e) => setSig({ ...sig, phone: e.target.value })} placeholder="Mobile number" style={{ width: 160 }} />
                      <Button disabled={!sig.name.trim() || !sig.phone.trim() || busy === 'sms'} onClick={() => void run('sms', `${API}/${woId}/sign`, { kind: 'checkin', name: sig.name.trim(), phone: sig.phone.trim() }, 'Signature link texted')}>Text a signature link</Button>
                    </ButtonRow>
                  </div>
                )}
              </Section>
            )}
            <Section title="Added work" meta={sentEst ? `Estimate ${sentEst.number} waiting on the customer` : `${count(draft.length)} finding(s) not sent`}>
              {x.findings.length === 0 ? <p className="t-cap">Technicians add what they find, with photos; the customer approves it by text.</p> : (
                <table className="ops-mini" aria-label="Findings">
                  <thead><tr><th>Finding</th><th className="n">Amount</th><th>Status</th></tr></thead>
                  <tbody>{x.findings.map((f) => <tr key={f.id}><td>{f.description}<div className="t-cap">{[f.labor_hours ? `${qty(f.labor_hours)} h` : null, ...f.parts.map((p) => `${qty(p.qty)} × ${p.part_number ?? p.description}`), f.photos ? `${f.photos} photos` : null].filter(Boolean).join(' · ')}</div></td><td className="n">{m(f.amount_cents)}</td><td>{f.status.toLowerCase()}{f.decided_by_name ? <div className="t-cap">{f.decided_by_name} · {(f.decision_method ?? '').toLowerCase().replace('_', ' ')}</div> : null}</td></tr>)}</tbody>
                </table>
              )}
              {!readOnly && x.status !== 'CLOSED' && (
                <div className="stack">
                  <div className="ops-toolbar">
                    <Field label="What you found"><Input value={fd.description} onChange={(e) => setFd({ ...fd, description: e.target.value })} style={{ minWidth: 260 }} /></Field>
                    <Field label="Labor hours"><Input inputMode="decimal" value={fd.hours} onChange={(e) => setFd({ ...fd, hours: e.target.value })} style={{ width: 80 }} /></Field>
                    <Field label="Rate ($/h)"><Input inputMode="decimal" value={fd.rate} onChange={(e) => setFd({ ...fd, rate: e.target.value })} style={{ width: 90 }} /></Field>
                    <PhotoButton url="/api/dealer/uploads" label={`Photo${fd.photos.length ? ` (${fd.photos.length})` : ''}`} onFiled={(id) => setFd({ ...fd, photos: [...fd.photos, id] })} />
                  </div>
                  <Field label="Parts (part number × qty × price, one per line)"><Textarea rows={2} value={fd.parts} onChange={(e) => setFd({ ...fd, parts: e.target.value })} placeholder="M123 × 1 × 45.00" /></Field>
                  <ButtonRow>
                    <Button disabled={!fd.description.trim() || busy === 'fd'} onClick={() => {
                      const parts = fd.parts.split('\n').map((l) => l.split(/[×x*]/).map((s) => s.trim())).filter((p) => p[0]).map((p) => ({ part_number: p[0], description: p[0], qty: Number(p[1]) || 1, unit_price_cents: centsFrom(p[2] ?? '') ?? 0 }));
                      void run('fd', API, { op: 'add_finding', woId, description: fd.description.trim(), laborHours: Number(fd.hours) || 0, laborRateCents: centsFrom(fd.rate) ?? 0, parts, photoIds: fd.photos }, 'Finding added').then((r) => { if (r) setFd({ description: '', hours: '', rate: '', parts: '', photos: [] }); });
                    }}>Add the finding</Button>
                    {draft.length > 0 && <Button variant="primary" disabled={busy === 'est'} onClick={() => void run<{ over_auth_limit: boolean; total_cents: number }>('est', API, { op: 'send_estimate', woId, findings: draft.map((f) => f.id) }, (r) => `Estimate ${m(r.total_cents)} ready${r.over_auth_limit ? ' (over the OK-to-spend limit)' : ''}`)}>Make the estimate ({draft.length})</Button>}
                  </ButtonRow>
                  {sentEst && (
                    <div className="stack">
                      <ButtonRow>
                        <Input aria-label="Customer name" value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} placeholder="Customer name" />
                        <Input aria-label="Mobile number" value={sig.phone} onChange={(e) => setSig({ ...sig, phone: e.target.value })} placeholder="Mobile number" style={{ width: 160 }} />
                        <Button variant="primary" disabled={!sig.name.trim() || !sig.phone.trim() || busy === 'esms'} onClick={() => void run('esms', `${API}/${woId}/sign`, { kind: 'estimate', estimateId: sentEst.id, name: sig.name.trim(), phone: sig.phone.trim() }, 'Approval link texted')}>Text it for approval</Button>
                      </ButtonRow>
                      <ButtonRow>
                        <span className="t-cap">Or record the answer from a call:</span>
                        <Button disabled={!sig.name.trim() || busy === 'dec'} onClick={() => void run('dec', API, { op: 'decide', estimateId: sentEst.id, name: sig.name.trim(), method: 'PHONE', decisions: x.findings.filter((f) => f.estimate_id === sentEst.id && f.status === 'SENT').map((f) => ({ finding_id: f.id, decision: 'APPROVED' })) }, 'Approved by phone')}>Approved</Button>
                        <Button variant="quiet" disabled={!sig.name.trim() || busy === 'dec'} onClick={() => void run('dec', API, { op: 'decide', estimateId: sentEst.id, name: sig.name.trim(), method: 'PHONE', decisions: x.findings.filter((f) => f.estimate_id === sentEst.id && f.status === 'SENT').map((f) => ({ finding_id: f.id, decision: 'DECLINED' })) }, 'Declined')}>Declined</Button>
                      </ButtonRow>
                    </div>
                  )}
                </div>
              )}
            </Section>
            <Section title="Sublet and shop fees">
              {x.sublets.map((s) => <ButtonRow key={s.id}><span className="l1" style={{ minWidth: 260 }}>{s.vendor}: {s.description}</span><span className="t-cap">{s.status.toLowerCase()} · {m(s.price_cents)}{x.amounts_visible ? ` (cost ${m(s.cost_cents)})` : ''}</span>{!readOnly && s.status === 'OPEN' && <Button variant="quiet" disabled={busy === s.id} onClick={() => void run(s.id, API, { op: 'update_sublet', subletId: s.id, status: 'RECEIVED' }, 'Back from the vendor')}>Back</Button>}</ButtonRow>)}
              {!readOnly && x.status !== 'CLOSED' && (
                <>
                  <div className="ops-toolbar">
                    <Field label="Vendor"><Select value={sub.vendorId} onChange={(e) => setSub({ ...sub, vendorId: e.target.value })}><option value="">Sublet to</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></Field>
                    <Field label="Work"><Input value={sub.description} onChange={(e) => setSub({ ...sub, description: e.target.value })} /></Field>
                    <Field label="Cost ($)"><Input inputMode="decimal" value={sub.cost} onChange={(e) => setSub({ ...sub, cost: e.target.value })} style={{ width: 90 }} /></Field>
                    <Field label="Price ($)"><Input inputMode="decimal" value={sub.price} onChange={(e) => setSub({ ...sub, price: e.target.value })} style={{ width: 90 }} /></Field>
                  </div>
                  <ButtonRow>
                    <Button disabled={!sub.vendorId || !sub.description.trim() || busy === 'sub'} onClick={() => void run('sub', API, { op: 'add_sublet', woId, vendorId: sub.vendorId, description: sub.description.trim(), costCents: centsFrom(sub.cost) ?? 0, priceCents: centsFrom(sub.price) ?? 0 }, 'Sublet added').then(() => setSub({ vendorId: '', description: '', cost: '', price: '' }))}>Add the sublet</Button>
                    <Button variant="quiet" disabled={busy === 'fees'} onClick={() => void run<{ fees: Array<{ label: string; amount_cents: number }> }>('fees', API, { op: 'shop_fees', woId }, (r) => r.fees.length ? r.fees.map((f) => `${f.label} ${m(f.amount_cents)}`).join(', ') : 'No shop fees apply')}>Apply shop fees</Button>
                    <Button variant="quiet" disabled={busy === 'stor'} onClick={() => void run<{ amount_cents: number }>('stor', API, { op: 'storage_fee', woId }, (r) => `Storage ${m(r.amount_cents)} added`)}>Add storage</Button>
                  </ButtonRow>
                </>
              )}
            </Section>
            {x.internal_lines.length > 0 && (
              <Section title="Internal lines" meta="Where the cost goes: the unit (PDI / recon / rental) or shop overhead">
                {x.internal_lines.map((l) => <ButtonRow key={l.id}><span className="l1" style={{ minWidth: 260 }}>{l.description}</span>{readOnly ? <span>{l.internal_route ?? 'Not routed'}</span> :
                  <Select aria-label={`Route for ${l.description}`} value={l.internal_route ?? ''} onChange={(e) => void run(l.id, API, { op: 'internal_route', lineId: l.id, route: e.target.value }, 'Routed')}><option value="" disabled>Route it</option><option value="PDI">PDI (new unit)</option><option value="RECON">Recon (used unit)</option><option value="RENTAL">Rental fleet</option><option value="SHOP">Shop overhead</option><option value="POLICY">Policy / goodwill</option></Select>}</ButtonRow>)}
              </Section>
            )}
            <Section title="QC and close" meta={x.close_check.can_close ? 'Ready to close' : `${count(x.close_check.blockers.length)} thing(s) stop the close`}>
              {x.close_check.blockers.map((b) => <InlineNotice key={b.code} tone="neg" title={b.message}>{''}</InlineNotice>)}
              {x.close_check.warnings.map((w) => <InlineNotice key={w.code} tone="warn" title={w.message}>{''}</InlineNotice>)}
              {!readOnly && !x.state?.qc_passed_at && x.status !== 'CLOSED' && (
                <>
                  <Field label="QC checklist (one per line)"><Textarea rows={3} value={qc} onChange={(e) => setQc(e.target.value)} /></Field>
                  <Button disabled={busy === 'qc'} onClick={() => void run('qc', API, { op: 'qc', woId, checklist: qc.split('\n').map((s) => s.trim()).filter(Boolean).map((item) => ({ item, ok: true })) }, 'QC passed; the customer is texted it is ready')}>QC passed</Button>
                </>
              )}
              {!readOnly && (
                <ButtonRow>
                  {x.status !== 'CLOSED' && <Button variant="primary" disabled={!x.close_check.can_close || busy === 'close'} onClick={() => void run('close', API, { op: 'close', woId }, 'RO closed; Books invoices each payer')}>Close the RO</Button>}
                  {x.status === 'CLOSED' && <Button disabled={busy === 'pay'} onClick={() => void run('pay', API, { op: 'pay_link', woId }, 'Pay link texted')}>Text the pay link</Button>}
                </ButtonRow>
              )}
              {!readOnly && x.state?.stage === 'READY' && (
                <ButtonRow>
                  <Input aria-label="Picked up by" value={pickup} onChange={(e) => setPickup(e.target.value)} placeholder="Picked up by" />
                  <Button disabled={!pickup.trim() || busy === 'pick'} onClick={() => void run('pick', API, { op: 'pickup', woId, signer: pickup.trim() }, 'Picked up')}>Record pickup</Button>
                </ButtonRow>
              )}
              <p className="t-cap"><Link className="nlink" href={`/work-orders?wo=${woId}`}>RO lines, parts and time</Link></p>
            </Section>
          </>
        )}
      </div>
    </Drawer>
  );
}
