'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, Field, InlineNotice, Input, KV, Seg, Select, Tag, Textarea } from '@meritbooks/merit-ui';
import type { Observation } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, day, dueText } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'open' | 'review' | 'closed' | 'all';
const TYPES = ['QUALITY', 'SAFETY', 'COMMISSIONING', 'ENVIRONMENTAL', 'WARRANTY'] as const;
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const RANK: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const OPEN = new Set(['OPEN', 'IN_PROGRESS']);

/** Open first by priority, then the earliest due. Pure. */
export function sortObservations(xs: ReadonlyArray<Observation>): Observation[] {
  return [...xs].sort((a, b) => Number(!OPEN.has(a.status)) - Number(!OPEN.has(b.status)) || (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9) || (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'));
}

/** The responsible sub with three or more observations on a job — a backcharge candidate (CGC-39). Pure. */
export function repeatOffenders(xs: ReadonlyArray<Observation>, min = 3): Array<{ jobId: string; key: string; name: string; count: number }> {
  const m = new Map<string, { jobId: string; key: string; name: string; count: number }>();
  for (const o of xs) {
    if (o.obs_type !== 'QUALITY' || o.status === 'VOID') continue;
    const who = o.assignee_vendor_id ?? o.assignee_name;
    if (!who) continue;
    const key = `${o.job_id}|${who}`;
    const g = m.get(key) ?? { jobId: o.job_id, key, name: o.assignee_name ?? 'Subcontractor', count: 0 };
    g.count += 1;
    m.set(key, g);
  }
  return [...m.values()].filter((g) => g.count >= min).sort((a, b) => b.count - a.count);
}

/**
 * Observations and issues (CGC-76): quality, safety, commissioning, environmental and warranty
 * findings with priority, hazard, the contributing condition, who fixes it and by when. A sub
 * with repeated quality issues on a job is flagged as a backcharge candidate.
 */
export function ObservationsView({ observations, jobs, vendors, today, canEdit, canChange, onChanged }: {
  observations: Observation[]; jobs: JobOption[]; vendors: Array<{ id: string; name: string }>; today: string; canEdit: boolean; canChange: boolean; onChanged?: () => void;
}) {
  const { readOnly } = useShell();
  const ops = useOps();
  const { busy, error } = ops;
  const act = (async (...a: Parameters<Act>) => { const r = await ops.act(...a); if (r) onChanged?.(); return r; }) as Act;
  const [tab, setTab] = useState<Tab>('open');
  const [jobId, setJobId] = useState('');
  const [type, setType] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = observations.filter((o) => (!jobId || o.job_id === jobId) && (!type || o.obs_type === type));
  const shown = sortObservations(inJob.filter((o) => tab === 'all' || (tab === 'open' ? OPEN.has(o.status) : tab === 'review' ? o.status === 'READY_FOR_REVIEW' : o.status === 'CLOSED')));
  const late = inJob.filter((o) => OPEN.has(o.status) && o.due_on && o.due_on < today).length;
  const repeats = repeatOffenders(inJob);
  const open = observations.find((o) => o.id === openId) ?? null;
  const edit = !readOnly && canEdit;

  const cols: Col<Observation>[] = [
    { key: 'n', head: 'Number', width: 100, cell: (o) => <span className="code">{o.number ?? '—'}</span> },
    { key: 't', head: 'Observation', cell: (o) => <><span className="b">{o.title}</span><span className="ops-sub" style={{ display: 'block' }}>{[words(o.obs_type), o.hazard, !jobId ? byJob.get(o.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'p', head: 'Priority', width: 110, cell: (o) => <Tag tone={o.priority === 'CRITICAL' ? 'neg' : o.priority === 'HIGH' ? 'warn' : undefined}>{words(o.priority)}</Tag> },
    { key: 'a', head: 'Assigned to', width: 190, cell: (o) => o.assignee_name ?? '—' },
    { key: 'd', head: 'Due', width: 150, cell: (o) => <>{day(o.due_on, today)}{OPEN.has(o.status) && o.due_on && <span className="ops-sub" style={{ display: 'block' }}>{o.due_on < today ? <Tag tone="neg">{dueText(o.due_on, today)}</Tag> : dueText(o.due_on, today)}</span>}</> },
    { key: 's', head: 'Status', width: 140, cell: (o) => <Tag tone={o.status === 'CLOSED' ? 'pos' : o.status === 'READY_FOR_REVIEW' ? 'warn' : undefined}>{words(o.status)}</Tag> },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Every type</option>{TYPES.map((t) => <option key={t} value={t}>{words(t)}</option>)}</Select></Field>
        <Seg aria-label="Which observations" value={tab} onChange={setTab} items={[
          { value: 'open', label: 'Open', count: inJob.filter((o) => OPEN.has(o.status)).length },
          { value: 'review', label: 'Ready for review', count: inJob.filter((o) => o.status === 'READY_FOR_REVIEW').length || undefined },
          { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {late > 0 && <Tag tone="neg">{late} past due</Tag>}
        {edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>New observation</Button>}
      </div>
      <Failure text={error} />
      {repeats.length > 0 && (
        <InlineNotice tone="warn" title="Repeated quality issues — a backcharge may be due">
          {repeats.map((r) => `${r.name} (${r.count} on ${byJob.get(r.jobId)?.label ?? 'a job'})`).join('; ')}. Open one from an observation, or on the <Link className="link" href="/change-events">change board</Link>.
        </InlineNotice>
      )}
      {adding && edit && <NewObservation jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} vendors={vendors} today={today} busy={busy} act={act} onDone={() => setAdding(false)} />}
      <CmTable label="Observations" keys rows={shown} cols={cols} rowKey={(o) => o.id} onOpen={(o) => setOpenId(o.id)} activeId={openId}
        rowTone={(o) => (OPEN.has(o.status) && (o.priority === 'CRITICAL' || (o.due_on != null && o.due_on < today)) ? 'neg' : null)}
        empty={{ title: tab === 'open' ? 'No open observations' : 'Nothing here', body: 'Record what you see — quality, safety, commissioning — with who fixes it and by when. Failed inspection items land here on their own.' }} />
      <TableKeys extra={edit ? [{ chord: 'n', label: 'New' }] : []} />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={520} title={open ? `${open.number ?? ''} · ${open.title}` : ''} eyebrow={open ? [words(open.obs_type), byJob.get(open.job_id)?.label].filter(Boolean).join(' // ') : undefined}>
        {open && <ObservationDetail key={open.id} o={open} today={today} edit={!readOnly && canChange} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function NewObservation({ jobs, defaultJobId, vendors, today, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; vendors: Array<{ id: string; name: string }>; today: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [type, setType] = useState<string>('QUALITY');
  const [priority, setPriority] = useState<string>('MEDIUM');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [hazard, setHazard] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId || !title.trim()) return setErr('Pick the job and say what was observed.');
      if (due && due < today) return setErr('The due date is in the past.');
      setErr(null);
      const name = assignee.trim() || vendors.find((v) => v.id === vendorId)?.name || null;
      const r = await act<{ number: string }>('add', 'post', '/api/commercial/observations', {
        jobId, obsType: type, priority, title: title.trim(), description: desc.trim() || null, hazard: hazard.trim() || null, assigneeVendorId: vendorId || null, assigneeName: name, dueOn: due || null,
      }, (d) => `Recorded ${d.number}`);
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{words(t)}</option>)}</Select></Field>
        <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
        <Field label="What was observed"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} style={{ width: 300 }} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {type === 'SAFETY' && <Field label="Hazard"><Input value={hazard} onChange={(e) => setHazard(e.target.value)} maxLength={200} placeholder="Unprotected edge" /></Field>}
        <Field label="Responsible sub"><Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Not a sub</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        <Field label="Person"><Input value={assignee} onChange={(e) => setAssignee(e.target.value)} maxLength={200} /></Field>
        <Field label="Fix by"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <Field label="Detail"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'add' ? 'Saving…' : 'Record it'}</Button></div>
    </form>
  );
}

function ObservationDetail({ o, today, edit, busy, act }: { o: Observation; today: string; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/observations/${o.id}`;
  const move = (status: string, ok: string) => void act(`s:${status}`, 'post', url, { status }, ok);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Priority', value: words(o.priority) }, { term: 'Status', value: words(o.status) }, { term: 'Assigned to', value: o.assignee_name ?? '—' },
        { term: 'Due', value: o.due_on ? `${day(o.due_on, today)}${OPEN.has(o.status) ? ` (${dueText(o.due_on, today)})` : ''}` : '—' },
        ...(o.hazard ? [{ term: 'Hazard', value: o.hazard }] : []), ...(o.contributing_condition ? [{ term: 'Contributing condition', value: o.contributing_condition }] : []),
        { term: 'Raised', value: day(o.created_at.slice(0, 10), today) }, ...(o.inspection_item_id ? [{ term: 'From', value: <Link className="link" href="/inspections">A failed inspection item</Link> }] : []),
      ]} />
      {o.description && <p style={{ whiteSpace: 'pre-wrap' }}>{o.description}</p>}
      {edit && o.status !== 'CLOSED' && o.status !== 'VOID' && (
        <DSection title="Move it along">
          <Actions busy={busy} items={[
            { key: 's:IN_PROGRESS', label: 'Being fixed', onClick: () => move('IN_PROGRESS', 'Marked in progress'), hidden: o.status !== 'OPEN' },
            { key: 's:READY_FOR_REVIEW', label: 'Ready for review', primary: o.status !== 'READY_FOR_REVIEW', onClick: () => move('READY_FOR_REVIEW', 'Ready for review'), hidden: o.status === 'READY_FOR_REVIEW' },
            { key: 's:CLOSED', label: 'Close it', primary: o.status === 'READY_FOR_REVIEW', onClick: () => move('CLOSED', 'Closed'), hidden: false },
            { key: 's:OPEN', label: 'Not fixed — reopen', onClick: () => move('OPEN', 'Reopened'), hidden: o.status !== 'READY_FOR_REVIEW' },
            { key: 's:VOID', label: 'Void', danger: true, onClick: () => move('VOID', 'Voided'), hidden: o.status === 'READY_FOR_REVIEW' },
          ]} />
        </DSection>
      )}
      {edit && o.obs_type === 'QUALITY' && o.assignee_name && (
        <DSection title="Backcharge">
          <Button disabled={busy !== null} onClick={() => void act('bc', 'post', '/api/commercial/change-events', {
            jobId: o.job_id, title: `Backcharge — ${o.assignee_name}: ${o.title}`.slice(0, 200), description: `From observation ${o.number ?? ''}. ${o.description ?? ''}`.trim().slice(0, 2000), sourceType: 'BACKCHARGE', scope: 'OUT',
          }, 'Opened a backcharge on the change board')}>Open a backcharge</Button>
        </DSection>
      )}
    </div>
  );
}
