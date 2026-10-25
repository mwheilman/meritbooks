'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Check, Field, InlineNotice, Input, Select, Status, Tag, WidgetState, count, money } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { SetupStatus, ShadowReport, ShadowSide } from '@/lib/fieldservice/completion-types';
import { dollarsToCentsText } from '@/lib/dealer/tabular';
import { useAction } from '../common/useAction';

export interface GoLiveProps {
  companyId: string;
  status: SetupStatus;
  statusError: string | null;
  shadow: ShadowReport;
  shadowError: string | null;
  today: string;
  canConfigure: boolean;
  canRecord: boolean;
}

const SYSTEMS = [
  ['SERVICETITAN', 'ServiceTitan'], ['FIELDEDGE', 'FieldEdge'], ['SIMPRO', 'simPRO'], ['HOUSECALL_PRO', 'Housecall Pro'], ['JOBBER', 'Jobber'], ['OTHER', 'Other / spreadsheet'],
] as const;
type System = (typeof SYSTEMS)[number][0];
const TRADES = ['HVAC', 'PLUMBING', 'ELECTRICAL'] as const;
type Trade = (typeof TRADES)[number];

const SIDE_COLS: ReadonlyArray<{ key: keyof ShadowSide; label: string; cents: boolean }> = [
  { key: 'jobs', label: 'Jobs', cents: false }, { key: 'revenue_cents', label: 'Revenue', cents: true }, { key: 'payments_cents', label: 'Payments', cents: true },
  { key: 'memberships', label: 'Members sold', cents: false }, { key: 'estimates_sold', label: 'Estimates sold', cents: false },
];

const show = (v: number | null, cents: boolean): string => (v == null ? '—' : cents ? money(v) : count(v));

/**
 * Guided setup and shadow run (FS-117). The checklist shows what is configured (each step links to
 * the screen that sets it); the starter setup loads job types, arrival windows, capacity, a price
 * book, checklists, follow-up cadences, message templates and a permit template in one go. During
 * the shadow run the office keys the old system's daily totals and the report shows, day by day,
 * whether Merit recorded the same jobs, revenue, payments, memberships and sold estimates.
 */
