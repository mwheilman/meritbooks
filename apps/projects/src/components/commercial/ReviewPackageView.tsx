'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, InlineNotice, KV, Ledger, Select, Tag, Textarea, WidgetState, money } from '@meritbooks/merit-ui';
import type { ReviewContent, ReviewPackage } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

/**
 * A first draft of the PM's variance commentary from the package's own figures: the forecast
 * cost's move against last month and the cost codes furthest over budget. The PM edits it. Pure.
 */
export function draftCommentary(c: ReviewContent, fmt: (cents: number) => string = (x) => money(x, { decimals: 0 })): string {
  const out: string[] = [];
  const eac = c.eac;
  if (eac?.total_eac_cents != null && eac.prior_eac_cents != null) {
    const d = Number(eac.total_eac_cents) - Number(eac.prior_eac_cents);
    out.push(d === 0 ? 'Forecast cost at completion is unchanged from last month.' : `Forecast cost at completion is ${d > 0 ? 'up' : 'down'} ${fmt(Math.abs(d))} from last month${eac.reason_code ? ` (${words(eac.reason_code).toLowerCase()})` : ''}.`);
  }
  const over = (c.cost_codes ?? [])
    .map((r) => ({ code: String(r.cost_code ?? ''), name: String(r.cost_code_name ?? ''), v: num(r.variance_cents), budget: num(r.budget_cents), forecast: num(r.forecast_cents) }))
    .map((r) => ({ ...r, over: r.forecast != null && r.budget != null ? r.forecast - r.budget : r.v != null ? -r.v : null }))
    .filter((r) => r.over != null && r.over > 0)
    .sort((a, b) => (b.over ?? 0) - (a.over ?? 0))
    .slice(0, 3);
  for (const r of over) out.push(`${[r.code, r.name].filter(Boolean).join(' ')}: forecast ${fmt(r.over!)} over its budget of ${fmt(r.budget ?? 0)}.`);
  const ex = c.exposure;
  if (ex && Number(ex.pending_cents ?? 0) > 0) out.push(`${fmt(Number(ex.pending_cents))} of change orders pending with the owner${Number(ex.pending_over_30_cents ?? 0) > 0 ? `, ${fmt(Number(ex.pending_over_30_cents))} of it over 30 days` : ''}.`);
  const docs = c.documents;
  if (docs && (docs.rfis_overdue || docs.submittals_late)) out.push(`${docs.rfis_overdue} RFIs overdue and ${docs.submittals_late} submittals late to submit.`);
  if (c.safety && c.safety.recordables) out.push(`${c.safety.recordables} OSHA recordable ${c.safety.recordables === 1 ? 'case' : 'cases'} this month.`);
  return out.join('\n') || 'No significant variances this month.';
}

/**
 * The monthly project review package (CGC-111): job cost by cost code, the cost forecast with
 * commentary, the change-order log and exposure, buyout, billing and retainage, schedule,
 * document control and safety — built from the job as it stands at month end, submitted by the
 * PM and signed off by the project executive (never the same person).
 */
