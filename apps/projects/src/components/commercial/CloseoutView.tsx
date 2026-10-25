'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Check, ConfirmDialog, Drawer, Field, Figure, Input, KV, Seg, Select, Tag, Textarea, WidgetState, useQuery } from '@meritbooks/merit-ui';
import { CLOSEOUT_DONE, GATE_FIX, addDaysIso, closeoutBySub } from '@/lib/commercial/screen-logic';
import type { CloseoutItem } from '@/lib/commercial/screen-types';
import type { CloseGate } from '@/lib/commercial/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
const CATEGORIES = ['OM_MANUAL', 'WARRANTY', 'AS_BUILT', 'ATTIC_STOCK', 'TRAINING', 'FINAL_INSPECTION', 'CERTIFICATE_OF_OCCUPANCY', 'SUBSTANTIAL_COMPLETION', 'AFFIDAVIT_OF_PAYMENT',
  'RELEASE_OF_LIENS', 'CONSENT_OF_SURETY', 'FINAL_LIEN_WAIVER', 'PUNCH_COMPLETE', 'KEYS', 'COMMISSIONING', 'OTHER'] as const;
interface CloseoutData { gate: CloseGate; items: CloseoutItem[]; vendors: Record<string, string> }

/** Closeout across jobs: each job's package progress; pick one to work it (CGC-103 / CGC-106). */
export function CloseoutBoard({ jobs, items, jobId, today, canEdit, canClose }: {
  jobs: JobOption[]; items: CloseoutItem[]; jobId: string | null; today: string; canEdit: boolean; canClose: boolean;
}) {
  const router = useRouter();
  const per = jobs.map((j) => {
    const xs = items.filter((i) => i.job_id === j.id && i.required);
    return { job: j, required: xs.length, done: xs.filter((i) => CLOSEOUT_DONE.has(i.status)).length, late: xs.filter((i) => !CLOSEOUT_DONE.has(i.status) && i.due_on && i.due_on < today).length };
  }).filter((r) => r.required > 0 || r.job.id === jobId);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-toolbar"><Field label="Job"><JobSelect jobs={jobs} value={jobId ?? ''} onChange={(id) => router.push(id ? `/closeout?job=${id}` : '/closeout')} /></Field></div>
      {!jobId && (
        <CmTable label="Closeout by job" keys rows={per} rowKey={(r) => r.job.id} onOpen={(r) => router.push(`/closeout?job=${r.job.id}`)} cols={[
          { key: 'j', head: 'Job', cell: (r) => <span className="b">{r.job.label}</span> },
          { key: 'd', head: 'Accepted', n: true, width: 140, cell: (r) => `${r.done} of ${r.required}` },
          { key: 'p', head: 'Progress', width: 160, cell: (r) => (r.required && r.done === r.required ? <Tag tone="pos">Package complete</Tag> : <Tag>{r.required ? Math.round((r.done / r.required) * 100) : 0}%</Tag>) },
          { key: 'l', head: 'Late', n: true, width: 80, cell: (r) => (r.late ? <span className="neg">{r.late}</span> : '—') },
        ]} empty={{ title: 'No closeout packages yet', body: 'Pick a job and generate its package: the standard closeout documents plus a set per subcontract — final waiver, warranty, O&Ms and as-builts.' }} />
      )}
      {jobId && <CloseoutJob key={jobId} jobId={jobId} today={today} canEdit={canEdit} canClose={canClose} />}
    </div>
  );
}

/**
 * One job's closeout (CGC-103) and close gate (CGC-106): O&M manuals, warranties with start and
 * end dates, as-builts, attic stock, training, final inspections and CO, the G704/G706/G707-style
 * forms, final waivers and consent of surety — status by sub — and what still stops the job from
 * closing for posting, each with who fixes it and where.
 */
