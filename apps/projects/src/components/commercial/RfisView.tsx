'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, Drawer, Field, Input, Seg, Select, Tag, Textarea, WidgetState, count } from '@meritbooks/merit-ui';
import { stamp } from '@/lib/time';
import { RFI_STATUS } from '@/lib/commercial/labels';
import { BALL_WORDS, type BallKind, type RfiResponseRow, type RfiRow } from '@/lib/commercial/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, day, daysSince, dueText } from './common';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'open' | 'answered' | 'closed' | 'all';
const BALLS: readonly BallKind[] = ['ARCHITECT', 'ENGINEER', 'OWNER', 'INTERNAL', 'SUB', 'OTHER'];

/**
 * The RFI log (CGC-64): numbered per job, due from the contract's response days, the ball in
 * court always named, the official answer distinguished from the conversation, and a cost or
 * schedule impact turned into a change event in one step. Private RFIs stay with the author's team.
 */
export function RfisView({ rfis, jobs, today, initialId }: { rfis: RfiRow[]; jobs: JobOption[]; today: string; initialId?: string | null }) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [jobId, setJobId] = useState('');
  const [tab, setTab] = useState<Tab>('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<RfiRow | null>(() => rfis.find((r) => r.id === initialId) ?? null);
  const [adding, setAdding] = useState(false);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = rfis.filter((r) => !jobId || r.job_id === jobId);
  const needle = q.trim().toLowerCase();
  const shown = inJob
    .filter((r) => tab === 'all' || (tab === 'open' ? r.status === 'OPEN' || r.status === 'DRAFT' : tab === 'answered' ? r.status === 'ANSWERED' : r.status === 'CLOSED'))
    .filter((r) => !needle || `${r.number} ${r.subject} ${r.spec_section ?? ''} ${r.drawing_ref ?? ''}`.toLowerCase().includes(needle));
  const overdue = inJob.filter((r) => r.status === 'OPEN' && r.due_on && r.due_on < today).length;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open || rfis.some((r) => r.job_id === j.id))} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <Field label="Find"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, subject, spec, sheet" style={{ width: 220 }} /></Field>
        <Seg aria-label="Which RFIs" value={tab} onChange={setTab} items={[
          { value: 'open', label: 'Open', count: inJob.filter((r) => r.status === 'OPEN' || r.status === 'DRAFT').length },
          { value: 'answered', label: 'Answered', count: inJob.filter((r) => r.status === 'ANSWERED').length },
          { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {overdue > 0 && <Tag tone="neg">{count(overdue)} overdue</Tag>}
        {!readOnly && <Button icon="plus" onClick={() => setAdding((v) => !v)}>New RFI</Button>}
      </div>
      <Failure text={error} />
      {adding && !readOnly && <NewRfi jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} busy={busy === 'add'}
        onSave={async (b) => { const r = await act<{ number: string }>('add', 'post', '/api/commercial/rfis', b, (d) => `Opened ${d.number}`); if (r) setAdding(false); return !!r; }} />}
      <div className="mp-table">
        {shown.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: needle ? 'No RFIs match' : tab === 'open' ? 'No open RFIs' : 'Nothing here', body: 'Ask the design team in writing: the question, the sheet and spec section, your suggested answer, and when you need it. The log is the record if the answer changes the price or the schedule.' }} />
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th style={{ width: 92 }}>Number</th><th>Subject</th><th style={{ width: 170 }}>Ball in court</th><th style={{ width: 150 }}>Due</th><th style={{ width: 120 }}>Status</th><th style={{ width: 120 }}>Impact</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const late = r.status === 'OPEN' && r.due_on && r.due_on < today;
                return (
                  <tr key={r.id} className="q-row" onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                    <td><span className="code">{r.number}</span></td>
                    <td>
                      <span className="b">{r.subject}</span>{r.is_private && <> <Tag>Private</Tag></>}{r.priority === 'URGENT' || r.priority === 'HIGH' ? <> <Tag tone="warn">{r.priority === 'URGENT' ? 'Urgent' : 'High'}</Tag></> : null}
                      <span className="ops-sub" style={{ display: 'block' }}>{[!jobId ? byJob.get(r.job_id)?.label : null, r.spec_section, r.drawing_ref].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td>{r.status === 'OPEN' ? (r.ball_in_court_name ?? (r.ball_in_court_kind ? BALL_WORDS[r.ball_in_court_kind] : '—')) : '—'}</td>
                    <td>{r.due_on ? <>{day(r.due_on, today)}{r.status === 'OPEN' && <span className={late ? 'ops-sub' : 'ops-sub'} style={{ display: 'block' }}>{late ? <Tag tone="neg">{dueText(r.due_on, today)}</Tag> : dueText(r.due_on, today)}</span>}</> : '—'}</td>
                    <td><Mk map={RFI_STATUS} status={r.status} /></td>
                    <td>{[r.cost_impact === 'YES' ? 'Cost' : null, r.schedule_impact === 'YES' ? 'Schedule' : null].filter(Boolean).join(' + ') || (r.cost_impact === 'TBD' || r.schedule_impact === 'TBD' ? 'Not known' : 'None')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} width={560} title={open ? `${open.number} · ${open.subject}` : ''} eyebrow={open ? byJob.get(open.job_id)?.label ?? 'RFI' : undefined}>
        {open && <RfiDetail rfi={open} version={version} readOnly={readOnly} busy={busy} act={act} today={today} />}
      </Drawer>
    </div>
  );
}

function NewRfi({ jobs, defaultJobId, busy, onSave }: { jobs: JobOption[]; defaultJobId: string; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [subject, setSubject] = useState('');
  const [question, setQuestion] = useState('');
  const [suggested, setSuggested] = useState('');
  const [spec, setSpec] = useState('');
  const [sheet, setSheet] = useState('');
  const [ball, setBall] = useState<BallKind>('ARCHITECT');
  const [ballName, setBallName] = useState('');
  const [ballEmail, setBallEmail] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<'NORMAL' | 'HIGH' | 'URGENT' | 'LOW'>('NORMAL');
  const [cost, setCost] = useState<'YES' | 'NO' | 'TBD'>('TBD');
  const [sched, setSched] = useState<'YES' | 'NO' | 'TBD'>('TBD');
  const [priv, setPriv] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!subject.trim() || !question.trim()) return setErr('Write the subject and the question.');
      if (ballEmail.trim() && !/^\S+@\S+\.\S+$/.test(ballEmail.trim())) return setErr('Use an email address for the reviewer.');
      setErr(null);
      void onSave({
        jobId, subject: subject.trim(), question: question.trim(), suggestedAnswer: suggested.trim() || null, specSection: spec.trim() || null, drawingRef: sheet.trim() || null,
        ballKind: ball, ballName: ballName.trim() || null, ballEmail: ballEmail.trim() || null, dueOn: due || null, priority, costImpact: cost, scheduleImpact: sched, isPrivate: priv, open: true,
      }).then((ok) => { if (ok) { setSubject(''); setQuestion(''); setSuggested(''); } });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Ceiling height at corridor 2" style={{ width: 300 }} /></Field>
        <Field label="Spec section"><Input value={spec} onChange={(e) => setSpec(e.target.value)} maxLength={20} placeholder="09 21 16" style={{ width: 110 }} /></Field>
        <Field label="Sheet"><Input value={sheet} onChange={(e) => setSheet(e.target.value)} maxLength={60} placeholder="A-501" style={{ width: 100 }} /></Field>
      </div>
      <Field label="Question"><Textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={8000} placeholder="What the drawings say, what the field found, what you need decided." /></Field>
      <Field label="Suggested answer"><Textarea value={suggested} onChange={(e) => setSuggested(e.target.value)} maxLength={2000} placeholder="Optional: the answer you propose. It speeds the response." /></Field>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Ball in court"><Select value={ball} onChange={(e) => setBall(e.target.value as BallKind)}>{BALLS.map((b) => <option key={b} value={b}>{BALL_WORDS[b]}</option>)}</Select></Field>
        <Field label="Name"><Input value={ballName} onChange={(e) => setBallName(e.target.value)} maxLength={120} placeholder="Firm or person" style={{ width: 180 }} /></Field>
        <Field label="Email"><Input type="email" value={ballEmail} onChange={(e) => setBallEmail(e.target.value)} maxLength={200} style={{ width: 200 }} /></Field>
        <Field label="Needed by" help="Blank uses the contract's response days."><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option><option value="LOW">Low</option></Select></Field>
        <Field label="Cost impact"><Select value={cost} onChange={(e) => setCost(e.target.value as typeof cost)}><option value="TBD">Not known</option><option value="YES">Yes</option><option value="NO">No</option></Select></Field>
        <Field label="Schedule impact"><Select value={sched} onChange={(e) => setSched(e.target.value as typeof sched)}><option value="TBD">Not known</option><option value="YES">Yes</option><option value="NO">No</option></Select></Field>
        <Check label="Private to our team" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
      </div>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Opening…' : 'Open RFI'}</Button></div>
    </form>
  );
}

