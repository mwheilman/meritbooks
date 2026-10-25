'use client';

import { useMemo, useState } from 'react';
import { Button, Drawer, Field, Input, KV, Select, Tabs, Tag, Textarea } from '@meritbooks/merit-ui';
import { CORR_TYPES, awaitingResponse, letterDraft } from '@/lib/commercial/screen-logic';
import type { Correspondence, Transmittal } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, day, dueText } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'letters' | 'transmittals';
const PURPOSES = ['FOR_APPROVAL', 'FOR_REVIEW', 'FOR_INFORMATION', 'FOR_CONSTRUCTION', 'AS_REQUESTED', 'FOR_RECORD'] as const;
const TYPE_WORD = new Map(CORR_TYPES.map((t) => [t.value, t.label]));


/**
 * Transmittals and correspondence (CGC-67): what was sent to whom and why, with the
 * acknowledgement; and the job's letters and notices — delay, claim, backcharge, default,
 * dispute — numbered per type, with the response each one needs and when.
 */
export function CorrespondenceView({ transmittals, letters, jobs, today, canEdit, initialJob }: {
  transmittals: Transmittal[]; letters: Correspondence[]; jobs: JobOption[]; today: string; canEdit: boolean; initialJob?: string | null;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>('letters');
  const [jobId, setJobId] = useState(initialJob ?? '');
  const [type, setType] = useState('');
  const [adding, setAdding] = useState(false);
  const [openT, setOpenT] = useState<string | null>(null);
  const [openL, setOpenL] = useState<string | null>(null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const lt = letters.filter((l) => l.status !== 'VOID' && (!jobId || l.job_id === jobId) && (!type || l.corr_type === type));
  const tr = transmittals.filter((t) => t.status !== 'VOID' && (!jobId || t.job_id === jobId));
  const overdue = lt.filter((l) => awaitingResponse(l) && l.response_required_by! < today).length;
  const unack = tr.filter((t) => t.status === 'SENT').length;
  const edit = !readOnly && canEdit;
  const ol = letters.find((l) => l.id === openL) ?? null;
  const ot = transmittals.find((t) => t.id === openT) ?? null;

  const lcols: Col<Correspondence>[] = [
    { key: 'n', head: 'Number', width: 100, cell: (l) => <span className="code">{l.number ?? '—'}</span> },
    { key: 's', head: 'Subject', cell: (l) => <><span className="b">{l.subject}</span><span className="ops-sub" style={{ display: 'block' }}>{[TYPE_WORD.get(l.corr_type) ?? words(l.corr_type), l.direction === 'INCOMING' ? 'Received' : 'Sent', !jobId ? byJob.get(l.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'to', head: 'To / from', width: 200, cell: (l) => (l.direction === 'INCOMING' ? l.from_name : [l.to_name, l.to_company].filter(Boolean).join(', ')) || '—' },
    { key: 'd', head: 'Dated', width: 110, cell: (l) => day(l.sent_on, today) },
    { key: 'r', head: 'Response needed', width: 170, cell: (l) => (l.responded_on ? <>Answered {day(l.responded_on, today)}</> : l.response_required_by ? <>{day(l.response_required_by, today)}{awaitingResponse(l) && <span style={{ display: 'block' }}><Tag tone={l.response_required_by < today ? 'neg' : 'warn'}>{dueText(l.response_required_by, today)}</Tag></span>}</> : '—') },
    { key: 'st', head: 'Status', width: 110, cell: (l) => <Tag tone={l.status === 'CLOSED' || l.status === 'RESPONDED' ? 'pos' : undefined}>{words(l.status)}</Tag> },
  ];
  const tcols: Col<Transmittal>[] = [
    { key: 'n', head: 'Number', width: 100, cell: (t) => <span className="code">{t.number ?? '—'}</span> },
    { key: 's', head: 'Subject', cell: (t) => <><span className="b">{t.subject}</span><span className="ops-sub" style={{ display: 'block' }}>{[words(t.purpose), `${t.items.length} ${t.items.length === 1 ? 'item' : 'items'}`, !jobId ? byJob.get(t.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'to', head: 'To', width: 220, cell: (t) => [t.to_name, t.to_company].filter(Boolean).join(', ') || '—' },
    { key: 'sent', head: 'Sent', width: 110, cell: (t) => (t.sent_at ? day(t.sent_at.slice(0, 10), today) : '—') },
    { key: 'ack', head: 'Acknowledged', width: 150, cell: (t) => (t.acknowledged_at ? <>{day(t.acknowledged_at.slice(0, 10), today)}{t.acknowledged_by && <span className="ops-sub" style={{ display: 'block' }}>{t.acknowledged_by}</span>}</> : t.status === 'SENT' ? <Tag tone="warn">Waiting</Tag> : '—') },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Tabs aria-label="Document control" value={tab} onChange={(v) => { setTab(v); setAdding(false); }} items={[
        { value: 'letters', label: 'Letters and notices', count: overdue || undefined }, { value: 'transmittals', label: 'Transmittals', count: unack || undefined },
      ]} />
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        {tab === 'letters' && <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Every type</option>{CORR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>}
        <span className="sp" />
        {tab === 'letters' && overdue > 0 && <Tag tone="neg">{overdue} responses overdue</Tag>}
        {edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>{tab === 'letters' ? 'New letter or notice' : 'New transmittal'}</Button>}
      </div>
      <Failure text={error} />
      {adding && edit && tab === 'letters' && <NewLetter jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} today={today} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {adding && edit && tab === 'transmittals' && <NewTransmittal jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {tab === 'letters' && <CmTable label="Letters and notices" keys rows={lt} cols={lcols} rowKey={(l) => l.id} onOpen={(l) => setOpenL(l.id)} activeId={openL}
        rowTone={(l) => (awaitingResponse(l) && l.response_required_by! < today ? 'neg' : null)}
        empty={{ title: 'No letters or notices', body: 'Log every notice the contract requires in writing — delay, claim, backcharge, default — and the date a response is due. A first draft comes from the facts you give it.' }} />}
      {tab === 'transmittals' && <CmTable label="Transmittals" keys rows={tr} cols={tcols} rowKey={(t) => t.id} onOpen={(t) => setOpenT(t.id)} activeId={openT}
        empty={{ title: 'No transmittals', body: 'Record what went out — drawings, samples, O&Ms — to whom and why, and when they acknowledged it.' }} />}
      <TableKeys extra={edit ? [{ chord: 'n', label: 'New' }] : []} />

      <Drawer open={!!ol} onClose={() => setOpenL(null)} width={620} title={ol ? `${ol.number ?? ''} · ${ol.subject}` : ''} eyebrow={ol ? [TYPE_WORD.get(ol.corr_type), byJob.get(ol.job_id)?.label].filter(Boolean).join(' // ') : undefined}>
        {ol && <LetterDetail key={ol.id} l={ol} today={today} edit={edit} busy={busy} act={act} />}
      </Drawer>
      <Drawer open={!!ot} onClose={() => setOpenT(null)} width={560} title={ot ? `${ot.number ?? ''} · ${ot.subject}` : ''} eyebrow={ot ? byJob.get(ot.job_id)?.label : undefined}>
        {ot && <TransmittalDetail key={ot.id} t={ot} edit={edit} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function NewLetter({ jobs, defaultJobId, today, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; today: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [type, setType] = useState('NOTICE_OF_DELAY');
  const [direction, setDirection] = useState<'OUTGOING' | 'INCOMING'>('OUTGOING');
  const [toName, setToName] = useState('');
  const [toCompany, setToCompany] = useState('');
  const [fromName, setFromName] = useState('');
  const [event, setEvent] = useState('');
  const [days, setDays] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sentOn, setSentOn] = useState(today);
  const [respBy, setRespBy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === jobId);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!subject.trim()) return setErr('Give it a subject.');
      setErr(null);
      const r = await act<{ number: string }>('letter', 'post', '/api/commercial/correspondence', {
        op: 'letter', jobId, corrType: type, direction, subject: subject.trim(), body: body.trim() || null, fromName: fromName.trim() || null, toName: toName.trim() || null,
        toCompany: toCompany.trim() || null, sentOn: sentOn || null, responseRequiredBy: respBy || null, changeEventId: null,
      }, (d) => `Logged ${d.number}`);
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{CORR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
        <Field label="Direction"><Select value={direction} onChange={(e) => setDirection(e.target.value as 'OUTGOING' | 'INCOMING')}><option value="OUTGOING">We sent it</option><option value="INCOMING">We received it</option></Select></Field>
        <Field label="Dated"><Input type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)} /></Field>
        <Field label="Response needed by"><Input type="date" value={respBy} onChange={(e) => setRespBy(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="To"><Input value={toName} onChange={(e) => setToName(e.target.value)} maxLength={200} /></Field>
        <Field label="Company"><Input value={toCompany} onChange={(e) => setToCompany(e.target.value)} maxLength={200} /></Field>
        <Field label="From"><Input value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={200} /></Field>
      </div>
      {direction === 'OUTGOING' && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="What happened" help="The event in a phrase; the draft is built around it."><Input value={event} onChange={(e) => setEvent(e.target.value)} maxLength={300} placeholder="late structural steel delivery" style={{ width: 320 }} /></Field>
          {type === 'NOTICE_OF_DELAY' && <Field label="Days (estimate)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 80 }} /></Field>}
          <Button onClick={() => { const d = letterDraft(type, { jobLabel: job?.label ?? 'the project', toName: toName || null, toCompany: toCompany || null, fromName: fromName || null, date: sentOn || today, event: event || null, days: days ? Number(days) : null }); setSubject(d.subject); setBody(d.body); }}>Draft it</Button>
        </div>
      )}
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
      <Field label="Body"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'letter' ? 'Saving…' : 'Log it'}</Button></div>
    </form>
  );
}

function NewTransmittal({ jobs, defaultJobId, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [subject, setSubject] = useState('');
  const [toName, setToName] = useState('');
  const [toCompany, setToCompany] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [purpose, setPurpose] = useState<string>('FOR_REVIEW');
  const [items, setItems] = useState([{ description: '', copies: 1 }]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId || !subject.trim()) return setErr('Pick the job and give it a subject.');
      if (toEmail.trim() && !/^\S+@\S+\.\S+$/.test(toEmail.trim())) return setErr('Use an email address.');
      setErr(null);
      const r = await act<{ number: string }>('tr', 'post', '/api/commercial/correspondence', {
        op: 'transmittal', jobId, subject: subject.trim(), toName: toName.trim() || null, toCompany: toCompany.trim() || null, toEmail: toEmail.trim() || null, purpose,
        items: items.filter((i) => i.description.trim()).map((i) => ({ description: i.description.trim(), copies: i.copies, document_id: null })), notes: notes.trim() || null,
      }, (d) => `Created ${d.number}`);
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} style={{ width: 280 }} /></Field>
        <Field label="Purpose"><Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>{PURPOSES.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="To"><Input value={toName} onChange={(e) => setToName(e.target.value)} maxLength={200} /></Field>
        <Field label="Company"><Input value={toCompany} onChange={(e) => setToCompany(e.target.value)} maxLength={200} /></Field>
        <Field label="Email"><Input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} maxLength={200} /></Field>
      </div>
      <DSection title="What is enclosed" aside={<Button variant="quiet" onClick={() => setItems((x) => [...x, { description: '', copies: 1 }])}>Add item</Button>}>
        {items.map((it, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
            <Field label={`Item ${i + 1}`}><Input value={it.description} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} maxLength={300} style={{ width: 340 }} placeholder="Shop drawings, rev 2, sheets S-1 to S-14" /></Field>
            <Field label="Copies"><Input inputMode="numeric" value={String(it.copies)} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, copies: Math.min(99, Math.max(1, Number(e.target.value.replace(/[^0-9]/g, '')) || 1)) } : y)))} style={{ width: 70 }} /></Field>
            {items.length > 1 && <Button variant="quiet" onClick={() => setItems((x) => x.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
        ))}
      </DSection>
      <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'tr' ? 'Saving…' : 'Create the transmittal'}</Button></div>
    </form>
  );
}

function LetterDetail({ l, today, edit, busy, act }: { l: Correspondence; today: string; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/correspondence/${l.id}`;
  const [respOn, setRespOn] = useState(today);
  const set = (status: string, ok: string, extra: Record<string, unknown> = {}) => void act(`s:${status}`, 'post', url, { kind: 'letter', status, ...extra }, ok);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Direction', value: l.direction === 'INCOMING' ? 'Received' : 'Sent' }, { term: 'To', value: [l.to_name, l.to_company].filter(Boolean).join(', ') || '—' },
        { term: 'From', value: l.from_name ?? '—' }, { term: 'Dated', value: day(l.sent_on, today) },
        { term: 'Response needed by', value: l.response_required_by ? `${day(l.response_required_by, today)}${awaitingResponse(l) ? ` (${dueText(l.response_required_by, today)})` : ''}` : 'None' },
        { term: 'Answered', value: l.responded_on ? day(l.responded_on, today) : '—' }, { term: 'Status', value: words(l.status) },
      ]} />
      {l.body && <div className="cm-letter">{l.body}</div>}
      {edit && (
        <DSection title="Move it along">
          <Actions busy={busy} items={[
            { key: 's:SENT', label: 'Mark sent', primary: true, onClick: () => set('SENT', 'Marked sent'), hidden: l.status !== 'DRAFT' || l.direction === 'INCOMING' },
            { key: 's:RECEIVED', label: 'Mark received', onClick: () => set('RECEIVED', 'Marked received'), hidden: l.status !== 'DRAFT' || l.direction !== 'INCOMING' },
            { key: 's:CLOSED', label: 'Close', onClick: () => set('CLOSED', 'Closed'), hidden: l.status === 'CLOSED' },
            { key: 's:VOID', label: 'Void', danger: true, onClick: () => set('VOID', 'Voided'), hidden: l.status === 'CLOSED' },
          ]} />
          {(l.status === 'SENT' || l.status === 'RECEIVED') && !l.responded_on && (
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', marginTop: 12 }}>
              <Field label="Answered on"><Input type="date" value={respOn} onChange={(e) => setRespOn(e.target.value)} /></Field>
              <Button disabled={busy !== null} onClick={() => set('RESPONDED', 'Logged the response', { respondedOn: respOn || null })}>Log the response</Button>
            </div>
          )}
        </DSection>
      )}
      <div className="ops-noprint"><Button variant="quiet" onClick={() => window.print()}>Print</Button></div>
    </div>
  );
}

function TransmittalDetail({ t, edit, busy, act }: { t: Transmittal; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/correspondence/${t.id}`;
  const [by, setBy] = useState('');
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'To', value: [t.to_name, t.to_company].filter(Boolean).join(', ') || '—' }, { term: 'Email', value: t.to_email ?? '—' }, { term: 'Purpose', value: words(t.purpose) },
        { term: 'Sent', value: t.sent_at ? stamp(t.sent_at) : 'Not yet' }, { term: 'Acknowledged', value: t.acknowledged_at ? `${stamp(t.acknowledged_at)}${t.acknowledged_by ? ` by ${t.acknowledged_by}` : ''}` : 'Not yet' },
      ]} />
      <DSection title="Enclosed">
        {t.items.length === 0 ? <p className="t-cap">No items listed.</p> : <ul className="feed">{t.items.map((i, k) => <li key={k}><span>{i.description}</span><span className="t tnum">{i.copies ?? 1} {i.copies === 1 ? 'copy' : 'copies'}</span></li>)}</ul>}
      </DSection>
      {t.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{t.notes}</p>}
      {edit && t.status !== 'ACKNOWLEDGED' && (
        <DSection title="Move it along">
          {t.status === 'DRAFT' && <Actions busy={busy} items={[{ key: 'sent', label: 'Mark sent', primary: true, onClick: () => void act('sent', 'post', url, { kind: 'transmittal', status: 'SENT', acknowledgedBy: null }, 'Marked sent') }]} />}
          {t.status === 'SENT' && (
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Acknowledged by"><Input value={by} onChange={(e) => setBy(e.target.value)} maxLength={200} /></Field>
              <Button variant="primary" disabled={busy !== null} onClick={() => void act('ack', 'post', url, { kind: 'transmittal', status: 'ACKNOWLEDGED', acknowledgedBy: by.trim() || null }, 'Recorded the acknowledgement')}>Record acknowledgement</Button>
            </div>
          )}
          <div style={{ marginTop: 8 }}><Button variant="danger" disabled={busy !== null} onClick={() => void act('void', 'post', url, { kind: 'transmittal', status: 'VOID', acknowledgedBy: null }, 'Voided')}>Void</Button></div>
        </DSection>
      )}
    </div>
  );
}
