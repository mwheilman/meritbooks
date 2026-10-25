'use client';

import { useMemo, useState } from 'react';
import { Button, Drawer, Field, Input, Seg, Select, Tag, Textarea, WidgetState, count } from '@meritbooks/merit-ui';
import { SUBMITTAL_STATUS } from '@/lib/commercial/labels';
import type { SubmittalReviewRow, SubmittalRow } from '@/lib/commercial/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, day, dueText } from './common';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'action' | 'review' | 'done' | 'all';
type ReviewerKind = 'SUB' | 'GC' | 'ARCHITECT' | 'ENGINEER' | 'CONSULTANT' | 'OWNER';
const REVIEWER_WORDS: Readonly<Record<ReviewerKind, string>> = { SUB: 'Subcontractor', GC: 'Our review', ARCHITECT: 'Architect', ENGINEER: 'Engineer', CONSULTANT: 'Consultant', OWNER: 'Owner' };
const NEEDS: ReadonlySet<string> = new Set(['NOT_STARTED', 'REQUESTED', 'REVISE_RESUBMIT', 'REJECTED']);
const REVIEW: ReadonlySet<string> = new Set(['SUBMITTED', 'IN_REVIEW']);
const CODES = [['APPROVED', 'Approved'], ['APPROVED_AS_NOTED', 'Approved as noted'], ['REVISE_RESUBMIT', 'Revise and resubmit'], ['REJECTED', 'Rejected'], ['FOR_RECORD', 'For record']] as const;

/**
 * Submittal register (CGC-62, CGC-65, CGC-66): generated from the spec sections, every item with its
 * submit-by date worked back from the date it is needed on site (minus lead time and review
 * days), the review path step by step, and fabrication released only after approval.
 */
