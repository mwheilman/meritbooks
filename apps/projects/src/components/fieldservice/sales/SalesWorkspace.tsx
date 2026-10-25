'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineNotice, Input, Select, Status, Tabs, Tag, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { FollowupQueueRow, OnlineAcceptanceRow, Pipeline, PipelineOpenRow } from '@/lib/fieldservice/completion-types';
import { fmtWhen, useAction, words } from '../common/useAction';

type Accepted = OnlineAcceptanceRow & { estimate_number: string | null; estimate_title: string | null; option_name: string | null };

export interface SalesWorkspaceProps {
  companyId: string;
  pipeline: Pipeline;
  queue: FollowupQueueRow[];
  accepted: Accepted[];
  error: string | null;
  employees: Record<string, string>;
  plans: Array<{ id: string; name: string }>;
  canEdit: boolean;
  canFinalize: boolean;
}

type Tab = 'pipeline' | 'followups' | 'accepted';

const STAGES: PipelineOpenRow['stage'][] = ['LEAD', 'APPOINTMENT', 'PROPOSAL'];

/**
 * After the visit (FS-56 / FS-57 / FS-59): the comfort-advisor pipeline split by TGL vs marketing
 * with close rate per advisor, the unsold-estimate follow-up queue (aging, owner, next touch, call
 * tasks due) and the estimates customers accepted in the portal, waiting for the office to finalize.
 */
