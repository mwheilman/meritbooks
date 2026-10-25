'use client';

import { useMemo, useState } from 'react';
import { Button, Check, Drawer, Field, Input, InlineNotice, KV, Ledger, Select, Tabs, Tag, Textarea, WidgetState, useQuery } from '@meritbooks/merit-ui';
import { oshaRate, suggestRecordable } from '@/lib/commercial/screen-logic';
import type { Incident, Jha, Osha300A, Osha300Row, ToolboxTalk } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'talks' | 'jha' | 'incidents' | 'osha';
const PPE = ['Hard hat', 'Safety glasses', 'Hi-vis vest', 'Gloves', 'Steel-toe boots', 'Hearing protection', 'Fall harness', 'Respirator', 'Face shield', 'Arc-flash suit'] as const;
const INCIDENT_TYPES = ['INJURY', 'ILLNESS', 'NEAR_MISS', 'PROPERTY_DAMAGE', 'ENVIRONMENTAL', 'VEHICLE'] as const;
const CLASSES = ['DEATH', 'DAYS_AWAY', 'RESTRICTED_OR_TRANSFER', 'OTHER_RECORDABLE'] as const;
const ILLNESS = ['INJURY', 'SKIN_DISORDER', 'RESPIRATORY', 'POISONING', 'HEARING_LOSS', 'OTHER_ILLNESS'] as const;

/** The toolbox-talk library, English and Spanish; the hazards on open safety observations come first. */
export const TALK_LIBRARY: ReadonlyArray<{ en: string; es: string; key: string }> = [
  { key: 'fall', en: 'Fall protection at leading edges and openings', es: 'Protección contra caídas en bordes y aberturas' },
  { key: 'ladder', en: 'Ladder setup and three points of contact', es: 'Uso de escaleras y tres puntos de contacto' },
  { key: 'electrical', en: 'Lockout / tagout before electrical work', es: 'Bloqueo y etiquetado antes de trabajo eléctrico' },
  { key: 'silica', en: 'Silica dust: wet cutting and respirators', es: 'Polvo de sílice: corte húmedo y respiradores' },
  { key: 'heat', en: 'Heat illness: water, rest, shade', es: 'Enfermedades por calor: agua, descanso, sombra' },
  { key: 'struck', en: 'Struck-by hazards around equipment', es: 'Riesgos de golpes cerca del equipo' },
  { key: 'trench', en: 'Trench and excavation protection', es: 'Protección en zanjas y excavaciones' },
  { key: 'housekeeping', en: 'Housekeeping and clear walkways', es: 'Orden y limpieza, pasillos libres' },
  { key: 'scaffold', en: 'Scaffold inspection tags', es: 'Etiquetas de inspección de andamios' },
  { key: 'ppe', en: 'Right PPE for the task', es: 'El equipo de protección correcto para la tarea' },
];

/** Topics for this week: the open safety hazards first (as written), then the library in the chosen language. Pure. */
export function suggestTopics(hazards: ReadonlyArray<string>, language: 'en' | 'es', n = 6): string[] {
  const fromSite = [...new Set(hazards.map((h) => h.trim()).filter(Boolean))].map((h) => (language === 'es' ? `Riesgo en obra: ${h}` : `On our site: ${h}`));
  return [...fromSite, ...TALK_LIBRARY.map((t) => t[language])].slice(0, n);
}

/**
 * Safety (CGC-78 / CGC-79): weekly toolbox talks with the crew sign-in, daily pre-task plans
 * (JHA) signed by the crew, incident reports with witnesses, root cause and corrective actions,
 * and the OSHA 300 log, 300A summary and 301 detail with TRIR and DART from hours worked.
 */
