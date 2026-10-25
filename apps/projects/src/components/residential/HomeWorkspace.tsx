'use client';

import { useState } from 'react';
import { AppLink, Button, Dialog, Field, Input, Tabs, Tag, WidgetState, count, money, shortDate } from '@meritbooks/merit-ui';
import type { HomeWorkspace as Bundle } from '@/lib/residential/queries';
import type { DecisionItem } from '@/lib/residential/types';
import { PAYMENT_STATUS, TRADE_STATUS, scheduleShare } from '@/lib/residential/labels';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, Section, StatusMark } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { HomeChangeOrders } from './HomeChangeOrders';
import { HomeProfilePanel, HomeSite } from './HomeSite';
import { HomeCloseout } from './HomeCloseout';

type Tab = 'decisions' | 'changes' | 'trades' | 'payments' | 'home' | 'site' | 'closeout';

export interface HomeWorkspaceProps {
  bundle: Bundle;
  today: string;
  can: { edit: boolean; billing: boolean; changeOrders: boolean; selections: boolean };
  initialTab?: Tab;
}

const DECISION_WORDS: Record<DecisionItem['kind'], string> = { selection: 'Selection', change_order: 'Change order', deposit: 'Payment', proposal: 'Proposal', walkthrough: 'Walkthrough' };

function decisionHref(d: DecisionItem): string | null {
  if (d.kind === 'selection') return `/selections/${d.id}`;
  if (d.kind === 'proposal') return `/proposals/${d.id}`;
  return null;
}

