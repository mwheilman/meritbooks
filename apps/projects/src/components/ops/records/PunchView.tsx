'use client';

import { useMemo, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Input, Panel, PanelSection, QueueTable, Seg, Select, Textarea, WidgetState, count, shortDate, useEscapeKey,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { PUNCH_KIND_WORDS, PUNCH_STATUS } from '@/lib/pm/ops/labels';
import type { LookupItem, PunchItemRow, PunchKind, PunchStatus } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, StatusMark } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useOps } from '../common/useOps';

type Show = 'open' | 'closed' | 'all';
const OPEN: ReadonlySet<PunchStatus> = new Set(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW']);
const STATUSES: PunchStatus[] = ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CLOSED', 'VOID'];

export interface PunchViewProps {
  items: PunchItemRow[];
  jobs: JobOption[];
  vendors: Record<string, string>;
  today: string;
  fixedJobId?: string | null;
}

export function PunchView(p: PunchViewProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [kind, setKind] = useState<PunchKind>('PUNCH');
  const [show, setShow] = useState<Show>('open');
  const [jobFilter, setJobFilter] = useState(p.fixedJobId ?? '');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const ofKind = (k: PunchKind) => p.items.filter((i) => i.kind === k && (!jobFilter || i.job_id === jobFilter));
  const rows = ofKind(kind).filter((i) => (show === 'open' ? OPEN.has(i.status) : show === 'closed' ? !OPEN.has(i.status) : true));
  const cur = p.items.find((i) => i.id === cursor) ?? null;
  const setStatus = (i: PunchItemRow, s: PunchStatus) => void act(`s:${i.id}`, 'patch', `/api/ops/punch/${i.id}`, { status: s }, `${i.title}: ${PUNCH_STATUS[s].word.toLowerCase()}`);

  const columns: QueueColumn<PunchItemRow>[] = [
    { id: 't', header: 'Item', cell: (i) => <><span className="l1">{i.title}</span><span className="l2">{[i.area, !p.fixedJobId ? jobs.get(i.job_id)?.label : null, i.billable ? 'billable' : null].filter(Boolean).join(' · ') || ' '}</span></> },
    { id: 'who', header: 'Responsible', width: 170, cell: (i) => <span className="l2">{i.responsible_vendor_id ? p.vendors[i.responsible_vendor_id] ?? 'Vendor' : 'Our crew'}</span> },
    { id: 'due', header: 'Due', width: 96, cell: (i) => (i.due_on ? <span className={OPEN.has(i.status) && i.due_on < p.today ? 'neg b' : undefined}>{shortDate(i.due_on, p.today)}</span> : '—') },
    { id: 'st', header: 'Status', width: 180, cell: (i) => (readOnly ? <StatusMark mark={PUNCH_STATUS[i.status]} /> : (
      <Select aria-label={`Status of ${i.title}`} value={i.status} disabled={busy === `s:${i.id}`} onChange={(e) => setStatus(i, e.target.value as PunchStatus)} onClick={(e) => e.stopPropagation()}>
        {STATUSES.map((s) => <option key={s} value={s}>{PUNCH_STATUS[s].word}</option>)}
      </Select>
    )) },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Seg<PunchKind> aria-label="Kind" value={kind} onChange={setKind} items={(['PUNCH', 'WARRANTY', 'CALLBACK'] as PunchKind[]).map((k) => ({ value: k, label: PUNCH_KIND_WORDS[k], count: ofKind(k).filter((i) => OPEN.has(i.status)).length }))} />
        <Seg<Show> aria-label="Show" value={show} onChange={setShow} items={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed or void' }, { value: 'all', label: 'All' }]} />
        {!p.fixedJobId && <Field label={v.job}><JobSelect jobs={p.jobs.filter((j) => p.items.some((i) => i.job_id === j.id))} value={jobFilter} onChange={setJobFilter} placeholder={`Every ${lower(v.job)}`} /></Field>}
        <span className="sp" />
        {!readOnly && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>New item</Button>}
      </div>
      <Failure text={error} />
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={ofKind(kind).length === 0
              ? { kind: 'empty', title: `No ${PUNCH_KIND_WORDS[kind].toLowerCase()} items`, body: kind === 'PUNCH' ? 'Walk the job and list what is left, by area and who owns it. The job cannot close while punch items are open.' : kind === 'WARRANTY' ? 'Warranty requests after completion, tracked to closed.' : 'Return visits on finished work, kept apart so the cost is visible.', action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New item</Button> }
              : { kind: 'done', title: show === 'open' ? 'Nothing open' : 'Nothing here', body: 'Switch the view above to see the others.' }} />
          ) : (
            <QueueTable aria-label={`${PUNCH_KIND_WORDS[kind]} items`} columns={columns} rows={rows} getRowId={(i) => i.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(i) => setCursor(i.id)}
              rowState={(i) => ({ done: !OPEN.has(i.status), attn: OPEN.has(i.status) && !!i.due_on && i.due_on < p.today })}
              actions={readOnly ? [] : [{ key: 'x', label: 'close', run: (rs) => rs.forEach((i) => OPEN.has(i.status) && setStatus(i, 'CLOSED')) }]} />
          )}
          {rows.length > 0 && <p className="t-cap" style={{ padding: 12 }}>{count(rows.length)} shown · press X to close the selected item</p>}
        </div>
        {creating ? (
          <NewPunch jobs={p.jobs.filter((j) => j.open)} fixedJobId={p.fixedJobId} kind={kind} onClose={() => setCreating(false)} />
        ) : cur ? (
          <PunchPanel key={cur.id} item={cur} vendor={cur.responsible_vendor_id ? p.vendors[cur.responsible_vendor_id] ?? null : null} jobLabel={jobs.get(cur.job_id)?.label ?? null} today={p.today} onClose={() => setCursor(null)} />
        ) : null}
      </div>
    </div>
  );
}