export function SafetyView({ talks, jhas, incidents, incidentsVisible, hazards, jobs, companies, today, canRecord, canIncident, initialTab = 'talks', onChanged }: {
  talks: ToolboxTalk[]; jhas: Jha[]; incidents: Incident[]; incidentsVisible: boolean; hazards: string[]; jobs: JobOption[];
  /** Establishments for the OSHA logs; none = the OSHA tab is left out (a job page). */
  companies: Array<{ id: string; name: string }>; today: string; canRecord: boolean; canIncident: boolean; initialTab?: Tab; onChanged?: () => void;
}) {
  const { readOnly } = useShell();
  const ops = useOps();
  const { busy, error, version } = ops;
  const act = (async (...a: Parameters<Act>) => { const r = await ops.act(...a); if (r) onChanged?.(); return r; }) as Act;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [jobId, setJobId] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ kind: 'talk' | 'jha' | 'incident'; id: string } | null>(null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const f = <T extends { job_id: string }>(xs: T[]) => xs.filter((x) => !jobId || x.job_id === jobId);
  const T = f(talks), J = f(jhas), I = f(incidents);
  const rec = !readOnly && canRecord;
  const ot = open?.kind === 'talk' ? talks.find((t) => t.id === open.id) ?? null : null;
  const oj = open?.kind === 'jha' ? jhas.find((t) => t.id === open.id) ?? null : null;
  const oi = open?.kind === 'incident' ? incidents.find((t) => t.id === open.id) ?? null : null;

  const tcols: Col<ToolboxTalk>[] = [
    { key: 'd', head: 'Held', width: 110, cell: (t) => day(t.held_on, today) },
    { key: 't', head: 'Topic', cell: (t) => <><span className="b">{t.topic}</span>{t.language === 'es' && <> <Tag>Español</Tag></>}<span className="ops-sub" style={{ display: 'block' }}>{[t.presenter_name, !jobId ? byJob.get(t.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'a', head: 'Signed in', n: true, width: 100, cell: (t) => t.attendees },
  ];
  const jcols: Col<Jha>[] = [
    { key: 'd', head: 'Work date', width: 110, cell: (h) => day(h.work_date, today) },
    { key: 't', head: 'Task', cell: (h) => <><span className="b">{h.task_description}</span><span className="ops-sub" style={{ display: 'block' }}>{[h.area, `${h.steps.length} steps`, !jobId ? byJob.get(h.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'p', head: 'PPE', width: 240, cell: (h) => h.ppe.join(', ') || '—' },
    { key: 's', head: 'Crew sign-off', width: 140, cell: (h) => (h.status === 'SIGNED' ? <Tag tone="pos">{h.signoffs.length} signed</Tag> : <Tag tone="warn">Not signed</Tag>) },
  ];
  const icols: Col<Incident>[] = [
    { key: 'n', head: 'Case', width: 100, cell: (i) => <span className="code">{i.number ?? '—'}</span> },
    { key: 't', head: 'Incident', cell: (i) => <><span className="b">{words(i.incident_type)}{i.person_name ? ` — ${i.privacy_case ? 'Privacy case' : i.person_name}` : ''}</span><span className="ops-sub" style={{ display: 'block' }}>{[i.where_occurred, !jobId ? byJob.get(i.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'd', head: 'Occurred', width: 120, cell: (i) => day(i.occurred_at.slice(0, 10), today) },
    { key: 'r', head: 'OSHA', width: 190, cell: (i) => (i.osha_recordable ? <Tag tone="neg">Recordable · {words(i.osha_classification)}</Tag> : i.osha_recordable === false ? <Tag>Not recordable</Tag> : <Tag tone="warn">To determine</Tag>) },
    { key: 's', head: 'Status', width: 120, cell: (i) => <Tag tone={i.status === 'CLOSED' ? 'pos' : undefined}>{words(i.status)}</Tag> },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Tabs aria-label="Safety records" value={tab} onChange={(v) => { setTab(v); setAdding(false); }} items={[
        { value: 'talks', label: 'Toolbox talks', count: T.length },
        { value: 'jha', label: 'Pre-task plans', count: J.filter((h) => h.status !== 'SIGNED').length || undefined },
        ...(incidentsVisible ? [{ value: 'incidents' as const, label: 'Incidents', count: I.filter((i) => i.status !== 'CLOSED').length || undefined }] : []),
        ...(incidentsVisible && companies.length > 0 ? [{ value: 'osha' as const, label: 'OSHA logs' }] : []),
      ]} />
      {tab !== 'osha' && (
        <div className="ops-toolbar">
          <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
          <span className="sp" />
          {rec && tab !== 'incidents' && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>{tab === 'talks' ? 'Record a toolbox talk' : 'New pre-task plan'}</Button>}
          {!readOnly && canIncident && tab === 'incidents' && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>Report an incident</Button>}
        </div>
      )}
      <Failure text={error} />
      {tab === 'talks' && adding && rec && <NewTalk jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} hazards={hazards} today={today} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {tab === 'jha' && adding && rec && <NewJha jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} today={today} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {tab === 'incidents' && adding && <NewIncident jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} today={today} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {tab === 'talks' && <CmTable label="Toolbox talks" keys rows={T} cols={tcols} rowKey={(t) => t.id} onOpen={(t) => setOpen({ kind: 'talk', id: t.id })} activeId={open?.id}
        empty={{ title: 'No toolbox talks yet', body: 'Hold one a week: a topic from this week’s work or an open hazard, in English or Spanish, and the crew signs in.' }} />}
      {tab === 'jha' && <CmTable label="Pre-task plans" keys rows={J} cols={jcols} rowKey={(h) => h.id} onOpen={(h) => setOpen({ kind: 'jha', id: h.id })} activeId={open?.id}
        rowTone={(h) => (h.status !== 'SIGNED' && h.work_date <= today ? 'warn' : null)}
        empty={{ title: 'No pre-task plans', body: 'Each crew plans the day’s task: steps, the hazard in each, the control, the PPE — and signs it before starting.' }} />}
      {tab === 'incidents' && <CmTable label="Incidents" keys rows={I} cols={icols} rowKey={(i) => i.id} onOpen={(i) => setOpen({ kind: 'incident', id: i.id })} activeId={open?.id}
        rowTone={(i) => (i.osha_recordable == null && (i.incident_type === 'INJURY' || i.incident_type === 'ILLNESS') ? 'warn' : null)}
        empty={{ title: 'No incidents reported', body: 'Report injuries, illnesses, near misses and damage the same day. Recordable cases flow to the OSHA 300 log.' }} />}
      {tab === 'osha' && <OshaLogs companies={companies} today={today} onIncident={(id) => setOpen({ kind: 'incident', id })} />}
      {tab !== 'osha' && <TableKeys extra={rec ? [{ chord: 'n', label: 'New' }] : []} />}

      <Drawer open={!!ot} onClose={() => setOpen(null)} width={520} title={ot?.topic ?? ''} eyebrow={ot ? `Toolbox talk // ${byJob.get(ot.job_id)?.label ?? ''}` : undefined}>
        {ot && <TalkDetail key={ot.id} t={ot} version={version} edit={rec} busy={busy} act={act} today={today} />}
      </Drawer>
      <Drawer open={!!oj} onClose={() => setOpen(null)} width={560} title={oj?.task_description ?? ''} eyebrow={oj ? `Pre-task plan // ${day(oj.work_date, today)}` : undefined}>
        {oj && <JhaDetail key={oj.id} h={oj} edit={rec} busy={busy} act={act} />}
      </Drawer>
      <Drawer open={!!oi} onClose={() => setOpen(null)} width={620} title={oi ? `${oi.number ?? 'Incident'} · ${words(oi.incident_type)}` : ''} eyebrow={oi ? `OSHA 301 // ${byJob.get(oi.job_id)?.label ?? ''}` : undefined}>
        {oi && <IncidentDetail key={oi.id} i={oi} edit={!readOnly && canIncident} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function NewTalk({ jobs, defaultJobId, hazards, today, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; hazards: string[]; today: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [lang, setLang] = useState<'en' | 'es'>('en');
  const [topic, setTopic] = useState('');
  const [held, setHeld] = useState(today);
  const [presenter, setPresenter] = useState('');
  const [crew, setCrew] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const topics = suggestTopics(hazards, lang);
  const attendees = crew.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, ...co] = l.split(','); return { name: name!.trim().slice(0, 120), company: co.join(',').trim() || null }; });
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId || !topic.trim()) return setErr('Pick the job and the topic.');
      setErr(null);
      const r = await act('talk', 'post', '/api/commercial/safety', { op: 'toolbox', jobId, heldOn: held, topic: topic.trim(), language: lang, presenterName: presenter.trim() || null, notes: notes.trim() || null, attendees }, `Recorded the talk with ${attendees.length} signed in`);
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Held on"><Input type="date" value={held} onChange={(e) => setHeld(e.target.value)} /></Field>
        <Field label="Language"><Select value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'es')}><option value="en">English</option><option value="es">Español</option></Select></Field>
        <Field label="Presenter"><Input value={presenter} onChange={(e) => setPresenter(e.target.value)} maxLength={200} /></Field>
      </div>
      <Field label="Topic"><Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} /></Field>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{topics.map((t) => <Button key={t} variant="quiet" onClick={() => setTopic(t)}>{t}</Button>)}</div>
      <Field label="Crew sign-in" help="One per line: name, company. Signatures by phone or QR come from the field app."><Textarea value={crew} onChange={(e) => setCrew(e.target.value)} rows={5} placeholder={'Luis Ortega, Heartland Electric\nAnna Price'} /></Field>
      <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'talk' ? 'Saving…' : 'Record the talk'}</Button></div>
    </form>
  );
}

function NewJha({ jobs, defaultJobId, today, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; today: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [date, setDate] = useState(today);
  const [task, setTask] = useState('');
  const [area, setArea] = useState('');
  const [steps, setSteps] = useState([{ step: '', hazard: '', control: '' }]);
  const [ppe, setPpe] = useState<string[]>(['Hard hat', 'Safety glasses', 'Hi-vis vest']);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId || !task.trim()) return setErr('Pick the job and describe the task.');
      setErr(null);
      const r = await act('jha', 'post', '/api/commercial/safety', { op: 'jha', jobId, workDate: date, task: task.trim(), area: area.trim() || null, steps: steps.filter((s) => s.step.trim()), ppe }, 'Saved the pre-task plan');
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Work date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Task"><Input value={task} onChange={(e) => setTask(e.target.value)} maxLength={500} style={{ width: 300 }} placeholder="Pull feeders in the east shaft" /></Field>
        <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={200} /></Field>
      </div>
      <DSection title="Steps, hazards and controls" aside={<Button variant="quiet" onClick={() => setSteps((s) => [...s, { step: '', hazard: '', control: '' }])}>Add a step</Button>}>
        {steps.map((s, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end', marginBottom: 6, flexWrap: 'wrap' }}>
            <Field label={`Step ${i + 1}`}><Input value={s.step} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, step: e.target.value } : y)))} maxLength={300} style={{ width: 220 }} /></Field>
            <Field label="Hazard"><Input value={s.hazard} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, hazard: e.target.value } : y)))} maxLength={300} style={{ width: 200 }} /></Field>
            <Field label="Control"><Input value={s.control} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, control: e.target.value } : y)))} maxLength={300} style={{ width: 220 }} /></Field>
            {steps.length > 1 && <Button variant="quiet" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
        ))}
      </DSection>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{PPE.map((p) => <Check key={p} label={p} checked={ppe.includes(p)} onChange={(e) => setPpe((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} />)}</div>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'jha' ? 'Saving…' : 'Save the plan'}</Button></div>
    </form>
  );
}

