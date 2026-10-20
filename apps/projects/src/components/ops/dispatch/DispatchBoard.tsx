'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, Field, InlineNotice, Input, Keybar, Panel, PanelSection, Pip, Search, Select, Tag, WidgetState, count, shortDate,
} from '@meritbooks/merit-ui';
import {
  GRID_END_MIN, GRID_START_MIN, SLOT_MIN, clockOf, defaultDuration, durationText, findOverlap, gridGeometry, hhmm, localParts,
  missingSkills, parseHhmm, shiftDay, slotStarts, windowText, zonedToUtc,
} from '@/lib/pm/ops/dispatch-math';
import { ASSIGNMENT_NEXT, ASSIGNMENT_STATUS, priorityPip, priorityWord, woKindLabel, woVocab } from '@/lib/pm/ops/labels';
import type { AssignmentStatus, DispatchQueueRow, SkillRow, WorkOrderRow } from '@/lib/pm/ops/types';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, StatusMark } from '../common/bits';
import { useOps } from '../common/useOps';
import { buildRows, suggestSlot, type BoardInput, type TechRow } from './model';
import { TechSetup } from './TechSetup';

export interface DispatchBoardProps extends BoardInput {
  today: string;
  queue: DispatchQueueRow[];
  jobLabels: Record<string, string>;
  companies: Array<{ id: string; name: string }>;
  activeCompanyId: string | null;
  /** ?wo= — open this work order in the assign panel (from the work-order page). */
  focusWo: string | null;
  /** The focused work order when it is already scheduled (reschedule). */
  focusOrder: WorkOrderRow | null;
}

interface Visit {
  id: string;
  number: string | null;
  summary: string;
  kind: DispatchQueueRow['kind'];
  priority: number;
  estimated: number | null;
  skills: string[];
  requestedStart: string | null;
  requestedEnd: string | null;
  jobId: string;
  /** Already on the board (rescheduling replaces its assignments). */
  scheduled: boolean;
}

interface Pending {
  techKey: string;
  helperKey: string;
  start: number;
  duration: number;
}

const STEPS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480];
const NEXT_VERB: Readonly<Record<AssignmentStatus, string>> = {
  ASSIGNED: 'Assigned', DISPATCHED: 'Dispatch', EN_ROUTE: 'On my way', ON_SITE: 'Arrived', DONE: 'Done', CANCELLED: 'Unassign',
};

function fromQueue(q: DispatchQueueRow): Visit {
  return { id: q.work_order_id, number: q.number, summary: q.summary, kind: q.kind, priority: q.priority, estimated: q.estimated_minutes, skills: q.required_skills ?? [], requestedStart: q.requested_start, requestedEnd: q.requested_end, jobId: q.job_id, scheduled: false };
}
function fromOrder(o: WorkOrderRow): Visit {
  return { id: o.id, number: o.number, summary: o.summary, kind: o.kind, priority: o.priority, estimated: o.estimated_minutes, skills: o.required_skills ?? [], requestedStart: o.requested_start, requestedEnd: o.requested_end, jobId: o.job_id, scheduled: true };
}