export function HomeWorkspace({ bundle: b, today, can, initialTab }: HomeWorkspaceProps) {
  const mv = useMoneyVis();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'decisions');
  const atRiskTrades = b.trades.filter((t) => t.at_risk).length;
  const stopWork = b.changeOrders.filter((c) => c.stop_work && c.exposure_state !== 'approved' && c.exposure_state !== 'void' && c.exposure_state !== 'rejected').length;
  const held = b.schedule.filter((s) => s.status === 'HELD').length;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {stopWork > 0 && <Tag tone="neg">{count(stopWork)} stop-work change order{stopWork === 1 ? '' : 's'} unsigned</Tag>}
        {atRiskTrades > 0 && <Tag tone="neg">{count(atRiskTrades)} trade{atRiskTrades === 1 ? '' : 's'} unconfirmed inside 72 hours</Tag>}
        {held > 0 && <Tag tone="warn">{count(held)} payment{held === 1 ? '' : 's'} held</Tag>}
        {b.rrp?.required && b.rrp.status !== 'COMPLETE' && <Tag tone="warn">Lead-safe (RRP) record open</Tag>}
        {b.profile?.occupied && <Tag>Occupied home</Tag>}
      </div>
      <Tabs<Tab> aria-label="Home workspace" value={tab} onChange={setTab} items={[
        { value: 'decisions', label: 'Decisions', count: count(b.decisions.length) },
        { value: 'changes', label: 'Change orders', count: count(b.changeOrders.length) },
        { value: 'trades', label: 'Trades', count: count(b.trades.length) },
        { value: 'payments', label: 'Payments', count: count(b.schedule.length) },
        { value: 'home', label: 'Home & household' },
        { value: 'site', label: 'Site & permits', count: count(b.permits.length + b.inspections.length) },
        { value: 'closeout', label: 'Chain & walks', count: count(b.chainSteps.length + b.walks.length) },
      ]} />
      {tab === 'decisions' && <Decisions items={b.decisions} jobId={b.job!.id} today={today} canRemind={can.selections && can.edit} />}
      {tab === 'changes' && <HomeChangeOrders jobId={b.job!.id} rows={b.changeOrders} today={today} canEdit={can.changeOrders} />}
      {tab === 'trades' && (
        <Section title="Trade confirmations" meta="Each trade confirms, can’t make it, or proposes a date from the text link; unconfirmed inside 72 hours turns red">
          {b.trades.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No trades assigned', body: 'Assign a trade to a schedule task (Schedule → task → Assign trade). They get a text with a one-tap confirm link.' }} /> : (
            <div className="mp-table">
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th>Task</th><th>Trade</th><th>Start</th><th>Status</th><th>Note</th></tr></thead>
                <tbody>
                  {b.trades.map((t) => (
                    <tr key={t.id} className={t.at_risk ? 'attn' : undefined}>
                      <td><AppLink href={`/schedule?job=${t.job_id}&task=${t.task_id}`}>{t.task_title}</AppLink></td>
                      <td>{b.vendors[t.vendor_id] ?? 'Trade'}</td>
                      <td><span className={t.at_risk ? 'neg b' : undefined}>{t.start_on ? shortDate(t.start_on, today) : '—'}</span>{t.date_moved_since_confirm && <span className="l2">Date moved since they confirmed</span>}</td>
                      <td><StatusMark mark={TRADE_STATUS[t.status]} />{t.proposed_on && <span className="l2">Proposes {shortDate(t.proposed_on, today)}</span>}</td>
                      <td>{t.response_note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
      {tab === 'payments' && (mv.contract ? <Payments bundle={b} today={today} canRelease={can.billing} /> : <p className="t-cap">The payment schedule is contract money; it is hidden for your role.</p>)}
      {tab === 'home' && <HomeProfilePanel bundle={b} canEdit={can.edit} />}
      {tab === 'site' && <HomeSite bundle={b} today={today} canEdit={can.edit} />}
      {tab === 'closeout' && <HomeCloseout bundle={b} today={today} canEdit={can.edit} />}
    </div>
  );
}

function Decisions({ items, jobId, today, canRemind }: { items: DecisionItem[]; jobId: string; today: string; canRemind: boolean }) {
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  return (
    <Section title="Waiting on the homeowner" meta="Selections, change orders, payments and walkthroughs, soonest first"
      actions={canRemind && !readOnly ? (
        <div className="btn-row">
          <Button disabled={busy === 'deadlines'} onClick={() => void act<{ refreshed: number }>('deadlines', 'post', `/api/residential/jobs/${jobId}`, { op: 'deadlines' }, (d) => `${d.refreshed} deadlines re-dated from the schedule`)}>Re-date from schedule</Button>
          <Button disabled={busy === 'reminders'} onClick={() => void act<{ reminded: number }>('reminders', 'post', `/api/residential/jobs/${jobId}`, { op: 'reminders' }, (d) => (d.reminded ? `Reminded the homeowner about ${d.reminded}` : 'Nothing due for a reminder'))}>Send reminders</Button>
        </div>
      ) : undefined}>
      <Failure text={error} />
      {items.length === 0 ? <WidgetState state={{ kind: 'done', title: 'The homeowner owes no decisions', body: 'New selections, change orders and payment requests land here.' }} /> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Decision</th><th>Kind</th><th>Due</th>{mv.contract && <th className="n">Amount</th>}</tr></thead>
            <tbody>
              {items.map((d) => {
                const href = decisionHref(d);
                const late = !!d.due_on && d.due_on < today;
                return (
                  <tr key={`${d.kind}-${d.id}`} className={d.at_risk || d.stop_work || late ? 'attn' : undefined}>
                    <td>{href ? <AppLink href={href}>{d.title}</AppLink> : d.title}{d.stop_work && <span className="l2 neg">Work stopped until signed</span>}</td>
                    <td>{DECISION_WORDS[d.kind]}</td>
                    <td><span className={late || d.at_risk ? 'neg b' : undefined}>{d.due_on ? shortDate(d.due_on, today) : '—'}</span></td>
                    {mv.contract && <td className="n">{d.amount_cents != null ? money(d.amount_cents) : d.allowance_cents != null ? `${money(d.allowance_cents)} allowance` : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Payments({ bundle: b, today, canRelease }: { bundle: Bundle; today: string; canRelease: boolean }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [release, setRelease] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [through, setThrough] = useState(today);
  const total = b.schedule.reduce((s, r) => s + (r.amount_cents ?? 0) + r.added_cents, 0);
  return (
    <div className="stack">
      <Section title="Payment schedule" meta={`${money(total)} · a finished milestone task drafts its bill; a missing photo or checklist holds it`}
        actions={canRelease && !readOnly ? (
          <div className="row" style={{ gap: 6 }}>
            <Input type="date" aria-label="Bill cost-plus through" value={through} onChange={(e) => setThrough(e.target.value)} style={{ width: 150 }} />
            <Button disabled={busy === 'cp'} onClick={() => void act<{ billing_request_id: string; cost_cents: number; fee_cents: number }>('cp', 'post', '/api/residential/billing', { op: 'cost_plus', jobId: b.job!.id, through }, (d) => `Cost-plus bill drafted: ${money(Number(d.cost_cents))} cost + ${money(Number(d.fee_cents))} fee, with backup`)}>Bill cost-plus with backup</Button>
          </div>
        ) : undefined}>
        <Failure text={error} />
        {b.schedule.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No payment schedule', body: 'The schedule comes from the accepted proposal.' }} /> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Payment</th><th className="n">Amount</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {b.schedule.map((s) => (
                  <tr key={s.id} className={s.status === 'HELD' ? 'attn' : undefined}>
                    <td><span className="l1">{s.label}</span><span className="l2">{[s.requires_photo ? 'Photo required' : null, s.requires_checklist ? 'Checklist required' : null, s.added_cents ? `${money(s.added_cents)} added by change orders` : null].filter(Boolean).join(' · ')}</span></td>
                    <td className="n">{scheduleShare(s, money)}</td>
                    <td><StatusMark mark={PAYMENT_STATUS[s.status]} />{s.hold_reason && <span className="l2">{s.hold_reason}</span>}</td>
                    <td className="n">{s.status === 'HELD' && canRelease && !readOnly && <Button variant="quiet" onClick={() => { setRelease(s.id); setReason(''); }}>Release</Button>}
                      {s.billing_request_id && <AppLink href={`/billing?request=${s.billing_request_id}`}>Bill</AppLink>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {release && (
        <Dialog open onClose={() => setRelease(null)} title="Release a held payment" dismissOnScrim={false}
          actions={<><Button onClick={() => setRelease(null)}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3 || busy === 'rel'} onClick={() => void act('rel', 'post', '/api/residential/billing', { op: 'milestone_release', itemId: release, reason: reason.trim() }, 'Released — bill drafted').then((r) => { if (r) setRelease(null); })}>Release</Button></>}>
          <Field label="Why it can be billed without the photo or checklist" help="Kept on the record"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></Field>
        </Dialog>
      )}
    </div>
  );
}