function NewIncident({ jobs, defaultJobId, today, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; today: string; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [type, setType] = useState<string>('INJURY');
  const [when, setWhen] = useState(`${today}T08:00`);
  const [person, setPerson] = useState('');
  const [employee, setEmployee] = useState(true);
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [where, setWhere] = useState('');
  const [body, setBody] = useState('');
  const [part, setPart] = useState('');
  const [nature, setNature] = useState('');
  const [away, setAway] = useState('0');
  const [restricted, setRestricted] = useState('0');
  const [err, setErr] = useState<string | null>(null);
  const injury = type === 'INJURY' || type === 'ILLNESS';
  const s = suggestRecordable({ incident_type: type, is_employee: employee, days_away: Number(away) || 0, days_restricted: Number(restricted) || 0, injury_nature: nature || null });
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      const at = new Date(when);
      if (!jobId || !body.trim() || Number.isNaN(at.getTime())) return setErr('Pick the job, when it happened, and describe it.');
      setErr(null);
      const r = await act<{ number: string | null }>('inc', 'post', '/api/commercial/safety', {
        op: 'incident', jobId, incidentType: type, occurredAt: at.toISOString(), personName: person.trim() || null, jobTitle: title.trim() || null, company: company.trim() || null,
        isEmployee: employee, description: body.trim(), whereOccurred: where.trim() || null, bodyPart: part.trim() || null, injuryNature: nature.trim() || null,
        oshaRecordable: s.recordable, oshaClassification: s.recordable ? s.classification : null, injuryOrIllness: injury ? (type === 'ILLNESS' ? 'OTHER_ILLNESS' : 'INJURY') : null,
        daysAway: Number(away) || 0, daysRestricted: Number(restricted) || 0,
      }, (d) => `Reported ${d.number ?? 'the incident'}`);
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{INCIDENT_TYPES.map((t) => <option key={t} value={t}>{words(t)}</option>)}</Select></Field>
        <Field label="When"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Where"><Input value={where} onChange={(e) => setWhere(e.target.value)} maxLength={200} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Person"><Input value={person} onChange={(e) => setPerson(e.target.value)} maxLength={200} /></Field>
        <Field label="Job title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} /></Field>
        <Check label="Our employee" checked={employee} onChange={(e) => setEmployee(e.target.checked)} />
      </div>
      <Field label="What happened"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} /></Field>
      {injury && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Body part"><Input value={part} onChange={(e) => setPart(e.target.value)} maxLength={200} /></Field>
          <Field label="Injury or illness"><Input value={nature} onChange={(e) => setNature(e.target.value)} maxLength={200} placeholder="Laceration, sprain, burn" /></Field>
          <Field label="Days away"><Input inputMode="numeric" value={away} onChange={(e) => setAway(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 80 }} /></Field>
          <Field label="Days restricted"><Input inputMode="numeric" value={restricted} onChange={(e) => setRestricted(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 80 }} /></Field>
        </div>
      )}
      <InlineNotice tone={s.recordable ? 'warn' : 'default'} title={s.recordable === true ? `Likely recordable — ${words(s.classification)}` : s.recordable === false ? 'Not recordable' : 'Recordable? Review it'}>{s.why} The safety manager confirms on the incident.</InlineNotice>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'inc' ? 'Reporting…' : 'Report it'}</Button></div>
    </form>
  );
}

