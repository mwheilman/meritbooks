'use client';

import { Button, ButtonLink, Figure, QueueTable, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { CompanyKpis, OwnerDashboard as Data } from '@/app/api/residential/dashboard/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

type Cash = { jobs: Array<{ job_id: string; job_number: string; name: string; cash_position_cents: number; cost_incurred_cents: number; cash_collected_cents: number; negative: boolean; why: string | null }>; negative: number } | null;

/**
 * Owner dashboard (RES-123): backlog in dollars and months, sold vs target, close rate, AR and
 * cash, jobs at risk, unbilled work, margin by PM and job type, warranty — per company, rolled up.
 */
export function OwnerDashboard({ companyId }: { companyId: string | null }) {
  const { readOnly } = useShell();
  const b = useBoard<Data & { cashPositions: Cash }>(`/api/residential/dashboard${companyId ? `?company=${companyId}` : ''}`);
  const { run, busy, error } = useDo(b.reload);
  const state = <BoardState b={b} what="Owner dashboard" />;
  if (!b.data) return state;
  const d = b.data;
  const t = d.total;
  const cols: QueueColumn<CompanyKpis>[] = [
    { id: 'c', header: 'Company', cell: (c) => <span className="l1">{c.company ?? 'Company'}</span> },
    { id: 'b', header: 'Backlog', numeric: true, width: 130, cell: (c) => money(c.backlog_cents, { decimals: 0 }) },
    { id: 'm', header: 'Months', numeric: true, width: 80, cell: (c) => (c.backlog_months == null ? '—' : qty(c.backlog_months)) },
    { id: 's', header: 'Sold (12 mo)', numeric: true, width: 130, cell: (c) => money(c.sold_12m_cents, { decimals: 0 }) },
    { id: 't', header: 'vs target', numeric: true, width: 90, cell: (c) => pctText(c.sold_vs_target_pct, 0) },
    { id: 'r', header: 'Close rate', numeric: true, width: 90, cell: (c) => pctText(c.close_rate, 0) },
    { id: 'a', header: 'Open AR', numeric: true, width: 120, cell: (c) => money(c.open_ar_cents, { decimals: 0 }) },
    { id: 'u', header: 'Unbilled', numeric: true, width: 120, cell: (c) => money(c.unbilled_work_cents, { decimals: 0 }) },
    { id: 'k', header: 'At risk', numeric: true, width: 80, cell: (c) => (c.jobs_at_risk > 0 ? <Status kind="risk" pip="risk">{count(c.jobs_at_risk)}</Status> : '0') },
  ];
  const one = d.companies.length === 1 ? d.companies[0]! : null;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="dl-strip">
        <Figure label="Backlog" value={money(Number(t.backlog_cents ?? 0), { decimals: 0 })} vs={[`${count(d.companies.length)} compan${d.companies.length === 1 ? 'y' : 'ies'}`, one?.backlog_months != null ? `${qty(one.backlog_months)} months of work` : 'contract not yet billed']} href="/jobs" linkLabel="Jobs" />
        <Figure label="Sold, last 12 months" value={money(Number(t.sold_12m_cents ?? 0), { decimals: 0 })} vs={[t.sales_target_cents ? `target ${money(Number(t.sales_target_cents), { decimals: 0 })}` : 'no target set', `close rate ${pctText(t.close_rate, 0)}`]} href="/leads" linkLabel="Leads" />
        <Figure label="Open AR" value={money(Number(t.open_ar_cents ?? 0), { decimals: 0 })} vs={[t.cash_cents != null ? `cash ${money(Number(t.cash_cents), { decimals: 0 })}` : 'cash from Books', `unbilled ${money(Number(t.unbilled_work_cents ?? 0), { decimals: 0 })}`]} href="/billing" linkLabel="Billing" />
        <Figure label="Jobs at risk" value={count(Number(t.jobs_at_risk ?? 0))} vs={['margin fading or cash-negative', `${count(Number(t.open_warranty_items ?? 0))} open warranty items`]} href="/job-cost" linkLabel="Job cost" />
      </div>
      <Section title="By company" meta={`As of ${new Date(d.as_of).toLocaleString('en-US')}`} actions={companyId && !readOnly ? <span className="btn-row">
        <Button disabled={busy === 'scan'} onClick={() => run('scan', '/api/residential/dashboard', { op: 'scan', companyId }, 'Scanned every active job')}>Scan job health now</Button>
        <ButtonLink variant="quiet" href={`/api/residential/export?company=${companyId}`}>Export everything</ButtonLink></span> : null}>
        {d.companies.length === 0 ? <Empty title="No company with job financials" body="The dashboard shows companies where you hold job financials." /> :
          <div className="mp-table"><QueueTable aria-label="Companies" columns={cols} rows={d.companies} getRowId={(c) => c.location_id} rowState={(c) => ({ attn: c.jobs_at_risk > 0 })} /></div>}
      </Section>
      {one && (
        <div className="ops-split">
          <Section title="Margin by project manager">
            <table className="ops-mini" aria-label="Margin by PM"><thead><tr><th>PM</th><th className="n">Jobs</th><th className="n">Contract</th><th className="n">Margin</th></tr></thead>
              <tbody>{one.margin_by_pm.map((m) => <tr key={m.pm}><td>{m.pm}</td><td className="n">{count(m.jobs)}</td><td className="n">{money(m.revised_contract_cents, { decimals: 0 })}</td><td className="n">{pctText(m.projected_margin_pct)}</td></tr>)}</tbody></table>
          </Section>
          <Section title="Margin by job type">
            <table className="ops-mini" aria-label="Margin by job type"><thead><tr><th>Job type</th><th className="n">Jobs</th><th className="n">Contract</th><th className="n">Margin</th></tr></thead>
              <tbody>{one.margin_by_job_type.map((m) => <tr key={m.job_type}><td>{m.job_type}</td><td className="n">{count(m.jobs)}</td><td className="n">{money(m.revised_contract_cents, { decimals: 0 })}</td><td className="n">{pctText(m.projected_margin_pct)}</td></tr>)}</tbody></table>
          </Section>
        </div>
      )}
      {d.cashPositions && (
        <Section title="Job cash position" meta={`${count(d.cashPositions.negative)} cash-negative`}>
          {d.cashPositions.jobs.length === 0 ? <Empty title="No active jobs" body="Active jobs show here with cash collected against cost incurred." /> :
            <table className="ops-mini" aria-label="Job cash position"><thead><tr><th>Job</th><th className="n">Collected</th><th className="n">Cost</th><th className="n">Position</th><th>Why</th></tr></thead>
              <tbody>{d.cashPositions.jobs.map((j) => <tr key={j.job_id}><td><a href={`/homes/${j.job_id}/money`}>{j.job_number} · {j.name}</a></td><td className="n">{money(j.cash_collected_cents, { decimals: 0 })}</td>
                <td className="n">{money(j.cost_incurred_cents, { decimals: 0 })}</td><td className={`n${j.negative ? ' neg' : ''}`}>{money(j.cash_position_cents, { decimals: 0 })}</td><td className="l2">{j.why ?? ''}</td></tr>)}</tbody></table>}
        </Section>
      )}
    </div>
  );
}