function RfiDetail({ rfi, version, readOnly, busy, act, today }: { rfi: RfiRow; version: number; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const d = useDetail<{ rfi: RfiRow; responses: RfiResponseRow[] }>(`/api/commercial/rfis/${rfi.id}`, version);
  const live = d.data?.rfi ?? rfi;
  const url = `/api/commercial/rfis/${rfi.id}`;
  const [body, setBody] = useState('');
  const [official, setOfficial] = useState(false);
  const [author, setAuthor] = useState('');
  const [ball, setBall] = useState<BallKind>(live.ball_in_court_kind ?? 'ARCHITECT');
  const [ballName, setBallName] = useState('');
  const age = daysSince((live.opened_at ?? live.created_at).slice(0, 10), today);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={RFI_STATUS} status={live.status} /></span>
        {live.due_on && <span>Due <b>{day(live.due_on, today)}</b>{live.status === 'OPEN' ? ` (${dueText(live.due_on, today)})` : ''}</span>}
        {live.status === 'OPEN' && <span>With <b>{live.ball_in_court_name ?? (live.ball_in_court_kind ? BALL_WORDS[live.ball_in_court_kind] : '—')}</b></span>}
        {age != null && <span>Open <b>{age}</b> days</span>}
        {live.spec_section && <span>Spec <b>{live.spec_section}</b></span>}
        {live.drawing_ref && <span>Sheet <b>{live.drawing_ref}</b></span>}
      </div>
      <DSection title="Question"><p style={{ whiteSpace: 'pre-wrap' }}>{live.question}</p>{live.suggested_answer && <p className="t-cap" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>Suggested: {live.suggested_answer}</p>}</DSection>
      {live.official_response && <DSection title="Official answer"><p style={{ whiteSpace: 'pre-wrap' }}>{live.official_response}</p>{live.responded_by_name && <p className="t-cap">— {live.responded_by_name}{live.answered_at ? `, ${stamp(live.answered_at)}` : ''}</p>}</DSection>}
      <DSection title="Thread">
        {d.isLoading && !d.data ? <WidgetState state={{ kind: 'loading', label: 'Loading the thread…', lines: 3 }} /> : <Failure text={d.error} title="The thread did not load." />}
        {(d.data?.responses ?? []).length === 0 && !d.isLoading ? <p className="t-cap">No replies yet.</p> : (
          <ul className="feed">{(d.data?.responses ?? []).map((r) => (
            <li key={r.id} style={{ alignItems: 'start' }}>
              <span style={{ minWidth: 0 }}>
                <span className="l1">{r.author_name ?? 'Team'}{r.is_official && <> <Tag tone="pos">Official</Tag></>}{r.via !== 'APP' && <> <Tag>{r.via === 'EMAIL' ? 'By email' : 'Portal'}</Tag></>}</span>
                <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{r.body}</span>
              </span>
              <span className="t">{stamp(r.created_at)}</span>
            </li>
          ))}</ul>
        )}
        {!readOnly && live.status !== 'CLOSED' && live.status !== 'VOID' && (
          <form className="stack" style={{ gap: 8, marginTop: 12 }} onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            const r = await act('respond', 'post', url, { op: 'respond', body: body.trim(), official, authorName: author.trim() || null }, official ? 'Recorded the official answer; the ball is back with the author' : 'Replied');
            if (r) { setBody(''); setOfficial(false); }
          }}>
            <Field label="Reply"><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} /></Field>
            <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Check label="This is the official answer" checked={official} onChange={(e) => setOfficial(e.target.checked)} />
              {official && <Field label="Answered by"><Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Architect of record" maxLength={120} /></Field>}
              <Button type="submit" variant="primary" disabled={!body.trim() || busy !== null}>{busy === 'respond' ? 'Saving…' : 'Post'}</Button>
            </div>
          </form>
        )}
      </DSection>
      {!readOnly && live.status === 'OPEN' && (
        <DSection title="Move the ball">
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="To"><Select value={ball} onChange={(e) => setBall(e.target.value as BallKind)}>{BALLS.map((b) => <option key={b} value={b}>{BALL_WORDS[b]}</option>)}</Select></Field>
            <Field label="Name"><Input value={ballName} onChange={(e) => setBallName(e.target.value)} maxLength={120} style={{ width: 180 }} /></Field>
            <Button disabled={busy !== null} onClick={() => void act('ball', 'post', url, { op: 'ball', kind: ball, membershipId: null, name: ballName.trim() || null, email: null, dueOn: null }, 'Moved the ball')}>Move</Button>
          </div>
        </DSection>
      )}
      {!readOnly && (
        <DSection title="Actions">
          <Actions busy={busy} items={[
            { key: 'open', label: 'Open it', primary: true, onClick: () => void act('open', 'post', url, { op: 'open', dueOn: null }, 'Opened'), hidden: live.status !== 'DRAFT' },
            { key: 'close', label: 'Close', onClick: () => void act('close', 'post', url, { op: 'close' }, 'Closed'), hidden: live.status !== 'ANSWERED' && live.status !== 'OPEN' },
            { key: 'reopen', label: 'Reopen', onClick: () => void act('reopen', 'post', url, { op: 'reopen' }, 'Reopened'), hidden: live.status !== 'CLOSED' },
            { key: 'ce', label: 'Open a change event', onClick: () => void act<{ changeEventId: string }>('ce', 'post', url, { op: 'to_change_event' }, 'Opened a change event from this RFI'), hidden: !!live.change_event_id || live.cost_impact === 'NO' },
          ]} />
          {live.change_event_id && <p className="t-cap" style={{ marginTop: 8 }}><Link className="link" href="/change-events">Its change event is on the change board</Link></p>}
        </DSection>
      )}
    </div>
  );
}
