'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Check, Drawer, Field, InlineNotice, Input, Select, Tag } from '@meritbooks/merit-ui';
import { requestFill, workforceGrid, type Assignment, type CrewRequest, type Employee } from '@/lib/commercial/screen-logic';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { CmTable, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
const ROLES = ['FOREMAN', 'JOURNEYMAN', 'APPRENTICE', 'HELPER', 'OPERATOR', 'OTHER'] as const;
export interface Conflict { week_start: string; employee_id: string | null; job_id: string | null; conflict: string; detail: string }

/**
 * People to fill a request for one week: on the bench that week, whose title names the role
 * (a foreman for FOREMAN …) first, then anyone else on the bench. Rules only; the dispatcher books. Pure.
 */
export function proposeFill(req: Pick<CrewRequest, 'role' | 'headcount'>, filled: number, bench: ReadonlyArray<Employee>): Employee[] {
  const need = Math.max(0, req.headcount - filled);
  const word = req.role.toLowerCase().replace('journeyman', 'journey');
  const fit = bench.filter((e) => (e.title ?? '').toLowerCase().includes(word));
  const rest = bench.filter((e) => !fit.includes(e));
  return [...fit, ...rest].slice(0, need);
}

/**
 * Workforce planning across jobs (CGC-92): foremen, journeymen and apprentices by job and week,
 * with per diem and travel, PMs' crew requests and how far each is filled, double bookings and
 * apprentice-ratio breaches, and who is on the bench.
 */
export function WorkforceView({ companyId, companies, from, weeks, requests, assignments, conflicts, employees, jobs, today, canAssign, canRequest }: {
  companyId: string; companies: Array<{ id: string; name: string }>; from: string; weeks: string[]; requests: CrewRequest[]; assignments: Assignment[]; conflicts: Conflict[];
  employees: Employee[]; jobs: JobOption[]; today: string; canAssign: boolean; canRequest: boolean;
}) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [cell, setCell] = useState<{ employeeId: string; week: string } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [openReq, setOpenReq] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState('');
  const grid = useMemo(() => workforceGrid(employees, assignments, weeks), [employees, assignments, weeks]);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const short = (id: string) => byJob.get(id)?.label.split(' · ')[0] ?? 'Job';
  const rows = jobFilter ? grid.rows.filter((r) => r.cells.some((c) => c.assignments.some((a) => a.job_id === jobFilter))) : grid.rows;
  const dbl = new Set(conflicts.filter((c) => c.conflict === 'DOUBLE_BOOKED').map((c) => `${c.employee_id}|${c.week_start}`));
  const ratio = conflicts.filter((c) => c.conflict === 'APPRENTICE_RATIO');
  const assign = !readOnly && canAssign;
  const benchOf = (week: string) => grid.rows.filter((r) => r.cells[weeks.indexOf(week)]?.days === 0).map((r) => r.employee);
  const req = requests.find((r) => r.id === openReq) ?? null;
  const shift = (n: number) => { const d = new Date(Date.parse(`${from}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10); router.push(`/workforce?company=${companyId}&from=${d}`); };

  const rcols: Col<CrewRequest>[] = [
    { key: 'j', head: 'Job', cell: (r) => <span className="b">{byJob.get(r.job_id)?.label ?? 'Job'}</span> },
    { key: 'r', head: 'Asking for', width: 200, cell: (r) => `${r.headcount} × ${words(r.role)}${r.trade ? ` · ${r.trade}` : ''}` },
    { key: 'w', head: 'Weeks', width: 180, cell: (r) => `${day(r.start_week, today)} – ${day(r.end_week, today)}` },
    { key: 'f', head: 'Filled', width: 220, cell: (r) => { const f = requestFill(r, assignments, weeks); const short_ = f.filter((x) => x.filled < x.need).length; return f.length === 0 ? '—' : short_ === 0 ? <Tag tone="pos">Filled</Tag> : <Tag tone="warn">{short_} of {f.length} weeks short</Tag>; } },
    { key: 's', head: 'Status', width: 110, cell: (r) => words(r.status) },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-toolbar">
        {companies.length > 1 && <Field label="Company"><Select value={companyId} onChange={(e) => router.push(`/workforce?company=${e.target.value}&from=${from}`)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
        <Field label="Show people on"><JobSelect jobs={jobs} value={jobFilter} onChange={setJobFilter} placeholder="Every job" /></Field>
        <Button variant="quiet" chord="[" bindChord onClick={() => shift(-4)}>Earlier</Button>
        <Button variant="quiet" chord="]" bindChord onClick={() => shift(4)}>Later</Button>
        <span className="sp" />
        {!readOnly && canRequest && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setRequesting((v) => !v)}>Request crew</Button>}
      </div>
      <Failure text={error} />
      {ratio.map((c, i) => <InlineNotice key={i} tone="warn" title={`Apprentice ratio — ${byJob.get(c.job_id ?? '')?.label ?? 'a job'}, week of ${day(c.week_start, today)}`}>{c.detail}</InlineNotice>)}
      {requesting && <NewRequest companyId={companyId} jobs={jobs.filter((j) => j.open && j.companyId === companyId)} weeks={weeks} busy={busy} act={act} onDone={() => setRequesting(false)} />}

      <section className="sec" aria-label="Crew requests">
        <div className="sec-h"><h2 className="t-section">Crew requests</h2><span className="t-cap ink-3">From the PMs, filled from the board</span></div>
        <CmTable label="Crew requests" rows={requests} cols={rcols} rowKey={(r) => r.id} onOpen={(r) => setOpenReq(r.id)} activeId={openReq}
          empty={{ title: 'No open crew requests', body: 'A PM asks for the people a job needs — role, trade, how many, which weeks — and the board shows how far it is filled.' }} />
      </section>

      <section className="sec" aria-label="Workforce board">
        <div className="sec-h"><h2 className="t-section">Board</h2><span className="t-cap ink-3">{employees.length} people · weeks from {day(weeks[0], today)}</span></div>
        <div className="cm-board">
          <table aria-label="Workforce board">
            <thead><tr><th>Person</th>{weeks.map((w) => <th key={w}>{day(w, today)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee.id}>
                  <td className="who">{r.employee.name}{r.employee.title && <span className="ops-sub" style={{ display: 'block', fontWeight: 400 }}>{r.employee.title}</span>}</td>
                  {r.cells.map((c, i) => {
                    const w = weeks[i]!;
                    const over = c.days > 5 || dbl.has(`${r.employee.id}|${w}`);
                    return (
                      <td key={w} className={['cell', over ? 'over' : null, c.days === 0 ? 'empty' : null].filter(Boolean).join(' ')} tabIndex={0} role="button"
                        aria-label={`${r.employee.name}, week of ${w}: ${c.assignments.length ? c.assignments.map((a) => short(a.job_id)).join(', ') : 'open'}`}
                        onClick={() => setCell({ employeeId: r.employee.id, week: w })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCell({ employeeId: r.employee.id, week: w }); } }}>
                        {c.assignments.length === 0 ? 'Open' : c.assignments.map((a) => <span key={a.id} className="chip">{short(a.job_id)} · {a.days}d{a.status === 'CONFIRMED' ? ' · firm' : ''}{a.per_diem ? ' · PD' : ''}</span>)}
                        {over && <span className="neg" style={{ fontWeight: 600 }}>{c.days} days</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>On the bench</td>{grid.bench.map((b, i) => <td key={weeks[i]}>{b}</td>)}</tr></tfoot>
          </table>
        </div>
        <p className="t-cap" style={{ marginTop: 8 }}>firm = confirmed · PD = per diem · a red cell is booked over five days. Open a cell to book or release.</p>
      </section>

      <Drawer open={!!cell} onClose={() => setCell(null)} width={520} title={cell ? employees.find((e) => e.id === cell.employeeId)?.name ?? 'Person' : ''} eyebrow={cell ? `Week of ${day(cell.week, today)}` : undefined}>
        {cell && <CellDetail key={`${cell.employeeId}|${cell.week}`} companyId={companyId} employeeId={cell.employeeId} week={cell.week}
          mine={assignments.filter((a) => a.employee_id === cell.employeeId && a.week_start === cell.week)} requests={requests.filter((r) => r.start_week <= cell.week && r.end_week >= cell.week)}
          jobs={jobs.filter((j) => j.open && j.companyId === companyId)} label={(id) => byJob.get(id)?.label ?? 'Job'} edit={assign} busy={busy} act={act} />}
      </Drawer>
      <Drawer open={!!req} onClose={() => setOpenReq(null)} width={560} title={req ? `${req.headcount} × ${words(req.role)}` : ''} eyebrow={req ? byJob.get(req.job_id)?.label : undefined}>
        {req && <RequestDetail key={req.id} req={req} weeks={weeks} assignments={assignments} benchOf={benchOf} companyId={companyId} today={today} edit={assign} canClose={!readOnly && canRequest} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function NewRequest({ companyId, jobs, weeks, busy, act, onDone }: { companyId: string; jobs: JobOption[]; weeks: string[]; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState('');
  const [role, setRole] = useState<string>('JOURNEYMAN');
  const [trade, setTrade] = useState('');
  const [n, setN] = useState('2');
  const [start, setStart] = useState(weeks[0] ?? '');
  const [end, setEnd] = useState(weeks[3] ?? weeks[0] ?? '');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={async (e) => {
      e.preventDefault();
      const count = Number(n);
      if (!jobId || !Number.isInteger(count) || count < 1) return setErr('Pick the job and how many people.');
      if (end < start) return setErr('The last week is before the first.');
      setErr(null);
      const r = await act('req', 'post', '/api/commercial/workforce', { op: 'request', companyId, jobId, trade: trade.trim() || null, role, headcount: count, startWeek: start, endWeek: end, note: note.trim() || null }, 'Requested the crew');
      if (r) onDone();
    }}>
      <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
      <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{words(r)}</option>)}</Select></Field>
      <Field label="Trade"><Input value={trade} onChange={(e) => setTrade(e.target.value)} maxLength={80} placeholder="Electrician" /></Field>
      <Field label="How many"><Input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 70 }} /></Field>
      <Field label="From week"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
      <Field label="To week"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'req' ? 'Requesting…' : 'Request'}</Button>
    </form>
  );
}

function CellDetail({ companyId, employeeId, week, mine, requests, jobs, label, edit, busy, act }: {
  companyId: string; employeeId: string; week: string; mine: Assignment[]; requests: CrewRequest[]; jobs: JobOption[]; label: (id: string) => string; edit: boolean; busy: string | null; act: Act;
}) {
  const [jobId, setJobId] = useState(requests[0]?.job_id ?? '');
  const [requestId, setRequestId] = useState(requests[0]?.id ?? '');
  const [role, setRole] = useState<string>(requests[0]?.role ?? 'JOURNEYMAN');
  const [days, setDays] = useState(String(Math.max(0, 5 - mine.reduce((s, a) => s + a.days, 0)) || 5));
  const [perDiem, setPerDiem] = useState(false);
  const [travel, setTravel] = useState(false);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <DSection title="Booked this week">
        {mine.length === 0 ? <p className="t-cap">Open — on the bench.</p> : (
          <ul className="feed">{mine.map((a) => (
            <li key={a.id}>
              <span><span className="l1">{label(a.job_id)}</span><span style={{ display: 'block' }}>{words(a.role)} · {a.days} days{a.per_diem ? ' · per diem' : ''}{a.travel ? ' · travel' : ''} · {words(a.status)}</span></span>
              {edit && <span className="row" style={{ gap: 4 }}>
                {a.status === 'PLANNED' && <Button variant="quiet" disabled={busy !== null} onClick={() => void act(`c:${a.id}`, 'patch', `/api/commercial/workforce/${a.id}`, { status: 'CONFIRMED' }, 'Confirmed')}>Confirm</Button>}
                <Button variant="quiet" disabled={busy !== null} onClick={() => void act(`x:${a.id}`, 'patch', `/api/commercial/workforce/${a.id}`, { status: 'RELEASED' }, 'Released from the job')}>Release</Button>
              </span>}
            </li>
          ))}</ul>
        )}
      </DSection>
      {edit && (
        <DSection title="Book">
          <form className="stack" style={{ gap: 8 }} onSubmit={(e) => {
            e.preventDefault();
            if (!jobId) return;
            void act('book', 'post', '/api/commercial/workforce', { op: 'assign', companyId, jobId, employeeId, requestId: requestId || null, role, weekStart: week, days: Math.min(7, Math.max(0, Number(days) || 0)), perDiem, travel, note: null }, 'Booked');
          }}>
            {requests.length > 0 && <Field label="Against a request"><Select value={requestId} onChange={(e) => { const r = requests.find((x) => x.id === e.target.value); setRequestId(e.target.value); if (r) { setJobId(r.job_id); setRole(r.role); } }}><option value="">No request</option>{requests.map((r) => <option key={r.id} value={r.id}>{label(r.job_id)} — {r.headcount} × {words(r.role)}</option>)}</Select></Field>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
              <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{words(r)}</option>)}</Select></Field>
              <Field label="Days"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, '').slice(0, 1))} style={{ width: 60 }} /></Field>
            </div>
            <div className="row" style={{ gap: 12 }}><Check label="Per diem" checked={perDiem} onChange={(e) => setPerDiem(e.target.checked)} /><Check label="Travel" checked={travel} onChange={(e) => setTravel(e.target.checked)} /></div>
            <div><Button type="submit" variant="primary" disabled={busy !== null || !jobId}>{busy === 'book' ? 'Booking…' : 'Book the week'}</Button></div>
          </form>
        </DSection>
      )}
    </div>
  );
}

function RequestDetail({ req, weeks, assignments, benchOf, companyId, today, edit, canClose, busy, act }: {
  req: CrewRequest; weeks: string[]; assignments: Assignment[]; benchOf: (week: string) => Employee[]; companyId: string; today: string; edit: boolean; canClose: boolean; busy: string | null; act: Act;
}) {
  const fill = requestFill(req, assignments, weeks);
  const bookAll = async (week: string, people: Employee[]) => {
    for (const p of people) {
      const r = await act(`b:${week}:${p.id}`, 'post', '/api/commercial/workforce', { op: 'assign', companyId, jobId: req.job_id, employeeId: p.id, requestId: req.id, role: req.role, weekStart: week, days: 5, perDiem: false, travel: false, note: null }, `Booked ${p.name}`);
      if (!r) break;
    }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      {fill.length === 0 && <p className="t-cap">The request’s weeks are outside the board’s range.</p>}
      {fill.map((f) => {
        const proposal = proposeFill(req, f.filled, benchOf(f.week));
        return (
          <div key={f.week} className="cm-check">
            <div><span className="lbl">Week of {day(f.week, today)}</span><span className="ops-sub" style={{ display: 'block' }}>{f.filled} of {f.need} booked{f.filled < f.need && proposal.length ? ` · proposed from the bench: ${proposal.map((p) => p.name).join(', ')}` : f.filled < f.need ? ' · nobody on the bench' : ''}</span></div>
            {edit && f.filled < f.need && proposal.length > 0 && <Button variant="quiet" disabled={busy !== null} onClick={() => void bookAll(f.week, proposal)}>Book {proposal.length}</Button>}
            {f.filled >= f.need && <Tag tone="pos">Filled</Tag>}
          </div>
        );
      })}
      {canClose && req.status !== 'FILLED' && (
        <div className="row" style={{ gap: 8 }}>
          <Button disabled={busy !== null} onClick={() => void act('rf', 'patch', `/api/commercial/workforce/requests/${req.id}`, { status: 'FILLED' }, 'Marked filled')}>Mark filled</Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => void act('rc', 'patch', `/api/commercial/workforce/requests/${req.id}`, { status: 'CANCELLED' }, 'Cancelled the request')}>Cancel the request</Button>
        </div>
      )}
    </div>
  );
}