function TalkDetail({ t, version, edit, busy, act, today }: { t: ToolboxTalk; version: number; edit: boolean; busy: string | null; act: Act; today: string }) {
  const url = `/api/commercial/safety/talks/${t.id}`;
  const d = useDetail<{ attendance: Array<{ id: string; worker_name: string; company: string | null; method: string; signed_at: string }> }>(url, version);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[{ term: 'Held', value: day(t.held_on, today) }, { term: 'Language', value: t.language === 'es' ? 'Español' : 'English' }, { term: 'Presenter', value: t.presenter_name ?? '—' }]} />
      {t.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{t.notes}</p>}
      <DSection title="Sign-in sheet">
        {d.isLoading && !d.data ? <WidgetState state={{ kind: 'loading', label: 'Loading the sign-in…', lines: 3 }} /> : d.error ? <Failure text={d.error} title="The sign-in did not load." /> : (d.data?.attendance ?? []).length === 0 ? <p className="t-cap">Nobody signed in yet.</p> : (
          <ul className="feed">{(d.data?.attendance ?? []).map((a) => <li key={a.id}><span><span className="l1">{a.worker_name}</span>{a.company && <span style={{ display: 'block' }}>{a.company}</span>}</span><span className="t">{words(a.method)} · {stamp(a.signed_at)}</span></li>)}</ul>
        )}
        {edit && (
          <form className="row" style={{ gap: 8, alignItems: 'flex-end', marginTop: 12 }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const r = await act('in', 'post', url, { name: name.trim(), company: company.trim() || null, method: 'PAPER' }, `Signed in ${name.trim()}`); if (r) { setName(''); } }}>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
            <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} /></Field>
            <Button type="submit" disabled={busy !== null || !name.trim()}>Sign in</Button>
          </form>
        )}
      </DSection>
    </div>
  );
}

