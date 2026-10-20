'use client';

import { useState } from 'react';
import {
  Button, Figure, InlineNotice, StatementTable, WidgetState, money, toast, api, type StatementColumn, type StatementRow,
} from '@meritbooks/merit-ui';
import { useRouter } from 'next/navigation';
import { COST_TYPE_LABELS, type CostType } from '@/lib/packs';
import type { CostCodeStatusRow, JobFinancialsRow } from '@/lib/pm/money/types';
import { originalMargin, projectedMargin } from '@/lib/pm/money/summaries';
import { useShell } from '@/components/shell/ShellContext';
import { m0, p } from './common';

export interface JobCostTabProps {
  jobId: string;
  rows: CostCodeStatusRow[];
  financials: JobFinancialsRow | null;
  booksPresent: boolean;
}

interface Refresh { status: 'ok' | 'busy'; seen?: number; applied?: number; stale?: number; duplicate?: number; rejected?: number }

const TYPES: Array<CostType | 'UNASSIGNED'> = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER', 'UNASSIGNED'];

/** Toast text for a refresh_job_costs result. Pure (exported for tests). */
export function refreshToast(r: Refresh): { text: string; tone: 'ok' | 'neg' } {
  if (r.status === 'busy') return { text: 'A refresh is already running for this workspace. Try again in a minute.', tone: 'neg' };
  const applied = r.applied ?? 0;
  const parts: string[] = [applied === 0 ? 'No new costs from Merit Books' : `${applied} ${applied === 1 ? 'cost' : 'costs'} from Merit Books applied`];
  if (r.stale) parts.push(`${r.stale} out of order kept as history`);
  if (r.duplicate) parts.push(`${r.duplicate} duplicate${r.duplicate === 1 ? '' : 's'} skipped`);
  if (r.rejected) parts.push(`${r.rejected} could not be read; tell your Merit Books administrator`);
  return { text: parts.join(' · '), tone: r.rejected ? 'neg' : 'ok' };
}

/** v_cost_code_status rows → statement rows by cost type (budget · committed · actual · projected · variance). Totals tie. */
export function costStatement(rows: ReadonlyArray<CostCodeStatusRow>): StatementRow[] {
  const out: StatementRow[] = [];
  const subs: string[] = [];
  for (const t of TYPES) {
    const group = rows.filter((r) => (r.cost_code_id == null ? 'UNASSIGNED' : (r.cost_type as CostType | null) ?? 'OTHER') === t);
    if (!group.length) continue;
    const label = t === 'UNASSIGNED' ? 'Not on a cost code' : COST_TYPE_LABELS[t];
    out.push({ kind: 'head', label });
    const ids: string[] = [];
    for (const r of [...group].sort((a, b) => (a.cost_code ?? '').localeCompare(b.cost_code ?? ''))) {
      const id = `${t}:${r.cost_code_id ?? 'none'}`;
      ids.push(id);
      out.push({
        kind: 'line', id,
        label: r.cost_code_id ? <><span className="code">{r.cost_code}</span>{r.cost_code_name}</> : 'Costs Merit Books could not place on a cost code',
        values: [r.budget_cents, r.committed_cents, r.actual_cents, r.forecast_cents, r.variance_cents],
        bold: r.variance_cents < 0 ? [4] : undefined,
        fu: r.variance_cents < 0 ? 'U' : r.variance_cents > 0 ? 'F' : null,
      });
    }
    const sum = (k: keyof Pick<CostCodeStatusRow, 'budget_cents' | 'committed_cents' | 'actual_cents' | 'forecast_cents' | 'variance_cents'>) => group.reduce((s, r) => s + r[k], 0);
    const sub = `${t}:sub`;
    subs.push(sub);
    out.push({ kind: 'sub', id: sub, label: `${label} total`, sumOf: ids, values: [sum('budget_cents'), sum('committed_cents'), sum('actual_cents'), sum('forecast_cents'), sum('variance_cents')] });
  }
  const all = (k: keyof Pick<CostCodeStatusRow, 'budget_cents' | 'committed_cents' | 'actual_cents' | 'forecast_cents' | 'variance_cents'>) => rows.reduce((s, r) => s + r[k], 0);
  out.push({ kind: 'grand', label: 'Job total', sumOf: subs, values: [all('budget_cents'), all('committed_cents'), all('actual_cents'), all('forecast_cents'), all('variance_cents')] });
  return out;
}

