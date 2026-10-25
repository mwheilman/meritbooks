'use client';

import { PortalAccessPanel } from '@/components/portal/staff/PortalAccessPanel';
import { useMemo, useState } from 'react';
import {
  Button, Check, Field, InlineNotice, Input, KV, MoneyInput, Panel, PanelSection, QueueTable, Select, WidgetState, count, money, pct, shortDate,
  useEscapeKey, type QueueColumn,
} from '@meritbooks/merit-ui';
import { DRAW_STATUS_WORDS, INSPECTION_WORDS, balanceOf, balanceSentence } from '@/lib/pm/ops/draw-math';
import type { DrawBundle } from '@/lib/pm/ops/development-queries';
import type { DrawSummaryRow } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, PctInput, Section } from '../common/bits';
import { useOps } from '../common/useOps';
import { ContinuationSheet } from './ContinuationSheet';
import { DrawWorkspace } from './DrawWorkspace';
import { LoanBudget } from './LoanBudget';

export interface DrawsViewProps extends DrawBundle {
  jobs: JobOption[];
  today: string;
  initialScheduleId: string | null;
  fixedJobId?: string | null;
}

const OPEN = new Set(['DRAFT', 'SUBMITTED', 'INSPECTION', 'APPROVED', 'RETURNED']);

