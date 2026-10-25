'use client';

import { useMemo, useState } from 'react';
import { Button, Drawer, Field, Input, Select, Tag, Textarea, WidgetState, count } from '@meritbooks/merit-ui';
import { MEETING_STATUS } from '@/lib/commercial/labels';
import type { MeetingAttendeeRow, MeetingItemRow, MeetingRow } from '@/lib/commercial/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, day } from './common';

type Act = ReturnType<typeof useOps>['act'];
const TYPES = [['OAC', 'Owner / architect / contractor'], ['SUB_COORDINATION', 'Subcontractor coordination'], ['PRECONSTRUCTION', 'Preconstruction'], ['PREINSTALLATION', 'Pre-installation'],
  ['SAFETY', 'Safety'], ['CLOSEOUT', 'Closeout'], ['OTHER', 'Other']] as const;
type MeetingType = (typeof TYPES)[number][0];
const typeWord = (t: string) => TYPES.find((x) => x[0] === t)?.[1] ?? t;

/**
 * Meetings (CGC-68): numbered series per job, items numbered by meeting (1.01, 2.03) that carry
 * forward until closed, minutes distributed to the attendees with acceptance tracked, and the
 * next meeting created from the last one.
 */
export function MeetingsView({ meetings, items, jobs, today, initialId }: { meetings: MeetingRow[]; items: MeetingItemRow[]; jobs: JobOption[]; today: string; initialId?: string | null }) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [jobId, setJobId] = useState('');
  const [open, setOpen] = useState<MeetingRow | null>(() => meetings.find((m) => m.id === initialId) ?? null);
  const [adding, setAdding] = useState(false);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const shown = meetings.filter((m) => !jobId || m.job_id === jobId);
  const openItems = items.filter((i) => i.status === 'OPEN' && (!jobId || i.job_id === jobId));
  const lateItems = openItems.filter((i) => i.due_on && i.due_on < today);
  const series = [...new Set(shown.map((m) => `${m.job_id}|${m.series_key ?? m.meeting_type}`))];
  const live = open ? meetings.find((m) => m.id === open.id) ?? open : null;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open || meetings.some((m) => m.job_id === j.id))} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <span className="ops-facts"><span><b>{count(openItems.length)}</b> open items</span>{lateItems.length > 0 && <span><Tag tone="neg">{count(lateItems.length)} past due</Tag></span>}</span>
        <span className="sp" />
        {!readOnly && <Button icon="plus" onClick={() => setAdding((v) => !v)}>New meeting</Button>}
      </div>
      <Failure text={error} />
      {adding && !readOnly && <NewMeeting jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} busy={busy === 'add'} onSave={async (b) => {
        const r = await act<{ number: number }>('add', 'post', '/api/commercial/meetings', b, (d) => `Scheduled meeting #${d.number}`);
        if (r) setAdding(false);
        return !!r;
      }} />}
      {shown.length === 0 ? (
        <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'No meetings yet', body: 'Schedule the first OAC or coordination meeting. Items raised carry to the next meeting until someone closes them, so nothing promised in a meeting is lost.' }} /></div>
      ) : series.map((key) => {
        const [jid, sk] = key.split('|') as [string, string];
        const list = shown.filter((m) => m.job_id === jid && (m.series_key ?? m.meeting_type) === sk).sort((a, b) => b.number - a.number);
        return (
          <section key={key} className="mp-table" aria-label={`${typeWord(sk)} meetings`}>
            <div className="row" style={{ padding: '8px 16px', background: 'var(--canvas)', borderBottom: '1px solid var(--line)', gap: 12 }}>
              <span className="b">{typeWord(sk)}</span>{!jobId && <span className="t-cap">{byJob.get(jid)?.label ?? 'Job'}</span>}
              <span style={{ flex: 1 }} />
              <span className="t-cap">{count(items.filter((i) => i.job_id === jid && (i.series_key ?? '') === sk && i.status === 'OPEN').length)} open items</span>
            </div>
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th style={{ width: 64 }}>#</th><th>Meeting</th><th style={{ width: 170 }}>When</th><th style={{ width: 150 }}>Status</th></tr></thead>
              <tbody>{list.map((m) => (
                <tr key={m.id} className="q-row" onClick={() => setOpen(m)} style={{ cursor: 'pointer' }}>
                  <td className="b">{m.number}</td><td>{m.title}</td><td>{m.scheduled_at ? stamp(m.scheduled_at) : '—'}</td><td><Mk map={MEETING_STATUS} status={m.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        );
      })}
      <Drawer open={!!live} onClose={() => setOpen(null)} width={600} title={live ? `${live.title}` : ''} eyebrow={live ? [byJob.get(live.job_id)?.label ?? 'Meeting', typeWord(live.meeting_type)] : undefined}>
        {live && <MeetingDetail m={live} items={items.filter((i) => i.job_id === live.job_id && ((i.series_key ?? '') === (live.series_key ?? '') && i.status === 'OPEN' || i.origin_meeting_id === live.id))}
          version={version} readOnly={readOnly} busy={busy} act={act} today={today} />}
      </Drawer>
    </div>
  );
}

function NewMeeting({ jobs, defaultJobId, busy, onSave }: { jobs: JobOption[]; defaultJobId: string; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [type, setType] = useState<MeetingType>('OAC');
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [where, setWhere] = useState('');
  const [agenda, setAgenda] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      setErr(null);
      void onSave({ jobId, meetingType: type, title: title.trim() || `${typeWord(type)} meeting`, scheduledAt: when ? new Date(when).toISOString() : null, locationText: where.trim() || null, agenda: agenda.trim() || null });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as MeetingType)}>{TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select></Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="OAC meeting" style={{ width: 220 }} /></Field>
        <Field label="When"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Where"><Input value={where} onChange={(e) => setWhere(e.target.value)} maxLength={200} placeholder="Site trailer" style={{ width: 160 }} /></Field>
      </div>
      <Field label="Agenda"><Textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={8000} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Schedule'}</Button></div>
    </form>
  );
}

