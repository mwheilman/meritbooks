'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, InlineNotice, Input, Status, Tabs, Tag, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { Dashboard, DashboardRole, FindingRow, MetricAnswer } from '@/lib/fieldservice/completion-types';
import { useAction, words } from '../common/useAction';

export interface RoleDashboardProps {
  companyId: string;
  role: DashboardRole;
  roles: DashboardRole[];
  dashboard: Dashboard | null;
  error: string | null;
  findings: FindingRow[];
  metrics: Array<{ key: string; label: string; example: string }>;
  canAudit: boolean;
  canDismiss: boolean;
}

const ROLE_LABEL: Record<DashboardRole, string> = { gm: 'Owner / GM', dispatcher: 'Dispatcher', service_manager: 'Service manager', install_pm: 'Install PM' };

type Tile = { label: string; value: string; href?: string; tone?: 'risk' | 'overdue' };

function tiles(d: Dashboard): Tile[] {
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const m = (k: string) => (n(k) == null ? '—' : money(n(k)!));
  switch (d.role) {
    case 'gm': return [
      { label: 'Revenue', value: m('revenue_cents') },
      { label: 'Gross margin', value: n('gross_margin_pct') == null ? '—' : `${pct(n('gross_margin_pct')!)} · ${m('gross_margin_cents')}` },
      { label: 'Members active', value: count(n('memberships_active') ?? 0), href: '/agreements' },
      { label: 'Members net adds', value: count((n('memberships_new') ?? 0) - (n('memberships_lost') ?? 0)), href: '/agreements' },
      { label: 'Visits not invoiced', value: count(n('unbilled_visits') ?? 0), href: '/invoice-review', tone: (n('unbilled_visits') ?? 0) > 0 ? 'risk' : undefined },
      { label: 'Unfunded financing', value: count(n('unfunded_financing') ?? 0), href: '/invoice-review?tab=financing' },
      { label: 'Billing leaks open', value: count(n('open_findings') ?? 0), tone: (n('open_findings') ?? 0) > 0 ? 'overdue' : undefined },
    ];
    case 'dispatcher': return [
      { label: 'Booked today', value: `${count(n('booked_today') ?? 0)} of ${count(n('capacity_today') ?? 0)}`, href: '/dispatch' },
      { label: 'Unassigned today', value: count(n('unassigned_today') ?? 0), href: '/dispatch', tone: (n('unassigned_today') ?? 0) > 0 ? 'risk' : undefined },
      { label: 'Late techs', value: count(Array.isArray(d.late_techs) ? d.late_techs.length : 0), href: '/dispatch', tone: Array.isArray(d.late_techs) && d.late_techs.length ? 'overdue' : undefined },
      { label: 'Tomorrow not confirmed', value: count(n('unconfirmed_tomorrow') ?? 0) },
      { label: 'Reschedule requests', value: count(n('reschedule_requests') ?? 0), href: '/calls/messages', tone: (n('reschedule_requests') ?? 0) > 0 ? 'risk' : undefined },
      { label: 'Unread conversations', value: count(n('unread_threads') ?? 0), href: '/calls/messages' },
      { label: 'Missed calls today', value: count(n('missed_calls_today') ?? 0), href: '/calls/log' },
      { label: 'Web requests waiting', value: count(n('requests_waiting') ?? 0), href: '/calls' },
    ];
    case 'service_manager': return [
      { label: 'Conversion', value: n('conversion') == null ? '—' : pct(n('conversion')!) },
      { label: 'Average ticket', value: m('average_ticket_cents') },
      { label: 'Recalls', value: count(n('recalls') ?? 0) },
      { label: 'Open estimates > 3 days', value: count(n('open_estimates_over_3_days') ?? 0), href: '/calls/sales' },
      { label: 'Follow-up calls due', value: count(n('followup_calls_due') ?? 0), href: '/calls/sales' },
      { label: 'Timesheet exceptions', value: count(n('timesheet_exceptions') ?? 0), href: '/dispatch/timesheets' },
      { label: 'Invoices to review', value: count(n('reviews_waiting') ?? 0), href: '/invoice-review' },
    ];
    case 'install_pm': {
      const st = (d.by_stage ?? {}) as Record<string, number>;
      return [
        ...Object.entries(st).map(([k, v]) => ({ label: words(k), value: count(v), href: '/installs' })),
        { label: 'Stuck', value: count(n('stuck') ?? 0), href: '/installs', tone: (n('stuck') ?? 0) > 0 ? 'risk' as const : undefined },
        { label: 'Permits pending', value: count(n('permits_pending') ?? 0), href: '/installs' },
        { label: 'Installs next 7 days', value: count(n('installs_next_7_days') ?? 0), href: '/installs' },
        { label: 'Pipeline', value: m('pipeline_cents') },
        { label: 'Closed margin', value: n('closed_margin_pct') == null ? '—' : pct(n('closed_margin_pct')!) },
      ];
    }
  }
}