function JhaDetail({ h, edit, busy, act }: { h: Jha; edit: boolean; busy: string | null; act: Act }) {
  const [crew, setCrew] = useState('');
  const signers = crew.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, ...co] = l.split(','); return { name: name!.trim().slice(0, 120), company: co.join(',').trim() || null }; });
  return (
    <div className="stack" style={{ gap: 20 }}>
      <DSection title="Steps">
        {h.steps.length === 0 ? <p className="t-cap">No steps written.</p> : (
          <table className="tbl tbl-q tbl-q--compact"><thead><tr><th>Step</th><th>Hazard</th><th>Control</th></tr></thead>
            <tbody>{h.steps.map((s, i) => <tr key={i}><td>{s.step}</td><td>{s.hazard ?? (s.hazards ?? []).join(', ')}</td><td>{s.control ?? (s.controls ?? []).join(', ')}</td></tr>)}</tbody></table>
        )}
      </DSection>
      <KV items={[{ term: 'PPE', value: h.ppe.join(', ') || '—' }, { term: 'Permits', value: h.permits.join(', ') || '—' }, { term: 'Area', value: h.area ?? '—' }]} />
      <DSection title="Crew sign-off">
        {h.signoffs.length === 0 ? <p className="t-cap">Not signed yet.</p> : <ul className="feed">{h.signoffs.map((s, i) => <li key={i}><span>{s.name}{s.company ? ` · ${s.company}` : ''}</span><span className="t">{s.signed_at ? stamp(s.signed_at) : ''}</span></li>)}</ul>}
        {edit && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            <Field label="Who signs" help="One per line: name, company."><Textarea value={crew} onChange={(e) => setCrew(e.target.value)} rows={4} /></Field>
            <div><Button variant="primary" disabled={busy !== null || signers.length === 0} onClick={() => void act('sign', 'post', '/api/commercial/safety', { op: 'sign_jha', jhaId: h.id, signoffs: signers }, `${signers.length} signed the plan`)}>Record the sign-off</Button></div>
          </div>
        )}
      </DSection>
    </div>
  );
}

