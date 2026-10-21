'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Check, ConfirmDialog, Field, InlineNotice, Input, QueueTable, Select, Tag, WidgetState, count, money, shortDate, type QueueColumn,
} from '@meritbooks/merit-ui';
import { TIME_APPROVAL_NOTE, approveBlock, pinnedRateText, sentToBooks } from '@/lib/pm/labor/time';
import { shiftDay } from '@/lib/pm/ops/dispatch-math';
import { mondayOf } from '@/lib/pm/ops/week';
import { APPROVAL_STATE, PAY_TYPE_WORDS, personName } from '@/lib/pm/ops/labels';
import type { EmployeeRow, PayType, TimeEntryRow } from '@/lib/pm/ops/types';
import type { CostCodeRow } from '@/lib/pm/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, StatusMark, parseNum } from '../common/bits';
import { useOps } from '../common/useOps';

export interface TimeViewProps {
  weekStart: string;
  today: string;
  entries: TimeEntryRow[];
  employees: EmployeeRow[];
  meEmployeeId: string | null;
  meUserId: string;
  jobs: JobOption[];
  costCodes: CostCodeRow[];
  workOrders: Array<{ id: string; job_id: string; number: string | null; summary: string; kind: string }>;
  operations: Array<{ id: string; job_id: string; work_order_id: string; seq: number; name: string }>;
  fixedJobId?: string | null;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PAY: PayType[] = ['REG', 'OT', 'DT', 'PIECE', 'FLAG'];

function hours(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function TimeView(p: TimeViewProps) {
  const v = useVocab();
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  // The job tab has no week in its URL: it loads several weeks and steps through them here.
  const [weekStart, setWeekStart] = useState(p.weekStart);
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i));
  const weekEntries = p.entries.filter((t) => t.work_date >= days[0]! && t.work_date <= days[6]!);
  const emp = useMemo(() => new Map(p.employees.map((e) => [e.id, e])), [p.employees]);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const codes = useMemo(() => new Map(p.costCodes.map((c) => [c.id, c])), [p.costCodes]);
  const wos = useMemo(() => new Map(p.workOrders.map((w) => [w.id, w])), [p.workOrders]);
  const ops = useMemo(() => new Map(p.operations.map((o) => [o.id, o])), [p.operations]);
  const keyOf = (t: TimeEntryRow) => t.employee_id ?? `u:${t.user_id}`;
  const nameOf = (k: string) => (k.startsWith('u:') ? (k === `u:${p.meUserId}` ? 'You' : 'Team member') : personName(emp.get(k)));
  const people = [...new Set(weekEntries.map(keyOf))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const [who, setWho] = useState<string>('');
  const [day, setDay] = useState<string>('');
  const [delEntry, setDelEntry] = useState<TimeEntryRow | null>(null);
  const [unEntry, setUnEntry] = useState<TimeEntryRow | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const shown = weekEntries.filter((t) => (!who || keyOf(t) === who) && (!day || t.work_date === day));
  const drafts = shown.filter((t) => t.approval_state === 'DRAFT');
  const clerkOf = (id: string) => emp.get(id)?.clerk_user_id ?? null;
  const canApprove = (t: TimeEntryRow) => approveBlock(t, p.meUserId, clerkOf) === null;
  const approvable = shown.filter(canApprove);
  const submittedMine = shown.filter((t) => approveBlock(t, p.meUserId, clerkOf) === 'YOURS').length;
  const approve = async (ids: string[], key: string) => {
    if (!ids.length) return;
    const r = await act<{ approved: number }>(key, 'post', '/api/ops/time/approve', { ids }, (d) => `Approved ${count(d.approved)} ${d.approved === 1 ? 'entry' : 'entries'}`);
    if (r) setSel(new Set());
  };
  const total = (rs: TimeEntryRow[]) => rs.reduce((s, t) => s + Number(t.hours), 0);
  const go = (w: string) => (p.fixedJobId ? setWeekStart(w) : router.push(`/time?week=${w}`));

  const columns: QueueColumn<TimeEntryRow>[] = [
    { id: 'd', header: 'Day', width: 96, cell: (t) => shortDate(t.work_date, p.today) },
    { id: 'p', header: 'Person', width: 150, cell: (t) => nameOf(keyOf(t)) },
    { id: 'j', header: 'Work', cell: (t) => {
      const w = t.work_order_id ? wos.get(t.work_order_id) : null;
      const o = t.operation_id ? ops.get(t.operation_id) : null;
      const c = t.cost_code_id ? codes.get(t.cost_code_id) : null;
      return <><span className="l1">{p.fixedJobId ? (c ? `${c.code} ${c.name}` : 'No cost code') : jobs.get(t.job_id)?.label ?? v.job}</span><span className="l2">{[!p.fixedJobId && c ? `${c.code} ${c.name}` : null, w ? `${w.number} ${w.summary}` : null, o ? `op ${o.seq} ${o.name}` : null, t.notes].filter(Boolean).join(' · ') || ' '}</span></>;
    } },
    { id: 'h', header: 'Hours', numeric: true, width: 72, cell: (t) => hours(Number(t.hours)) },
    { id: 'pt', header: 'Pay', width: 96, cell: (t) => <span className="l2">{PAY_TYPE_WORDS[t.pay_type]}{t.billable ? '' : ' · not billable'}</span> },
    { id: 'rate', header: 'Cost rate', numeric: true, width: 112, cell: (t) => {
      const r = pinnedRateText(t.cost_rate_cents, (c) => money(c));
      return r
        ? <span title="Pinned at approval: pay + burden × the pay type. Overhead is never in job cost."><span className="l1" style={{ fontWeight: 400 }}>{r}</span><span className="l2">{money(Math.round(Number(t.hours) * t.cost_rate_cents!))}</span></span>
        : <span className="l2">at approval</span>;
    } },
    { id: 'st', header: 'State', width: 150, cell: (t) => (
      <span><StatusMark mark={APPROVAL_STATE[t.approval_state]} />{sentToBooks(t) ? <span className="l2">Sent to Merit Books</span> : null}</span>
    ) },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Actions</span>, width: 200, cell: (t: TimeEntryRow) => (
      <div className="btn-row">
        {t.approval_state === 'DRAFT' && <Button variant="quiet" disabled={busy === `t:${t.id}`} onClick={() => void act(`t:${t.id}`, 'patch', `/api/ops/time/${t.id}`, { state: 'submit' }, 'Submitted')}>Submit</Button>}
        {t.approval_state === 'SUBMITTED' && canApprove(t) && <Button variant="quiet" disabled={busy === `ap:${t.id}`} onClick={() => void approve([t.id], `ap:${t.id}`)}>Approve</Button>}
        {(t.approval_state === 'SUBMITTED' || t.approval_state === 'REJECTED') && <Button variant="quiet" disabled={busy === `t:${t.id}`} onClick={() => void act(`t:${t.id}`, 'patch', `/api/ops/time/${t.id}`, { state: 'recall' }, 'Back to draft')}>Recall</Button>}
        {t.approval_state === 'APPROVED' && <Button variant="quiet" onClick={() => setUnEntry(t)}>Unapprove</Button>}
        {t.approval_state !== 'APPROVED' && <Button variant="quiet" iconOnly icon="x" aria-label="Delete entry" onClick={() => setDelEntry(t)} />}
      </div>
    ) }]),
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div className="btn-row" role="group" aria-label="Week">
          <Button icon="left" onClick={() => go(shiftDay(weekStart, -7))}>Previous week</Button>
          <Button onClick={() => go(mondayOf(p.today))}>This week</Button>
          <Button iconAfter="right" onClick={() => go(shiftDay(weekStart, 7))}>Next week</Button>
        </div>
        <span className="t-cap">{shortDate(weekStart, p.today)} to {shortDate(days[6]!, p.today)}</span>
        <span className="sp" />
        {people.length > 1 && (
          <Field label="Person"><Select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.map((k) => <option key={k} value={k}>{nameOf(k)}</option>)}</Select></Field>
        )}
      </div>

      {shown.some((t) => t.approval_state === 'SUBMITTED') && (
        <InlineNotice tone="info" title={approvable.length ? `${count(approvable.length)} ${approvable.length === 1 ? 'entry is' : 'entries are'} ready for you to approve.` : 'Submitted time waits for someone else to approve it.'}>
          {TIME_APPROVAL_NOTE}{submittedMine ? ` ${count(submittedMine)} submitted ${submittedMine === 1 ? 'entry is' : 'entries are'} yours, so another person approves ${submittedMine === 1 ? 'it' : 'them'}.` : ''}
        </InlineNotice>
      )}

      {people.length > 0 && (
        <div className="mp-table" style={{ overflowX: 'auto' }}>
          <table className="ops-mini" aria-label="Hours by day">
            <thead><tr><th>Person</th>{days.map((d, i) => <th key={d} className="n"><button type="button" className="nlink" style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit', color: day === d ? 'var(--electric)' : 'inherit' }} aria-pressed={day === d} onClick={() => setDay(day === d ? '' : d)}>{DAYS[i]} {shortDate(d, p.today).replace(/^\w+ /, '')}</button></th>)}<th className="n">Week</th></tr></thead>
            <tbody>
              {people.filter((k) => !who || k === who).map((k) => {
                const mine = weekEntries.filter((t) => keyOf(t) === k);
                const wk = total(mine);
                return (
                  <tr key={k}>
                    <td>{nameOf(k)}</td>
                    {days.map((d) => { const h = total(mine.filter((t) => t.work_date === d)); return <td key={d} className="n">{h ? hours(h) : '—'}</td>; })}
                    <td className={wk > 40 ? 'n b' : 'n'}>{hours(wk)}{wk > 40 ? <span className="l2">{hours(wk - 40)} over 40</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td>Total</td>{days.map((d) => <td key={d} className="n">{hours(total(weekEntries.filter((t) => t.work_date === d && (!who || keyOf(t) === who))))}</td>)}<td className="n">{hours(total(weekEntries.filter((t) => !who || keyOf(t) === who)))}</td></tr></tfoot>
          </table>
        </div>
      )}

      {!readOnly && <EntryForm key={weekStart} {...p} days={days} act={act} busy={busy} />}
      <Failure text={error} />

      <div className="mp-table">
        {shown.length === 0 ? (
          <WidgetState state={weekEntries.length === 0
            ? { kind: 'empty', title: 'No time this week', body: `Enter hours against a ${lower(v.job)} and cost code, and against the work order or shop operation they were for.` }
            : { kind: 'done', title: 'Nothing for that person or day', body: 'Clear the filter to see the whole week.' }} />
        ) : (
          <>
            {!readOnly && (drafts.length > 1 || approvable.length > 0) && (
              <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', gap: 12 }}>
                {drafts.length > 1 && (
                  <>
                    <span className="t-cap">{count(drafts.length)} drafts, {hours(total(drafts))} hours</span>
                    <Button disabled={busy === 'all'} onClick={() => void (async () => { for (const t of drafts) await act('all', 'patch', `/api/ops/time/${t.id}`, { state: 'submit' }, () => null); })()}>Submit all shown</Button>
                  </>
                )}
                {approvable.length > 0 && (
                  <>
                    <span className="t-cap">{count(approvable.length)} ready to approve, {hours(total(approvable))} hours</span>
                    <Button variant="primary" disabled={busy === 'approve-all'} onClick={() => void approve(approvable.map((t) => t.id), 'approve-all')}>Approve all shown</Button>
                  </>
                )}
              </div>
            )}
            <QueueTable aria-label="Time entries" columns={columns} rows={shown} getRowId={(t) => t.id} compact rowState={(t) => ({ done: t.approval_state === 'APPROVED' })} hotkeys={false}
              selectable={!readOnly && approvable.length > 0} selected={sel} onSelectedChange={setSel}
              bulkSummary={(rs) => { const ok = rs.filter(canApprove); return [`${count(rs.length)} selected`, `${count(ok.length)} you can approve`, `${hours(total(ok))} hours`]; }}
              bulkActions={(rs) => { const ok = rs.filter(canApprove); return <Button variant="primary" disabled={!ok.length || busy === 'approve-sel'} onClick={() => void approve(ok.map((t) => t.id), 'approve-sel')}>Approve {count(ok.length)}</Button>; }} />
          </>
        )}
      </div>

      <ConfirmDialog open={!!unEntry} onClose={() => setUnEntry(null)} title="Unapprove this time" confirmLabel="Unapprove"
        reason={{ label: 'Why?', placeholder: 'Wrong cost code', minLength: 0 }}
        onConfirm={async (reason) => {
          if (!unEntry) return;
          const r = await act<{ reversalSent: boolean }>('unapprove', 'patch', `/api/ops/time/${unEntry.id}`, { state: 'unapprove', reason: reason?.trim() || null },
            (d) => (d.reversalSent ? 'Unapproved. Merit Books reverses the labor cost' : 'Unapproved'));
          if (!r) throw new Error('Not unapproved. The reason is shown on the page.');
        }}>
        {unEntry ? (
          <>
            {hours(Number(unEntry.hours))} hours on {shortDate(unEntry.work_date, p.today)} go back to submitted and the pinned cost rate is cleared, so they can be corrected and approved again.
            {sentToBooks(unEntry) ? ' Merit Books is told to reverse the labor cost it booked.' : ''}
            {unEntry.bill_rate_cents != null ? <> <Tag>Bill rate kept</Tag></> : null}
          </>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog open={!!delEntry} onClose={() => setDelEntry(null)} tone="danger" title="Delete this time" confirmLabel="Delete"
        onConfirm={async () => { if (!delEntry) return; const r = await act('del', 'delete', `/api/ops/time/${delEntry.id}`, undefined, 'Deleted the entry'); if (!r) throw new Error('Not deleted.'); }}>
        {delEntry ? `${hours(Number(delEntry.hours))} hours on ${shortDate(delEntry.work_date, p.today)}.` : null}
      </ConfirmDialog>
    </div>
  );
}

function EntryForm(p: TimeViewProps & { days: string[]; act: ReturnType<typeof useOps>['act']; busy: string | null }) {
  const v = useVocab();
  const [person, setPerson] = useState(p.meEmployeeId ?? '');
  const [date, setDate] = useState(p.days.includes(p.today) ? p.today : p.days[0]!);
  const [jobId, setJobId] = useState(p.fixedJobId ?? '');
  const [code, setCode] = useState('');
  const [wo, setWo] = useState('');
  const [op, setOp] = useState('');
  const [hrs, setHrs] = useState('');
  const [pay, setPay] = useState<PayType>('REG');
  const [billable, setBillable] = useState(true);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const job = p.jobs.find((j) => j.id === jobId) ?? null;
  const jobCodes = p.costCodes.filter((c) => c.is_active && job && c.location_id === job.companyId && (c.job_id == null || c.job_id === jobId));
  const jobWos = p.workOrders.filter((w) => w.job_id === jobId);
  const jobOps = p.operations.filter((o) => o.job_id === jobId && (!wo || o.work_order_id === wo));
  const save = async (submit: boolean) => {
    const h = parseNum(hrs);
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (h == null || h <= 0 || h > 24) return setErr('Hours between 0 and 24, like 7.5.');
    setErr(null);
    const r = await p.act('add', 'post', '/api/ops/time', { jobId, employeeId: person || null, workDate: date, hours: h, payType: pay, costCodeId: code || null, workOrderId: wo || null, operationId: op || null, billable, notes: notes.trim() || null, submit }, submit ? 'Saved and submitted' : 'Saved the time');
    if (r) { setHrs(''); setNotes(''); }
  };
  return (
    <form className="mp-table mp-add" onSubmit={(e) => { e.preventDefault(); void save(false); }} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Person"><Select value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Me</option>{p.employees.map((e) => <option key={e.id} value={e.id}>{personName(e)}</option>)}</Select></Field>
        <Field label="Day"><Select value={date} onChange={(e) => setDate(e.target.value)}>{p.days.map((d, i) => <option key={d} value={d}>{DAYS[i]} {shortDate(d, p.today)}</option>)}</Select></Field>
        {!p.fixedJobId && <Field label={v.job}><JobSelect jobs={p.jobs.filter((j) => j.open)} value={jobId} onChange={(id) => { setJobId(id); setCode(''); setWo(''); setOp(''); }} /></Field>}
        <Field label="Cost code"><Select value={code} onChange={(e) => setCode(e.target.value)} disabled={!job}><option value="">None</option>{jobCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {jobWos.length > 0 && <Field label="Work order"><Select value={wo} onChange={(e) => { setWo(e.target.value); setOp(''); }}><option value="">None</option>{jobWos.map((w) => <option key={w.id} value={w.id}>{w.number} · {w.summary}</option>)}</Select></Field>}
        {jobOps.length > 0 && <Field label="Shop operation"><Select value={op} onChange={(e) => setOp(e.target.value)}><option value="">None</option>{jobOps.map((o) => <option key={o.id} value={o.id}>{o.seq}. {o.name}</option>)}</Select></Field>}
        <Field label="Hours" error={err ?? undefined}><Input inputMode="decimal" value={hrs} onChange={(e) => setHrs(e.target.value)} placeholder="7.5" style={{ width: 88 }} /></Field>
        <Field label="Pay"><Select value={pay} onChange={(e) => setPay(e.target.value as PayType)}>{PAY.map((x) => <option key={x} value={x}>{PAY_TYPE_WORDS[x]}</option>)}</Select></Field>
        <Field label="Note"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} style={{ width: 200 }} /></Field>
        <Check label="Billable" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
        <Button type="submit" icon="plus" disabled={p.busy === 'add'}>Save</Button>
        <Button variant="primary" disabled={p.busy === 'add'} onClick={() => void save(true)}>Save and submit</Button>
      </div>
    </form>
  );
}