export function CloseoutJob({ jobId, today, canEdit, canClose }: { jobId: string; today: string; canEdit: boolean; canClose: boolean }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [bump, setBump] = useState(0);
  const q = useQuery<CloseoutData>('/api/commercial/closeout', { jobId }, { scope: false, key: String(bump) });
  const [by, setBy] = useState<'sub' | 'category'>('sub');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const run = (async (...a: Parameters<Act>) => { const r = await act(...a); if (r) setBump((b) => b + 1); return r; }) as Act;
  if (q.isLoading && !q.data) return <WidgetState state={{ kind: 'loading', label: 'Loading the closeout…', lines: 5 }} />;
  if (q.error) return <WidgetState state={{ kind: 'error', title: 'The closeout did not load', body: q.error, onRetry: () => void q.refetch(), retryLabel: 'Try again' }} />;
  if (!q.data) return null;
  const { gate, items, vendors } = q.data;
  const edit = !readOnly && canEdit;
  const req = items.filter((i) => i.required);
  const done = req.filter((i) => CLOSEOUT_DONE.has(i.status)).length;
  const warrantiesSoon = items.filter((i) => i.warranty_ends_on && i.warranty_ends_on >= today && i.warranty_ends_on <= addDaysIso(today, 90)).length;
  const groups = by === 'sub' ? closeoutBySub(items, (id) => vendors[id] ?? 'Subcontractor', today) : null;
  const ordered = groups ? groups.flatMap((g) => g.items.map((i) => i as CloseoutItem)) : [...items].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const open = items.find((i) => i.id === openId) ?? null;

  const cols: Col<CloseoutItem>[] = [
    { key: 't', head: 'Item', cell: (i) => <><span className="b">{i.title}</span>{!i.required && <span className="ops-sub"> optional</span>}<span className="ops-sub" style={{ display: 'block' }}>{[words(i.category), i.form_ref, by === 'category' && i.vendor_id ? vendors[i.vendor_id] : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'sub', head: 'Sub', width: 180, hidden: by === 'sub', cell: (i) => (i.vendor_id ? vendors[i.vendor_id] ?? '—' : 'Ours') },
    { key: 'd', head: 'Due', width: 120, cell: (i) => <>{day(i.due_on, today)}{i.due_on && i.due_on < today && !CLOSEOUT_DONE.has(i.status) && <span style={{ display: 'block' }}><Tag tone="neg">Late</Tag></span>}</> },
    { key: 'w', head: 'Warranty ends', width: 130, cell: (i) => day(i.warranty_ends_on, today) },
    { key: 's', head: 'Status', width: 130, cell: (i) => <Tag tone={CLOSEOUT_DONE.has(i.status) ? 'pos' : i.status === 'REJECTED' ? 'neg' : undefined}>{words(i.status)}</Tag> },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="cm-figs">
        <Figure dense label="Closeout package" value={`${done} of ${req.length}`} vs={[`${req.filter((i) => !CLOSEOUT_DONE.has(i.status) && i.due_on && i.due_on < today).length} late`, groups ? `${groups.filter((g) => g.key !== 'general' && g.done < g.required).length} subs still owe documents` : '']} href={`/jobs/${jobId}?tab=closeout`} linkLabel="On the job" />
        <Figure dense label="Warranties ending in 90 days" value={String(warrantiesSoon)} vs={[`${items.filter((i) => i.warranty_ends_on).length} warranties on file`]} href={`/closeout?job=${jobId}`} linkLabel="Closeout" />
      </div>
      <Failure text={error} />
      <section className="sec" aria-label="Close gate">
        <div className="sec-h"><h2 className="t-section">Close gate</h2><span className="t-cap ink-3">What stops the job closing for posting</span><span className="sp" />
          {!readOnly && canClose && <Button variant={gate.ready ? 'primary' : 'default'} disabled={busy !== null || !gate.ready} onClick={() => setClosing(true)}>Close the job</Button>}
        </div>
        {gate.ready ? <WidgetState state={{ kind: 'done', title: 'Nothing blocks closing this job', body: 'Final billing and retainage are billed, waivers are in, commitments and accruals are clear. Close it to send the final WIP to Merit Books.' }} /> : (
          <CmTable label="Close gate blockers" rows={gate.blockers} rowKey={(b) => b.code} cols={[
            { key: 'l', head: 'Blocker', cell: (b) => <span className="b">{b.label}</span> },
            { key: 'n', head: 'Open', n: true, width: 80, cell: (b) => b.count },
            { key: 'o', head: 'Owner', width: 170, cell: (b) => GATE_FIX[b.code]?.owner ?? '—' },
            { key: 'f', head: 'Fix it', width: 280, cell: (b) => (GATE_FIX[b.code] ? <Link className="link" href={GATE_FIX[b.code]!.href(jobId)}>{GATE_FIX[b.code]!.label}</Link> : '—') },
          ]} empty={{ title: 'Nothing blocks closing', body: '' }} />
        )}
      </section>
      <section className="sec" aria-label="Closeout package">
        <div className="sec-h"><h2 className="t-section">Closeout package</h2><span className="sp" />
          <Seg aria-label="Group by" value={by} onChange={setBy} items={[{ value: 'sub', label: 'By sub' }, { value: 'category', label: 'By document' }]} />
          {edit && <Button disabled={busy !== null} onClick={() => void run<{ generated: number }>('gen', 'post', '/api/commercial/closeout', { op: 'generate', jobId }, (d) => (d.generated ? `Added ${d.generated} closeout items` : 'The package already has every standard item'))}>{busy === 'gen' ? 'Building…' : 'Generate from the job'}</Button>}
          {edit && <Button icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>Add item</Button>}
        </div>
        {adding && edit && <NewItem jobId={jobId} vendors={vendors} busy={busy} act={run} onDone={() => setAdding(false)} />}
        {groups && groups.length > 0 && (
          <p className="t-cap" style={{ marginBottom: 8 }}>{groups.map((g) => `${g.label}: ${g.done}/${g.required}${g.late ? ` (${g.late} late)` : ''}`).join(' · ')}</p>
        )}
        <CmTable label="Closeout items" keys rows={ordered} cols={cols} rowKey={(i) => i.id} onOpen={(i) => setOpenId(i.id)} activeId={openId}
          rowTone={(i) => (i.status === 'REJECTED' || (i.due_on != null && i.due_on < today && !CLOSEOUT_DONE.has(i.status)) ? 'neg' : null)}
          empty={{ title: 'No closeout items yet', body: 'Generate the package: substantial completion, punch, final inspection and CO, as-builts, the payment and lien affidavits, consent of surety when bonded, training and keys — and a final waiver, warranty, O&Ms and as-builts per subcontract.' }} />
        <TableKeys extra={edit ? [{ chord: 'n', label: 'Add item' }] : []} />
      </section>
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={480} title={open?.title ?? ''} eyebrow={open ? [words(open.category), open.vendor_id ? vendors[open.vendor_id] : null].filter(Boolean).join(' // ') : undefined}>
        {open && <ItemDetail key={`${open.id}:${open.status}`} i={open} today={today} edit={edit} busy={busy} act={run} />}
      </Drawer>
      <ConfirmDialog open={closing} onClose={() => setClosing(false)} title="Close the job for posting?" confirmLabel="Close the job"
        onConfirm={async () => { await run('close', 'post', '/api/commercial/closeout', { op: 'close', jobId, note: note.trim() || null }, 'Close gate passed — the job is ready to close'); setClosing(false); }}>
        <p>The gate is checked again as you confirm; anything still open stops it.</p>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      </ConfirmDialog>
    </div>
  );
}

function NewItem({ jobId, vendors, busy, act, onDone }: { jobId: string; vendors: Record<string, string>; busy: string | null; act: Act; onDone: () => void }) {
  const [cat, setCat] = useState<string>('OM_MANUAL');
  const [title, setTitle] = useState('');
  const [vendor, setVendor] = useState('');
  const [spec, setSpec] = useState('');
  const [due, setDue] = useState('');
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!title.trim()) return;
      const r = await act('add', 'post', '/api/commercial/closeout/items', { jobId, category: cat, title: title.trim(), vendorId: vendor || null, specSection: spec.trim() || null, dueOn: due || null }, 'Added to the package');
      if (r) onDone();
    }}>
      <Field label="Document"><Select value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{words(c)}</option>)}</Select></Field>
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} style={{ width: 260 }} /></Field>
      <Field label="From"><Select value={vendor} onChange={(e) => setVendor(e.target.value)}><option value="">Us</option>{Object.entries(vendors).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select></Field>
      <Field label="Spec section"><Input value={spec} onChange={(e) => setSpec(e.target.value)} maxLength={20} style={{ width: 110 }} placeholder="01 78 00" /></Field>
      <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Button type="submit" variant="primary" disabled={busy !== null || !title.trim()}>Add</Button>
    </form>
  );
}