export function DrawsView(p: DrawsViewProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const [scheduleId, setScheduleId] = useState<string>(p.initialScheduleId ?? p.status.find((s) => s.status === 'ACTIVE')?.draw_schedule_id ?? p.status[0]?.draw_schedule_id ?? '');
  const [creating, setCreating] = useState(p.status.length === 0 && !readOnly);
  const [periodEnd, setPeriodEnd] = useState(p.today);
  const st = p.status.find((s) => s.draw_schedule_id === scheduleId) ?? null;
  const sched = p.schedules.find((s) => s.id === scheduleId) ?? null;
  const lines = p.lineStatus.filter((l) => l.draw_schedule_id === scheduleId);
  const budgetLines = p.budgetLines.filter((l) => l.draw_schedule_id === scheduleId);
  const draws = p.draws.filter((d) => d.draw_schedule_id === scheduleId).sort((a, b) => b.draw_number - a.draw_number);
  const open = draws.find((d) => OPEN.has(d.status)) ?? null;
  const [drawId, setDrawId] = useState<string | null>(null);
  const shown = draws.find((d) => d.draw_id === drawId) ?? open;
  const lineIds = new Set(budgetLines.map((b) => b.id));
  const revisions = p.revisions.filter((r) => lineIds.has(r.draw_budget_line_id));
  const equityElsewhere = shown ? draws.filter((d) => d.draw_id !== shown.draw_id && (d.status === 'APPROVED' || d.status === 'FUNDED')).reduce((s, d) => s + (d.equity_applied_cents ?? 0), 0) : 0;

  const columns: QueueColumn<DrawSummaryRow>[] = [
    { id: 'n', header: 'Draw', width: 72, cell: (d) => <span className="b tnum">#{d.draw_number}</span> },
    { id: 'pe', header: 'Period end', width: 104, cell: (d) => shortDate(d.period_end, p.today) },
    { id: 'st', header: 'Status', width: 140, cell: (d) => <><span className="l1">{DRAW_STATUS_WORDS[d.status]}</span><span className="l2">{INSPECTION_WORDS[d.inspection_status]}</span></> },
    { id: 'rq', header: 'Requested', numeric: true, width: 120, cell: (d) => money(d.requested_cents ?? d.lines_requested_cents) },
    { id: 'ap', header: 'Approved', numeric: true, width: 120, cell: (d) => (d.approved_cents == null ? '—' : money(d.approved_cents)) },
    { id: 'rt', header: 'Retainage', numeric: true, width: 110, cell: (d) => (d.retainage_held_cents == null ? '—' : money(d.retainage_held_cents)) },
    { id: 'eq', header: 'Equity', numeric: true, width: 110, cell: (d) => (d.equity_applied_cents == null ? '—' : money(d.equity_applied_cents)) },
    { id: 'fd', header: 'Funded', numeric: true, width: 120, cell: (d) => (d.funded_cents == null ? '—' : money(d.funded_cents)) },
    { id: 'cy', header: 'Days', numeric: true, width: 64, cell: (d) => (d.cycle_days == null ? '—' : String(Math.round(Number(d.cycle_days)))) },
    { id: 'pk', header: 'Package', width: 120, cell: (d) => (d.status === 'CANCELLED' ? '—' : d.package_missing.length ? <span className="l2">{count(d.package_missing.length)} missing</span> : 'Complete') },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar ops-noprint">
        {p.status.length > 1 && (
          <Field label="Loan">
            <Select value={scheduleId} onChange={(e) => { setScheduleId(e.target.value); setDrawId(null); setCreating(false); }}>
              {p.status.map((s) => <option key={s.draw_schedule_id} value={s.draw_schedule_id}>{jobs.get(s.job_id)?.label ?? v.job} · {s.lender_name}{s.loan_number ? ` ${s.loan_number}` : ''}</option>)}
            </Select>
          </Field>
        )}
        <span className="sp" />
        {st && <Button onClick={() => window.print()}>Print for the lender</Button>}
        {!readOnly && <Button variant={p.status.length ? 'default' : 'primary'} icon="plus" onClick={() => setCreating(true)}>New loan budget</Button>}
      </div>
      <Failure text={error} />

      {creating && !readOnly ? (
        <NewSchedulePanel jobs={p.jobs.filter((j) => j.open)} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setScheduleId(id); }} />
      ) : !st || !sched ? (
        <div className="surface"><WidgetState state={{ kind: 'empty', title: 'No loan budget yet', body: `Set up the construction loan: lender, commitment, equity, retainage and the budget by line (it can start from the ${lower(v.job)}’s budget). Each draw is then requested against it.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New loan budget</Button> }} /></div>
      ) : (
        <>
          <Section title={`${st.lender_name}${st.loan_number ? ` · loan ${st.loan_number}` : ''}`} meta={`${jobs.get(st.job_id)?.label ?? ''} · ${st.status === 'ACTIVE' ? 'Active' : st.status === 'DRAFT' ? 'Draft' : 'Closed'}`}>
            <div className="cols" style={{ marginTop: 0 }}>
              <div>
                <p className="t-section" style={{ marginBottom: 8 }}>Sources and uses</p>
                <KV items={[
                  { term: 'Loan commitment', value: money(st.loan_commitment_cents) },
                  { term: 'Equity required', value: money(st.equity_required_cents) },
                  { term: 'Budget (revised)', value: money(st.revised_budget_cents) },
                  { term: 'Funded by the lender', value: money(st.loan_funded_cents) },
                  { term: 'Equity in', value: money(st.equity_contributed_cents) },
                  { term: 'Drawn (gross)', value: money(st.drawn_gross_cents) },
                  { term: 'Retainage held', value: money(st.retainage_held_cents) },
                  { term: 'Cost to complete', value: <b>{money(st.cost_to_complete_cents)}</b> },
                ]} />
              </div>
              <div className="stack">
                {st.status === 'ACTIVE' && (() => {
                  const b = balanceSentence(balanceOf(st));
                  return <InlineNotice tone={b.tone === 'neg' ? 'neg' : 'info'} title={b.title}>{b.body}</InlineNotice>;
                })()}
                <KV items={[
                  { term: 'Interest reserve left', value: money(st.interest_reserve_remaining_cents) },
                  { term: 'Runway', value: st.interest_reserve_months == null ? 'Set a rate or monthly interest' : `${Number(st.interest_reserve_months).toFixed(1)} months at ${money(st.monthly_interest_cents)} a month` },
                  ...(st.contingency_burn_ratio != null ? [{ term: 'Contingency burn vs progress', value: <span className={Number(st.contingency_burn_ratio) > 1 ? 'neg b' : undefined}>{Number(st.contingency_burn_ratio).toFixed(2)}×</span> }] : []),
                  { term: 'Retainage', value: `${pct(Number(sched.retainage_pct))} on hard cost` },
                  { term: 'Inspection', value: sched.requires_inspection ? 'Required before approval' : 'Not required' },
                  { term: 'Equity', value: sched.equity_first ? 'Applied before the loan' : 'Alongside the loan' },
                  ...(sched.maturity_on ? [{ term: 'Matures', value: shortDate(sched.maturity_on, p.today) }] : []),
                ]} />
                {st.contingency_burn_ratio != null && Number(st.contingency_burn_ratio) > 1 && <p className="t-cap">Contingency is going faster than the building: more than 1.0× means burning ahead of progress.</p>}
              </div>
            </div>
          </Section>

          {sched.status === 'ACTIVE' && (
            <Section title="Continuation sheet" meta="G703 columns; drawn = approved on funded draws">
              <ContinuationSheet rows={lines} openDrawNumber={open?.draw_number ?? null} />
            </Section>
          )}

          <LoanBudget schedule={sched} lines={budgetLines} status={lines} revisions={revisions} today={p.today} />

          {(() => {
            const company = p.jobs.find((j) => j.id === sched.job_id)?.companyId ?? null;
            return company ? (
              <Section title="Lender portal" meta={`${sched.lender_name} reviews draws, inspections and documents in the portal`}>
                <PortalAccessPanel key={sched.id} companyId={company} audience="lender" jobId={sched.job_id} />
              </Section>
            ) : null;
          })()}

          {sched.status === 'ACTIVE' && (
            <Section title="Draws" meta={`${count(draws.filter((d) => d.status === 'FUNDED').length)} funded`}
              actions={!readOnly && !open ? (
                <form className="row ops-noprint" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void act<{ drawId: string }>('draw', 'post', `/api/ops/draw-schedules/${sched.id}`, { op: 'create_draw', periodEnd }, 'Opened the next draw').then((r) => { if (r) setDrawId(r.drawId); }); }}>
                  <Field label="Period ending"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
                  <Button type="submit" variant="primary" icon="plus" disabled={busy === 'draw'}>New draw</Button>
                </form>
              ) : undefined}>
              {draws.length === 0 ? <p className="t-cap">No draws yet. Open the first one for the period it covers.</p> : (
                <div className="mp-table">
                  <QueueTable aria-label="Draws" columns={columns} rows={draws} getRowId={(d) => d.draw_id} cursorId={shown?.draw_id ?? null} onCursorChange={(id) => setDrawId(id)} onOpen={(d) => setDrawId(d.draw_id)}
                    rowState={(d) => ({ done: d.status === 'CANCELLED', attn: d.status === 'RETURNED' })} />
                </div>
              )}
            </Section>
          )}

          {shown && sched.status === 'ACTIVE' && (
            <DrawWorkspace key={shown.draw_id} draw={shown} detail={p.details.find((x) => x.id === shown.draw_id) ?? null} lines={p.drawLines.filter((l) => l.draw_id === shown.draw_id)} schedule={sched} budgetLines={budgetLines} lineStatus={lines} equityUsedElsewhere={equityElsewhere} today={p.today} />
          )}
        </>
      )}
    </div>
  );
}

function NewSchedulePanel({ jobs, fixedJobId, onClose, onCreated }: { jobs: JobOption[]; fixedJobId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [lender, setLender] = useState('');
  const [loanNo, setLoanNo] = useState('');
  const [commit, setCommit] = useState<number | null>(null);
  const [equity, setEquity] = useState<number | null>(null);
  const [reserve, setReserve] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [ret, setRet] = useState<number | null>(0.1);
  const [inspect, setInspect] = useState(true);
  const [equityFirst, setEquityFirst] = useState(true);
  const [seed, setSeed] = useState(true);
  const [maturity, setMaturity] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'New loan budget');
  const submit = async () => {
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!lender.trim()) return setErr('Name the lender.');
    if (commit == null) return setErr('Enter the loan commitment.');
    if (ret != null && ret > 0.25) return setErr('Retainage is at most 25%.');
    setErr(null);
    const r = await act<{ scheduleId: string; seeded: number }>('create', 'post', '/api/ops/draw-schedules', {
      jobId, lenderName: lender.trim(), loanNumber: loanNo.trim() || null, loanCommitmentCents: commit, equityRequiredCents: equity ?? 0, interestReserveCents: reserve ?? 0,
      interestRate: rate, retainagePct: ret ?? 0, requiresInspection: inspect, equityFirst, maturityOn: maturity || null, seedFromBudget: seed,
    }, (d) => (d.seeded ? `Created the loan budget with ${d.seeded} lines from the job budget` : 'Created the loan budget'));
    if (r) onCreated(r.scheduleId);
  };
  return (
    <div className="ops-split has-panel">
      <div className="surface"><WidgetState state={{ kind: 'empty', title: 'Set up the loan', body: 'The loan budget is the lender’s view of the job: every draw is requested against its lines, and the in-balance test runs on it after every draw.' }} /></div>
      <Panel eyebrow={['New', 'Loan budget']} title={lender.trim() || 'New loan budget'} meta="Starts as a draft you can edit; activate it before the first draw" onClose={onClose}
        foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create draft</Button></div>}>
        <PanelSection>
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
            <div className="mp-form-2">
              <Field label="Lender" error={err ?? undefined}><Input autoFocus value={lender} onChange={(e) => setLender(e.target.value)} placeholder="West Bank" maxLength={160} /></Field>
              <Field label="Loan number"><Input value={loanNo} onChange={(e) => setLoanNo(e.target.value)} maxLength={60} /></Field>
            </div>
            <div className="mp-form-2">
              <Field label="Loan commitment"><MoneyInput valueCents={commit} onChangeCents={setCommit} placeholder="0.00" /></Field>
              <Field label="Equity required"><MoneyInput valueCents={equity} onChangeCents={setEquity} placeholder="0.00" /></Field>
            </div>
            <div className="mp-form-2">
              <Field label="Interest reserve" help="Or add an interest-reserve line"><MoneyInput valueCents={reserve} onChangeCents={setReserve} placeholder="0.00" /></Field>
              <Field label="Interest rate"><PctInput value={rate} onChange={setRate} placeholder="8.25" /></Field>
            </div>
            <div className="mp-form-2">
              <Field label="Retainage on hard cost"><PctInput value={ret} onChange={setRet} placeholder="10" max={25} /></Field>
              <Field label="Matures"><Input type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} /></Field>
            </div>
            <Check label="Lender inspection required before approval" checked={inspect} onChange={(e) => setInspect(e.target.checked)} />
            <Check label="Equity goes in before the loan" checked={equityFirst} onChange={(e) => setEquityFirst(e.target.checked)} />
            <Check label={`Start the lines from the ${lower(v.job)}’s budget`} checked={seed} onChange={(e) => setSeed(e.target.checked)} />
            <Failure text={error} />
            <button type="submit" hidden />
          </form>
        </PanelSection>
      </Panel>
    </div>
  );
}