export function DispatchBoard(p: DispatchBoardProps) {
  const v = useVocab();
  const wv = woVocab(v);
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error, clearError } = useOps();
  const rows = useMemo(() => buildRows(p), [p]);
  const skillName = useMemo(() => new Map(p.skills.map((s: SkillRow) => [s.code, s.name])), [p.skills]);
  const [q, setQ] = useState('');
  const [visit, setVisit] = useState<Visit | null>(() => {
    if (!p.focusWo) return null;
    const inQueue = p.queue.find((x) => x.work_order_id === p.focusWo);
    return inQueue ? fromQueue(inQueue) : p.focusOrder ? fromOrder(p.focusOrder) : null;
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [blockId, setBlockId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [lastError, setLastError] = useState<{ code: 'skills' | 'other'; text: string } | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const tick = () => setNow(p.day === p.today ? localParts(new Date().toISOString(), p.tz).minutes : null);
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [p.day, p.today, p.tz]);

  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? p.queue.filter((x) => [x.number, x.summary, p.jobLabels[x.job_id]].filter(Boolean).join(' ').toLowerCase().includes(t)) : p.queue;
  }, [p.queue, q, p.jobLabels]);
  const overdue = p.queue.filter((x) => x.is_overdue).length;
  const block = useMemo(() => rows.flatMap((r) => r.blocks.map((b) => ({ ...b, row: r }))).find((b) => b.id === blockId) ?? null, [rows, blockId]);

  // Choosing a visit proposes the earliest free, qualified slot (the dispatcher can change everything).
  const choose = (vv: Visit, at?: { techKey: string; start: number }) => {
    clearError();
    setLastError(null);
    setBlockId(null);
    setVisit(vv);
    const duration = defaultDuration(vv.estimated);
    if (at) {
      setPending({ techKey: at.techKey, helperKey: '', start: at.start, duration });
      return;
    }
    const reqStart = vv.requestedStart ? localParts(vv.requestedStart, p.tz) : null;
    const notBefore = Math.max(now ?? 0, reqStart && reqStart.day === p.day ? reqStart.minutes : 0);
    const s = suggestSlot(rows, duration, vv.skills, notBefore, vv.scheduled ? vv.id : undefined);
    setPending({ techKey: s?.techKey ?? rows[0]?.key ?? '', helperKey: '', start: s?.start ?? Math.max(GRID_START_MIN, Math.ceil((now ?? 8 * 60) / 30) * 30), duration });
  };

  useEffect(() => {
    if (visit && !pending) choose(visit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pending && visit) firstField.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit?.id]);

  // Client hints (the database decides): overlap on each chosen tech, skills across them.
  const hints = useMemo(() => {
    if (!pending || !visit) return null;
    const chosen = [pending.techKey, pending.helperKey].filter(Boolean).map((k) => rowByKey.get(k)).filter((r): r is TechRow => !!r);
    const iv = { start: pending.start, end: pending.start + pending.duration };
    const clashes = chosen
      .map((r) => ({ r, hit: findOverlap(r.blocks.filter((b) => b.assignment.work_order_id !== visit.id), iv) }))
      .filter((x) => x.hit);
    const held = chosen.flatMap((r) => r.skills);
    const missing = chosen.some((r) => r.employeeId) ? missingSkills(visit.skills, held) : [];
    const pastGrid = iv.end > GRID_END_MIN;
    return { chosen, iv, clashes, missing, pastGrid };
  }, [pending, visit, rowByKey]);

  const assign = async (ignoreSkills = false) => {
    if (!visit || !pending || !hints) return;
    const techs = hints.chosen;
    if (!techs.length) return setLastError({ code: 'other', text: 'Pick a technician.' });
    const start = zonedToUtc(p.day, pending.start, p.tz).toISOString();
    const end = zonedToUtc(p.day, pending.start + pending.duration, p.tz).toISOString();
    const employeeIds = techs.map((t) => t.employeeId).filter((x): x is string => !!x);
    const crewOnly = techs.find((t) => !t.employeeId)?.crewId ?? null;
    const r = await act<{ work_order_status: string }>('assign', 'post', `/api/ops/work-orders/${visit.id}`, {
      op: 'schedule', start, end, employeeIds, crewId: employeeIds.length ? null : crewOnly, replace: true, ignoreSkills,
    }, () => `Scheduled ${visit.number ?? lower(wv.one)} with ${techs.map((t) => t.name).join(' and ')} at ${clockOf(pending.start)}`);
    if (r) {
      setVisit(null);
      setPending(null);
      setLastError(null);
    }
  };

  useEffect(() => {
    if (!error) return;
    setLastError({ code: /does not hold/.test(error) ? 'skills' : 'other', text: error });
  }, [error]);

  const moveAssignment = async (assignmentId: string, to: AssignmentStatus, label: string) => {
    await act('status', 'post', `/api/ops/assignments/${assignmentId}`, { status: to }, label);
  };

  const go = (day: string) => router.push(`/dispatch?day=${day}`);
  const ticks = slotStarts(GRID_START_MIN, GRID_END_MIN, 60);
  const slots = slotStarts(GRID_START_MIN, GRID_END_MIN, SLOT_MIN);
  const panelOpen = !!(visit && pending) || !!block;
  const booked = rows.reduce((s, r) => s + r.blocks.length, 0);
  const dayWord = p.day === p.today ? 'Today' : shortDate(p.day, p.today);

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div className="btn-row" role="group" aria-label="Day">
          <Button icon="left" chord="[" bindChord onClick={() => go(shiftDay(p.day, -1))}>Previous day</Button>
          <Button onClick={() => go(p.today)} disabled={p.day === p.today}>Today</Button>
          <Button iconAfter="right" chord="]" bindChord onClick={() => go(shiftDay(p.day, 1))}>Next day</Button>
        </div>
        <Field label="Day">
          <Input type="date" value={p.day} onChange={(e) => e.target.value && go(e.target.value)} />
        </Field>
        <span className="sp" />
        <span className="t-cap">{dayWord} · {count(booked)} booked · {count(rows.length)} on the board</span>
        {!readOnly && <Button onClick={() => setSetupOpen(true)}>Technicians and skills</Button>}
      </div>

      <div className={panelOpen ? 'dsp has-panel' : 'dsp'}>
        <section className="dsp-queue" aria-label={`Unassigned ${lower(wv.many)}`}>
          <div className="dsp-queue-h">
            <span className="t-section">Unassigned</span>
            <span className="tnum b">{count(p.queue.length)}</span>
            {overdue > 0 && <Tag tone="neg">{count(overdue)} past due</Tag>}
          </div>
          {p.queue.length > 0 && (
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
              <Search aria-label={`Find a ${lower(wv.one)}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, job or summary" />
            </div>
          )}
          {p.queue.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: 'Everything is on the board', body: `New ${lower(wv.many)} and ones put on hold land here to be scheduled.`, action: <ButtonLink href="/work-orders?new=1">New {lower(wv.one)}</ButtonLink> }} />
          ) : visible.length === 0 ? (
            <p className="t-cap" style={{ padding: 16 }}>Nothing matches “{q}”.</p>
          ) : (
            <QueueList items={visible} selectedId={visit?.id ?? null} jobLabels={p.jobLabels} tz={p.tz} today={p.today} vocab={v} skillName={skillName} onPick={(x) => choose(fromQueue(x))} readOnly={readOnly} />
          )}
        </section>

        <section className="dsp-board" aria-label={`Board for ${dayWord}`}>
          {rows.length === 0 ? (
            <WidgetState
              state={{
                kind: 'empty',
                title: 'Put your technicians on the board',
                body: 'Add a crew and its technicians, with each person’s daily hours and skills. The board then shows who is free and who is qualified.',
                action: readOnly ? undefined : <Button variant="primary" onClick={() => setSetupOpen(true)}>Add technicians</Button>,
              }}
            />
          ) : (
            <>
              <div className="dsp-scale" aria-hidden="true">
                <div style={{ padding: '6px 12px' }} className="t-cap">Technician</div>
                <div className="ticks">
                  {ticks.map((m) => {
                    const g = gridGeometry({ start: m, end: m + 1 });
                    return g ? <span key={m} style={{ left: `${g.left}%` }}>{clockOf(m).replace(':00', '')}</span> : null;
                  })}
                </div>
              </div>
              {rows.map((r) => (
                <div className="dsp-row" key={r.key}>
                  <div className="dsp-who">
                    <span className="l1 b">{r.name}</span>
                    <span className="l2">{[r.crewName, r.skills.length ? r.skills.map((s) => skillName.get(s) ?? s).slice(0, 2).join(', ') + (r.skills.length > 2 ? ` +${r.skills.length - 2}` : '') : null].filter(Boolean).join(' · ') || ' '}</span>
                    <div className={r.capacity.over ? 'dsp-cap over' : 'dsp-cap'} role="img" aria-label={r.capacity.text} title={r.capacity.text}>
                      <i style={{ width: `${Math.round(r.capacity.fill * 100)}%` }} />
                    </div>
                    <span className="ops-sub">{r.capacity.over ? `${durationText(r.capacity.booked - r.capacity.capacity)} over` : `${durationText(Math.max(r.capacity.free, 0))} free`}</span>
                  </div>
                  <div className="dsp-track">
                    <div className="dsp-slots">
                      {slots.map((m) => (
                        <button
                          key={m}
                          type="button"
                          tabIndex={-1}
                          className={dropKey === `${r.key}:${m}` ? 'dsp-slot is-drop' : 'dsp-slot'}
                          aria-label={`${r.name} at ${clockOf(m)}`}
                          disabled={readOnly || !visit}
                          title={visit ? `Put ${visit.number ?? 'this visit'} with ${r.name} at ${clockOf(m)}` : undefined}
                          onClick={() => visit && choose(visit, { techKey: r.key, start: m })}
                          onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setDropKey(`${r.key}:${m}`); } }}
                          onDragLeave={() => setDropKey((k) => (k === `${r.key}:${m}` ? null : k))}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDropKey(null);
                            const id = e.dataTransfer.getData('text/plain');
                            const item = p.queue.find((x) => x.work_order_id === id);
                            if (item) choose(fromQueue(item), { techKey: r.key, start: m });
                          }}
                        />
                      ))}
                    </div>
                    {now != null && now >= GRID_START_MIN && now <= GRID_END_MIN && <span className="dsp-now" style={{ left: `${gridGeometry({ start: now, end: now + 1 })!.left}%` }} aria-hidden="true" />}
                    {r.blocks.map((b) => {
                      const g = gridGeometry(b);
                      if (!g) return null;
                      const st = b.assignment.status;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={['dsp-blk', st === 'ON_SITE' || st === 'EN_ROUTE' ? 'on' : '', st === 'DONE' ? 'done' : '', blockId === b.id ? 'is-cur' : ''].filter(Boolean).join(' ')}
                          style={{ left: `${g.left}%`, width: `${g.width}%` }}
                          aria-label={`${b.label} ${b.order?.summary ?? ''}, ${r.name}, ${clockOf(b.start)} to ${clockOf(b.end)}, ${ASSIGNMENT_STATUS[st].word}`}
                          onClick={() => { setBlockId(b.id); setVisit(null); setPending(null); clearError(); }}
                        >
                          <b>{b.label}</b>
                          <span>{clockOf(b.start)} · {b.order?.summary ?? ''}</span>
                        </button>
                      );
                    })}
                    {pending && visit && hints && (pending.techKey === r.key || pending.helperKey === r.key) && (() => {
                      const g = gridGeometry(hints.iv);
                      const bad = hints.clashes.some((c) => c.r.key === r.key) || (hints.missing.length > 0 && !!r.employeeId);
                      return g ? <span className={bad ? 'dsp-blk ghost bad' : 'dsp-blk ghost'} style={{ left: `${g.left}%`, width: `${g.width}%` }} aria-hidden="true"><b>{visit.number ?? 'New'}</b><span>{clockOf(pending.start)}</span></span> : null;
                    })()}
                  </div>
                </div>
              ))}
            </>
          )}
        </section>

        {visit && pending && hints ? (
          <Panel
            eyebrow={[visit.scheduled ? 'Reschedule' : 'Assign', woKindLabel(visit.kind, v)]}
            title={`${visit.number ?? ''} ${visit.summary}`.trim()}
            meta={[p.jobLabels[visit.jobId], priorityWord(visit.priority)].filter(Boolean).join(' · ')}
            onClose={() => { setVisit(null); setPending(null); setLastError(null); }}
            foot={
              readOnly ? undefined : (
                <div className="btn-row" style={{ width: '100%', justifyContent: 'flex-end' }}>
                  <Button onClick={() => { setVisit(null); setPending(null); }}>Cancel</Button>
                  <Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'assign' || !pending.techKey} onClick={() => void assign(false)}>
                    {visit.scheduled ? 'Reschedule' : 'Assign'}
                  </Button>
                </div>
              )
            }
          >
            <PanelSection>
              <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void assign(false); }}>
                <Field label="Technician">
                  <Select ref={firstField} value={pending.techKey} onChange={(e) => setPending({ ...pending, techKey: e.target.value })}>
                    {rows.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name} · {r.capacity.over ? 'over capacity' : `${durationText(Math.max(r.capacity.free, 0))} free`}{visit.skills.length && r.employeeId && missingSkills(visit.skills, r.skills).length ? ' · lacks a skill' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Helper" help="Optional second technician on the same slot">
                  <Select value={pending.helperKey} onChange={(e) => setPending({ ...pending, helperKey: e.target.value })}>
                    <option value="">No helper</option>
                    {rows.filter((r) => r.key !== pending.techKey && r.employeeId).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </Select>
                </Field>
                <div className="mp-form-2">
                  <Field label="Start">
                    <Input type="time" step={900} value={hhmm(pending.start)} onChange={(e) => { const m = parseHhmm(e.target.value); if (m != null) setPending({ ...pending, start: m }); }} />
                  </Field>
                  <Field label="Length" help={visit.estimated ? `Estimate ${durationText(visit.estimated)}` : 'No estimate on the work order'}>
                    <Select value={String(pending.duration)} onChange={(e) => setPending({ ...pending, duration: Number(e.target.value) })}>
                      {[...new Set([...STEPS, pending.duration])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{durationText(m)}</option>)}
                    </Select>
                  </Field>
                </div>
                <p className="t-cap">
                  {shortDate(p.day, p.today)}, {clockOf(pending.start)} to {clockOf(pending.start + pending.duration)}
                  {visit.requestedStart ? ` · customer asked for ${windowText(visit.requestedStart, visit.requestedEnd, p.tz, p.today)}` : ''}
                </p>
                <button type="submit" hidden />
              </form>
            </PanelSection>
            {(hints.clashes.length > 0 || hints.missing.length > 0 || hints.pastGrid) && (
              <PanelSection>
                {hints.clashes.map((c) => (
                  <InlineNotice key={c.r.key} tone="warn" title={`${c.r.name} is booked then.`}>
                    {c.hit!.label} runs {clockOf(c.hit!.start)} to {clockOf(c.hit!.end)}. Pick another time or technician; the board will not double-book.
                  </InlineNotice>
                ))}
                {hints.missing.length > 0 && (
                  <InlineNotice tone="warn" title="Missing a required skill.">
                    This {lower(wv.one)} needs {hints.missing.map((s) => skillName.get(s) ?? s).join(', ')}, which {hints.chosen.length > 1 ? 'neither technician holds' : 'this technician does not hold'}.
                  </InlineNotice>
                )}
                {hints.pastGrid && <InlineNotice tone="info" title="Runs past 8 PM.">It still books; the board only draws the day to 8 PM.</InlineNotice>}
              </PanelSection>
            )}
            {lastError && (
              <PanelSection>
                <Failure text={lastError.text} />
                {lastError.code === 'skills' && !readOnly && (
                  <div style={{ marginTop: 8 }}>
                    <Button onClick={() => void assign(true)} disabled={busy === 'assign'}>Assign anyway</Button>
                  </div>
                )}
              </PanelSection>
            )}
            <PanelSection title="The work">
              <div className="ops-facts">
                <span>{visit.skills.length ? <>Needs <b>{visit.skills.map((s) => skillName.get(s) ?? s).join(', ')}</b></> : 'No required skills'}</span>
                {visit.estimated ? <span>Estimate <b>{durationText(visit.estimated)}</b></span> : null}
              </div>
              <p style={{ marginTop: 12 }}><Link className="link" href={`/work-orders?wo=${visit.id}`}>Open the {lower(wv.one)}</Link></p>
            </PanelSection>
          </Panel>
        ) : block ? (
          <Panel
            eyebrow={[block.label, ASSIGNMENT_STATUS[block.assignment.status].word]}
            title={block.order?.summary ?? 'Visit'}
            meta={`${block.row.name} · ${clockOf(block.start)} to ${clockOf(block.end)}`}
            onClose={() => setBlockId(null)}
            foot={
              readOnly ? undefined : (
                <div className="btn-row" style={{ width: '100%' }}>
                  {block.order && block.order.status !== 'COMPLETE' && block.order.status !== 'CLOSED' && (
                    <Button onClick={() => choose(fromOrder(block.order!), { techKey: block.row.key, start: block.start })}>Reschedule</Button>
                  )}
                  <span className="sp" />
                  {ASSIGNMENT_NEXT[block.assignment.status].filter((s) => s !== 'CANCELLED').slice(0, 2).map((s, i) => (
                    <Button key={s} variant={i === 0 ? 'primary' : 'default'} disabled={busy === 'status'} onClick={() => void moveAssignment(block.assignment.id, s, `${block.row.name}: ${ASSIGNMENT_STATUS[s].word.toLowerCase()}`)}>
                      {NEXT_VERB[s]}
                    </Button>
                  ))}
                </div>
              )
            }
          >
            <PanelSection title="Where it stands">
              <StatusMark mark={ASSIGNMENT_STATUS[block.assignment.status]} />
              <div className="ops-facts" style={{ marginTop: 8 }}>
                {block.order && <span>{p.jobLabels[block.order.job_id] ?? ''}</span>}
                {block.order && <span>{priorityWord(block.order.priority)}</span>}
                {block.assignment.is_lead && <span>Lead technician</span>}
              </div>
              {error && <div style={{ marginTop: 12 }}><Failure text={error} /></div>}
            </PanelSection>
            {block.order?.complaint && (
              <PanelSection title="Complaint">
                <p>{block.order.complaint}</p>
              </PanelSection>
            )}
            <PanelSection>
              {block.order && <Link className="link" href={`/work-orders?wo=${block.order.id}`}>Open the {lower(wv.one)}</Link>}
              {!readOnly && ASSIGNMENT_NEXT[block.assignment.status].includes('CANCELLED') && (
                <div style={{ marginTop: 12 }}>
                  <Button variant="quiet" disabled={busy === 'status'} onClick={() => void moveAssignment(block.assignment.id, 'CANCELLED', `Took ${block.row.name} off ${block.label}`)}>Take off the board</Button>
                </div>
              )}
            </PanelSection>
          </Panel>
        ) : null}
      </div>

      <Keybar
        hints={[{ chord: '[ ]', label: 'day' }, ...(readOnly ? [] : [{ chord: 'mod+enter', label: 'assign' }])]}
        note="Pick a visit, then a slot or the fields in the panel. Overlaps and skills are checked again when it saves."
      />

      {setupOpen && (
        <TechSetup
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          crews={p.crews}
          members={p.members}
          employees={p.employees}
          skills={p.skills}
          employeeSkills={p.employeeSkills}
          companies={p.companies}
          activeCompanyId={p.activeCompanyId}
        />
      )}
    </div>
  );
}

function QueueList({ items, selectedId, jobLabels, tz, today, vocab, skillName, onPick, readOnly }: {
  items: DispatchQueueRow[]; selectedId: string | null; jobLabels: Record<string, string>; tz: string; today: string;
  vocab: ReturnType<typeof useVocab>; skillName: Map<string, string>; onPick: (q: DispatchQueueRow) => void; readOnly: boolean;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (from: number, d: number) => {
    const next = items[Math.min(items.length - 1, Math.max(0, from + d))];
    if (next) refs.current.get(next.work_order_id)?.focus();
  };
  return (
    <ul className="dsp-q" role="listbox" aria-label="Visits to schedule">
      {items.map((x, i) => {
        const win = windowText(x.requested_start, x.requested_end, tz, today);
        return (
          <li key={x.work_order_id} role="option" aria-selected={selectedId === x.work_order_id}>
            <button
              ref={(el) => { if (el) refs.current.set(x.work_order_id, el); else refs.current.delete(x.work_order_id); }}
              type="button"
              draggable={!readOnly}
              onDragStart={(e) => { e.dataTransfer.setData('text/plain', x.work_order_id); e.dataTransfer.effectAllowed = 'move'; }}
              onClick={() => onPick(x)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
                if (e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
              }}
            >
              <Pip kind={x.is_overdue ? 'overdue' : priorityPip(x.priority)} />
              <span style={{ minWidth: 0 }}>
                <span className="l1"><span className="code">{x.number}</span> {x.summary}</span>
                <span className="l2">
                  {[
                    woKindLabel(x.kind, vocab),
                    x.priority <= 2 ? priorityWord(x.priority) : null,
                    x.estimated_minutes ? durationText(x.estimated_minutes) : null,
                    win,
                    x.due_by || x.due_on ? `${x.is_overdue ? 'past due' : 'due'} ${shortDate((x.due_by ?? x.due_on)!, today)}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
                <span className="l2">{[jobLabels[x.job_id], x.required_skills?.length ? x.required_skills.map((s) => skillName.get(s) ?? s).join(', ') : null].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