const COLUMNS: StatementColumn[] = [
  { id: 'b', header: 'Budget', width: 128 },
  { id: 'c', header: 'Committed', width: 128 },
  { id: 'a', header: 'Actual from Merit Books', width: 152, current: true },
  { id: 'f', header: 'Projected', width: 128 },
  { id: 'v', header: 'Variance', width: 128 },
];

export function JobCostTab({ jobId, rows, financials: f, booksPresent }: JobCostTabProps) {
  const { readOnly } = useShell();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    const r = await api.post<Refresh>(`/api/jobs/${jobId}/costs`, {});
    setBusy(false);
    if (r.error) return void toast.error(r.error.error);
    const t = refreshToast(r.data!);
    if (t.tone === 'neg') toast.error(t.text);
    else toast(t.text);
    router.refresh();
  };

  const om = f ? originalMargin(f) : null;
  const pmg = f ? projectedMargin(f) : null;
  const pending = f?.pending_cost_cents ?? 0;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
        {f ? (
          <div className="row" style={{ alignItems: 'flex-start', gap: 32, flexWrap: 'wrap' }}>
            <Figure dense label="Contract" value={m0(f.revised_contract_cents)} vs={[`${m0(f.original_contract_cents)} original`, `${money(f.approved_co_cents, { decimals: 0, sign: 'delta' })} change orders`]} href={`/jobs/${jobId}?tab=contract`} linkLabel="Contract" />
            <Figure dense label="Committed" value={m0(f.committed_cents)} vs={[`of ${m0(f.revised_budget_cents)} budget`, `${m0(f.committed_open_cents)} still open`]} href={`/jobs/${jobId}?tab=commitments`} linkLabel="Commitments" />
            <Figure dense label="Actual cost" value={m0(f.actual_cost_cents)} vs={[`of ${m0(f.projected_final_cost_cents)} projected`, pending ? `${m0(pending)} pending in Merit Books` : `${p(f.pct_complete_cost)} complete on cost`]} href="/job-cost" linkLabel="All jobs" />
            <Figure dense label="Projected margin" value={`${m0(f.projected_margin_cents)} · ${p(pmg)}`} vs={[om != null ? `vs ${p(om)} sold` : 'No original budget to compare', `${m0(f.cost_to_complete_cents)} cost to complete`]} href={`/jobs/${jobId}?tab=budget`} linkLabel="Budget" />
            {f.over_under_billing_cents != null && (
              <Figure dense label={f.over_under_billing_cents >= 0 ? 'Over billed' : 'Under billed'} value={m0(Math.abs(f.over_under_billing_cents))} vs={[`${m0(f.billed_to_date_cents)} billed vs ${m0(f.earned_revenue_cents ?? 0)} earned`, 'Estimate; Merit Books WIP is the book']} href={`/jobs/${jobId}?tab=billing`} linkLabel="Billing" />
            )}
          </div>
        ) : <span />}
        {!readOnly && (
          <Button icon="history" disabled={busy || !booksPresent} aria-busy={busy || undefined} title={booksPresent ? undefined : 'Merit Books is not on'} onClick={() => void refresh()}>
            Refresh from Merit Books
          </Button>
        )}
      </div>

      {!booksPresent && <InlineNotice title="Merit Books is not on.">Actual cost comes from bills, payroll and bank costs posted in Merit Books, so it stays at zero here. Budget, committed and projected still work.</InlineNotice>}

      {rows.length === 0 ? (
        <div className="surface">
          <WidgetState state={{ kind: 'empty', title: 'No cost by cost code yet', body: 'Approve a budget, commit cost with a purchase order or subcontract, or post a bill to the job in Merit Books, and the cost codes appear here.' }} />
        </div>
      ) : (
        <StatementTable
          aria-label="Job cost by cost code"
          unitLabel="Cost code · in US dollars"
          columns={COLUMNS}
          rows={costStatement(rows)}
          fu
          caption={
            <>
              Projected is the larger of budget, committed plus cost not on a commitment, and actual plus pending, by cost code; variance is budget less projected.
              {f && f.projected_final_cost_cents !== rows.reduce((s, r) => s + r.forecast_cents, 0)
                ? ` The job’s projected final cost (${money(f.projected_final_cost_cents)}) is higher because it also counts the revised budget, including approved change-order cost.`
                : ' Totals tie.'}
            </>
          }
        />
      )}
    </div>
  );
}
