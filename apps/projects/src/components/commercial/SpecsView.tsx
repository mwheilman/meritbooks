'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ConfirmDialog, Drawer, Field, Input, KV, Search, Select, Tag, Textarea } from '@meritbooks/merit-ui';
import { divisionName, parseSpecToc } from '@/lib/commercial/screen-logic';
import type { SpecSection } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { CmTable, TableKeys, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];

/**
 * Specifications (CGC-62): the project manual auto-sectioned by MasterFormat number and title
 * (other numbering kept as written), revised by addendum, searchable, and tied to the submittals
 * each section calls for.
 */
export function SpecsView({ sections, submittalsBySection, jobs, today, canEdit, initialJob }: {
  sections: SpecSection[]; submittalsBySection: Readonly<Record<string, number>>; jobs: JobOption[]; today: string; canEdit: boolean; initialJob?: string | null;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(initialJob ?? (jobs.length === 1 ? jobs[0]!.id : ''));
  const [div, setDiv] = useState('');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = sections.filter((s) => !jobId || s.job_id === jobId);
  const divisions = [...new Set(inJob.map((s) => s.division ?? ''))].filter(Boolean).sort();
  const needle = q.trim().toLowerCase();
  const shown = inJob.filter((s) => (!div || s.division === div) && (!needle || `${s.number} ${s.title} ${s.addendum ?? ''}`.toLowerCase().includes(needle)));
  const open = sections.find((s) => s.id === openId) ?? null;
  const edit = !readOnly && canEdit;
  const subs = (s: SpecSection) => submittalsBySection[`${s.job_id}|${s.number}`] ?? 0;

  const cols: Col<SpecSection>[] = [
    { key: 'n', head: 'Section', width: 130, cell: (s) => <span className="code">{s.number}</span> },
    { key: 't', head: 'Title', cell: (s) => <><span className="b">{s.title}</span>{!jobId && <span className="ops-sub" style={{ display: 'block' }}>{byJob.get(s.job_id)?.label}</span>}</> },
    { key: 'd', head: 'Division', width: 240, cell: (s) => (s.division ? `${s.division} ${divisionName(s.division)}` : '—') },
    { key: 'r', head: 'Revision', width: 150, cell: (s) => (s.revision > 0 ? <>Rev {s.revision}{s.addendum && <span className="ops-sub" style={{ display: 'block' }}>{s.addendum}</span>}</> : 'Original') },
    { key: 'p', head: 'Pages', width: 90, cell: (s) => (s.page_start ? `${s.page_start}${s.page_end ? `–${s.page_end}` : ''}` : '—') },
    { key: 's', head: 'Submittals', n: true, width: 100, cell: (s) => subs(s) || '—' },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        {divisions.length > 1 && <Field label="Division"><Select value={div} onChange={(e) => setDiv(e.target.value)}><option value="">Every division</option>{divisions.map((d) => <option key={d} value={d}>{d} {divisionName(d)}</option>)}</Select></Field>}
        <div style={{ width: 260 }}><Search aria-label="Search the specifications" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number or title" slashToFocus /></div>
        <span className="sp" />
        {edit && jobId && inJob.length > 0 && <Button disabled={busy !== null} onClick={() => void act<{ generated: number }>('gen', 'post', '/api/commercial/submittals', { op: 'generate', jobId }, (d) => `Added ${d.generated} expected submittals from the specifications`)}>{busy === 'gen' ? 'Building…' : 'Build the submittal register'}</Button>}
        {edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setImporting((v) => !v)}>Import sections</Button>}
      </div>
      <Failure text={error} />
      {importing && edit && <SpecImport jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} busy={busy} act={act} onDone={() => setImporting(false)} />}
      <CmTable label="Specification sections" keys rows={shown} cols={cols} rowKey={(s) => s.id} onOpen={(s) => setOpenId(s.id)} activeId={openId}
        empty={{ title: needle || div ? 'No section matches' : 'No specifications yet', body: 'Paste the project manual’s table of contents: each line with a section number becomes a section, MasterFormat numbers sorted into divisions. Import an addendum the same way to revise the sections it changes.' }} />
      <TableKeys extra={edit ? [{ chord: 'n', label: 'Import' }, { chord: '/', label: 'Search' }] : [{ chord: '/', label: 'Search' }]} />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={480} title={open ? `${open.number} ${open.title}` : ''} eyebrow={open ? byJob.get(open.job_id)?.label : undefined}>
        {open && <SectionDetail key={open.id} s={open} subs={subs(open)} edit={edit} busy={busy} act={act} today={today} onRemoved={() => setOpenId(null)} />}
      </Drawer>
    </div>
  );
}