function PunchPanel({ item, vendor, jobLabel, today, onClose }: { item: PunchItemRow; vendor: string | null; jobLabel: string | null; today: string; onClose: () => void }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [title, setTitle] = useState(item.title);
  const [area, setArea] = useState(item.area ?? '');
  const [due, setDue] = useState(item.due_on ?? '');
  const [desc, setDesc] = useState(item.description ?? '');
  const [delOpen, setDelOpen] = useState(false);
  const url = `/api/ops/punch/${item.id}`;
  return (
    <Panel eyebrow={[PUNCH_KIND_WORDS[item.kind], PUNCH_STATUS[item.status].word]} title={item.title} meta={[jobLabel, vendor].filter(Boolean).join(' · ')} onClose={onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          <Button variant="quiet" onClick={() => setDelOpen(true)}>Delete</Button>
          <span className="sp" />
          {item.status === 'OPEN' && <Button onClick={() => void act('s', 'patch', url, { status: 'IN_PROGRESS' }, 'Started')}>Start</Button>}
          {(item.status === 'OPEN' || item.status === 'IN_PROGRESS') && <Button onClick={() => void act('s', 'patch', url, { status: 'READY_FOR_REVIEW' }, 'Ready for review')}>Ready for review</Button>}
          {OPEN.has(item.status) ? <Button variant="primary" disabled={busy === 's'} onClick={() => void act('s', 'patch', url, { status: 'CLOSED' }, 'Closed')}>Close</Button> : <Button disabled={busy === 's'} onClick={() => void act('s', 'patch', url, { status: 'OPEN' }, 'Reopened')}>Reopen</Button>}
        </div>
      )}>
      <PanelSection>
        <StatusMark mark={PUNCH_STATUS[item.status]} />
        {item.closed_at && <p className="t-cap" style={{ marginTop: 6 }}>Closed {shortDate(item.closed_at.slice(0, 10), today)}</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>
      <PanelSection title="Details">
        {readOnly ? (
          <>{item.area && <p className="t-cap">{item.area}</p>}{item.description && <p>{item.description}</p>}</>
        ) : (
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void act('edit', 'patch', url, { title: title.trim() || undefined, area: area.trim() || null, dueOn: due || null, description: desc.trim() || null }, 'Saved'); }}>
            <Field label="Item"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
            <div className="mp-form-2">
              <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} /></Field>
              <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            </div>
            <Field label="Notes"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4000} /></Field>
            <div><Button type="submit" disabled={busy === 'edit'}>Save</Button></div>
          </form>
        )}
      </PanelSection>
      <ConfirmDialog open={delOpen} onClose={() => setDelOpen(false)} tone="danger" title="Delete this item" confirmLabel="Delete"
        onConfirm={async () => { const r = await act('del', 'delete', url, undefined, 'Deleted'); if (!r) throw new Error('Not deleted.'); onClose(); }}>
        {item.title}. Closing it keeps the record; delete only an item entered by mistake.
      </ConfirmDialog>
    </Panel>
  );
}

function NewPunch({ jobs, fixedJobId, kind: initialKind, onClose }: { jobs: JobOption[]; fixedJobId?: string | null; kind: PunchKind; onClose: () => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [kind, setKind] = useState<PunchKind>(initialKind);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('');
  const [due, setDue] = useState('');
  const [desc, setDesc] = useState('');
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [billable, setBillable] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [keepGoing, setKeepGoing] = useState(true);
  useEscapeKey(onClose, busy !== 'create', 'New punch item');
  const submit = async () => {
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!title.trim()) return setErr('Say what needs fixing.');
    setErr(null);
    const r = await act('create', 'post', '/api/ops/punch', { jobId, kind, title: title.trim(), area: area.trim() || null, dueOn: due || null, description: desc.trim() || null, responsibleVendorId: vendor?.id ?? null, billable }, `Added ${title.trim()}`);
    if (r) { if (keepGoing) { setTitle(''); setDesc(''); } else onClose(); }
  };
  return (
    <Panel eyebrow={['New', PUNCH_KIND_WORDS[kind]]} title={title.trim() || 'New item'} meta="Walk the job and add them one after another" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Done</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Add</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
          <Field label="Kind"><Seg<PunchKind> aria-label="Kind" value={kind} onChange={setKind} items={(['PUNCH', 'WARRANTY', 'CALLBACK'] as PunchKind[]).map((k) => ({ value: k, label: PUNCH_KIND_WORDS[k] }))} /></Field>
          <Field label="What needs fixing" error={err ?? undefined}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Touch up paint at the stair stringer" maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Main stair" maxLength={120} /></Field>
            <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          <Field label="Responsible trade" help="Blank means your own crew"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Search vendors" /></Field>
          <Field label="Notes"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4000} /></Field>
          <Check label="Billable to the customer" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
          <Check label="Keep this open for the next item" checked={keepGoing} onChange={(e) => setKeepGoing(e.target.checked)} />
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