export function GoLive(p: GoLiveProps) {
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [trades, setTrades] = useState<Set<Trade>>(new Set(TRADES));
  const [day, setDay] = useState(p.today);
  const [system, setSystem] = useState<System>('SERVICETITAN');
  const [jobs, setJobs] = useState('');
  const [revenue, setRevenue] = useState('');
  const [payments, setPayments] = useState('');
  const [members, setMembers] = useState('');
  const [sold, setSold] = useState('');
  const [notes, setNotes] = useState('');

  const whole = (s: string): number | null => (/^\d{1,6}$/.test(s.trim()) ? Number(s.trim()) : null);
  const legacy = {
    jobs: whole(jobs), memberships: whole(members), estimates_sold: whole(sold),
    revenue_cents: dollarsToCentsText(revenue), payments_cents: dollarsToCentsText(payments),
  };
  const formOk = legacy.jobs != null && legacy.memberships != null && legacy.estimates_sold != null && legacy.revenue_cents != null && legacy.revenue_cents >= 0
    && legacy.payments_cents != null && legacy.payments_cents >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(day);

  const seed = () => run<{ base: unknown; completion: unknown }>('seed', '/api/fieldservice/setup', { op: 'seed', companyId: p.companyId, trades: [...trades] }, 'Starter setup loaded');
  const record = () => run<{ id: string; status: 'MATCH' | 'VARIANCE' }>('shadow', '/api/fieldservice/setup', { op: 'shadow', companyId: p.companyId, day, system, legacy, notes: notes.trim() || null },
    (d) => (d.status === 'MATCH' ? `${day} matches` : `${day} recorded with differences`)).then((r) => {
    if (r) { setJobs(''); setRevenue(''); setPayments(''); setMembers(''); setSold(''); setNotes(''); }
  });
  const toggleTrade = (t: Trade) => setTrades((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  return (
    <div className="stack">
      {error && <InlineNotice tone="neg" title="That did not save.">{error}</InlineNotice>}

      <section className="fs-card" aria-label="Setup checklist">
        <header className="fs-card-h"><b>01 // Setup</b><span className="sp" style={{ flex: 1 }} />
          <span className="t-cap">{`${count(p.status.done)} of ${count(p.status.total)} done`}</span></header>
        {p.statusError ? <WidgetState state={{ kind: 'error', title: 'The checklist did not load', body: p.statusError }} />
          : p.status.steps.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing set up yet', body: 'Load the starter setup below, then adjust each step.' }} />
          : (
            <ul className="fs-list">{p.status.steps.map((s) => (
              <li key={s.key}>
                {s.done ? <Status kind="ready">Done</Status> : <Status kind="risk">To do</Status>}
                <Link href={s.href}>{s.label}</Link>
                <span className="sp" />
                <span className="t-cap">{count(s.count)}</span>
              </li>
            ))}</ul>
          )}
        {p.canConfigure && !readOnly && (
          <div className="fs-card-b">
            <div className="fs-toolbar">
              <span className="t-cap">Trades</span>
              {TRADES.map((t) => <Check key={t} label={t[0] + t.slice(1).toLowerCase()} checked={trades.has(t)} onChange={() => toggleTrade(t)} />)}
              <span className="sp" />
              <Button variant="primary" disabled={trades.size === 0 || busy === 'seed'} onClick={() => void seed()}>
                {busy === 'seed' ? 'Loading…' : 'Load the starter setup'}</Button>
            </div>
            <p className="t-cap">Safe to run again — it only adds what is missing and never overwrites what you changed.</p>
          </div>
        )}
      </section>

      <section className="fs-card" aria-label="Shadow run">
        <header className="fs-card-h"><b>02 // Shadow run</b><span className="sp" style={{ flex: 1 }} />
          <span className="t-cap">{`${count(p.shadow.matched_days)} of ${count(p.shadow.days.length)} days match`}</span></header>
        {p.canRecord && !readOnly && (
          <div className="fs-card-b">
            <p className="t-cap">Run both systems side by side. At day end, key the old system's totals; Merit compares them with what it recorded.</p>
            <div className="fs-toolbar">
              <Field label="Day"><Input type="date" value={day} max={p.today} onChange={(e) => setDay(e.target.value)} /></Field>
              <Field label="Old system"><Select value={system} onChange={(e) => setSystem(e.target.value as System)}>
                {SYSTEMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label="Jobs"><Input inputMode="numeric" value={jobs} onChange={(e) => setJobs(e.target.value)} placeholder="0" /></Field>
              <Field label="Revenue ($)"><Input inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="0.00" /></Field>
              <Field label="Payments ($)"><Input inputMode="decimal" value={payments} onChange={(e) => setPayments(e.target.value)} placeholder="0.00" /></Field>
              <Field label="Members sold"><Input inputMode="numeric" value={members} onChange={(e) => setMembers(e.target.value)} placeholder="0" /></Field>
              <Field label="Estimates sold"><Input inputMode="numeric" value={sold} onChange={(e) => setSold(e.target.value)} placeholder="0" /></Field>
            </div>
            <Field label="Notes"><Input value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="Anything that explains a difference" /></Field>
            <div className="fs-toolbar"><span className="sp" style={{ flex: 1 }} />
              <Button variant="primary" disabled={!formOk || busy === 'shadow'} onClick={() => void record()}>{busy === 'shadow' ? 'Comparing…' : 'Record and compare'}</Button></div>
          </div>
        )}
        {p.shadowError ? <WidgetState state={{ kind: 'error', title: 'The comparison did not load', body: p.shadowError }} />
          : p.shadow.days.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No shadow days yet', body: 'Record the first day to start the comparison report.' }} />
          : (
            <table className="fs-table">
              <thead><tr><th>Day</th><th>Result</th>{SIDE_COLS.map((c) => <th key={c.key} className="n">{c.label}</th>)}<th>Notes</th></tr></thead>
              <tbody>{p.shadow.days.map((d) => (
                <tr key={`${d.day}:${d.system}`}>
                  <td className="fs-mono">{d.day}<div className="t-cap">{SYSTEMS.find(([k]) => k === d.system)?.[1] ?? d.system}</div></td>
                  <td>{d.status === 'MATCH' ? <Tag tone="pos">Match</Tag> : <Tag tone="warn">Differences</Tag>}</td>
                  {SIDE_COLS.map((c) => {
                    const diff = d.diff[c.key];
                    return (
                      <td key={c.key} className="n">
                        <div>{show(d.merit[c.key], c.cents)}</div>
                        <div className="t-cap">{`was ${show(d.legacy[c.key], c.cents)}`}</div>
                        {diff != null && diff !== 0 && <Status kind="risk">{`${diff > 0 ? '+' : '−'}${show(Math.abs(diff), c.cents)}`}</Status>}
                      </td>
                    );
                  })}
                  <td>{d.notes ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
      </section>
    </div>
  );
}
