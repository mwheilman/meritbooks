'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Drawer, Field, Figure, Input, Select, Tabs, Tag, Textarea, WidgetState, count, money } from '@meritbooks/merit-ui';
import { AUDIT_RULES, EAC_STATUS, pctText } from '@/lib/commercial/labels';
import type { AuditFinding, EacForecastRow, EacLineRow, WipRow } from '@/lib/commercial/types';
import { useShell } from '@/components/shell/ShellContext';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, cm, dollarsText, parseDollars } from './common';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'schedule' | 'eac' | 'audit' | 'summary';

export interface WipCompanyRows { companyId: string; companyName: string; rows: WipRow[]; error: string | null }
export interface ExecutiveSummary {
  jobs: number; contract_cents: number; billed_cents: number; earned_cents: number; backlog_cents: number; over_billed_cents: number; under_billed_cents: number;
  projected_margin_cents: number; retainage_receivable_cents: number; retainage_payable_cents: number;
  exposure: { approved_cents: number; pending_cents: number; pending_over_30_cents: number; unpriced_count: number; unpriced_rom_cents: number | null; proceeding_count: number; owner_co_without_sub_co_cents: number };
  fades: Array<{ job_id: string; period_end: string; gp_pct: number | null; fade_gain_pts: number | null; contract_cents: number | null }>;
  document_control: { rfis_overdue: number; submittals_late: number };
  billing: { pencils: number; sub_pay_apps_in_review: number; compliance_holds: number };
  forecasts: { submitted: number; late: number; loss_jobs: number };
}

const REASONS = [['SCOPE_GAP', 'Scope gap / owner change'], ['PRODUCTIVITY', 'Labor productivity'], ['BUYOUT', 'Buyout result'], ['MATERIAL_PRICE', 'Material price'], ['ESTIMATE_ERROR', 'Estimate error'],
  ['SCHEDULE', 'Schedule / acceleration'], ['CLAIM', 'Claim or backcharge'], ['OTHER', 'Other']] as const;

/**
 * Work in progress, CFMA layout (CGC-28, CGC-30, CGC-53..55, CGC-111): earned on cost-to-cost against the approved
 * forecast, over / under billing, gross profit and its fade against last month, backlog and
 * loss provision. Where Merit Books has posted the period's WIP run, its numbers win and the
 * row says so. Below: the month's cost forecasts (the PM prepares, an executive approves), the
 * billing auditor, and the executive roll-up.
 */