function MeetingDetail({ m, items, version, readOnly, busy, act, today }: { m: MeetingRow; items: MeetingItemRow[]; version: number; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const d = useDetail<{ attendees: MeetingAttendeeRow[] }>(`/api/commercial/meetings/${m.id}`, version);
  const url = `/api/commercial/meetings/${m.id}`;
  const [minutes, setMinutes] = useState(m.minutes ?? '');
  const [topic, setTopic] = useState('');
  const [owner, setOwner] = useState('');
  const [ownerCo, setOwnerCo] = useState('');
  const [due, setDue] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const editable = m.status !== 'DISTRIBUTED' && m.status !== 'CLOSED' && m.status !== 'CANCELLED';
  const att = d.data?.attendees ?? [];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={MEETING_STATUS} status={m.status} /></span>
        <span>Meeting <b>#{m.number}</b></span>
        {m.scheduled_at && <span>{stamp(m.scheduled_at)}</span>}
        {m.location_text && <span>{m.location_text}</span>}
        {m.distributed_at && <span>Distributed {stamp(m.distributed_at)}</span>}
      </div>
      {m.agenda && <DSection title="Agenda"><p style={{ whiteSpace: 'pre-wrap' }}>{m.agenda}</p></DSection>}

      <DSection title="Items" aside={<span className="t-cap">{count(items.filter((i) => i.status === 'OPEN').length)} open</span>}>
        {items.length === 0 ? <p className="t-cap">No items yet.</p> : (
          <table className="ops-mini">
            <thead><tr><th>Item</th><th>Topic</th><th>Who</th><th>Due</th><th /></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}>
                <td className="b">{i.item_no}</td>
                <td>{i.topic}{i.origin_meeting_id !== m.id && <span className="ops-sub" style={{ display: 'block' }}>Carried forward</span>}</td>
                <td>{[i.owner_name, i.owner_company].filter(Boolean).join(', ') || '—'}</td>
                <td>{day(i.due_on, today)}{i.status === 'OPEN' && i.due_on && i.due_on < today && <> <Tag tone="neg">Late</Tag></>}</td>
                <td>{!readOnly && (i.status === 'OPEN'
                  ? <Button variant="quiet" disabled={busy !== null} onClick={() => void act(`c${i.id}`, 'post', url, { op: 'item_status', itemId: i.id, status: 'CLOSED' }, `Closed ${i.item_no}`)}>Close</Button>
                  : <span className="t-cap">{i.status === 'CLOSED' ? 'Closed' : 'Deferred'}</span>)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {!readOnly && editable && (
          <form className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }} onSubmit={async (e) => {
            e.preventDefault();
            if (!topic.trim()) return;
            const r = await act<{ item_no: string }>('item', 'post', url, { op: 'item', topic: topic.trim(), description: null, ownerName: owner.trim() || null, ownerCompany: ownerCo.trim() || null, dueOn: due || null }, (x) => `Added item ${x.item_no}`);
            if (r) { setTopic(''); setOwner(''); setOwnerCo(''); setDue(''); }
          }}>
            <Field label="New item"><Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} placeholder="Confirm ceiling heights" style={{ width: 200 }} /></Field>
            <Field label="Who"><Input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={120} style={{ width: 110 }} /></Field>
            <Field label="Company"><Input value={ownerCo} onChange={(e) => setOwnerCo(e.target.value)} maxLength={120} style={{ width: 110 }} /></Field>
            <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            <Button type="submit" disabled={!topic.trim() || busy !== null}>Add</Button>
          </form>
        )}
      </DSection>

      <DSection title="Attendees" aside={<span className="t-cap">{count(att.filter((a) => a.accepted_minutes_at).length)} of {count(att.length)} accepted the minutes</span>}>
        {d.isLoading && !d.data ? <WidgetState state={{ kind: 'loading', label: 'Loading attendees…', lines: 2 }} /> : <Failure text={d.error} title="Attendees did not load." />}
        {att.length > 0 && <ul className="feed">{att.map((a) => <li key={a.id}><span><span className="l1">{a.name}</span><span className="l2">{[a.company, a.role, a.email].filter(Boolean).join(' · ')}</span></span><span className="t">{a.accepted_minutes_at ? 'Accepted' : m.distributed_at ? 'Not yet' : ''}</span></li>)}</ul>}
        {!readOnly && editable && (
          <form className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }} onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return;
            const r = await act('att', 'post', url, { op: 'attendee', name: name.trim(), company: company.trim() || null, email: email.trim() || null, role: null }, `Added ${name.trim()}`);
            if (r) { setName(''); setCompany(''); setEmail(''); }
          }}>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={{ width: 150 }} /></Field>
            <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} style={{ width: 130 }} /></Field>
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} style={{ width: 170 }} /></Field>
            <Button type="submit" disabled={!name.trim() || busy !== null}>Add</Button>
          </form>
        )}
      </DSection>

      <DSection title="Minutes">
        {editable && !readOnly ? (
          <div className="stack" style={{ gap: 8 }}>
            <Textarea value={minutes} onChange={(e) => setMinutes(e.target.value)} rows={8} maxLength={40000} placeholder="Discussion by item. Decisions in plain words." />
            <div><Button disabled={busy !== null} onClick={() => void act('min', 'post', url, { op: 'minutes', minutes }, 'Saved the minutes')}>Save minutes</Button></div>
          </div>
        ) : <p style={{ whiteSpace: 'pre-wrap' }}>{m.minutes || '—'}</p>}
      </DSection>

      {!readOnly && (
        <Actions busy={busy} items={[
          { key: 'dist', label: 'Distribute minutes', primary: true, onClick: () => void act('dist', 'post', url, { op: 'distribute' }, 'Sent the minutes to the attendees'), hidden: !editable },
          { key: 'next', label: 'Next meeting', onClick: () => void act('next', 'post', url, { op: 'next', scheduledAt: null }, 'Created the next meeting; open items carried forward') },
        ]} />
      )}
    </div>
  );
}