function IncidentDetail({ i, edit, busy, act }: { i: Incident; edit: boolean; busy: string | null; act: Act }) {
  const url = `/api/commercial/safety/incidents/${i.id}`;
  const [recordable, setRecordable] = useState<string>(i.osha_recordable == null ? '' : i.osha_recordable ? 'yes' : 'no');
  const [cls, setCls] = useState(i.osha_classification ?? '');
  const [ill, setIll] = useState(i.injury_or_illness ?? 'INJURY');
  const [away, setAway] = useState(String(i.days_away));
  const [restricted, setRestricted] = useState(String(i.days_restricted));
  const [privacy, setPrivacy] = useState(i.privacy_case);
  const [root, setRoot] = useState(i.root_cause ?? '');
  const [actions, setActions] = useState(i.corrective_actions.map((a) => ({ ...a })));
  const [witness, setWitness] = useState(i.witnesses.map((w) => `${w.name}${w.statement ? `: ${w.statement}` : ''}`).join('\n'));
  const [wc, setWc] = useState(i.wc_claim_ref ?? '');
  const s = suggestRecordable(i);
  const save = (status?: string) => void act(status ? `st:${status}` : 'save', 'patch', url, {
    oshaRecordable: recordable === '' ? null : recordable === 'yes', oshaClassification: recordable === 'yes' ? cls || null : null, injuryOrIllness: ill || null,
    daysAway: Number(away) || 0, daysRestricted: Number(restricted) || 0, privacyCase: privacy, rootCause: root.trim() || null,
    correctiveActions: actions.filter((a) => a.action.trim()), wcClaimRef: wc.trim() || null,
    witnesses: witness.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [n, ...st] = l.split(':'); return { name: n!.trim().slice(0, 120), ...(st.length ? { statement: st.join(':').trim().slice(0, 2000) } : {}) }; }),
    ...(status ? { status } : {}),
  }, status ? `Incident ${words(status).toLowerCase()}` : 'Saved the incident');
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Occurred', value: stamp(i.occurred_at) }, { term: 'Reported', value: stamp(i.reported_at) },
        { term: 'Person', value: i.privacy_case ? 'Privacy case' : i.person_name ?? '—' }, { term: 'Job title', value: i.job_title ?? '—' },
        { term: 'Employee', value: i.is_employee ? 'Yes' : `No${i.company ? ` — ${i.company}` : ''}` }, { term: 'Where', value: i.where_occurred ?? '—' },
        { term: 'Body part', value: i.body_part ?? '—' }, { term: 'Injury or illness', value: i.injury_nature ?? '—' }, { term: 'Case number', value: i.case_number ?? '—' },
      ]} />
      <p style={{ whiteSpace: 'pre-wrap' }}>{i.description}</p>
      {edit ? (
        <>
          <DSection title="Recordable determination">
            <InlineNotice tone="default" title={s.recordable === true ? `Suggested: recordable, ${words(s.classification)}` : s.recordable === false ? 'Suggested: not recordable' : 'Needs review'}>{s.why}</InlineNotice>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <Field label="OSHA recordable"><Select value={recordable} onChange={(e) => setRecordable(e.target.value)}><option value="">Not decided</option><option value="yes">Yes</option><option value="no">No</option></Select></Field>
              {recordable === 'yes' && <Field label="Classification"><Select value={cls} onChange={(e) => setCls(e.target.value)}><option value="">Pick one</option>{CLASSES.map((c) => <option key={c} value={c}>{words(c)}</option>)}</Select></Field>}
              <Field label="Case type"><Select value={ill} onChange={(e) => setIll(e.target.value)}>{ILLNESS.map((c) => <option key={c} value={c}>{words(c)}</option>)}</Select></Field>
              <Field label="Days away"><Input inputMode="numeric" value={away} onChange={(e) => setAway(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 70 }} /></Field>
              <Field label="Days restricted"><Input inputMode="numeric" value={restricted} onChange={(e) => setRestricted(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 70 }} /></Field>
            </div>
            <Check label="Privacy case (name left off the 300 log)" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
          </DSection>
          <DSection title="Investigation">
            <Field label="Witnesses" help="One per line: name: what they saw"><Textarea value={witness} onChange={(e) => setWitness(e.target.value)} rows={3} /></Field>
            <Field label="Root cause"><Textarea value={root} onChange={(e) => setRoot(e.target.value)} maxLength={2000} rows={3} /></Field>
            <div className="stack" style={{ gap: 6 }}>
              {actions.map((a, k) => (
                <div key={k} className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label={`Corrective action ${k + 1}`}><Input value={a.action} onChange={(e) => setActions((x) => x.map((y, j) => (j === k ? { ...y, action: e.target.value } : y)))} maxLength={300} style={{ width: 260 }} /></Field>
                  <Field label="Owner"><Input value={a.owner ?? ''} onChange={(e) => setActions((x) => x.map((y, j) => (j === k ? { ...y, owner: e.target.value } : y)))} maxLength={120} /></Field>
                  <Field label="Due"><Input type="date" value={a.due ?? ''} onChange={(e) => setActions((x) => x.map((y, j) => (j === k ? { ...y, due: e.target.value || undefined } : y)))} /></Field>
                  <Check label="Done" checked={a.done ?? false} onChange={(e) => setActions((x) => x.map((y, j) => (j === k ? { ...y, done: e.target.checked } : y)))} />
                </div>
              ))}
              <div><Button variant="quiet" onClick={() => setActions((x) => [...x, { action: '' }])}>Add a corrective action</Button></div>
            </div>
            <Field label="Workers' comp claim"><Input value={wc} onChange={(e) => setWc(e.target.value)} maxLength={80} /></Field>
          </DSection>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button variant="primary" chord="mod+s" bindChord disabled={busy !== null || (recordable === 'yes' && !cls)} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
            {i.status === 'OPEN' && <Button disabled={busy !== null} onClick={() => save('UNDER_REVIEW')}>Send for review</Button>}
            {i.status !== 'CLOSED' && <Button disabled={busy !== null || recordable === '' || (i.incident_type === 'INJURY' && !root.trim())} onClick={() => save('CLOSED')}>Close the investigation</Button>}
          </div>
        </>
      ) : (
        <KV items={[
          { term: 'OSHA', value: i.osha_recordable ? `Recordable — ${words(i.osha_classification)}` : i.osha_recordable === false ? 'Not recordable' : 'Not decided' },
          { term: 'Root cause', value: i.root_cause ?? '—' }, { term: 'Corrective actions', value: i.corrective_actions.map((a) => a.action).join('; ') || '—' },
        ]} />
      )}
      <div className="ops-noprint"><Button variant="quiet" onClick={() => window.print()}>Print the 301</Button></div>
    </div>
  );
}