export function ReviewPackageView({ packages, jobs, periods, jobId, periodEnd, today, canBuild }: {
  packages: ReviewPackage[]; jobs: JobOption[]; periods: string[]; jobId: string | null; periodEnd: string; today: string; canBuild: boolean;
}) {
  const router = useRouter();
  const { readOnly } = useShell();
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const pkg = jobId ? packages.find((p) => p.job_id === jobId && p.period_end === periodEnd) ?? null : null;
  const [commentary, setCommentary] = useState(pkg?.pm_commentary ?? '');
  const go = (j: string | null, p: string) => router.push(`/project-review?period=${p}${j ? `&job=${j}` : ''}`);
  const edit = !readOnly && canBuild;
  const inPeriod = packages.filter((p) => p.period_end === periodEnd);

  const cols: Col<ReviewPackage>[] = [
    { key: 'j', head: 'Job', cell: (p) => <span className="b">{byJob.get(p.job_id)?.label ?? 'Job'}</span> },
    { key: 'p', head: 'Month', width: 110, cell: (p) => p.period_end.slice(0, 7) },
    { key: 's', head: 'Status', width: 130, cell: (p) => <Tag tone={p.status === 'SIGNED' ? 'pos' : p.status === 'SUBMITTED' ? 'warn' : undefined}>{p.status === 'SUBMITTED' ? 'Waiting on sign-off' : words(p.status)}</Tag> },
    { key: 'b', head: 'Built', width: 150, cell: (p) => (p.built_at ? stamp(p.built_at) : '—') },
    { key: 'g', head: 'Signed', width: 150, cell: (p) => (p.signed_at ? stamp(p.signed_at) : '—') },
  ];
  const c = pkg?.content ?? {};
  const f = c.financials ?? null;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-toolbar ops-noprint">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId ?? ''} onChange={(id) => go(id || null, periodEnd)} placeholder="Every job" /></Field>
        <Field label="Month ending"><Select value={periodEnd} onChange={(e) => go(jobId, e.target.value)}>{periods.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
        <span className="sp" />
        {pkg && <Button variant="quiet" onClick={() => window.print()}>Print</Button>}
        {edit && jobId && pkg?.status !== 'SIGNED' && <Button variant={pkg ? 'default' : 'primary'} disabled={busy !== null} onClick={() => void act('build', 'post', '/api/commercial/review-packages', { op: 'build', jobId, periodEnd, commentary: commentary.trim() || null }, pkg ? 'Rebuilt the package from the job' : 'Built the package')}>{busy === 'build' ? 'Building…' : pkg ? 'Rebuild from the job' : 'Build the package'}</Button>}
      </div>
      <Failure text={error} />
      {!jobId && (
        <>
          <CmTable label="Review packages" keys rows={inPeriod} cols={cols} rowKey={(p) => p.id} onOpen={(p) => go(p.job_id, p.period_end)}
            empty={{ title: `No packages for ${periodEnd.slice(0, 7)} yet`, body: 'Pick a job and build its package. It pins the month’s figures; the PM writes the commentary and submits; the project executive signs off.' }} />
          <TableKeys />
          {jobs.filter((j) => j.open && !inPeriod.some((p) => p.job_id === j.id)).length > 0 && <p className="t-cap">{jobs.filter((j) => j.open && !inPeriod.some((p) => p.job_id === j.id)).length} open jobs have no package for this month.</p>}
        </>
      )}
      {jobId && !pkg && <div className="mp-table"><WidgetState state={{ kind: 'empty', title: `No package for ${periodEnd.slice(0, 7)}`, body: edit ? 'Build it: the job cost, forecast, change orders, buyout, billing, schedule, document control and safety as they stand now.' : 'The PM has not built this month’s package yet.' }} /></div>}
      {jobId && pkg && (
        <>
          <div className="ops-facts">
            <span><Tag tone={pkg.status === 'SIGNED' ? 'pos' : pkg.status === 'SUBMITTED' ? 'warn' : undefined}>{words(pkg.status)}</Tag></span>
            <span>Built <b>{pkg.built_at ? stamp(pkg.built_at) : '—'}</b></span>
            {pkg.submitted_at && <span>Submitted <b>{stamp(pkg.submitted_at)}</b></span>}
            {pkg.signed_at && <span>Signed off <b>{stamp(pkg.signed_at)}</b></span>}
          </div>
          <div className="cm-pkg">
            {mv.cost && f && (
              <DSection title="Job cost">
                <Ledger rows={[
                  ...(mv.contract ? [{ label: 'Revised contract', value: cm(num(f.revised_contract_cents), 0) }] : []),
                  { label: 'Revised budget', value: cm(num(f.revised_budget_cents), 0) }, { label: 'Committed', value: cm(num(f.committed_cents), 0) },
                  { label: 'Actual cost', value: cm(num(f.actual_cost_cents), 0) }, { label: 'Projected final cost', value: cm(num(f.projected_final_cost_cents), 0) },
                  ...(mv.contract ? [{ label: 'Projected margin', value: cm(num(f.projected_margin_cents), 0) }, { label: 'Billed to date', value: cm(num(f.billed_to_date_cents), 0) }, { label: 'Over / (under) billed', value: cm(num(f.over_under_billing_cents), 0) }] : []),
                ]} />
              </DSection>
            )}
            {mv.cost && c.eac && (
              <DSection title="Cost forecast">
                <KV items={[
                  { term: 'Forecast at completion', value: cm(num(c.eac.total_eac_cents), 0) }, { term: 'Last month', value: cm(num(c.eac.prior_eac_cents), 0) },
                  { term: 'Change', value: c.eac.total_eac_cents != null && c.eac.prior_eac_cents != null ? money(Number(c.eac.total_eac_cents) - Number(c.eac.prior_eac_cents), { decimals: 0 }) : '—' },
                  { term: 'Status', value: words(c.eac.status) }, ...(c.eac.loss ? [{ term: 'Loss', value: <Tag tone="neg">Forecast at a loss</Tag> }] : []),
                ]} />
                {c.eac.commentary && <p className="t-cap" style={{ marginTop: 8 }}>{c.eac.commentary}</p>}
              </DSection>
            )}
            {c.exposure && mv.contract && (
              <DSection title="Change exposure">
                <KV items={[
                  { term: 'Approved', value: cm(num(c.exposure.approved_cents), 0) }, { term: 'Pending with the owner', value: cm(num(c.exposure.pending_cents), 0) },
                  { term: 'Pending over 30 days', value: cm(num(c.exposure.pending_over_30_cents), 0) }, { term: 'Unpriced changes', value: String(c.exposure.unpriced_count ?? 0) },
                  { term: 'Work proceeding unpriced', value: String(c.exposure.proceeding_count ?? 0) },
                ]} />
              </DSection>
            )}
            {c.schedule && (
              <DSection title="Schedule"><KV items={[{ term: 'Tasks', value: c.schedule.tasks }, { term: 'Done', value: c.schedule.done }, { term: 'Late at month end', value: c.schedule.late }]} /></DSection>
            )}
            {c.documents && (
              <DSection title="Document control"><KV items={[{ term: 'RFIs open', value: c.documents.rfis_open }, { term: 'RFIs overdue', value: c.documents.rfis_overdue }, { term: 'Submittals in review', value: c.documents.submittals_open }, { term: 'Submittals late', value: c.documents.submittals_late }]} /></DSection>
            )}
            {c.safety && <DSection title="Safety this month"><KV items={[{ term: 'Incidents', value: c.safety.incidents }, { term: 'OSHA recordable', value: c.safety.recordables }]} /></DSection>}
            {c.retainage && mv.contract && (
              <DSection title="Retainage"><KV items={[{ term: 'Receivable outstanding', value: cm(num(c.retainage.receivable_outstanding_cents as number | null), 0) }, ...(mv.cost ? [{ term: 'Payable outstanding', value: cm(num(c.retainage.payable_outstanding_cents as number | null), 0) }] : [])]} /></DSection>
            )}
          </div>
          {mv.cost && (c.cost_codes ?? []).length > 0 && (
            <DSection title="Cost by cost code">
              <CmTable label="Cost by cost code" rows={c.cost_codes ?? []} rowKey={(r) => `${String(r.cost_code_id ?? '')}|${String(r.cost_code ?? '')}|${String(r.cost_type ?? '')}`} cols={[
                { key: 'c', head: 'Cost code', cell: (r) => <><span className="code">{String(r.cost_code ?? '')}</span> {String(r.cost_code_name ?? '')}</> },
                { key: 'b', head: 'Budget', n: true, width: 120, cell: (r) => cm(num(r.budget_cents), 0) },
                { key: 'm', head: 'Committed', n: true, width: 120, cell: (r) => cm(num(r.committed_cents), 0) },
                { key: 'a', head: 'Actual', n: true, width: 120, cell: (r) => cm(num(r.actual_cents), 0) },
                { key: 'f', head: 'Forecast', n: true, width: 120, cell: (r) => cm(num(r.forecast_cents), 0) },
                { key: 'v', head: 'Variance', n: true, width: 120, cell: (r) => cm(num(r.variance_cents), 0) },
              ]} empty={{ title: 'No cost codes', body: '' }} />
            </DSection>
          )}
          {(c.change_orders ?? []).length > 0 && (
            <DSection title="Change-order log">
              <CmTable label="Change orders" rows={c.change_orders ?? []} rowKey={(r) => `${r.number}-${r.title}`} cols={[
                { key: 'n', head: 'Number', width: 100, cell: (r) => <span className="code">{r.number ?? '—'}</span> },
                { key: 't', head: 'Title', cell: (r) => r.title },
                { key: 's', head: 'Stage', width: 120, cell: (r) => words(r.stage) },
                { key: 'a', head: 'Amount', n: true, width: 120, hidden: !mv.contract, cell: (r) => cm(r.amount_cents, 0) },
                { key: 'c', head: 'Cost impact', n: true, width: 120, hidden: !mv.cost, cell: (r) => cm(r.cost_impact_cents, 0) },
              ]} empty={{ title: 'No change orders', body: '' }} />
            </DSection>
          )}
          {mv.contract && (c.billing ?? []).length > 0 && (
            <DSection title="Billing this month">
              <CmTable label="Billing" rows={c.billing ?? []} rowKey={(r) => `${r.application_no}-${r.period_end}-${r.status}`} cols={[
                { key: 'n', head: 'Application', width: 110, cell: (r) => (r.application_no ? `#${r.application_no}` : '—') },
                { key: 's', head: 'Status', width: 120, cell: (r) => words(r.status) },
                { key: 'g', head: 'Gross', n: true, width: 130, cell: (r) => cm(r.gross_earned_cents, 0) },
                { key: 'r', head: 'Retainage', n: true, width: 120, cell: (r) => cm(r.retainage_cents, 0) },
                { key: 'x', head: 'Net', n: true, width: 130, cell: (r) => cm(r.net_cents, 0) },
                { key: 'i', head: 'Invoice', width: 120, cell: (r) => r.invoice_number ?? '—' },
              ]} empty={{ title: 'No billing', body: '' }} />
            </DSection>
          )}
          <DSection title="Commentary" aside={edit && pkg.status === 'DRAFT' ? <Button variant="quiet" onClick={() => setCommentary(draftCommentary(c))}>Pre-write from the figures</Button> : undefined}>
            {pkg.status === 'DRAFT' && edit ? (
              <div className="stack" style={{ gap: 8 }}>
                <Textarea aria-label="PM commentary" value={commentary} onChange={(e) => setCommentary(e.target.value)} rows={6} maxLength={2000} placeholder="What moved this month and why; what you need from the PX." />
                <div className="row" style={{ gap: 8 }}>
                  <Button variant="primary" chord="mod+enter" bindChord disabled={busy !== null || !commentary.trim()} onClick={() => void act('submit', 'post', '/api/commercial/review-packages', { op: 'submit', packageId: pkg.id, commentary: commentary.trim() }, 'Submitted for sign-off')}>{busy === 'submit' ? 'Submitting…' : 'Submit for sign-off'}</Button>
                </div>
              </div>
            ) : <p style={{ whiteSpace: 'pre-wrap' }}>{pkg.pm_commentary ?? 'No commentary.'}</p>}
          </DSection>
          {pkg.status === 'SUBMITTED' && !readOnly && (
            <InlineNotice tone="info" title="Waiting on the project executive">
              The PM who submitted it cannot sign it. <Button variant="primary" disabled={busy !== null} onClick={() => void act('sign', 'post', '/api/commercial/review-packages', { op: 'sign', packageId: pkg.id }, 'Signed off the package')}>{busy === 'sign' ? 'Signing…' : 'Sign off'}</Button>
            </InlineNotice>
          )}
          <p className="t-cap">Figures as of {pkg.built_at ? stamp(pkg.built_at) : day(today)}; rebuilding refreshes them until it is signed.</p>
        </>
      )}
    </div>
  );
}