export function SalesWorkspace(p: SalesWorkspaceProps) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>(p.accepted.length ? 'accepted' : 'pipeline');
  const { run, busy, error } = useAction();
  const callsDue = p.queue.reduce((s, q) => s + q.calls_due, 0);
  return (
    <div className="stack">
      <Tabs aria-label="Sales" value={tab} onChange={setTab} items={[
        { value: 'pipeline', label: 'Pipeline', count: count(p.pipeline.open.length) },
        { value: 'followups', label: 'Open estimates', count: count(p.queue.length) },
        { value: 'accepted', label: 'Accepted online', count: count(p.accepted.length) },
      ]} />
      {p.error && <InlineNotice tone="neg" title="Part of this page did not load.">{p.error}</InlineNotice>}
      {error && <InlineNotice tone="neg" title="That did not go through.">{error}</InlineNotice>}

      {tab === 'pipeline' && (
        <>
          <div className="fs-grid fs-grid--wide">
            <section className="fs-card" aria-label="Open opportunities">
              <div className="fs-card-h"><h2 className="t-section">01 // Open opportunities</h2><span className="sp" /><span className="t-cap">Stalled deals first</span></div>
              {p.pipeline.open.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'Nothing open', body: 'Tech-generated leads and presented replacement estimates appear here.' }} /></div> : (
                <table className="fs-table">
                  <thead><tr><th>Opportunity</th><th>Source</th><th>Stage</th><th>Advisor</th><th>Next step</th><th aria-label="Move" /></tr></thead>
                  <tbody>{p.pipeline.open.map((o) => <OpenRow key={o.id} o={o} employees={p.employees} canEdit={p.canEdit && !readOnly} />)}</tbody>
                </table>
              )}
            </section>
            <section className="fs-card" aria-label="By source">
              <div className="fs-card-h"><h2 className="t-section">02 // By source</h2><span className="sp" /><span className="t-cap">Last 90 days</span></div>
              <table className="fs-table">
                <thead><tr><th>Source</th><th className="n">Opps</th><th className="n">Sold</th><th className="n">Close rate</th>{p.pipeline.by_source.some((s) => s.sold_cents != null) && <th className="n">Sold value</th>}</tr></thead>
                <tbody>{p.pipeline.by_source.map((s) => (
                  <tr key={s.source}><td>{s.source === 'TGL' ? <Tag tone="ai">Tech-generated</Tag> : words(s.source)}</td><td className="n">{count(s.opportunities)}</td><td className="n">{count(s.sold)}</td>
                    <td className="n">{s.close_rate == null ? '—' : pct(s.close_rate)}</td>{s.sold_cents != null && <td className="n">{money(s.sold_cents)}</td>}</tr>
                ))}</tbody>
              </table>
            </section>
          </div>
          <section className="fs-card" aria-label="By advisor">
            <div className="fs-card-h"><h2 className="t-section">03 // Close rate by comfort advisor</h2></div>
            {p.pipeline.by_advisor.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No opportunities in the last 90 days' }} /></div> : (
              <table className="fs-table">
                <thead><tr><th>Advisor</th><th className="n">Opps</th><th className="n">Appointments</th><th className="n">Proposals</th><th className="n">Sold</th><th className="n">Lost</th><th className="n">Close rate</th>
                  {p.pipeline.by_advisor.some((a) => a.sold_cents != null) && <th className="n">Sold value</th>}</tr></thead>
                <tbody>{p.pipeline.by_advisor.map((a) => (
                  <tr key={a.advisor_id ?? 'none'}><td>{a.advisor}</td><td className="n">{count(a.opportunities)}</td><td className="n">{count(a.appointments)}</td><td className="n">{count(a.proposals)}</td>
                    <td className="n">{count(a.sold)}</td><td className="n">{count(a.lost)}</td><td className="n">{a.close_rate == null ? '—' : pct(a.close_rate)}</td>
                    {a.sold_cents != null && <td className="n">{money(a.sold_cents)}</td>}</tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === 'followups' && (
        <section className="fs-card" aria-label="Open estimates">
          <div className="fs-card-h">
            <h2 className="t-section">Open estimates</h2><span className="sp" />
            {callsDue > 0 && <Tag tone="warn">{count(callsDue)} calls due</Tag>}
            {p.canEdit && !readOnly && <Button variant="quiet" disabled={busy === 'run'} onClick={() => void run<{ followups: number }>('run', '/api/fieldservice/sales', { op: 'run', companyId: p.companyId }, (d) => `${count(d.followups)} follow-up step(s) sent`)}>Send due follow-ups now</Button>}
          </div>
          {p.queue.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No open estimates', body: 'Every presented estimate starts the company’s follow-up cadence (1 / 3 / 7 / 14 days) and stops when it is sold or declined.' }} /></div> : (
            <table className="fs-table">
              <thead><tr><th>Estimate</th><th>Customer</th><th className="n">Age</th><th className="n">Options</th><th>Owner</th><th>Next touch</th><th className="n">Touches</th><th aria-label="Actions" /></tr></thead>
              <tbody>{p.queue.map((q) => (
                <tr key={q.id} data-click>
                  <td><span className="l1">{q.number ?? 'Estimate'}</span><span className="l2">{q.title}</span></td>
                  <td>{q.customer ?? '—'}</td>
                  <td className="n">{q.age_days > 7 ? <Status kind="overdue">{`${q.age_days} d`}</Status> : `${q.age_days} d`}</td>
                  <td className="n">{q.from_cents == null ? '—' : q.from_cents === q.to_cents ? money(q.from_cents) : `${money(q.from_cents)} – ${money(q.to_cents ?? q.from_cents)}`}</td>
                  <td>{q.owner_employee_id ? p.employees[q.owner_employee_id] ?? 'Tech' : '—'}</td>
                  <td>{q.next_step ? <>{q.next_step.channel === 'CALL_TASK' ? 'Call' : words(q.next_step.channel)} · {q.next_step.status === 'DUE' ? <Tag tone="warn">due now</Tag> : fmtWhen(q.next_step.due_at)}</> : '—'}</td>
                  <td className="n">{count(q.touches)}</td>
                  <td>{q.next_step?.status === 'DUE' && p.canEdit && !readOnly && (
                    <Button variant="quiet" disabled={busy === q.next_step.id} onClick={() => void run(q.next_step!.id, '/api/fieldservice/sales', { op: 'followup_done', followupId: q.next_step!.id, outcome: 'Called' }, 'Call logged')}>Called</Button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'accepted' && (
        <section className="fs-card" aria-label="Accepted online">
          <div className="fs-card-h"><h2 className="t-section">Accepted in the customer portal</h2><span className="sp" /><span className="t-cap">The customer chose and signed — finalize to sell it</span></div>
          {p.accepted.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'Nothing waiting', body: 'When a customer picks an option and signs in the portal, it waits here for you to finalize the sale (and request the deposit).' }} /></div> : (
            <div className="fs-card-b">{p.accepted.map((a) => <AcceptedRow key={a.id} a={a} plans={p.plans} canFinalize={p.canFinalize && !readOnly} />)}</div>
          )}
        </section>
      )}
    </div>
  );
}

function OpenRow({ o, employees, canEdit }: { o: PipelineOpenRow; employees: Record<string, string>; canEdit: boolean }) {
  const { run, busy } = useAction();
  const [lost, setLost] = useState(false);
  const [reason, setReason] = useState('');
  const next = STAGES[STAGES.indexOf(o.stage) + 1];
  return (
    <tr>
      <td><span className="l1">{o.title}</span><span className="l2">{o.customer ?? ''}{o.job_id && <> · <Link href={`/jobs/${o.job_id}`}>job</Link></>}</span></td>
      <td>{o.source === 'TGL' ? <Tag tone="ai">TGL</Tag> : words(o.source)}</td>
      <td>{o.stalled ? <Status kind="risk">{`${words(o.stage)} · ${o.days_in_stage} d`}</Status> : `${words(o.stage)} · ${o.days_in_stage} d`}</td>
      <td>{o.advisor_employee_id ? employees[o.advisor_employee_id] ?? 'Advisor' : <span className="fs-muted">Unassigned</span>}</td>
      <td className="t-cap">{o.next_step}</td>
      <td>{canEdit && (lost ? (
        <div className="fs-flags">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why lost" aria-label="Lost reason" />
          <Button variant="danger" disabled={reason.trim().length < 3 || !!busy} onClick={() => void run('lost', '/api/fieldservice/sales', { op: 'advance', opportunityId: o.id, stage: 'LOST', reason }, 'Marked lost')}>Lost</Button>
        </div>
      ) : (
        <div className="fs-flags">
          {next && <Button variant="quiet" disabled={!!busy} onClick={() => void run('adv', '/api/fieldservice/sales', { op: 'advance', opportunityId: o.id, stage: next }, `Moved to ${words(next)}`)}>{words(next)}</Button>}
          <Button variant="quiet" onClick={() => setLost(true)}>Lost…</Button>
        </div>
      ))}</td>
    </tr>
  );
}

function AcceptedRow({ a, plans, canFinalize }: { a: Accepted; plans: Array<{ id: string; name: string }>; canFinalize: boolean }) {
  const { run, busy, error } = useAction();
  const [deposit, setDeposit] = useState('');
  const [plan, setPlan] = useState('');
  const [reject, setReject] = useState('');
  const cents = deposit ? Math.round(Number(deposit.replace(/[$,]/g, '')) * 100) : 0;
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '12px 0' }}>
      <div className="fs-toolbar" style={{ marginBottom: 8 }}>
        <div><span className="l1">{a.estimate_number ?? 'Estimate'} · {a.option_name ?? 'Option'}</span><span className="l2">{a.estimate_title} — signed “{a.typed_name}” {fmtWhen(a.accepted_at)}</span></div>
        <span className="sp" />
        <Link className="btn btn--quiet" href={`/jobs/${a.job_id}`}>Job</Link>
      </div>
      {error && <InlineNotice tone="neg" title="Not finalized.">{error}</InlineNotice>}
      {canFinalize && (
        <div className="fs-form">
          <Field label="Deposit to request (optional)" help="Books mints the deposit invoice; the customer pays it in the portal">
            <Input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Financing plan (optional)">
            <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">None</option>
              {plans.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <div className="fs-span fs-toolbar" style={{ marginBottom: 0 }}>
            <Input value={reject} onChange={(e) => setReject(e.target.value)} placeholder="Reason, to send back" aria-label="Reject reason" />
            <Button variant="quiet" disabled={reject.trim().length < 3 || !!busy} onClick={() => void run('rej', '/api/fieldservice/sales', { op: 'reject', acceptanceId: a.id, reason: reject }, 'Sent back')}>Send back</Button>
            <span className="sp" />
            <Button variant="primary" disabled={!!busy || !Number.isFinite(cents) || cents < 0}
              onClick={() => void run('fin', '/api/fieldservice/sales', { op: 'finalize', acceptanceId: a.id, depositCents: cents, requestDeposit: cents > 0, financingPlanId: plan || null }, 'Sold — install project created if equipment was sold')}>
              Finalize sale</Button>
          </div>
        </div>
      )}
    </div>
  );
}