function OshaLogs({ companies, today, onIncident }: { companies: Array<{ id: string; name: string }>; today: string; onIncident: (id: string) => void }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const year0 = Number(today.slice(0, 4));
  const [year, setYear] = useState(year0);
  const q = useQuery<{ log: Osha300Row[]; summary: Osha300A }>(companyId ? '/api/commercial/osha' : null, { companyId, year: String(year) }, { scope: false });
  const cols: Col<Osha300Row>[] = [
    { key: 'c', head: 'Case', width: 90, cell: (r) => <span className="code">{r.case_number ?? '—'}</span> },
    { key: 'p', head: 'Employee', width: 170, cell: (r) => <>{r.person_name || '—'}{r.job_title && <span className="ops-sub" style={{ display: 'block' }}>{r.job_title}</span>}</> },
    { key: 'd', head: 'Date', width: 100, cell: (r) => r.occurred_on },
    { key: 'w', head: 'Where', width: 150, cell: (r) => r.where_occurred ?? '—' },
    { key: 'x', head: 'Injury or illness, body part', cell: (r) => r.description || '—' },
    { key: 'k', head: 'Classification', width: 170, cell: (r) => words(r.classification) },
    { key: 'a', head: 'Days away', n: true, width: 90, cell: (r) => r.days_away },
    { key: 'r', head: 'Restricted', n: true, width: 90, cell: (r) => r.days_restricted },
    { key: 't', head: 'Type', width: 140, cell: (r) => words(r.injury_or_illness ?? 'INJURY') },
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        {companies.length > 1 && <Field label="Establishment"><Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
        <Field label="Year"><Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>{[0, 1, 2, 3, 4].map((k) => <option key={k} value={year0 - k}>{year0 - k}</option>)}</Select></Field>
        <span className="sp" />
        <Button variant="quiet" onClick={() => window.print()}>Print</Button>
      </div>
      {q.isLoading && !q.data ? <WidgetState state={{ kind: 'loading', label: 'Loading the OSHA log…', lines: 5 }} />
        : q.error ? <WidgetState state={{ kind: 'error', title: 'The OSHA log did not load', body: q.error, onRetry: () => void q.refetch(), retryLabel: 'Try again' }} />
        : q.data && (
          <>
            <section className="sec" aria-label="OSHA 300A summary">
              <div className="sec-h"><h2 className="t-section">300A summary · {year}</h2><span className="t-cap ink-3">Post February 1 to April 30</span></div>
              <div className="cm-split">
                <Ledger rows={[
                  { label: 'Deaths', value: q.data.summary.deaths }, { label: 'Cases with days away', value: q.data.summary.days_away_cases },
                  { label: 'Cases with job transfer or restriction', value: q.data.summary.restricted_cases }, { label: 'Other recordable cases', value: q.data.summary.other_recordable_cases },
                  { label: 'Total days away', value: q.data.summary.total_days_away }, { label: 'Total days of restriction', value: q.data.summary.total_days_restricted },
                  { label: 'Injuries', value: q.data.summary.injuries }, { label: 'Skin disorders', value: q.data.summary.skin_disorders }, { label: 'Respiratory', value: q.data.summary.respiratory },
                  { label: 'Poisonings', value: q.data.summary.poisonings }, { label: 'Hearing loss', value: q.data.summary.hearing_loss }, { label: 'All other illnesses', value: q.data.summary.other_illnesses },
                ]} />
                <div className="stack" style={{ gap: 12 }}>
                  <KV items={[
                    { term: 'Hours worked', value: Math.round(Number(q.data.summary.hours_worked)).toLocaleString('en-US') },
                    { term: 'From approved time', value: Math.round(Number(q.data.summary.hours_from_time)).toLocaleString('en-US') },
                    { term: 'Entered by hand', value: Math.round(Number(q.data.summary.hours_manual)).toLocaleString('en-US') },
                    { term: 'TRIR', value: q.data.summary.trir == null ? '—' : Number(q.data.summary.trir).toFixed(2) },
                    { term: 'DART', value: q.data.summary.dart == null ? '—' : Number(q.data.summary.dart).toFixed(2) },
                    { term: 'Near misses reported', value: q.data.summary.near_misses },
                  ]} />
                  {q.data.summary.trir == null && <p className="t-cap">Rates need hours worked: approved time entries, or hours entered for subs and before payroll lands.</p>}
                  {q.data.summary.trir != null && <p className="t-cap">Per 200,000 hours: {q.data.log.length} recordable {q.data.log.length === 1 ? 'case' : 'cases'} gives a TRIR of {oshaRate(q.data.log.length, q.data.summary.hours_worked)?.toFixed(2) ?? '—'}.</p>}
                </div>
              </div>
            </section>
            <section className="sec" aria-label="OSHA 300 log">
              <div className="sec-h"><h2 className="t-section">300 log · {year}</h2><span className="t-cap ink-3">Open a case for its 301</span></div>
              <CmTable label="OSHA 300 log" rows={q.data.log} cols={cols} rowKey={(r) => r.incident_id} onOpen={(r) => onIncident(r.incident_id)}
                empty={{ title: `No recordable cases in ${year}`, body: 'Recordable injuries and illnesses to our employees land here when the determination is made on the incident.' }} />
            </section>
          </>
        )}
    </div>
  );
}