export function SubmittalsView({ submittals, jobs, today, initialId }: { submittals: SubmittalRow[]; jobs: JobOption[]; today: string; initialId?: string | null }) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [jobId, setJobId] = useState(jobs.length === 1 ? jobs[0]!.id : '');
  const [tab, setTab] = useState<Tab>('action');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<SubmittalRow | null>(() => submittals.find((s) => s.id === initialId) ?? null);
  const [panel, setPanel] = useState<'none' | 'specs' | 'add'>('none');
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = submittals.filter((s) => !jobId || s.job_id === jobId);
  const needle = q.trim().toLowerCase();
  const late = (s: SubmittalRow) => NEEDS.has(s.status) && !!s.submit_by && s.submit_by < today;
  const shown = inJob
    .filter((s) => tab === 'all' || (tab === 'action' ? NEEDS.has(s.status) : tab === 'review' ? REVIEW.has(s.status) : !NEEDS.has(s.status) && !REVIEW.has(s.status)))
    .filter((s) => !needle || `${s.number} ${s.title} ${s.spec_section ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => (a.submit_by ?? '9999').localeCompare(b.submit_by ?? '9999'));
  const sections = [...new Set(shown.map((s) => s.spec_section ?? '—'))].sort();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open || submittals.some((s) => s.job_id === j.id))} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <Field label="Find"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, title, section" style={{ width: 200 }} /></Field>
        <Seg aria-label="Which submittals" value={tab} onChange={setTab} items={[
          { value: 'action', label: 'To submit', count: inJob.filter((s) => NEEDS.has(s.status)).length },
          { value: 'review', label: 'In review', count: inJob.filter((s) => REVIEW.has(s.status)).length },
          { value: 'done', label: 'Returned' }, { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {inJob.filter(late).length > 0 && <Tag tone="neg">{count(inJob.filter(late).length)} past submit-by</Tag>}
        {!readOnly && jobId && (
          <>
            <Button onClick={() => setPanel(panel === 'specs' ? 'none' : 'specs')}>Spec sections</Button>
            <Button disabled={busy !== null} onClick={() => void act<{ generated: number }>('gen', 'post', '/api/commercial/submittals', { op: 'generate', jobId }, (r) => r.generated ? `Added ${count(r.generated)} submittals from the spec` : 'The register already covers every spec section')}>
              {busy === 'gen' ? 'Generating…' : 'Generate from spec'}
            </Button>
            <Button icon="plus" onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>Add submittal</Button>
          </>
        )}
      </div>
      <Failure text={error} />
      {panel === 'specs' && jobId && <SpecImport busy={busy === 'specs'} onImport={async (sections) => !!(await act<{ imported: number }>('specs', 'post', '/api/commercial/submittals', { op: 'import_specs', jobId, sections }, (r) => `Imported ${count(r.imported)} spec sections`))} />}
      {panel === 'add' && jobId && <AddSubmittal busy={busy === 'add'} onSave={async (b) => { const r = await act<{ number: string }>('add', 'post', '/api/commercial/submittals', { op: 'create', jobId, ...b }, (d) => `Added ${d.number}`); if (r) setPanel('none'); return !!r; }} />}

      <div className="mp-table">
        {shown.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: needle ? 'No submittals match' : 'No submittals here', body: jobId ? 'Paste the project manual’s section list, then generate the register: each section that needs product data, shop drawings or samples gets a line with its submit-by date.' : 'Pick a job to build its register from the spec sections.' }} />
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th style={{ width: 120 }}>Number</th><th>Submittal</th><th style={{ width: 150 }}>Submit by</th><th style={{ width: 110 }}>On site</th><th style={{ width: 160 }}>Status</th><th style={{ width: 150 }}>With</th></tr></thead>
            {sections.map((sec) => (
              <tbody key={sec}>
                <tr className="q-band"><td colSpan={6}><span className="b">{sec}</span></td></tr>
                {shown.filter((s) => (s.spec_section ?? '—') === sec).map((s) => (
                  <tr key={s.id} className="q-row" onClick={() => setOpen(s)} style={{ cursor: 'pointer' }}>
                    <td><span className="code">{s.number}{s.revision > 0 ? `.${s.revision}` : ''}</span></td>
                    <td><span className="b">{s.title}</span>{s.long_lead && <> <Tag tone="warn">Long lead</Tag></>}{!jobId && <span className="ops-sub" style={{ display: 'block' }}>{byJob.get(s.job_id)?.label ?? 'Job'}</span>}</td>
                    <td>{s.submit_by ? <>{day(s.submit_by, today)}{NEEDS.has(s.status) && <span className="ops-sub" style={{ display: 'block' }}>{late(s) ? <Tag tone="neg">{dueText(s.submit_by, today)}</Tag> : dueText(s.submit_by, today)}</span>}</> : <span className="ops-sub">Set the on-site date</span>}</td>
                    <td>{day(s.required_on_site, today)}</td>
                    <td><Mk map={SUBMITTAL_STATUS} status={s.status} />{s.released_for_fab_on && <span className="ops-sub" style={{ display: 'block' }}>Released {day(s.released_for_fab_on, today)}</span>}</td>
                    <td>{REVIEW.has(s.status) ? s.ball_in_court_name ?? s.ball_in_court_kind ?? '—' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} width={540} title={open ? `${open.number} · ${open.title}` : ''} eyebrow={open ? [byJob.get(open.job_id)?.label ?? 'Submittal', open.spec_section ?? ''].filter(Boolean) : undefined}>
        {open && <SubmittalDetail s={submittals.find((x) => x.id === open.id) ?? open} version={version} readOnly={readOnly} busy={busy} act={act} today={today} />}
      </Drawer>
    </div>
  );
}

function SpecImport({ busy, onImport }: { busy: boolean; onImport: (sections: Array<{ section: string; title: string }>) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const parsed = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => /^(\d{2}\s?\d{2}\s?\d{2}(?:\.\d{2})?)\s+[-–—]?\s*(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ section: m[1]!.replace(/^(\d{2})\s?(\d{2})\s?(\d{2})/, '$1 $2 $3'), title: m[2]!.trim().slice(0, 200) }));
  return (
    <div className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <Field label="Spec sections" help="One per line, as the project manual lists them: 09 21 16 Gypsum Board Assemblies.">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={'03 30 00 Cast-in-Place Concrete\n08 71 00 Door Hardware\n09 21 16 Gypsum Board Assemblies'} />
      </Field>
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Button variant="primary" disabled={busy || parsed.length === 0} onClick={() => void onImport(parsed).then((ok) => { if (ok) setText(''); })}>{busy ? 'Importing…' : `Import ${count(parsed.length)} sections`}</Button>
        {text.trim() && parsed.length === 0 && <span className="t-cap">No lines start with a six-digit section number.</span>}
      </div>
    </div>
  );
}

function AddSubmittal({ busy, onSave }: { busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [type, setType] = useState('PRODUCT_DATA');
  const [onSite, setOnSite] = useState('');
  const [lead, setLead] = useState('');
  const [rev, setRev] = useState('14');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={(e) => {
      e.preventDefault();
      if (!title.trim()) return setErr('Name the submittal.');
      setErr(null);
      void onSave({ title: title.trim(), specSection: spec.trim() || null, submittalType: type, requiredOnSite: onSite || null, leadTimeDays: lead ? Number(lead) : null, reviewDays: rev ? Number(rev) : null, responsibleVendorId: null });
    }}>
      <Field label="Title" error={err ?? undefined}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Switchgear shop drawings" style={{ width: 260 }} /></Field>
      <Field label="Spec section"><Input value={spec} onChange={(e) => setSpec(e.target.value)} maxLength={20} placeholder="26 24 13" style={{ width: 110 }} /></Field>
      <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="PRODUCT_DATA">Product data</option><option value="SHOP_DRAWING">Shop drawings</option><option value="SAMPLE">Samples</option><option value="MOCKUP">Mock-up</option><option value="CERTIFICATE">Certificates</option><option value="TEST_REPORT">Test report</option><option value="CALCULATIONS">Calculations</option><option value="WARRANTY">Warranty</option><option value="OM_MANUAL">O&amp;M manual</option><option value="OTHER">Other</option>
      </Select></Field>
      <Field label="Needed on site"><Input type="date" value={onSite} onChange={(e) => setOnSite(e.target.value)} /></Field>
      <Field label="Lead time (days)"><Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/\D/g, ''))} style={{ width: 90 }} /></Field>
      <Field label="Review (days)"><Input inputMode="numeric" value={rev} onChange={(e) => setRev(e.target.value.replace(/\D/g, ''))} style={{ width: 90 }} /></Field>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Add'}</Button>
    </form>
  );
}

function SubmittalDetail({ s, version, readOnly, busy, act, today }: { s: SubmittalRow; version: number; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const d = useDetail<{ reviews: SubmittalReviewRow[] }>(`/api/commercial/submittals/${s.id}`, version);
  const url = `/api/commercial/submittals/${s.id}`;
  const [path, setPath] = useState<Array<{ kind: ReviewerKind; name: string }>>([{ kind: 'GC', name: '' }, { kind: 'ARCHITECT', name: '' }]);
  const [onSite, setOnSite] = useState(s.required_on_site ?? '');
  const [lead, setLead] = useState(s.lead_time_days != null ? String(s.lead_time_days) : '');
  const [revDays, setRevDays] = useState(s.review_days != null ? String(s.review_days) : '');
  const [code, setCode] = useState<(typeof CODES)[number][0]>('APPROVED');
  const [comments, setComments] = useState('');
  const reviews = d.data?.reviews ?? [];
  const active = reviews.find((r) => r.status === 'ACTIVE' && r.revision === s.revision);
  const canSubmit = NEEDS.has(s.status) && s.status !== 'REJECTED' && s.status !== 'REVISE_RESUBMIT';
  const approved = s.status === 'APPROVED' || s.status === 'APPROVED_AS_NOTED';
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={SUBMITTAL_STATUS} status={s.status} /></span>
        {s.submit_by && <span>Submit by <b>{day(s.submit_by, today)}</b></span>}
        {s.required_on_site && <span>On site <b>{day(s.required_on_site, today)}</b></span>}
        {s.lead_time_days != null && <span>Lead <b>{s.lead_time_days}</b> days</span>}
        <span>Procurement <b>{s.procurement_status.replace(/_/g, ' ').toLowerCase()}</b></span>
      </div>
      {!readOnly && (
        <DSection title="Dates">
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Needed on site"><Input type="date" value={onSite} onChange={(e) => setOnSite(e.target.value)} /></Field>
            <Field label="Lead (days)"><Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/\D/g, ''))} style={{ width: 80 }} /></Field>
            <Field label="Review (days)"><Input inputMode="numeric" value={revDays} onChange={(e) => setRevDays(e.target.value.replace(/\D/g, ''))} style={{ width: 80 }} /></Field>
            <Button disabled={busy !== null} onClick={() => void act<{ submit_by: string | null }>('dates', 'post', url, { op: 'dates', requiredOnSite: onSite || null, leadTimeDays: lead ? Number(lead) : null, reviewDays: revDays ? Number(revDays) : null }, (r) => r.submit_by ? `Submit by ${day(r.submit_by, today)}` : 'Saved')}>Save dates</Button>
          </div>
        </DSection>
      )}
      <DSection title="Review path">
        {d.isLoading && !d.data ? <WidgetState state={{ kind: 'loading', label: 'Loading the reviews…', lines: 3 }} /> : <Failure text={d.error} title="Reviews did not load." />}
        {reviews.length === 0 && !d.isLoading && <p className="t-cap">Not submitted yet.</p>}
        {reviews.length > 0 && (
          <table className="ops-mini">
            <thead><tr><th>Rev</th><th>Step</th><th>Reviewer</th><th>Due</th><th>Result</th></tr></thead>
            <tbody>{reviews.map((r) => (
              <tr key={r.id}>
                <td>{r.revision}</td><td>{r.step}</td><td>{r.reviewer_name ?? REVIEWER_WORDS[r.reviewer_kind as ReviewerKind] ?? r.reviewer_kind}</td>
                <td>{day(r.due_on, today)}{r.status === 'ACTIVE' && r.due_on && r.due_on < today && <> <Tag tone="neg">Late</Tag></>}</td>
                <td>{r.status === 'RETURNED' ? <>{CODES.find((c) => c[0] === r.response_code)?.[1] ?? r.response_code}{r.comments && <span className="ops-sub" style={{ display: 'block' }}>{r.comments}</span>}</> : r.status === 'ACTIVE' ? 'Reviewing' : r.status === 'SKIPPED' ? 'Skipped' : 'Waiting'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {!readOnly && canSubmit && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            {path.map((p, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label={`Step ${i + 1}`}><Select value={p.kind} onChange={(e) => setPath(path.map((x, j) => (j === i ? { ...x, kind: e.target.value as ReviewerKind } : x)))}>{(Object.keys(REVIEWER_WORDS) as ReviewerKind[]).map((k) => <option key={k} value={k}>{REVIEWER_WORDS[k]}</option>)}</Select></Field>
                <Field label="Name"><Input value={p.name} onChange={(e) => setPath(path.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={120} style={{ width: 180 }} /></Field>
                {path.length > 1 && <Button variant="quiet" iconOnly icon="x" aria-label={`Remove step ${i + 1}`} onClick={() => setPath(path.filter((_, j) => j !== i))} />}
              </div>
            ))}
            <div className="row" style={{ gap: 8 }}>
              {path.length < 6 && <Button variant="quiet" icon="plus" onClick={() => setPath([...path, { kind: 'ENGINEER', name: '' }])}>Add a step</Button>}
              <Button variant="primary" disabled={busy !== null} onClick={() => void act('submit', 'post', url, { op: 'submit', reviewers: path.map((p) => ({ kind: p.kind, name: p.name.trim() || null })) }, 'Submitted for review')}>{busy === 'submit' ? 'Submitting…' : 'Submit for review'}</Button>
            </div>
          </div>
        )}
        {!readOnly && active && (
          <form className="stack" style={{ gap: 8, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void act('respond', 'post', url, { op: 'respond', reviewId: active.id, code, comments: comments.trim() || null, stamp: null }, 'Recorded the review'); }}>
            <p className="t-cap">Record step {active.step} ({active.reviewer_name ?? REVIEWER_WORDS[active.reviewer_kind as ReviewerKind] ?? active.reviewer_kind}).</p>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Stamp"><Select value={code} onChange={(e) => setCode(e.target.value as typeof code)}>{CODES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select></Field>
              <Button type="submit" variant="primary" disabled={busy !== null}>Record</Button>
            </div>
            <Field label="Comments"><Textarea value={comments} onChange={(e) => setComments(e.target.value)} maxLength={2000} /></Field>
          </form>
        )}
      </DSection>
      {!readOnly && (
        <DSection title="Actions">
          <Actions busy={busy} items={[
            { key: 'revise', label: 'Start revision', primary: true, onClick: () => void act('revise', 'post', url, { op: 'revise' }, 'Started the next revision'), hidden: s.status !== 'REVISE_RESUBMIT' && s.status !== 'REJECTED' },
            { key: 'release', label: 'Release for fabrication', primary: true, onClick: () => void act('release', 'post', url, { op: 'release', on: today }, 'Released for fabrication'), hidden: !approved || !!s.released_for_fab_on },
          ]} />
          {!approved && !s.released_for_fab_on && <p className="t-cap" style={{ marginTop: 8 }}>Fabrication is released only after the submittal comes back approved.</p>}
        </DSection>
      )}
    </div>
  );
}
