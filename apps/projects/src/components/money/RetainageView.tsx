'use client';

import Link from 'next/link';
import { Figure, InlineNotice, StatementTable, WidgetState, money, shortDate, type StatementRow } from '@meritbooks/merit-ui';
import type { BillingStatus, SuppressedReason } from '@/lib/pm/money/types';
import { billingMark } from '@/lib/pm/money/status';
import { MarkStatus, m0 } from './common';

export interface RetainageJob { jobId: string; jobLabel: string; company: string | null; held: number; released: number; outstanding: number }
export interface ReleaseRow { id: string; jobId: string; jobLabel: string; status: BillingStatus; suppressed: SuppressedReason | null; amount: number; date: string; invoice: string | null }

/** Retainage receivable by job (pm.v_job_retainage), grouped by company; releases in flight below. */
export function RetainageView({ jobs, releases, multi, booksPresent }: { jobs: RetainageJob[]; releases: ReleaseRow[]; multi: boolean; booksPresent: boolean }) {
  if (jobs.length === 0) {
    return <div className="surface"><WidgetState state={{ kind: 'empty', title: 'No retainage held yet', body: 'Retainage shows here once a billing that withholds it is approved: pay applications, progress billing or milestones on a contract with a retention rate.', action: <Link className="link" href="/billing">Open billing</Link> }} /></div>;
  }
  const groups = multi ? [...new Set(jobs.map((j) => j.company ?? 'Company'))].sort() : [null];
  const rows: StatementRow[] = [];
  const subs: string[] = [];
  for (const g of groups) {
    const list = jobs.filter((j) => !multi || (j.company ?? 'Company') === g).sort((a, b) => b.outstanding - a.outstanding);
    if (multi) rows.push({ kind: 'head', label: g });
    const ids: string[] = [];
    for (const j of list) {
      ids.push(j.jobId);
      rows.push({ kind: 'line', id: j.jobId, label: <Link className="nlink" href={`/jobs/${j.jobId}?tab=billing`}>{j.jobLabel}</Link>, values: [j.held, j.released, j.outstanding] });
    }
    if (multi) {
      const id = `sub:${g}`;
      subs.push(id);
      rows.push({ kind: 'sub', id, label: `${g} total`, sumOf: ids, values: [list.reduce((s, j) => s + j.held, 0), list.reduce((s, j) => s + j.released, 0), list.reduce((s, j) => s + j.outstanding, 0)] });
    } else subs.push(...ids);
  }
  const held = jobs.reduce((s, j) => s + j.held, 0);
  const released = jobs.reduce((s, j) => s + j.released, 0);
  const outstanding = jobs.reduce((s, j) => s + j.outstanding, 0);
  rows.push({ kind: 'grand', label: 'Retainage receivable', sumOf: subs, values: [held, released, outstanding] });
  const inFlight = releases.filter((r) => r.status === 'DRAFT' || r.status === 'EMITTED' || r.status === 'REJECTED');

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Figure dense label="Outstanding" value={m0(outstanding)} vs={[`${m0(held)} held on bills`, `${m0(released)} released`]} href="/billing" linkLabel="Billing" />
        <Figure dense label="Releases in flight" value={m0(inFlight.reduce((s, r) => s + r.amount, 0))} vs={[`${inFlight.length} drafted or sent`, `of ${m0(outstanding)} outstanding`]} href="/billing" linkLabel="Billing queue" />
      </div>
      <StatementTable aria-label="Retainage by job" unitLabel="Job · in US dollars" columns={[{ id: 'h', header: 'Held', width: 144 }, { id: 'r', header: 'Released', width: 144 }, { id: 'o', header: 'Outstanding', width: 144, current: true }]}
        rows={rows} caption={booksPresent ? 'Counts bills that reached Merit Books or were approved here. Merit Books’ retainage receivable account is the book; this ties to it.' : 'Counts approved bills. Merit Books is not on, so there is no ledger account to tie to.'} />
      <section className="sec" aria-label="Retainage releases">
        <div className="sec-h"><h2 className="t-section">Releases</h2></div>
        {releases.length === 0 ? (
          <InlineNotice title="No releases yet.">Draft one from the job’s Billing tab at closeout, or in part as work is accepted.</InlineNotice>
        ) : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <colgroup><col /><col style={{ width: 104 }} /><col style={{ width: 196 }} /><col style={{ width: 136 }} /><col style={{ width: 136 }} /></colgroup>
              <thead><tr><th>Job</th><th>Date</th><th>Status</th><th className="n">Release</th><th>Invoice</th></tr></thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={r.id} className="q-row">
                    <td><Link className="nlink" href={`/jobs/${r.jobId}?tab=billing&request=${r.id}`}>{r.jobLabel}</Link></td>
                    <td>{shortDate(r.date)}</td>
                    <td><MarkStatus mark={billingMark(r.status, r.suppressed)} /></td>
                    <td className="n">{money(r.amount)}</td>
                    <td>{r.invoice ? <span className="code">{r.invoice}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
