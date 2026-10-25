'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input, Select, Status, Textarea, money, type StatusKind } from '@meritbooks/merit-ui';
import type { PursuitCard } from '@/app/api/development/pursuits/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, useBoard, useDo } from '@/components/dealer/common/depth';

const STAGES: Array<[PursuitCard['stage'], string]> = [['IDENTIFIED', 'Identified'], ['LOI', 'LOI'], ['UNDER_CONTRACT', 'Under contract'], ['GO_NO_GO', 'Go / no-go']];
const DD_STATUS = ['NOT_STARTED', 'ORDERED', 'RECEIVED', 'REVIEWED', 'ISSUE', 'WAIVED'] as const;
const NEXT: Partial<Record<PursuitCard['stage'], PursuitCard['stage']>> = { IDENTIFIED: 'LOI', LOI: 'UNDER_CONTRACT', UNDER_CONTRACT: 'GO_NO_GO' };

interface Draft { name: string; address: string; price: string; earnest: string; budget: string; dd: string; hard: string; closing: string }
const EMPTY: Draft = { name: '', address: '', price: '', earnest: '', budget: '', dd: '', hard: '', closing: '' };
const isDay = (s: string) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Pursuit pipeline (RED-03) and due diligence (RED-04): sites by stage, hard-date countdown, the DD checklist, kill (pursuit cost written off) or go (becomes an SPE job). */
export function PursuitBoard({ companyId, today, jobs }: { companyId: string; today: string; jobs: Array<{ id: string; label: string }> }) {
  const { readOnly } = useShell();
  const url = '/api/development/pursuits';
  const b = useBoard<{ pursuits: PursuitCard[] }>(`${url}?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [d, setD] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState<string | null>(null);
  const [kill, setKill] = useState<Record<string, string>>({});
  const [goJob, setGoJob] = useState<Record<string, string>>({});
  const money3 = { price: d.price ? centsFrom(d.price) : null, earnest: d.earnest ? centsFrom(d.earnest) : null, budget: d.budget ? centsFrom(d.budget) : null };
  const bad = !d.name.trim() || (d.price && money3.price == null) || (d.earnest && money3.earnest == null) || (d.budget && money3.budget == null) || ![d.dd, d.hard, d.closing].every(isDay);
  const state = <BoardState b={b} what="Pursuits" />;
  if (!b.data) return state;
  const live = b.data.pursuits.filter((p) => p.stage !== 'DEAD' && p.stage !== 'GO');
  const urgent = live.filter((p) => p.days_to_hard_date != null && p.days_to_hard_date <= 7);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {urgent.length > 0 && <InlineNotice tone="warn" title={`${urgent.length} earnest deposit(s) go hard within a week.`}>{urgent.map((p) => `${p.name} (${p.days_to_hard_date} d)`).join(' · ')}</InlineNotice>}
      {!readOnly && (
        <Section title="New pursuit">
          <div className="ops-toolbar">
            <Field label="Site"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
            <Field label="Address"><Input value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} /></Field>
            <Field label="Contract price" error={d.price && money3.price == null ? 'Dollars' : undefined}><Input value={d.price} style={{ width: 130 }} onChange={(e) => setD({ ...d, price: e.target.value })} /></Field>
            <Field label="Earnest money" error={d.earnest && money3.earnest == null ? 'Dollars' : undefined}><Input value={d.earnest} style={{ width: 110 }} onChange={(e) => setD({ ...d, earnest: e.target.value })} /></Field>
            <Field label="Pursuit budget" error={d.budget && money3.budget == null ? 'Dollars' : undefined}><Input value={d.budget} style={{ width: 110 }} onChange={(e) => setD({ ...d, budget: e.target.value })} /></Field>
          </div>
          <div className="ops-toolbar">
            <Field label="DD expires"><Input type="date" value={d.dd} onChange={(e) => setD({ ...d, dd: e.target.value })} /></Field>
            <Field label="Earnest goes hard"><Input type="date" value={d.hard} onChange={(e) => setD({ ...d, hard: e.target.value })} /></Field>
            <Field label="Closing"><Input type="date" value={d.closing} onChange={(e) => setD({ ...d, closing: e.target.value })} /></Field>
            <Button variant="primary" disabled={!!bad || busy === 'new'} onClick={async () => {
              const r = await run('new', url, { op: 'save', companyId, fields: { name: d.name.trim(), address: d.address || null, contract_price_cents: money3.price, earnest_money_cents: money3.earnest,
                pursuit_budget_cents: money3.budget, dd_expires_on: d.dd || null, earnest_hard_on: d.hard || null, closing_on: d.closing || null } }, 'Pursuit added');
              if (r) setD(EMPTY);
            }}>Add the pursuit</Button>
          </div>
        </Section>
      )}
      {live.length === 0 && <Empty title="No live pursuits" body="Add a site you are chasing; it moves from identified to LOI, contract and go / no-go, with its due-diligence checklist and hard dates." />}
      {STAGES.map(([stage, label]) => {
        const rows = live.filter((p) => p.stage === stage);
        if (rows.length === 0) return null;
        return (
          <Section key={stage} title={label} meta={`${rows.length} site(s)`}>
            <ul className="ops-agenda">{rows.map((p) => {
              const hk: StatusKind = p.days_to_hard_date == null ? 'track' : p.days_to_hard_date < 0 ? 'overdue' : p.days_to_hard_date <= 7 ? 'risk' : 'track';
              return (
                <li key={p.id}>
                  <span className="d">{p.dd_done}/{p.dd_total} DD</span>
                  <div className="stack">
                    <span><b>{p.name}</b>{p.address ? ` · ${p.address}` : ''} · {p.contract_price_cents == null ? 'price open' : money(p.contract_price_cents, { decimals: 0 })}
                      {p.earnest_hard_on && <> · <Status kind={hk} pip="open">{p.earnest_refundable ? 'refundable' : 'hard'} {day(p.earnest_hard_on, today)}</Status></>}
                      {p.pursuit_budget_cents != null && ` · spent ${money(p.pursuit_spent_cents, { decimals: 0 })} of ${money(p.pursuit_budget_cents, { decimals: 0 })}`}</span>
                    {p.open_risks.length > 0 && <span className="l2 neg">{p.open_risks.join(' · ')}</span>}
                    <span className="btn-row">
                      <Button variant="quiet" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide diligence' : 'Diligence'}</Button>
                      {!readOnly && NEXT[p.stage] && <Button disabled={busy === `a${p.id}`} onClick={() => run(`a${p.id}`, url, { op: 'advance', pursuitId: p.id, stage: NEXT[p.stage] }, 'Moved')}>Move to {STAGES.find((s) => s[0] === NEXT[p.stage])![1]}</Button>}
                      {!readOnly && p.dd_total === 0 && <Button disabled={busy === `s${p.id}`} onClick={() => run(`s${p.id}`, url, { op: 'seed_dd', pursuitId: p.id }, (r: { added: number }) => `${r.added} checklist items`)}>Start the DD checklist</Button>}
                    </span>
                    {open === p.id && (
                      <div className="stack">
                        {p.dd.length > 0 && <table className="ops-mini" aria-label={`Due diligence for ${p.name}`}><thead><tr><th>Item</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                          <tbody>{p.dd.map((i) => <tr key={i.id}><td>{i.title}</td><td>{i.owner ?? '—'}</td><td>{day(i.due_on, today)}</td>
                            <td>{readOnly ? i.status.toLowerCase().replace(/_/g, ' ') : <Select aria-label={`Status of ${i.title}`} value={i.status} onChange={(e) => run(`d${i.id}`, url, { op: 'dd_item', itemId: i.id, fields: { status: e.target.value } }, null)}>
                              {DD_STATUS.map((s) => <option key={s} value={s}>{s.toLowerCase().replace(/_/g, ' ')}</option>)}</Select>}</td></tr>)}</tbody></table>}
                        {!readOnly && <div className="ops-toolbar">
                          <Field label="Go: the SPE job"><Select value={goJob[p.id] ?? ''} onChange={(e) => setGoJob({ ...goJob, [p.id]: e.target.value })}><option value="">Pick the job</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
                          <Button variant="primary" disabled={!goJob[p.id] || busy === `g${p.id}`} onClick={() => run(`g${p.id}`, url, { op: 'go', pursuitId: p.id, jobId: goJob[p.id] }, 'Go — the pursuit is now the project')}>Go</Button>
                          <Field label="Kill: why"><Textarea rows={1} value={kill[p.id] ?? ''} onChange={(e) => setKill({ ...kill, [p.id]: e.target.value })} /></Field>
                          <Button variant="danger" disabled={!(kill[p.id] ?? '').trim() || busy === `k${p.id}`} onClick={() => { if (window.confirm(`Kill ${p.name}? Pursuit cost is sent to Books to write off.`)) void run(`k${p.id}`, url, { op: 'kill', pursuitId: p.id, reason: kill[p.id] }, 'Killed — write-off sent to Books'); }}>Kill the deal</Button>
                        </div>}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}</ul>
          </Section>
        );
      })}
      {b.data.pursuits.some((p) => p.stage === 'DEAD' || p.stage === 'GO') && <Section title="Closed out">
        {b.data.pursuits.filter((p) => p.stage === 'DEAD' || p.stage === 'GO').map((p) => <p key={p.id} className="l2">{p.name} · {p.stage === 'GO' ? 'went ahead' : 'dead'} · spent {money(p.pursuit_spent_cents, { decimals: 0 })}</p>)}
      </Section>}
    </div>
  );
}