function SpecImport({ jobs, defaultJobId, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [text, setText] = useState('');
  const [addendum, setAddendum] = useState('');
  const parsed = useMemo(() => parseSpecToc(text), [text]);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!parsed.length) return setErr('No section numbers found. Paste lines like "09 21 16  Gypsum Board Assemblies".');
      setErr(null);
      const r = await act<{ imported: number }>('import', 'post', '/api/commercial/specs', { jobId, addendum: addendum.trim() || null, sections: parsed.map((p) => ({ number: p.number, title: p.title })) },
        (d) => `Imported ${d.imported} sections${addendum.trim() ? ` from ${addendum.trim()}` : ''}`);
      if (r) { setText(''); onDone(); }
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Addendum" help="Blank for the original manual."><Input value={addendum} onChange={(e) => setAddendum(e.target.value)} maxLength={60} placeholder="Addendum 2" /></Field>
      </div>
      <Field label="Table of contents" help={parsed.length ? `${parsed.length} sections found${parsed.some((p) => !p.csi) ? `, ${parsed.filter((p) => !p.csi).length} with the project’s own numbering` : ''}.` : 'Paste from the PDF: one section per line.'}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'01 10 00  Summary\n03 30 00  Cast-in-Place Concrete\n09 21 16  Gypsum Board Assemblies\n26 05 19  Low-Voltage Electrical Power Conductors and Cables'} />
      </Field>
      {parsed.length > 0 && <p className="t-cap">{parsed.slice(0, 6).map((p) => `${p.number} ${p.title}`).join(' · ')}{parsed.length > 6 ? ` · and ${parsed.length - 6} more` : ''}</p>}
      <div><Button type="submit" variant="primary" disabled={busy !== null || parsed.length === 0}>{busy === 'import' ? 'Importing…' : `Import ${parsed.length || ''} sections`.replace('  ', ' ')}</Button></div>
    </form>
  );
}

function SectionDetail({ s, subs, edit, busy, act, today, onRemoved }: { s: SpecSection; subs: number; edit: boolean; busy: string | null; act: Act; today: string; onRemoved: () => void }) {
  const url = `/api/commercial/specs/${s.id}`;
  const [title, setTitle] = useState(s.title);
  const [rev, setRev] = useState(String(s.revision));
  const [addendum, setAddendum] = useState(s.addendum ?? '');
  const [p1, setP1] = useState(s.page_start ? String(s.page_start) : '');
  const [p2, setP2] = useState(s.page_end ? String(s.page_end) : '');
  const [confirm, setConfirm] = useState(false);
  const int = (v: string) => (v.trim() ? Math.max(1, Math.round(Number(v))) : null);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Division', value: s.division ? `${s.division} ${divisionName(s.division)}` : '—' },
        { term: 'Revision', value: s.revision > 0 ? `Rev ${s.revision}${s.addendum ? ` (${s.addendum})` : ''}` : 'Original' },
        { term: 'Submittals', value: subs ? <Link className="link" href="/submittals">{subs} on the register</Link> : 'None yet' },
        { term: 'Last changed', value: day(s.updated_at.slice(0, 10), today) },
      ]} />
      {s.revision > 0 && <Tag tone="warn">Revised by addendum — check the submittals against it</Tag>}
      {edit && (
        <DSection title="Edit">
          <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void act('save', 'patch', url, { title: title.trim(), revision: Math.max(0, Math.round(Number(rev) || 0)), addendum: addendum.trim() || null, pageStart: int(p1), pageEnd: int(p2) }, 'Saved the section'); }}>
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
            <div className="row" style={{ gap: 8 }}>
              <Field label="Revision"><Input inputMode="numeric" value={rev} onChange={(e) => setRev(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 70 }} /></Field>
              <Field label="Addendum"><Input value={addendum} onChange={(e) => setAddendum(e.target.value)} maxLength={60} /></Field>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Field label="First page"><Input inputMode="numeric" value={p1} onChange={(e) => setP1(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 90 }} /></Field>
              <Field label="Last page"><Input inputMode="numeric" value={p2} onChange={(e) => setP2(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 90 }} /></Field>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button type="submit" variant="primary" disabled={busy !== null || !title.trim()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
              <Button variant="danger" disabled={busy !== null} onClick={() => setConfirm(true)}>Remove</Button>
            </div>
          </form>
        </DSection>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} tone="danger" title={`Remove section ${s.number}?`} confirmLabel="Remove the section"
        onConfirm={async () => { const r = await act('remove', 'delete', url, undefined, `Removed ${s.number}`); setConfirm(false); if (r) onRemoved(); }}>
        Submittals that name this section keep their section number.
      </ConfirmDialog>
    </div>
  );
}
