'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, Field, Input, Seg, Select, Tag, Textarea, WidgetState, toast } from '@meritbooks/merit-ui';
import type { ChecklistTemplate, Inspection, InspectionItem } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'open' | 'done' | 'all';

/** What still stops an inspection from completing: unanswered items and photo-required items without a photo. Pure. */
export function inspectionBlockers(items: ReadonlyArray<Pick<InspectionItem, 'response' | 'requires_photo' | 'photo_ids'>>): { unanswered: number; needPhoto: number; fails: number } {
  return {
    unanswered: items.filter((i) => i.response == null).length,
    needPhoto: items.filter((i) => i.requires_photo && i.response !== 'NA' && i.response != null && (i.photo_ids ?? []).length === 0).length,
    fails: items.filter((i) => i.response === 'FAIL').length,
  };
}

/**
 * Inspections and QA / QC checklists (CGC-75): pre-pour, framing, MEP rough-in, above-ceiling,
 * firestopping, envelope, final, the weekly safety audit, and trade QA (megger, pressure, torque).
 * Pass / fail / N/A with notes and photos, signed when complete; every failure opens an observation.
 */
export function InspectionsView({ inspections, templates, jobs, today, canEdit, initialId, onChanged }: {
  inspections: Inspection[]; templates: ChecklistTemplate[]; jobs: JobOption[]; today: string; canEdit: boolean; initialId?: string | null; onChanged?: () => void;
}) {
  const { readOnly } = useShell();
  const ops = useOps();
  const { busy, error, version } = ops;
  const act = (async (...a: Parameters<Act>) => { const r = await ops.act(...a); if (r) onChanged?.(); return r; }) as Act;
  const [tab, setTab] = useState<Tab>('open');
  const [jobId, setJobId] = useState('');
  const [cat, setCat] = useState('');
  const [starting, setStarting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialId ?? null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = inspections.filter((i) => (!jobId || i.job_id === jobId) && (!cat || i.category === cat));
  const shown = inJob.filter((i) => tab === 'all' || (tab === 'open' ? i.status === 'IN_PROGRESS' : i.status === 'COMPLETE'));
  const cats = [...new Set(inspections.map((i) => i.category).filter((x): x is string => !!x))].sort();
  const open = inspections.find((i) => i.id === openId) ?? null;
  const edit = !readOnly && canEdit;

  const cols: Col<Inspection>[] = [
    { key: 'n', head: 'Number', width: 100, cell: (i) => <span className="code">{i.number ?? '—'}</span> },
    { key: 't', head: 'Inspection', cell: (i) => <><span className="b">{i.title}</span><span className="ops-sub" style={{ display: 'block' }}>{[words(i.category), i.area, !jobId ? byJob.get(i.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'd', head: 'Date', width: 110, cell: (i) => day(i.inspected_on, today) },
    { key: 'by', head: 'Inspector', width: 170, cell: (i) => i.inspector_name ?? '—' },
    { key: 'r', head: 'Result', width: 130, cell: (i) => (i.status === 'IN_PROGRESS' ? <Tag>In progress</Tag> : i.result === 'PASS' ? <Tag tone="pos">Pass</Tag> : i.result === 'FAIL' ? <Tag tone="neg">Fail</Tag> : <Tag tone="warn">Partial</Tag>) },
    { key: 's', head: 'Signed', width: 150, cell: (i) => i.signed_by_name ?? '—' },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        {cats.length > 1 && <Field label="Checklist"><Select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Every kind</option>{cats.map((c) => <option key={c} value={c}>{words(c)}</option>)}</Select></Field>}
        <Seg aria-label="Which inspections" value={tab} onChange={setTab} items={[
          { value: 'open', label: 'In progress', count: inJob.filter((i) => i.status === 'IN_PROGRESS').length }, { value: 'done', label: 'Complete' }, { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setStarting((v) => !v)}>Start an inspection</Button>}
      </div>
      <Failure text={error} />
      {starting && edit && (templates.length === 0
        ? <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'No checklists yet', body: 'Add the standard templates (they include the QA and safety checklists) under Project templates.', action: <Link className="btn" href="/project-templates">Project templates</Link> }} /></div>
        : <StartInspection jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} templates={templates} busy={busy} act={act} onStarted={(id) => { setStarting(false); setOpenId(id); }} />)}
      <CmTable label="Inspections" keys rows={shown} cols={cols} rowKey={(i) => i.id} onOpen={(i) => setOpenId(i.id)} activeId={openId}
        rowTone={(i) => (i.result === 'FAIL' ? 'neg' : i.result === 'PARTIAL' ? 'warn' : null)}
        empty={{ title: tab === 'open' ? 'No inspections in progress' : 'No inspections yet', body: 'Start one from a checklist: each item is pass, fail or N/A with a note or photo. Failures become observations assigned with a due date.' }} />
      <TableKeys extra={edit ? [{ chord: 'n', label: 'Start' }] : []} />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={640} title={open ? `${open.number ?? ''} · ${open.title}` : ''} eyebrow={open ? [words(open.category), byJob.get(open.job_id)?.label].filter(Boolean).join(' // ') : undefined}>
        {open && <Runner key={open.id} ins={open} version={version} edit={edit && open.status === 'IN_PROGRESS'} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function StartInspection({ jobs, defaultJobId, templates, busy, act, onStarted }: { jobs: JobOption[]; defaultJobId: string; templates: ChecklistTemplate[]; busy: string | null; act: Act; onStarted: (id: string) => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [tpl, setTpl] = useState(templates[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId || !tpl) return setErr('Pick the job and the checklist.');
      setErr(null);
      const r = await act<{ id: string }>('start', 'post', '/api/commercial/inspections', { jobId, templateId: tpl, title: title.trim() || null, area: area.trim() || null }, 'Started the inspection');
      if (r) onStarted(r.id);
    }}>
      <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
      <Field label="Checklist"><Select value={tpl} onChange={(e) => setTpl(e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="Title" help="Blank: the checklist's name"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={200} placeholder="Level 2, east wing" /></Field>
      <Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'start' ? 'Starting…' : 'Start'}</Button>
    </form>
  );
}

function Runner({ ins, version, edit, busy, act }: { ins: Inspection; version: number; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/inspections/${ins.id}`;
  const d = useDetail<{ items: InspectionItem[] }>(url, version);
  const [signer, setSigner] = useState('');
  const items = d.data?.items ?? [];
  const b = inspectionBlockers(items);
  const sections = [...new Set(items.map((i) => i.section ?? ''))];
  if (d.isLoading && !d.data) return <WidgetState state={{ kind: 'loading', label: 'Loading the checklist…', lines: 5 }} />;
  if (d.error) return <WidgetState state={{ kind: 'error', title: 'The checklist did not load', body: d.error, onRetry: () => void d.refetch(), retryLabel: 'Try again' }} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-facts">
        <span><b>{items.length - b.unanswered}</b> of {items.length} answered</span>
        {b.fails > 0 && <span><b>{b.fails}</b> failed</span>}
        {ins.status === 'COMPLETE' && <span>Result <b>{words(ins.result)}</b></span>}
        {ins.signed_by_name && <span>Signed by <b>{ins.signed_by_name}</b></span>}
      </div>
      {sections.map((sec) => (
        <DSection key={sec || 'items'} title={sec || 'Checklist'}>
          {items.filter((i) => (i.section ?? '') === sec).map((i) => <ItemRow key={i.id} i={i} url={url} jobId={ins.job_id} edit={edit} busy={busy} act={act} onPhoto={() => void d.refetch()} />)}
        </DSection>
      ))}
      {edit && (
        <DSection title="Complete">
          <div className="stack" style={{ gap: 8 }}>
            {b.unanswered > 0 && <p className="t-cap">{b.unanswered} {b.unanswered === 1 ? 'item has' : 'items have'} no answer yet.</p>}
            {b.needPhoto > 0 && <p className="t-cap">{b.needPhoto} {b.needPhoto === 1 ? 'item needs' : 'items need'} a photo.</p>}
            {b.fails > 0 && <p className="t-cap">Completing opens {b.fails} {b.fails === 1 ? 'observation' : 'observations'}, due in 7 days.</p>}
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Signed by"><Input value={signer} onChange={(e) => setSigner(e.target.value)} maxLength={200} placeholder="Inspector's name" /></Field>
              <Button variant="primary" chord="mod+enter" bindChord disabled={busy !== null || b.unanswered > 0 || b.needPhoto > 0 || !signer.trim()}
                onClick={() => void act<{ result: string; observations: number }>('complete', 'post', url, { op: 'complete', signerName: signer.trim(), signaturePng: null },
                  (r) => `Completed: ${words(r.result).toLowerCase()}${r.observations ? `, ${r.observations} observations opened` : ''}`)}>
                {busy === 'complete' ? 'Completing…' : 'Sign and complete'}
              </Button>
            </div>
          </div>
        </DSection>
      )}
      {ins.status === 'COMPLETE' && b.fails > 0 && <p className="t-cap"><Link className="link" href="/observations">Open the observations it raised</Link></p>}
    </div>
  );
}

function ItemRow({ i, url, jobId, edit, busy, act, onPhoto }: { i: InspectionItem; url: string; jobId: string; edit: boolean; busy: string | null; act: Act; onPhoto: () => void }) {
  const [note, setNote] = useState(i.note ?? '');
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const answer = (response: 'PASS' | 'FAIL' | 'NA') => void act(`i:${i.id}`, 'post', url, { op: 'item', itemId: i.id, response, note: note.trim() || null, value: i.value }, `${i.label}: ${response === 'NA' ? 'N/A' : response.toLowerCase()}`);
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set('file', f); fd.set('jobId', jobId); fd.set('kind', 'photo'); fd.set('title', i.label.slice(0, 200));
      const res = await fetch('/api/documents', { method: 'POST', body: fd });
      const j = (await res.json().catch(() => null)) as { file_id?: string; error?: string } | null;
      if (!res.ok || !j?.file_id) throw new Error(j?.error ?? 'The photo did not upload.');
      const r = await act('photo', 'post', `${url}/photos`, { itemId: i.id, fileId: j.file_id }, 'Attached the photo');
      if (r) onPhoto();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The photo did not upload.');
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="cm-check">
      <div>
        <span className="lbl">{i.label}</span>
        <span className="ops-sub" style={{ display: 'block' }}>
          {i.requires_photo && <>Needs a photo{(i.photo_ids ?? []).length ? ` · ${(i.photo_ids ?? []).length} attached` : ''} · </>}
          {i.observation_id && <Link className="link" href="/observations">Observation opened</Link>}
        </span>
        {edit && <Textarea aria-label={`Note on ${i.label}`} value={note} onChange={(e) => setNote(e.target.value)} rows={1} maxLength={2000} placeholder="Note (what failed, the reading)" style={{ marginTop: 6 }} />}
        {!edit && i.note && <p className="t-cap" style={{ marginTop: 4 }}>{i.note}</p>}
      </div>
      <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
        {edit ? (
          <Seg aria-label={`Answer for ${i.label}`} value={(i.response ?? '') as 'PASS' | 'FAIL' | 'NA'} onChange={(v) => answer(v)} items={[{ value: 'PASS', label: 'Pass' }, { value: 'FAIL', label: 'Fail' }, { value: 'NA', label: 'N/A' }]} />
        ) : i.response ? <Tag tone={i.response === 'PASS' ? 'pos' : i.response === 'FAIL' ? 'neg' : undefined}>{i.response === 'NA' ? 'N/A' : words(i.response)}</Tag> : <Tag>No answer</Tag>}
        {edit && i.requires_photo && (
          <>
            <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            <Button variant="quiet" disabled={uploading || busy !== null} onClick={() => file.current?.click()}>{uploading ? 'Uploading…' : 'Add photo'}</Button>
          </>
        )}
      </div>
    </div>
  );
}