export function WipView({ companies, forecasts, audit, summary, periodEnd, periods, jobLabels, today, initialTab, initialForecast }: {
  companies: WipCompanyRows[]; forecasts: EacForecastRow[]; audit: AuditFinding[]; summary: ExecutiveSummary | null; periodEnd: string; periods: string[];
  jobLabels: Readonly<Record<string, string>>; today: string; initialTab?: Tab; initialForecast?: string | null;
}) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'schedule');
  const [openId, setOpenId] = useState<string | null>(initialForecast ?? null);
  const all = companies.flatMap((c) => c.rows);
  const tot = (k: keyof WipRow) => all.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const fcByJob = useMemo(() => new Map(forecasts.map((f) => [f.job_id, f])), [forecasts]);
  const highAudit = audit.filter((a) => a.severity === 'HIGH').length;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-toolbar">
        <Field label="Period ending"><Select value={periodEnd} onChange={(e) => router.push(`/wip?period=${e.target.value}&tab=${tab}`)}>{periods.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
        <span className="sp" />
        {all.some((r) => r.source === 'BOOKS_PINNED') && <Tag tone="pos">Includes Merit Books’ posted WIP</Tag>}
      </div>
      <Tabs aria-label="WIP views" value={tab} onChange={setTab} items={[
        { value: 'schedule', label: 'WIP schedule', count: all.length },
        { value: 'eac', label: 'Cost forecasts', count: forecasts.filter((f) => f.status === 'SUBMITTED').length || undefined },
        { value: 'audit', label: 'Billing auditor', count: audit.length || undefined },
        { value: 'summary', label: 'Executive view' },
      ]} />
      <Failure text={error} />

      {tab === 'schedule' && (
        <>
          <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Figure dense label="Earned to date" value={money(tot('earned_cents'), { decimals: 0 })} vs={[`${money(tot('billed_cents'), { decimals: 0 })} billed`, `${money(tot('contract_cents'), { decimals: 0 })} contract`]} href="/billing" linkLabel="Billing" />
            <Figure dense label="Over billed" value={money(tot('over_billed_cents'), { decimals: 0 })} vs={[`${money(tot('under_billed_cents'), { decimals: 0 })} under billed`]} href="/billing" linkLabel="Billing" />
            <Figure dense label="Backlog" value={money(tot('backlog_cents'), { decimals: 0 })} vs={[`${money(tot('gp_cents'), { decimals: 0 })} gross profit at completion`]} href="/job-cost" linkLabel="Job cost" />
            <Figure dense label="Loss provision" value={money(tot('loss_provision_cents'), { decimals: 0 })} vs={[`${count(all.filter((r) => Number(r.loss_provision_cents ?? 0) > 0).length)} jobs forecast at a loss`]} href="/wip?tab=eac" linkLabel="Forecasts" />
          </div>
          {companies.map((c) => (
            <section key={c.companyId} className="sec" aria-label={`${c.companyName} WIP`}>
              <div className="sec-h" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <h2 className="t-section">{c.companyName}</h2><span style={{ flex: 1 }} />
                {c.rows.length > 0 && c.rows.every((r) => r.pinned) && <Tag>Pinned</Tag>}
                {!readOnly && c.rows.length > 0 && <Button disabled={busy !== null} onClick={() => void act<{ pinned: number }>(`pin${c.companyId}`, 'post', '/api/commercial/wip', { companyId: c.companyId, periodEnd }, (r) => `Pinned ${count(r.pinned)} jobs for ${periodEnd}`)}>
                  {busy === `pin${c.companyId}` ? 'Pinning…' : c.rows.some((r) => r.pinned) ? 'Pin again (revision)' : 'Pin the period'}
                </Button>}
              </div>
              {c.error ? <Failure text={c.error} title="WIP did not load." /> : c.rows.length === 0 ? <p className="t-cap">No active contracts in this period.</p> : (
                <div className="mp-table" style={{ overflowX: 'auto' }}>
                  <table className="tbl tbl-q tbl-q--compact">
                    <thead><tr>
                      <th>Job</th><th className="n">Contract</th><th className="n">Forecast cost</th><th className="n">Cost to date</th><th className="n">Complete</th><th className="n">Earned</th>
                      <th className="n">Billed</th><th className="n">Over</th><th className="n">Under</th><th className="n">GP %</th><th className="n">Fade</th><th className="n">Backlog</th><th>Forecast</th>
                    </tr></thead>
                    <tbody>{c.rows.map((r) => (
                      <tr key={r.job_id} className="q-row">
                        <td><Link className="nlink" href={`/jobs/${r.job_id}?tab=money`}>{[r.job_number, r.job_name].filter(Boolean).join(' · ')}</Link>{r.source === 'BOOKS_PINNED' && <span className="ops-sub" style={{ display: 'block' }}>Merit Books posted</span>}</td>
                        <td className="n">{cm(r.contract_cents, 0)}</td><td className="n">{cm(r.eac_cents, 0)}</td><td className="n">{cm(r.cost_to_date_cents, 0)}</td>
                        <td className="n">{pctText(r.pct_complete == null ? null : Number(r.pct_complete), 1)}</td><td className="n">{cm(r.earned_cents, 0)}</td><td className="n">{cm(r.billed_cents, 0)}</td>
                        <td className="n">{Number(r.over_billed_cents ?? 0) ? cm(r.over_billed_cents, 0) : '—'}</td><td className="n">{Number(r.under_billed_cents ?? 0) ? cm(r.under_billed_cents, 0) : '—'}</td>
                        <td className="n">{pctText(r.gp_pct == null ? null : Number(r.gp_pct), 1)}</td>
                        <td className="n">{r.fade_gain_pts == null ? '—' : <span style={{ color: Number(r.fade_gain_pts) < -1 ? 'var(--neg)' : undefined }}>{Number(r.fade_gain_pts) > 0 ? '+' : ''}{Number(r.fade_gain_pts).toFixed(1)} pts</span>}</td>
                        <td className="n">{cm(r.backlog_cents, 0)}</td>
                        <td>{r.eac_status ? <Mk map={EAC_STATUS} status={r.eac_status} /> : <span className="t-cap">Budget</span>}</td>
                      </tr>
                    ))}</tbody>
                    <tfoot><tr className="q-row b">
                      <td>Total</td>
                      {(['contract_cents', 'eac_cents', 'cost_to_date_cents'] as const).map((k) => <td key={k} className="n">{money(c.rows.reduce((s, r) => s + Number(r[k] ?? 0), 0), { decimals: 0 })}</td>)}
                      <td />
                      {(['earned_cents', 'billed_cents', 'over_billed_cents', 'under_billed_cents'] as const).map((k) => <td key={k} className="n">{money(c.rows.reduce((s, r) => s + Number(r[k] ?? 0), 0), { decimals: 0 })}</td>)}
                      <td /><td /><td className="n">{money(c.rows.reduce((s, r) => s + Number(r.backlog_cents ?? 0), 0), { decimals: 0 })}</td><td />
                    </tr></tfoot>
                  </table>
                </div>
              )}
            </section>
          ))}
          <p className="t-cap">Earned = percent complete (cost to date over forecast cost, uninstalled material excluded) × contract. A job forecast at a loss carries the full loss now. Pinning keeps the rows exactly as printed for the period.</p>
        </>
      )}

      {tab === 'eac' && (
        <section className="sec" aria-label="Cost forecasts">
          <p className="t-cap" style={{ marginBottom: 12 }}>Each month the project manager forecasts the cost to complete by cost code; an executive who did not prepare it approves it. The approved forecast drives earned revenue here and is sent to Merit Books.</p>
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Job</th><th style={{ width: 150 }}>Status</th><th className="n" style={{ width: 140 }}>Forecast cost</th><th className="n" style={{ width: 140 }}>Last month</th><th className="n" style={{ width: 120 }}>Change</th><th style={{ width: 200 }} /></tr></thead>
              <tbody>{all.map((r) => {
                const f = fcByJob.get(r.job_id);
                const delta = f?.total_eac_cents != null && f.prior_eac_cents != null ? Number(f.total_eac_cents) - Number(f.prior_eac_cents) : null;
                return (
                  <tr key={r.job_id} className="q-row">
                    <td>{jobLabels[r.job_id] ?? [r.job_number, r.job_name].filter(Boolean).join(' · ')}{f?.loss_flag && <> <Tag tone="neg">Loss</Tag></>}</td>
                    <td>{f ? <Mk map={EAC_STATUS} status={f.status} /> : <span className="t-cap">Not started</span>}</td>
                    <td className="n">{cm(f?.total_eac_cents ?? null, 0)}</td><td className="n">{cm(f?.prior_eac_cents ?? null, 0)}</td>
                    <td className="n">{delta == null ? '—' : `${delta > 0 ? '+' : ''}${money(delta, { decimals: 0 })}`}</td>
                    <td>{f ? <Button variant="quiet" onClick={() => setOpenId(f.id)}>Open</Button>
                      : !readOnly && <Button variant="quiet" disabled={busy !== null} onClick={async () => { const x = await act<{ id: string }>(`start${r.job_id}`, 'post', '/api/commercial/eac', { jobId: r.job_id, periodEnd }, 'Started the forecast'); if (x) setOpenId(x.id); }}>Start forecast</Button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'audit' && (
        <section className="sec" aria-label="Billing auditor">
          {audit.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing for the auditor to flag', body: 'Before each cutoff the auditor checks for approved changes not on the schedule of values, signed T&M not billed, stored material not billed, retainage ready to bill, over and under billing, and subs approved ahead of owner billing.' }} /> : (
            <div className="mp-table">
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th style={{ width: 90 }}>Severity</th><th>Finding</th><th>Job</th><th className="n" style={{ width: 130 }}>Amount</th><th>Fix</th></tr></thead>
                <tbody>{[...audit].sort((a, b) => (a.severity === 'HIGH' ? 0 : a.severity === 'MEDIUM' ? 1 : 2) - (b.severity === 'HIGH' ? 0 : b.severity === 'MEDIUM' ? 1 : 2)).map((a, i) => (
                  <tr key={`${a.rule}:${a.ref_id ?? i}:${a.job_id ?? ''}`} className="q-row">
                    <td>{a.severity === 'HIGH' ? <Tag tone="neg">High</Tag> : a.severity === 'MEDIUM' ? <Tag tone="warn">Medium</Tag> : <Tag>Low</Tag>}</td>
                    <td><span className="b">{AUDIT_RULES[a.rule] ?? a.title}</span>{a.detail && <span className="ops-sub" style={{ display: 'block' }}>{a.detail}</span>}</td>
                    <td>{a.job_id ? <Link className="nlink" href={`/jobs/${a.job_id}?tab=billing`}>{jobLabels[a.job_id] ?? 'Job'}</Link> : '—'}</td>
                    <td className="n">{cm(a.amount_cents, 0)}</td><td>{a.fix ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {highAudit > 0 && <p className="t-cap" style={{ marginTop: 8 }}>{count(highAudit)} high-severity findings: fix these before the pencil goes out.</p>}
        </section>
      )}

      {tab === 'summary' && (summary ? <Executive s={summary} jobLabels={jobLabels} /> : <WidgetState state={{ kind: 'empty', title: 'The executive view needs job financials access', body: 'Ask an owner for Job financials on this company.' }} />)}

      <Drawer open={!!openId} onClose={() => setOpenId(null)} width={720} title="Cost forecast" eyebrow={openId ? [jobLabels[forecasts.find((f) => f.id === openId)?.job_id ?? ''] ?? 'Job', periodEnd] : undefined}>
        {openId && <ForecastDetail id={openId} version={version} readOnly={readOnly} busy={busy} act={act} today={today} />}
      </Drawer>
    </div>
  );
}

function Executive({ s, jobLabels }: { s: ExecutiveSummary; jobLabels: Readonly<Record<string, string>> }) {
  const m0 = (v: number | null | undefined) => money(Number(v ?? 0), { decimals: 0 });
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Figure label="Contract value" value={m0(s.contract_cents)} vs={[`${count(s.jobs)} jobs`, `${m0(s.backlog_cents)} backlog`]} href="/wip" linkLabel="WIP schedule" />
        <Figure label="Projected margin" value={m0(s.projected_margin_cents)} vs={[`${m0(s.earned_cents)} earned`, `${m0(s.billed_cents)} billed`]} href="/insights" linkLabel="Margin by job" />
        <Figure label="Net over / under" value={m0(s.over_billed_cents - s.under_billed_cents)} vs={[`${m0(s.over_billed_cents)} over`, `${m0(s.under_billed_cents)} under`]} href="/wip" linkLabel="WIP schedule" />
        <Figure label="Retainage" value={m0(s.retainage_receivable_cents)} vs={[`${m0(s.retainage_payable_cents)} owed to subs`]} href="/retainage" linkLabel="Retainage" />
      </div>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Figure dense label="Changes with the owner" value={m0(s.exposure.pending_cents)} vs={[`${m0(s.exposure.pending_over_30_cents)} over 30 days`, `${count(s.exposure.proceeding_count)} proceeding unpriced`]} href="/change-events" linkLabel="Change events" />
        <Figure dense label="Document control" value={count(s.document_control.rfis_overdue + s.document_control.submittals_late)} vs={[`${count(s.document_control.rfis_overdue)} RFIs overdue`, `${count(s.document_control.submittals_late)} submittals late`]} href="/rfis" linkLabel="RFIs" />
        <Figure dense label="Billing in flight" value={count(s.billing.pencils)} vs={[`${count(s.billing.sub_pay_apps_in_review)} sub pay apps in review`, `${count(s.billing.compliance_holds)} payment holds`]} href="/compliance" linkLabel="Compliance" />
        <Figure dense label="Forecasts" value={count(s.forecasts.submitted)} vs={[`${count(s.forecasts.late)} late`, `${count(s.forecasts.loss_jobs)} jobs at a loss`]} href="/wip?tab=eac" linkLabel="Forecasts" />
      </div>
      <DSection title="Profit fade">
        {s.fades.length === 0 ? <p className="t-cap">No job lost more than a point of gross profit at the last pinned period.</p> : (
          <table className="ops-mini"><thead><tr><th>Job</th><th>Period</th><th className="n">GP %</th><th className="n">Fade</th><th className="n">Contract</th></tr></thead>
            <tbody>{s.fades.map((f) => <tr key={`${f.job_id}:${f.period_end}`}><td>{jobLabels[f.job_id] ?? 'Job'}</td><td>{f.period_end}</td><td className="n">{pctText(f.gp_pct == null ? null : Number(f.gp_pct), 1)}</td><td className="n">{f.fade_gain_pts == null ? '—' : `${Number(f.fade_gain_pts).toFixed(1)} pts`}</td><td className="n">{cm(f.contract_cents, 0)}</td></tr>)}</tbody>
          </table>
        )}
      </DSection>
    </div>
  );
}

function ForecastDetail({ id, version, readOnly, busy, act, today }: { id: string; version: number; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const d = useDetail<{ forecast: EacForecastRow; lines: EacLineRow[] }>(`/api/commercial/eac/${id}`, version);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string>('SCOPE_GAP');
  const [commentary, setCommentary] = useState('');
  const [uninstalled, setUninstalled] = useState('');
  const [note, setNote] = useState('');
  if (!d.data) return d.error ? <Failure text={d.error} title="The forecast did not load." /> : <WidgetState state={{ kind: 'loading', label: 'Loading the forecast…', lines: 6 }} />;
  const { forecast: f, lines } = d.data;
  const url = `/api/commercial/eac/${id}`;
  const draft = f.status === 'DRAFT' || f.status === 'REJECTED';
  const dirty = Object.keys(edits).length > 0;
  const moved = f.prior_eac_cents != null && f.total_eac_cents != null && Number(f.total_eac_cents) !== Number(f.prior_eac_cents);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={EAC_STATUS} status={f.status} /></span>
        <span>Forecast cost <b>{cm(f.total_eac_cents, 0)}</b></span>
        <span>Last month <b>{cm(f.prior_eac_cents, 0)}</b></span>
        <span>Contract <b>{cm(f.contract_cents, 0)}</b></span>
        {f.loss_flag && <span><Tag tone="neg">Forecast at a loss</Tag></span>}
        {f.due_on && draft && <span>Due <b>{f.due_on}</b>{f.due_on < today && <> <Tag tone="neg">Late</Tag></>}</span>}
      </div>
      {f.rejected_reason && <Failure title="Sent back." text={f.rejected_reason} />}
      <div style={{ overflowX: 'auto' }}>
        <table className="ops-mini">
          <thead><tr><th>Cost code</th><th className="n">Budget</th><th className="n">Committed</th><th className="n">Actual</th><th className="n">Cost to complete</th><th className="n">Forecast</th><th className="n">Last month</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id}>
              <td>{l.cost_code ? <span className="code">{l.cost_code}</span> : null} {l.cost_code_name ?? 'Uncoded'}</td>
              <td className="n">{cm(l.budget_cents, 0)}</td><td className="n">{cm(l.committed_cents, 0)}</td><td className="n">{cm(l.actual_cents, 0)}</td>
              <td className="n">{draft && !readOnly
                ? <Input aria-label={`Cost to complete for ${l.cost_code ?? 'line'}`} inputMode="decimal" value={edits[l.id] ?? dollarsText(l.ctc_cents)} onChange={(e) => setEdits({ ...edits, [l.id]: e.target.value })} style={{ width: 120, textAlign: 'right' }} />
                : cm(l.ctc_cents, 0)}</td>
              <td className="n b">{cm(l.eac_cents, 0)}</td><td className="n">{cm(l.prior_eac_cents, 0)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {draft && !readOnly && dirty && (
        <div><Button variant="primary" disabled={busy !== null} onClick={async () => {
          for (const [lineId, text] of Object.entries(edits)) {
            const c = parseDollars(text);
            if (c === null) continue;
            const ok = await act(`l${lineId}`, 'post', url, { op: 'line', lineId, ctcCents: c, commentary: null }, '');
            if (!ok) return;
          }
          setEdits({});
        }}>Save cost to complete</Button></div>
      )}
      {draft && !readOnly && (
        <DSection title="Submit for approval">
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Why it moved"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select></Field>
            <Field label="Uninstalled material ($)" help="Excluded from percent complete."><Input inputMode="decimal" value={uninstalled} onChange={(e) => setUninstalled(e.target.value)} style={{ width: 130 }} /></Field>
          </div>
          <Field label="Commentary" help={moved ? 'Required: the forecast moved from last month.' : undefined}><Textarea value={commentary} onChange={(e) => setCommentary(e.target.value)} maxLength={2000} placeholder="What changed, what you are doing about it." /></Field>
          <Button variant="primary" disabled={busy !== null || dirty} onClick={() => void act('submit', 'post', url, { op: 'submit', reasonCode: reason, commentary: commentary.trim() || null, uninstalledCents: uninstalled.trim() ? parseDollars(uninstalled) : null, inefficiencyCents: null }, 'Submitted for approval')}>
            {busy === 'submit' ? 'Submitting…' : 'Submit'}
          </Button>
        </DSection>
      )}
      {f.status === 'SUBMITTED' && !readOnly && (
        <DSection title="Approve">
          {f.commentary && <p style={{ whiteSpace: 'pre-wrap' }}>{f.commentary}</p>}
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Required to send it back" /></Field>
          <Actions busy={busy} items={[
            { key: 'approve', label: 'Approve and send to Merit Books', primary: true, onClick: () => void act('approve', 'post', url, { op: 'decide', approve: true, note: note.trim() || null }, 'Approved; the forecast now drives WIP') },
            { key: 'reject', label: 'Send back', onClick: () => { if (note.trim()) void act('reject', 'post', url, { op: 'decide', approve: false, note: note.trim() }, 'Sent back to the project manager'); } },
          ]} />
        </DSection>
      )}
    </div>
  );
}