function ItemDetail({ i, today, edit, busy, act }: { i: CloseoutItem; today: string; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/closeout/items/${i.id}`;
  const [due, setDue] = useState(i.due_on ?? '');
  const [ws, setWs] = useState(i.warranty_starts_on ?? '');
  const [wy, setWy] = useState(i.warranty_years == null ? '' : String(i.warranty_years));
  const [notes, setNotes] = useState(i.notes ?? '');
  const [required, setRequired] = useState(i.required);
  const status = (s: string, ok: string) => void act(`s:${s}`, 'patch', url, { status: s }, ok);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Status', value: words(i.status) }, { term: 'Form', value: i.form_ref ?? '—' }, { term: 'Spec section', value: i.spec_section ?? '—' },
        { term: 'Due', value: day(i.due_on, today) }, { term: 'Warranty', value: i.warranty_starts_on ? `${day(i.warranty_starts_on, today)} to ${day(i.warranty_ends_on, today)}` : '—' },
        { term: 'Accepted', value: i.accepted_at ? day(i.accepted_at.slice(0, 10), today) : '—' },
      ]} />
      {edit && (
        <>
          <DSection title="Status">
            <Actions busy={busy} items={[
              { key: 's:REQUESTED', label: 'Requested from the sub', onClick: () => status('REQUESTED', 'Marked requested'), hidden: i.status !== 'REQUIRED' && i.status !== 'REJECTED' },
              { key: 's:SUBMITTED', label: 'Received', onClick: () => status('SUBMITTED', 'Marked received'), hidden: i.status === 'SUBMITTED' || CLOSEOUT_DONE.has(i.status) },
              { key: 's:ACCEPTED', label: 'Accept', primary: true, onClick: () => status('ACCEPTED', 'Accepted'), hidden: CLOSEOUT_DONE.has(i.status) },
              { key: 's:REJECTED', label: 'Reject', danger: true, onClick: () => status('REJECTED', 'Rejected — back to the sub'), hidden: i.status !== 'SUBMITTED' },
              { key: 's:WAIVED', label: 'Waive', onClick: () => status('WAIVED', 'Waived'), hidden: CLOSEOUT_DONE.has(i.status) },
              { key: 's:REQUIRED', label: 'Reopen', onClick: () => status('REQUIRED', 'Reopened'), hidden: !CLOSEOUT_DONE.has(i.status) },
            ]} />
          </DSection>
          <DSection title="Dates and notes">
            <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void act('save', 'patch', url, { dueOn: due || null, warrantyStartsOn: ws || null, warrantyYears: wy.trim() ? Number(wy) : null, notes: notes.trim() || null, required }, 'Saved the item'); }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
                <Field label="Warranty starts" help="Usually substantial completion"><Input type="date" value={ws} onChange={(e) => setWs(e.target.value)} /></Field>
                <Field label="Years"><Input inputMode="decimal" value={wy} onChange={(e) => setWy(e.target.value.replace(/[^0-9.]/g, ''))} style={{ width: 70 }} /></Field>
              </div>
              <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
              <Check label="Required to close" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              <div><Button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button></div>
            </form>
          </DSection>
        </>
      )}
    </div>
  );
}
