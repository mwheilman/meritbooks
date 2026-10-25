'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { PhotoButton, type Opt } from '@/components/dealer/completion/kit';
import { edgeCode, fractionalInches, parseEdges } from '@/lib/mfg/uom';

const ENG = '/api/mfg/engineering';

interface Gates { measure_done: boolean; open_selections: number; selections_ok: boolean; shop_drawing_status: string | null }
interface Task { id: string; job_id: string; job: string; job_name: string; area: string | null; wbs_id: string | null; kind: string; title: string; status: string; blocked_reason: string | null; assignee: string | null; slot_on: string | null; due_on: string | null; est_hours: number; actual_hours: number; at_risk: boolean; gates: Gates }
interface Queue { capacity_hours_per_week: number; tasks: Task[]; load: Array<{ assignee: string | null; week: string; hours: number; over: boolean }> }
interface SD { id: string; number: string; revision: number; title: string; status: string; wbs_id: string | null; area: string | null; file_id: string | null; envelope_id: string | null; reviewer_kind: string | null; submitted_at: string | null; days_out: number | null; stamp_code: string | null; stamped_by: string | null; comments: string | null; released_at: string | null; gates: Gates }
interface Area { wbs_id: string; name: string; gates: Gates; measures: Array<{ id: string; status: string; scheduled_on: string | null; measured_at: string | null; walls: number; photos: number; waive_reason: string | null }>; selections: Array<{ id: string; category: string; title: string; status: string; due_on: string | null; change_order_id: string | null }>; orders: Array<{ id: string; number: string; status: string; drawings_approved: boolean }> }
interface AreaBoard { areas: Area[]; shop_drawings: SD[]; tasks: Array<{ id: string; wbs_id: string | null; kind: string; title: string; status: string; blocked_reason: string | null; due_on: string | null }>; proposals: unknown[] }

const SD_KIND: Record<string, 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'> = { DRAFTING: 'track', SUBMITTED: 'track', APPROVED: 'ready', APPROVED_AS_NOTED: 'ready', RELEASED: 'ready', REVISE_RESUBMIT: 'risk', REJECTED: 'blocked', SUPERSEDED: 'blocked' };
type Tab = 'queue' | 'job';

/** The engineering queue against drafter capacity, and one job's areas through measure → selections → shop drawings → release. */
export function EngineeringView({ companyId, today, jobs, docs, drafters }: { companyId: string; today: string; jobs: Opt[]; docs: Array<Opt & { jobId: string }>; drafters: Opt[] }) {
  const [tab, setTab] = useState<Tab>('queue');
  const [job, setJob] = useState(jobs[0]?.id ?? '');
  return (
    <div className="stack">
      <Tabs aria-label="Engineering" value={tab} onChange={setTab} items={[{ value: 'queue', label: 'Drafting queue' }, { value: 'job', label: 'Areas and shop drawings' }]} />
      {tab === 'queue' && <QueueView companyId={companyId} today={today} jobs={jobs} drafters={drafters} onOpenJob={(j) => { setJob(j); setTab('job'); }} />}
      {tab === 'job' && (
        <>
          <Field label="Job"><Select value={job} onChange={(e) => setJob(e.target.value)}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
          {job && <AreasView key={job} jobId={job} today={today} docs={docs.filter((d) => d.jobId === job)} />}
        </>
      )}
    </div>
  );
}

