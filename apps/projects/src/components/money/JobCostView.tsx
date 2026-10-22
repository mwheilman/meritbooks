'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Figure, Keybar, QueueTable, Seg, WidgetState, pts, type QueueColumn } from '@meritbooks/merit-ui';
import type { JobFinancialsRow } from '@/lib/pm/money/types';
import { byFade, marginFade, originalMargin, projectedMargin } from '@/lib/pm/money/summaries';
import { useMoneyVis, useVocab } from '@/components/shell/ShellContext';
import { when } from '@/components/money/visibility';
import { lower } from '@/lib/pm/vocab';
import { m0, p } from './common';

export interface JobCostRow extends JobFinancialsRow { label: string; company: string | null }
type Sort = 'fade' | 'margin' | 'contract';

/** Jobs × the four numbers (v_job_financials), worst margin fade first. */
export function JobCostView({ rows, showCompany }: { rows: JobCostRow[]; showCompany: boolean }) {
  const v = useVocab();
  const router = useRouter();
  // Cost page (financials); contract, margin and billing columns also need contract_value.
  const mv = useMoneyVis();
  const c = mv.contract;
  const [sort, setSort] = useState<Sort>(c ? 'fade' : 'margin');
  const sorted = !c ? [...rows].sort((a, b) => b.actual_cost_cents - a.actual_cost_cents) : sort === 'fade' ? byFade(rows) : [...rows].sort((a, b) => (sort === 'margin' ? a.projected_margin_cents - b.projected_margin_cents : b.revised_contract_cents - a.revised_contract_cents));
  const sum = (f: (r: JobCostRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const contract = sum((r) => r.revised_contract_cents);
  const projected = sum((r) => r.projected_margin_cents);
  const sold = sum((r) => r.original_contract_cents) - sum((r) => r.budget_original_cents ?? 0);

  const columns: QueueColumn<JobCostRow>[] = [
    { id: 'job', header: v.job, cell: (r) => <><span className="l1">{r.label}</span><span className="l2">{[showCompany ? r.company : null, `${p(r.pct_complete_cost)} complete on cost`].filter(Boolean).join(' · ')}</span></> },
    ...when<QueueColumn<JobCostRow>>(c, { id: 'contract', header: 'Contract', numeric: true, width: 128, cell: (r) => m0(r.revised_contract_cents) }),
    { id: 'com', header: 'Committed', numeric: true, width: 128, cell: (r) => m0(r.committed_cents) },
    { id: 'act', header: 'Actual', numeric: true, width: 128, cell: (r) => m0(r.actual_cost_cents) },
    ...when<QueueColumn<JobCostRow>>(c, { id: 'pm', header: 'Projected margin', numeric: true, width: 168, cell: (r) => <span className={r.projected_margin_cents < 0 ? 'neg b' : undefined}>{m0(r.projected_margin_cents)} · {p(projectedMargin(r))}</span> }),
    ...when<QueueColumn<JobCostRow>>(c, { id: 'fade', header: 'Fade vs sold', numeric: true, width: 120, cell: (r) => { const f = marginFade(r); return f == null ? <span className="l2">No budget</span> : <span className={f > 0.02 ? 'neg b' : undefined}>{pts(-f * 100)}</span>; } }),
    ...when<QueueColumn<JobCostRow>>(c, { id: 'ou', header: 'Over / under billed', numeric: true, width: 152, cell: (r) => (r.over_under_billing_cents == null ? '—' : m0(r.over_under_billing_cents)) }),
  ];

  if (rows.length === 0) {
    return <div className="surface"><WidgetState state={{ kind: 'empty', title: `No ${lower(v.jobs)} to cost yet`, body: 'Job cost appears once a job has a contract or a budget.', action: <a className="link" href="/jobs">Open {lower(v.jobs)}</a> }} /></div>;
  }
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {c && <Figure dense label="Contract" value={m0(contract)} vs={[`${m0(sum((r) => r.original_contract_cents))} original`, `${m0(sum((r) => r.pending_co_cents))} pending changes`]} href="/change-orders" linkLabel={v.change_orders} />}
        <Figure dense label="Committed" value={m0(sum((r) => r.committed_cents))} vs={[`of ${m0(sum((r) => r.revised_budget_cents))} budget`, `${m0(sum((r) => r.committed_open_cents))} open`]} href="/commitments" linkLabel={v.commitments} />
        <Figure dense label="Actual cost" value={m0(sum((r) => r.actual_cost_cents))} vs={[`of ${m0(sum((r) => r.projected_final_cost_cents))} projected`, `${m0(sum((r) => r.pending_cost_cents))} pending in Merit Books`]} href={c ? '/insights/margin' : '/commitments'} linkLabel={c ? 'Margin by job' : v.commitments} />
        {c && <Figure dense label="Projected margin" value={`${m0(projected)} · ${p(contract > 0 ? projected / contract : null)}`} vs={[`${m0(sold)} sold`, `${p(sum((r) => r.original_contract_cents) > 0 ? sold / sum((r) => r.original_contract_cents) : null)} sold margin`]} href="/insights/margin" linkLabel="Margin by job" />}
      </div>
      {c && <div className="row row--between">
        <Seg<Sort> aria-label="Sort" value={sort} onChange={setSort} items={[{ value: 'fade', label: 'Worst fade first' }, { value: 'margin', label: 'Lowest margin' }, { value: 'contract', label: 'Largest contract' }]} />
        <span className="t-cap">Fade = margin when sold (original contract less original budget) less projected margin now.</span>
      </div>}
      <div className="mp-table">
        <QueueTable aria-label={`${v.jobs} by margin fade`} columns={columns} rows={sorted} getRowId={(r) => r.job_id}
          rowState={(r) => ({ attn: c && (r.projected_margin_cents < 0 || (marginFade(r) ?? 0) > 0.05) })} openOnClick onOpen={(r) => router.push(`/jobs/${r.job_id}?tab=job-cost`)} />
      </div>
      <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open job cost' }]} note={`${rows.filter((r) => originalMargin(r) == null).length} without an original budget sort last`} />
    </div>
  );
}
