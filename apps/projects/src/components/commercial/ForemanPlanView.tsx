'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ButtonLink, Field, Input, Tag, WidgetState, pct } from '@meritbooks/merit-ui';
import { addDaysIso } from '@/lib/commercial/screen-logic';
import type { CostCodeLite, CostCodeUnit, ForemanPlan } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { QuantityForm } from './ProductivityView';
import { qty, words } from './kit';

/** The plan's open items, for the line under the title. Pure. */
export function planCounts(p: ForemanPlan): { crew: number; tasks: number; deliveries: number; hazards: number; jhaSigned: boolean } {
  return { crew: p.crew.length, tasks: p.tasks.length, deliveries: p.deliveries.length, hazards: p.hazards.length, jhaSigned: p.jha.length > 0 && p.jha.every((j) => j.status === 'SIGNED') };
}

/**
 * The foreman's morning screen (CGC-93): today's crew, the tasks from the lookahead, materials
 * staged or due, open hazards and today's pre-task plan, the drawings for the area, yesterday's
 * productivity, and the installed-quantity entry for tonight — one screen, no money.
 */
export function ForemanPlanView({ jobs, jobId, date, plan, codes, units, today, canLog, error }: {
  jobs: JobOption[]; jobId: string | null; date: string; plan: ForemanPlan | null; codes: CostCodeLite[]; units: CostCodeUnit[]; today: string; canLog: boolean; error: string | null;
}) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error: actError } = useOps();
  const go = (j: string, d: string) => router.push(`/foreman?job=${j}&date=${d}`);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-toolbar ops-noprint">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId ?? ''} onChange={(id) => id && go(id, date)} /></Field>
        <Field label="Day"><Input type="date" value={date} onChange={(e) => jobId && e.target.value && go(jobId, e.target.value)} /></Field>
        {jobId && <Button variant="quiet" chord="[" bindChord onClick={() => go(jobId, addDaysIso(date, -1))}>Day before</Button>}
        {jobId && <Button variant="quiet" chord="]" bindChord onClick={() => go(jobId, addDaysIso(date, 1))}>Next day</Button>}
        {jobId && date !== today && <Button variant="quiet" onClick={() => go(jobId, today)}>Today</Button>}
        <span className="sp" />
        {plan && <Button variant="quiet" chord="mod+p" onClick={() => window.print()}>Print</Button>}
      </div>
      <Failure text={error ?? actError} title="The plan did not load." />
      {!jobId ? <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'Pick your job', body: 'The day’s crew, tasks, deliveries, hazards and drawings come together here.' }} /></div> : plan && (
        <div className="cm-pkg">
          <DSection title={`Crew · ${plan.crew.length}`}>
            {plan.crew.length === 0 ? <p className="t-cap">Nobody is booked on this job this week. <Link className="link" href="/workforce">Workforce board</Link></p> : (
              <ul className="feed">{plan.crew.map((c) => <li key={c.employee_id}><span>{c.name ?? 'Crew member'}</span><span className="t">{words(c.role)}</span></li>)}</ul>
            )}
          </DSection>
          <DSection title={`Today's work · ${plan.tasks.length}`}>
            {plan.tasks.length === 0 ? <p className="t-cap">No tasks start or run today on the schedule. <Link className="link" href={`/jobs/${jobId}?tab=schedule`}>Open the lookahead</Link></p> : (
              <ul className="feed">{plan.tasks.map((t) => <li key={t.id}><span><span className="l1">{t.title}</span><span style={{ display: 'block' }}>{t.due_on ? `Due ${day(t.due_on, today)}` : ''}{t.pct_complete != null ? ` · ${pct(Number(t.pct_complete) > 1 ? Number(t.pct_complete) / 100 : Number(t.pct_complete))} done` : ''}</span></span><span className="t">{words(t.status)}</span></li>)}</ul>
            )}
          </DSection>
          <DSection title={`Materials · ${plan.deliveries.length}`}>
            {plan.deliveries.length === 0 ? <p className="t-cap">Nothing due on site today.</p> : (
              <ul className="feed">{plan.deliveries.map((d, i) => <li key={i}><span><span className="l1">{d.title}</span>{d.number && <span style={{ display: 'block' }}>{d.number}</span>}</span><span className="t">{d.delivered_on ? <Tag tone="pos">On site</Tag> : `Ships ${day(d.ship_on, today)}`}</span></li>)}</ul>
            )}
          </DSection>
          <DSection title="Hazards and pre-task plan" aside={<ButtonLink variant="quiet" href="/safety?tab=jha">{plan.jha.length ? 'Open the plans' : 'Write today’s plan'}</ButtonLink>}>
            {plan.jha.length === 0 ? <p className="t-cap" style={{ marginBottom: 8 }}><Tag tone="warn">No pre-task plan for today</Tag></p> : plan.jha.map((j) => (
              <div key={j.id} style={{ marginBottom: 8 }}>
                <p><b>{j.task}</b> {j.status === 'SIGNED' ? <Tag tone="pos">Signed</Tag> : <Tag tone="warn">Not signed</Tag>}</p>
                {j.steps.length > 0 && <p className="t-cap">{j.steps.map((s) => [s.step, s.hazard ?? (s.hazards ?? []).join(', ')].filter(Boolean).join(' — ')).join(' · ')}</p>}
                {j.ppe.length > 0 && <p className="t-cap">PPE: {j.ppe.join(', ')}</p>}
              </div>
            ))}
            {plan.hazards.length > 0 && <ul className="feed">{plan.hazards.map((h) => <li key={h.id}><span><span className="code">{h.number}</span> {h.title}</span><span className="t"><Tag tone={h.priority === 'CRITICAL' || h.priority === 'HIGH' ? 'neg' : 'warn'}>{words(h.priority)}</Tag></span></li>)}</ul>}
          </DSection>
          <DSection title="Drawings" aside={<ButtonLink variant="quiet" href={`/documents?job=${jobId}`}>All drawings</ButtonLink>}>
            {plan.sheets.length === 0 ? <p className="t-cap">No sheets on file for this job.</p> : <ul className="feed">{plan.sheets.map((s) => <li key={s.id}><span><span className="code">{s.sheet_number}</span> {s.title}</span></li>)}</ul>}
          </DSection>
          <DSection title="Yesterday's productivity">
            {plan.yesterday.length === 0 ? <p className="t-cap">No hours logged to measured cost codes yesterday.</p> : (
              <ul className="feed">{plan.yesterday.map((y, i) => (
                <li key={i}><span><span className="code">{y.cost_code}</span> {qty(y.earned_hours, 0)} earned / {qty(y.actual_hours, 0)} used</span>
                  <span className="t">{y.productivity_factor == null ? '—' : <span className={Number(y.productivity_factor) < 0.95 ? 'neg' : undefined}>{Number(y.productivity_factor).toFixed(2)}</span>}</span></li>
              ))}</ul>
            )}
          </DSection>
        </div>
      )}
      {jobId && plan && !readOnly && canLog && codes.length > 0 && (
        <section className="sec ops-noprint" aria-label="Installed today">
          <div className="sec-h"><h2 className="t-section">Installed today</h2><span className="t-cap ink-3">Feeds earned hours and the pay-app draft</span></div>
          <QuantityForm jobId={jobId} codes={codes} units={units} today={today} busy={busy} act={act} />
        </section>
      )}
    </div>
  );
}