function QueueView({ companyId, today, jobs, drafters, onOpenJob }: { companyId: string; today: string; jobs: Opt[]; drafters: Opt[]; onOpenJob: (job: string) => void }) {
  const { readOnly } = useShell();
  const q = useBoard<Queue>(`${ENG}?view=queue&company=${companyId}`);
  const { run, busy, error } = useDo(q.reload);
  const [open, setOpen] = useState<Task | null>(null);
  const [hours, setHours] = useState('');
  const [nw, setNw] = useState({ jobId: jobs[0]?.id ?? '', title: '', est: '', slot: '', assignee: '' });
  const cols: QueueColumn<Task>[] = [
    { id: 't', header: 'Task', cell: (r) => <><span className="l1">{r.title}</span><span className="l2">{[r.job, r.area, r.kind.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · ')}</span></> },
    { id: 'a', header: 'Drafter', width: 140, cell: (r) => r.assignee ?? <span className="t-cap">unassigned</span> },
    { id: 'd', header: 'Due', width: 120, cell: (r) => r.due_on ? <Status kind={r.at_risk ? 'overdue' : 'track'} pip="open">{day(r.due_on, today)}</Status> : '—' },
    { id: 'h', header: 'Hours', numeric: true, width: 100, cell: (r) => `${qty(r.actual_hours)} / ${qty(r.est_hours)}` },
    { id: 's', header: 'Status', width: 170, cell: (r) => <><Status kind={r.status === 'BLOCKED' ? 'blocked' : r.status === 'DONE' ? 'ready' : 'track'} pip="open">{r.status.toLowerCase().replace('_', ' ')}</Status>{r.blocked_reason && <span className="l2">{r.blocked_reason}</span>}</> },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={q} what="The drafting queue" />
      {q.data && (
        <>
          {q.data.tasks.length === 0 ? <Empty title="No drafting work" body="Add a drafting task per area; it is due the engineering buffer before the area's production slot." /> :
            <div className="mp-table"><QueueTable aria-label="Drafting queue" columns={cols} rows={q.data.tasks} getRowId={(r) => r.id} onOpen={setOpen} openOnClick rowState={(r) => ({ attn: r.at_risk || r.status === 'BLOCKED', done: r.status === 'DONE' })} /></div>}
          {q.data.load.length > 0 && (
            <Section title="Drafter load by week" meta={`${qty(q.data.capacity_hours_per_week)} hours a week each`}>
              <table className="ops-mini" aria-label="Drafter load"><thead><tr><th>Drafter</th><th>Week of</th><th className="n">Hours left</th></tr></thead>
                <tbody>{q.data.load.map((l, i) => <tr key={i} className={l.over ? 'neg' : undefined}><td>{l.assignee ?? 'Unassigned'}</td><td>{day(l.week, today)}</td><td className="n">{qty(l.hours)}{l.over ? ' · over' : ''}</td></tr>)}</tbody></table>
            </Section>
          )}
        </>
      )}
      {!readOnly && (
        <Section title="Add a drafting task">
          <div className="ops-toolbar">
            <Field label="Job"><Select value={nw.jobId} onChange={(e) => setNw({ ...nw, jobId: e.target.value })}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
            <Field label="Task"><Input value={nw.title} onChange={(e) => setNw({ ...nw, title: e.target.value })} /></Field>
            <Field label="Hours"><Input inputMode="decimal" value={nw.est} onChange={(e) => setNw({ ...nw, est: e.target.value })} style={{ width: 70 }} /></Field>
            <Field label="Production slot"><Input type="date" value={nw.slot} onChange={(e) => setNw({ ...nw, slot: e.target.value })} /></Field>
            <Field label="Drafter"><Select value={nw.assignee} onChange={(e) => setNw({ ...nw, assignee: e.target.value })}><option value="">Unassigned</option>{drafters.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</Select></Field>
          </div>
          <Button disabled={!nw.jobId || !nw.title.trim() || busy === 'nw'} onClick={() => void run('nw', ENG, { op: 'save_task', jobId: nw.jobId, title: nw.title.trim(), estHours: Number(nw.est) || 0, slotOn: nw.slot || null, assigneeId: nw.assignee || null }, 'Task added').then(() => setNw({ ...nw, title: '', est: '' }))}>Add the task</Button>
        </Section>
      )}
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={open.title} meta={`${open.job} · ${open.area ?? 'whole job'}`}>
          <div className="stack" style={{ padding: 16 }}>
            {open.blocked_reason && <InlineNotice tone="warn" title="Blocked.">{open.blocked_reason}</InlineNotice>}
            <p className="t-cap">Measure {open.gates.measure_done ? 'done' : 'not done'} · {count(open.gates.open_selections)} open selection(s) · shop drawing {open.gates.shop_drawing_status?.toLowerCase().replace('_', ' ') ?? 'none'}</p>
            {!readOnly && (
              <>
                <ButtonRow>{(['IN_PROGRESS', 'SUBMITTED', 'DONE'] as const).filter((s) => s !== open.status).map((s) => <Button key={s} disabled={busy === s} onClick={() => void run<{ status: string }>(s, ENG, { op: 'move_task', taskId: open.id, status: s }, (r) => r.status === 'BLOCKED' ? 'Blocked by the area gates' : `Now ${r.status.toLowerCase().replace('_', ' ')}`).then(() => setOpen(null))}>{s.toLowerCase().replace('_', ' ')}</Button>)}</ButtonRow>
                <ButtonRow><Field label="Log hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 80 }} /></Field><Button disabled={!(Number(hours) > 0) || busy === 'h'} onClick={() => void run('h', ENG, { op: 'log_hours', taskId: open.id, hours: Number(hours) }, 'Hours logged (time entry submitted)').then(() => { setHours(''); setOpen(null); })}>Log</Button></ButtonRow>
              </>
            )}
            <Button variant="quiet" onClick={() => onOpenJob(open.job_id)}>Open the job&apos;s areas</Button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function AreasView({ jobId, today, docs }: { jobId: string; today: string; docs: Opt[] }) {
  const { readOnly } = useShell();
  const b = useBoard<AreaBoard>(`${ENG}?view=areas&job=${jobId}`);
  const { run, busy, error } = useDo(b.reload);
  const [measure, setMeasure] = useState<{ id: string; dims: string; photos: string[] } | null>(null);
  const [sel, setSel] = useState<{ wbsId: string; text: string } | null>(null);
  const [sd, setSd] = useState<{ sd: SD; fileId: string; reviewer: string; email: string; code: string; by: string; comments: string } | null>(null);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="The job's areas" />
      {b.data && (b.data.areas.length === 0 ? <Empty title="No areas on this job" body="Add the job's areas (kitchen, baths, lobby) on the job; each area moves through measure, selections and shop drawings." /> : b.data.areas.map((a) => {
        const d = b.data!.shop_drawings.find((x) => x.wbs_id === a.wbs_id && x.status !== 'SUPERSEDED');
        return (
          <Section key={a.wbs_id} title={a.name} meta={[a.gates.measure_done ? 'measured' : 'not measured', a.gates.selections_ok ? 'selections done' : `${a.gates.open_selections} selection(s) open`, d ? `SD ${d.number} rev ${d.revision} ${d.status.toLowerCase().replace('_', ' ')}` : 'no shop drawing'].join(' · ')}>
            <ButtonRow>
              <Status kind={a.gates.measure_done ? 'ready' : 'risk'} pip="open">Field measure</Status>
              <Status kind={a.gates.selections_ok ? 'ready' : 'risk'} pip="open">Selections</Status>
              <Status kind={d ? SD_KIND[d.status] ?? 'track' : 'track'} pip="open">Shop drawings</Status>
              <Status kind={a.orders.every((o) => o.drawings_approved) && a.orders.length ? 'ready' : 'track'} pip="open">{count(a.orders.length)} order(s) released to drawings</Status>
            </ButtonRow>
            {!readOnly && (
              <ButtonRow>
                {!a.gates.measure_done && (a.measures.find((x) => x.status === 'SCHEDULED') ? <>
                  <Button onClick={() => setMeasure({ id: a.measures.find((x) => x.status === 'SCHEDULED')!.id, dims: 'A | 144 | 96 | 24', photos: [] })}>Record the measure</Button>
                  <Button variant="quiet" onClick={() => { const why = window.prompt('Why can drafting go ahead without a field measure?'); if (why) void run('w' + a.wbs_id, ENG, { op: 'waive_measure', measureId: a.measures.find((x) => x.status === 'SCHEDULED')!.id, reason: why }, 'Measure waived'); }}>Waive</Button>
                </> : <Button onClick={() => { const on = window.prompt('Measure on (YYYY-MM-DD)', today); if (on) void run('m' + a.wbs_id, ENG, { op: 'schedule_measure', jobId, wbsId: a.wbs_id, on }, 'Measure scheduled'); }}>Schedule a field measure</Button>)}
                <Button variant="quiet" onClick={() => setSel({ wbsId: a.wbs_id, text: 'Door style | Shaker 0 | Inset 850\nFinish | Natural 0 | Painted 600\nHardware | Standard pull 0 | Brass pull 240' })}>Add cabinet selections</Button>
                {!d && <Button variant="quiet" onClick={() => { const title = window.prompt('Shop drawing title', `${a.name} elevations`); if (title) void run('sd' + a.wbs_id, ENG, { op: 'create_drawing', jobId, wbsId: a.wbs_id, title }, 'Shop drawing opened'); }}>Start shop drawings</Button>}
              </ButtonRow>
            )}
            {a.selections.length > 0 && <ul className="t-cap">{a.selections.map((s) => <li key={s.id}>{s.title} · {s.status.toLowerCase()}{s.due_on ? ` · due ${day(s.due_on, today)}` : ''}{s.change_order_id ? ' · upcharge change order opened' : ''}</li>)}</ul>}
          </Section>
        );
      }))}
      {b.data && (
        <Section title="Shop drawing log" meta="Every revision with the reviewer's stamp; approval releases the area's production orders">
          {b.data.shop_drawings.length === 0 ? <p className="t-cap">No shop drawings yet.</p> : (
            <table className="ops-mini" aria-label="Shop drawing log">
              <thead><tr><th>Drawing</th><th>Area</th><th>Status</th><th>Stamp</th><th><span className="sr">Next</span></th></tr></thead>
              <tbody>{b.data.shop_drawings.map((x) => <tr key={x.id}><td>{x.number} rev {x.revision}<div className="t-cap">{x.title}</div></td><td>{x.area ?? 'Job'}</td>
                <td><Status kind={SD_KIND[x.status] ?? 'track'} pip="open">{x.status.toLowerCase().replace('_', ' ')}</Status>{x.days_out != null && <div className="t-cap">{x.days_out} days with the {x.reviewer_kind?.toLowerCase() ?? 'reviewer'}</div>}</td>
                <td>{x.stamp_code ? `${x.stamp_code.toLowerCase().replace(/_/g, ' ')} · ${x.stamped_by ?? ''}` : '—'}{x.comments && <div className="t-cap">{x.comments}</div>}</td>
                <td>{!readOnly && ['DRAFTING', 'SUBMITTED', 'APPROVED', 'APPROVED_AS_NOTED'].includes(x.status) && <Button variant={x.status.startsWith('APPROVED') ? 'primary' : 'default'} onClick={() => setSd({ sd: x, fileId: x.file_id ?? docs[0]?.id ?? '', reviewer: '', email: '', code: 'APPROVED', by: '', comments: '' })}>{x.status === 'DRAFTING' ? 'Submit' : x.status === 'SUBMITTED' ? 'Record the stamp' : 'Release'}</Button>}</td></tr>)}</tbody>
            </table>
          )}
        </Section>
      )}
      {measure && (
        <Drawer open onClose={() => setMeasure(null)} title="Field measure">
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Walls (wall | width in | height in | depth in, one per line)"><Textarea rows={5} value={measure.dims} onChange={(e) => setMeasure({ ...measure, dims: e.target.value })} /></Field>
            <PhotoButton url="/api/mfg/uploads" label={`Measure sheet photo${measure.photos.length ? ` (${measure.photos.length})` : ''}`} onFiled={(id) => setMeasure({ ...measure, photos: [...measure.photos, id] })} />
            <Button variant="primary" disabled={busy === 'meas'} onClick={() => void run('meas', ENG, { op: 'record_measure', measureId: measure.id, photoIds: measure.photos,
              dims: measure.dims.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((r) => r[0]).map((r) => ({ wall: r[0]!, width_in: r[1] ? Number(r[1]) : null, height_in: r[2] ? Number(r[2]) : null, depth_in: r[3] ? Number(r[3]) : null })) }, 'Measure recorded').then(() => setMeasure(null))}>Save the measure</Button>
          </div>
        </Drawer>
      )}
      {sel && (
        <Drawer open onClose={() => setSel(null)} title="Cabinet selections" meta="The client chooses on the portal; an option over its allowance opens a priced change order when approved">
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Category | option upcharge $ | option upcharge $ … (one category per line)"><Textarea rows={6} value={sel.text} onChange={(e) => setSel({ ...sel, text: e.target.value })} /></Field>
            <Button variant="primary" disabled={busy === 'sel'} onClick={() => void run('sel', ENG, { op: 'seed_selections', jobId, wbsId: sel.wbsId,
              rows: sel.text.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((r) => r[0]).map((r) => ({ category: r[0]!, title: r[0]!, allowance_cents: 0, options: r.slice(1).filter(Boolean).map((o) => { const mm = /^(.*?)\s+(\d+(?:\.\d{1,2})?)$/.exec(o); return { label: mm ? mm[1]! : o, upcharge_cents: mm ? centsFrom(mm[2]!) ?? 0 : 0 }; }) })) }, 'Selections added').then(() => setSel(null))}>Add the selections</Button>
          </div>
        </Drawer>
      )}
      {sd && (
        <Drawer open onClose={() => setSd(null)} width={520} title={`${sd.sd.number} rev ${sd.sd.revision}`} meta={sd.sd.title}>
          <div className="stack" style={{ padding: 16 }}>
            {sd.sd.status === 'DRAFTING' && (
              <>
                <Field label="Drawing PDF (a document on this job)"><Select value={sd.fileId} onChange={(e) => setSd({ ...sd, fileId: e.target.value })}><option value="">Pick the PDF</option>{docs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
                <Field label="Reviewer name (optional: sends a link to stamp it)"><Input value={sd.reviewer} onChange={(e) => setSd({ ...sd, reviewer: e.target.value })} /></Field>
                <Field label="Reviewer e-mail"><Input value={sd.email} onChange={(e) => setSd({ ...sd, email: e.target.value })} /></Field>
                <Button variant="primary" disabled={!sd.fileId || busy === 'sub'} onClick={() => void run('sub', `/api/mfg/shop-drawings/${sd.sd.id}/submit`, { fileId: sd.fileId, reviewerKind: 'GC', reviewer: sd.reviewer && /@/.test(sd.email) ? { name: sd.reviewer, email: sd.email } : null }, 'Submitted for review').then(() => setSd(null))}>Submit</Button>
                {docs.length === 0 && <p className="t-cap">Upload the PDF on the job&apos;s <Link className="nlink" href={`/documents?job=${jobId}`}>Documents</Link> first.</p>}
              </>
            )}
            {sd.sd.status === 'SUBMITTED' && (
              <>
                <Field label="Stamp"><Select value={sd.code} onChange={(e) => setSd({ ...sd, code: e.target.value })}><option value="APPROVED">Approved</option><option value="APPROVED_AS_NOTED">Approved as noted</option><option value="REVISE_RESUBMIT">Revise and resubmit</option><option value="REJECTED">Rejected</option></Select></Field>
                <Field label="Stamped by"><Input value={sd.by} onChange={(e) => setSd({ ...sd, by: e.target.value })} /></Field>
                <Field label="Comments"><Textarea rows={3} value={sd.comments} onChange={(e) => setSd({ ...sd, comments: e.target.value })} /></Field>
                <Button variant="primary" disabled={!sd.by.trim() || busy === 'st'} onClick={() => void run('st', ENG, { op: 'stamp', id: sd.sd.id, code: sd.code, by: sd.by.trim(), comments: sd.comments || null }, sd.code === 'REVISE_RESUBMIT' ? 'Returned; the next revision and a drafting task are open' : 'Stamp recorded').then(() => setSd(null))}>Record the stamp</Button>
              </>
            )}
            {sd.sd.status.startsWith('APPROVED') && <Button variant="primary" disabled={busy === 'rel'} onClick={() => void run<{ orders_approved: number }>('rel', ENG, { op: 'release_drawing', id: sd.sd.id }, (r) => `Released; ${r.orders_approved} production order(s) cleared to build`).then(() => setSd(null))}>Release for fabrication</Button>}
          </div>
        </Drawer>
      )}
    </div>
  );
}

// ── cut list + traveler (MFG-20 / MFG-32) ────────────────────────────────────────────────────────
interface CutPart { id: string; assembly: string | null; part_code: string | null; label_id: string | null; description: string; material: string | null; qty: number; length_mm: number | null; width_mm: number | null; thickness_mm: number | null; grain: string | null; edges: { l1: string | null; l2: string | null; w1: string | null; w2: string | null }; machining: boolean; sqft: number; edge_lf: number }
interface Cut { number: string; parts: CutPart[]; materials: Array<{ material: string; thickness_mm: number | null; parts: number; sqft: number; sheets_4x8: number; yield_pct: number; nest_sheets: number | null }>; edge_lf_total: number; board_feet: number }
interface Traveler { number: string; summary: string; status: string; area: string | null; quantity: number; operations: Array<{ id: string; seq: number; name: string; status: string; work_center: string | null }>; sheets: Array<{ sheet_id: string; sheet_number: string; title: string | null; revision_label: string | null }>; shop_drawing: { number: string; revision: number; status: string; stamp_code: string | null; comments: string | null } | null; assemblies: Array<{ id: string; ref: string | null; description: string; qty: number; parts: number }>; nests: Array<{ material: string | null; sheets: number; yield_pct: number | null }>; remakes: Array<{ id: string; part_label: string; reason_code: string; status: string }>; change_orders: Array<{ change_order_id: string; number: string | null; title: string; stage: string }>; co_flag: boolean; notes: string | null }

export function CutListView({ woId, families }: { woId: string; families: string[] }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<'cut' | 'traveler'>('cut');
  const c = useBoard<Cut>(`${ENG}?view=cut_list&wo=${woId}`);
  const t = useBoard<Traveler>(tab === 'traveler' ? `${ENG}?view=traveler&wo=${woId}` : null);
  const { run, busy, error } = useDo(() => { c.reload(); t.reload(); });
  const [inch, setInch] = useState(false);
  const [fam, setFam] = useState(families[0] ?? 'BASE');
  const len = (mm: number | null) => (mm == null ? '—' : inch ? fractionalInches(Number(mm)) : `${qty(mm)} mm`);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Tabs aria-label="Order" value={tab} onChange={setTab} items={[{ value: 'cut', label: 'Cut list' }, { value: 'traveler', label: 'Traveler' }]} />
      {tab === 'cut' && <>
        <BoardState b={c} what="The cut list" />
        {c.data && (
          <>
            <ButtonRow><Button variant="quiet" onClick={() => setInch(!inch)}>{inch ? 'Show millimetres' : 'Show inches'}</Button>
              {!readOnly && <><Select aria-label="Family" value={fam} onChange={(e) => setFam(e.target.value)}>{['BASE', 'WALL', 'TALL', 'VANITY', 'CLOSET', 'PANEL', 'FILLER', 'COUNTERTOP', 'DESK', 'FEATURE_WALL', 'OTHER'].map((f) => <option key={f} value={f}>{f.toLowerCase().replace('_', ' ')}</option>)}</Select>
                <Button variant="quiet" disabled={busy === 'fam'} onClick={() => void run<{ operations: number }>('fam', ENG, { op: 'apply_family', woId, family: fam }, (r) => `${r.operations} operations from the family routing`)}>Apply the family routing</Button></>}</ButtonRow>
            <p className="t-cap">{count(c.data.parts.length)} parts · {qty(c.data.edge_lf_total)} LF of edge band{Number(c.data.board_feet) > 0 ? ` · ${qty(c.data.board_feet)} board feet` : ''}</p>
            {c.data.materials.length > 0 && <table className="ops-mini" aria-label="Materials"><thead><tr><th>Material</th><th className="n">Parts</th><th className="n">Sq ft</th><th className="n">4×8 sheets</th><th className="n">Nest</th></tr></thead>
              <tbody>{c.data.materials.map((x) => <tr key={x.material + x.thickness_mm}><td>{x.material}{x.thickness_mm ? ` ${qty(x.thickness_mm)} mm` : ''}</td><td className="n">{count(x.parts)}</td><td className="n">{qty(x.sqft)}</td><td className="n">{count(x.sheets_4x8)} <span className="t-cap">at {Math.round(Number(x.yield_pct) * 100)}%</span></td><td className="n">{x.nest_sheets == null ? '—' : qty(x.nest_sheets)}</td></tr>)}</tbody></table>}
            {c.data.parts.length === 0 ? <Empty title="No parts yet" body="Apply the CAD/CAM import to this order (CAD imports) and its parts list here." /> : (
              <table className="ops-mini" aria-label="Cut list">
                <thead><tr><th>Part</th><th>Material</th><th className="n">Qty</th><th className="n">L × W</th><th>Grain</th><th>Edges</th><th className="n">Edge LF</th></tr></thead>
                <tbody>{c.data.parts.map((p) => {
                  const e = { l1: !!p.edges.l1, l2: !!p.edges.l2, w1: !!p.edges.w1, w2: !!p.edges.w2 };
                  return <tr key={p.id}><td>{p.label_id ?? p.part_code ?? '—'}<div className="t-cap">{p.assembly} · {p.description}{p.machining ? ' · machined' : ''}</div></td><td>{p.material ?? '—'}</td><td className="n">{qty(p.qty)}</td><td className="n">{len(p.length_mm)} × {len(p.width_mm)}</td><td>{p.grain?.toLowerCase() ?? '—'}</td>
                    <td>{readOnly ? edgeCode(e) || 'none' : <Input aria-label={`Edges for ${p.part_code ?? p.description}`} defaultValue={edgeCode(e)} onBlur={(ev) => { const n = parseEdges(ev.target.value); if (edgeCode(n) !== edgeCode(e)) void run(p.id, ENG, { op: 'part_edges', lineId: p.id, edges: { l1: n.l1 ? 'EB' : null, l2: n.l2 ? 'EB' : null, w1: n.w1 ? 'EB' : null, w2: n.w2 ? 'EB' : null } }, 'Edges saved'); }} style={{ width: 90 }} />}</td>
                    <td className="n">{qty(p.edge_lf)}</td></tr>;
                })}</tbody>
              </table>
            )}
          </>
        )}
      </>}
      {tab === 'traveler' && <>
        <BoardState b={t} what="The traveler" />
        {t.data && (
          <>
            {t.data.co_flag && <InlineNotice tone="warn" title="Change order on this area.">{t.data.change_orders.map((x) => `${x.number ?? 'CO'} ${x.title} (${x.stage.toLowerCase()})`).join('; ')}. Check the current drawings before cutting.</InlineNotice>}
            {t.data.shop_drawing && <p className="t-cap">Shop drawing {t.data.shop_drawing.number} rev {t.data.shop_drawing.revision}: {t.data.shop_drawing.status.toLowerCase().replace('_', ' ')}{t.data.shop_drawing.comments ? ` · ${t.data.shop_drawing.comments}` : ''}</p>}
            <Section title="Operations">{t.data.operations.length === 0 ? <p className="t-cap">No routing yet.</p> : <ol>{t.data.operations.map((o) => <li key={o.id}>{o.name} · {o.work_center ?? ''} · <span className="t-cap">{o.status.toLowerCase()}</span></li>)}</ol>}</Section>
            <Section title="Current drawings">{t.data.sheets.length === 0 ? <p className="t-cap">No sheets on the job.</p> : <ul>{t.data.sheets.map((s) => <li key={s.sheet_id}>{s.sheet_number} rev {s.revision_label ?? '—'} · {s.title}</li>)}</ul>}</Section>
            <Section title="Assemblies">{t.data.assemblies.map((a) => <p key={a.id} className="t-cap">{a.ref} · {a.description} × {qty(a.qty)} ({count(a.parts)} parts)</p>)}</Section>
            {t.data.remakes.length > 0 && <Section title="Open remakes">{t.data.remakes.map((r) => <p key={r.id} className="t-cap">{r.part_label} · {r.reason_code.toLowerCase().replace('_', ' ')} · {r.status.toLowerCase()}</p>)}</Section>}
          </>
        )}
      </>}
    </div>
  );
}