/**
 * Role dashboards (FS-109) — GM, dispatcher, service manager, install PM — with "ask a question"
 * over the operations metric catalog (FS-110; rules-only until AI is on, every answer links to the
 * records) and the billing integrity auditor's open findings (FS-112).
 */
export function RoleDashboard(p: RoleDashboardProps) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<{ understood: string[]; answer: MetricAnswer | null; suggestions: Array<{ key: string; example: string }> } | null>(null);

  async function ask(question: string) {
    setQ(question);
    const r = await run<{ understood: string[]; answer: MetricAnswer | null; suggestions: Array<{ key: string; example: string }> }>('ask', '/api/fieldservice/insights', { op: 'ask', companyId: p.companyId, question });
    if (r) setAnswer(r);
  }

  return (
    <div className="stack">
      <Tabs aria-label="Dashboard" value={p.role} onChange={(v) => router.push(`/dispatch/dashboard?role=${v}`)} items={p.roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      {p.error ? <WidgetState state={{ kind: 'error', title: 'The dashboard did not load', body: p.error }} />
        : !p.dashboard ? <WidgetState state={{ kind: 'loading', label: 'Loading' }} />
        : (
          <div className="fs-tiles">
            {tiles(p.dashboard).map((t) => {
              const inner = <><span className="t-cap">{t.label}</span><b>{t.value}</b>{t.tone && <Status kind={t.tone}>{t.tone === 'risk' ? 'Look' : 'Act'}</Status>}</>;
              return t.href ? <Link key={t.label} href={t.href} className="fs-tile">{inner}</Link> : <div key={t.label} className="fs-tile">{inner}</div>;
            })}
          </div>
        )}

      <section className="fs-card" aria-label="Ask">
        <div className="fs-card-h"><h2 className="t-section">Ask about operations</h2><span className="sp" /><Tag>Rules-based · AI answers come later</Tag></div>
        <div className="fs-card-b">
          <form className="fs-toolbar" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 3) void ask(q.trim()); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Which sold jobs ran under 40% margin last month?" aria-label="Question" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={q.trim().length < 3 || busy === 'ask'}>Ask</Button>
          </form>
          {error && <InlineNotice tone="neg" title="No answer.">{error}</InlineNotice>}
          {answer && (answer.answer ? (
            <div className="stack">
              <p><b>{answer.answer.label}</b> <span className="t-cap">{answer.understood.join(' · ')} · {answer.answer.from} – {answer.answer.to}</span></p>
              {answer.answer.masked ? <InlineNotice tone="info" title="This answer has amounts you don’t have access to." />
                : answer.answer.rows.length === 0 ? <WidgetState state={{ kind: 'done', title: 'Nothing found', body: 'No records match.' }} />
                : (
                  <table className="fs-table">
                    <thead><tr><th>Record</th><th className="n">{answer.answer.unit === 'cents' ? 'Amount' : answer.answer.unit === 'ratio' ? 'Rate' : 'Value'}</th></tr></thead>
                    <tbody>{answer.answer.rows.slice(0, 50).map((r, i) => (
                      <tr key={i}><td>{r.ref_table === 'work_orders' && r.ref_id ? <Link href={`/dispatch/visit/${r.ref_id}`}>{r.label}</Link> : r.job_id ? <Link href={`/jobs/${r.job_id}`}>{r.label}</Link> : r.label ?? String(r.advisor ?? '')}</td>
                        <td className="n">{r.value == null ? (typeof r.close_rate === 'number' ? pct(r.close_rate) : '—') : answer.answer!.unit === 'cents' ? money(Number(r.value)) : answer.answer!.unit === 'ratio' ? pct(Number(r.value)) : count(Number(r.value))}</td></tr>
                    ))}</tbody>
                  </table>
                )}
            </div>
          ) : (
            <div><p>I can answer questions like these:</p>
              <ul>{(answer.suggestions.length ? answer.suggestions : p.metrics.map((m) => ({ key: m.key, example: m.example }))).slice(0, 8).map((s) => (
                <li key={s.key}><button type="button" className="btn btn--quiet" onClick={() => void ask(s.example)}>{s.example}</button></li>
              ))}</ul>
            </div>
          ))}
        </div>
      </section>

      <section className="fs-card" aria-label="Billing integrity">
        <div className="fs-card-h"><h2 className="t-section">Billing integrity</h2><span className="sp" />
          <span className="t-cap">Completed work not invoiced, cost with no billing, parts not billed, member pricing, chargebacks, installs not billed</span>
          {p.canAudit && !readOnly && <Button variant="quiet" disabled={busy === 'audit'} onClick={() => void run<{ counts: Record<string, number> }>('audit', '/api/fieldservice/insights', { op: 'audit', companyId: p.companyId },
            (d) => `Audit done — ${count(Object.values(d.counts).reduce((s, v) => s + Number(v), 0))} open finding(s)`)}>Run audit now</Button>}
        </div>
        {p.findings.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'done', title: 'No open findings', body: 'Run the audit after a busy day, or let the nightly run catch leaks.' }} /></div> : (
          <table className="fs-table">
            <thead><tr><th>Finding</th><th>Kind</th>{p.findings.some((f) => f.amount_cents != null) && <th className="n">Amount</th>}<th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{p.findings.map((f) => <FindingView key={f.id} f={f} canDismiss={p.canDismiss && !readOnly} canTask={p.canAudit && !readOnly} />)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function FindingView({ f, canDismiss, canTask }: { f: FindingRow; canDismiss: boolean; canTask: boolean }) {
  const { run, busy } = useAction();
  const [why, setWhy] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const href = f.subject_table === 'work_orders' ? `/dispatch/visit/${f.subject_id}` : f.subject_table === 'fs_install_projects' ? '/installs' : f.subject_table === 'fs_invoice_reviews' ? '/invoice-review' : f.job_id ? `/jobs/${f.job_id}` : null;
  return (
    <tr>
      <td>{href ? <Link href={href}>{f.detail}</Link> : f.detail}</td>
      <td><Tag tone={f.kind === 'COMPLETED_NOT_INVOICED' || f.kind === 'INSTALL_NOT_BILLED' ? 'neg' : 'warn'}>{words(f.kind)}</Tag></td>
      {f.amount_cents !== undefined && <td className="n">{f.amount_cents == null ? '—' : money(f.amount_cents)}</td>}
      <td>{f.status === 'TASKED' ? <Status kind="track">Task open</Status> : <Status kind="risk">Open</Status>}</td>
      <td><div className="fs-flags">
        {canTask && f.status === 'OPEN' && f.job_id && <Button variant="quiet" disabled={!!busy} onClick={() => void run('t', '/api/fieldservice/insights', { op: 'task', findingId: f.id }, 'Fix task created on the job')}>Make a task</Button>}
        {canDismiss && (dismissing ? <>
          <Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it is not a leak" aria-label="Reason" />
          <Button variant="quiet" disabled={why.trim().length < 3 || !!busy} onClick={() => void run('d', '/api/fieldservice/insights', { op: 'dismiss', findingId: f.id, reason: why }, 'Dismissed')}>Dismiss</Button>
        </> : <Button variant="quiet" onClick={() => setDismissing(true)}>Dismiss…</Button>)}
      </div></td>
    </tr>
  );
}
