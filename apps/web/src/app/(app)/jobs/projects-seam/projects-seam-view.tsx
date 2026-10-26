'use client';

import { useState } from 'react';
import { Button, InlineNotice, KV, Page, PageHead, Tag, money, toast, useQuery } from '@meritbooks/merit-ui';
import type { SeamStatus } from '@/lib/projects-seam/status';

const TYPE_LABEL: Record<string, string> = {
  JOB_BILLING: 'Billing', JOB_DEPOSIT_REQUEST: 'Deposit requests', JOB_PROGRESS: 'Progress (WIP)', JOB_COMMITMENT: 'Commitments (job POs)',
  JOB_TIME: 'Approved time', DEPT_INVOICE_ISSUE: 'Internal invoices', JOB_MATERIAL: 'Materials', JOB_PAYABLE_REQUEST: 'Payable requests',
};
const THREE_WAY: Record<string, string> = {
  OVER_COMMITTED: 'Billed more than committed', BILLED_OVER_RECEIVED: 'Billed more than received', NO_RECEIPT: 'Nothing received yet',
};

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }} aria-label={title}>
      <p className="eyebrow" style={{ marginBottom: 8 }}>{n} // {title}</p>
      {children}
    </section>
  );
}

export function ProjectsSeamView() {
  const { data, error, isLoading, refetch } = useQuery<SeamStatus>('/api/projects-seam/status');
  const [busy, setBusy] = useState<string | null>(null);

  const allocate = async (runId: string) => {
    setBusy(runId);
    try {
      const res = await fetch('/api/projects-seam/labor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'allocate', payroll_run_id: runId }) });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Allocation failed');
      toast('Payroll labor allocated to jobs');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Allocation failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHead eyebrow={['Jobs', 'Merit Projects']} title="Merit Projects in Books">
        What Projects sent — billing, deposits, commitments, approved time, progress — and what Books booked from it.
      </PageHead>

      {isLoading && !data && <p aria-busy="true">Loading…</p>}
      {error && <InlineNotice tone="neg" title="This page did not load.">{error} <button type="button" className="link" onClick={() => void refetch()}>Try again</button></InlineNotice>}
      {data && !data.projectsEnabled && (
        <InlineNotice title="This organization does not use Merit Projects.">
          Books runs on its own: jobs, purchase orders, job costing and payroll all work here directly. Nothing on this page applies.
        </InlineNotice>
      )}

      {data?.projectsEnabled && (
        <>
          <Section n="01" title="Messages from Projects">
            {data.events.length === 0
              ? <InlineNotice title="Everything Projects sent is processed.">Nothing is waiting, nothing was rejected — the close is not held up by Projects.</InlineNotice>
              : (
                <>
                  <InlineNotice tone="warn" title="Some messages are not processed yet.">Messages dated in a month block that month’s hard close until they are processed or fixed in Projects and re-sent.</InlineNotice>
                  <table className="tbl" style={{ marginTop: 12 }}>
                    <thead><tr><th>Kind</th><th className="n">Waiting</th><th className="n">Rejected</th><th>Oldest waiting</th></tr></thead>
                    <tbody>
                      {data.events.map((e) => (
                        <tr key={e.eventType}>
                          <td>{TYPE_LABEL[e.eventType] ?? e.eventType}</td>
                          <td className="n tnum">{e.pending}</td>
                          <td className="n tnum">{e.rejected}</td>
                          <td>{e.oldestPendingAt ? e.oldestPendingAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.rejected.length > 0 && (
                    <ul style={{ marginTop: 12, display: 'grid', gap: 6, listStyle: 'none', padding: 0 }} aria-label="Rejected messages">
                      {data.rejected.map((r) => (
                        <li key={r.id}><Tag tone="neg">{r.errorCode ?? 'REJECTED'}</Tag> {TYPE_LABEL[r.eventType] ?? r.eventType} · {r.occurredOn} — {r.error?.replace(/^[A-Z_]+:\s*/, '') ?? 'Rejected'}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
          </Section>

          <Section n="02" title="Commitments (job purchase orders)">
            <KV items={[
              { term: 'Open commitments', value: data.commitments.active },
              { term: 'On payment hold', value: data.commitments.onHold },
              { term: 'Committed (open)', value: money(data.commitments.committedCents) },
              { term: 'Bills matched to commitments', value: money(data.commitments.matchedCents) },
              { term: 'Closed / void', value: data.commitments.retired },
            ]} />
            <p style={{ fontSize: 12, marginTop: 8 }}>Projects owns job purchase orders for this organization. Vendor bills for a job are matched to the commitment automatically when there is one clear line, otherwise from the bill.</p>
            {data.billsOnCommitmentHold.length > 0 && (
              <InlineNotice tone="warn" title={`${data.billsOnCommitmentHold.length} bill(s) on a commitment payment hold.`}>
                {data.billsOnCommitmentHold.map((b) => `${b.billNumber ?? 'Bill'} (${money(b.totalCents)})`).join(', ')} — released automatically when Projects lifts the hold.
              </InlineNotice>
            )}
            {data.threeWayWarnings.length > 0 && (
              <ul style={{ marginTop: 12, display: 'grid', gap: 6, listStyle: 'none', padding: 0 }} aria-label="Three-way match warnings">
                {data.threeWayWarnings.map((w) => (
                  <li key={w.billLineId}><Tag tone="warn">{THREE_WAY[w.status] ?? w.status}</Tag> {w.commitmentNumber ?? 'Commitment'} · over by {money(w.varianceCents)} · <a className="link" href={`/bills?bill=${w.billId}`}>Open the bill</a></li>
                ))}
              </ul>
            )}
          </Section>

          <Section n="03" title="Job labor from payroll">
            <KV items={[
              { term: 'Approved hours waiting for payroll', value: data.labor.hoursAwaitingPayroll.toFixed(2) },
              { term: 'Time entries waiting', value: data.labor.entriesAwaitingPayroll },
              { term: 'Entries with no Books employee', value: data.labor.entriesWithoutEmployee },
              { term: 'Estimated at standard rate (open)', value: money(data.labor.accruedOpenCents) },
              { term: 'Withdrawn after payroll (needs a reclass)', value: data.labor.withdrawnAfterPayroll },
            ]} />
            <p style={{ fontSize: 12, marginTop: 8 }}>Job labor is the actual payroll cost — wages, employer taxes and benefits — spread over the jobs each person worked, by approved hours, when payroll posts.</p>
            {data.labor.entriesWithoutEmployee > 0 && (
              <InlineNotice tone="warn" title="Some approved hours have no Books employee.">Link the worker in Projects to their Books employee so payroll can cost the hours.</InlineNotice>
            )}
            {data.labor.allocations.length > 0 && (
              <table className="tbl" style={{ marginTop: 12 }}>
                <thead><tr><th>Pay period</th><th>Status</th><th className="n">To jobs</th><th className="n">Not on a job</th><th className="n">Hours not costed</th><th /></tr></thead>
                <tbody>
                  {data.labor.allocations.map((a) => (
                    <tr key={a.id}>
                      <td>{a.periodStart} – {a.periodEnd}</td>
                      <td>{a.status === 'POSTED' ? <Tag tone="pos">Posted</Tag> : a.status === 'FAILED' ? <Tag tone="neg" title={a.error ?? undefined}>Failed</Tag> : a.status === 'NOTHING' ? <Tag>Nothing to allocate</Tag> : <Tag>In progress</Tag>}</td>
                      <td className="n tnum">{money(a.allocatedCents)}</td>
                      <td className="n tnum">{money(a.unallocatedCostCents)}</td>
                      <td className="n tnum">{a.unallocatedHours.toFixed(2)}</td>
                      <td>{a.status === 'FAILED' && <Button disabled={busy === a.payrollRunId} onClick={() => void allocate(a.payrollRunId)}>Retry</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
