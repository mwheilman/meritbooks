'use client';

import Link from 'next/link';
import { StatementTable, WidgetState, count, pct, ratio, type StatementColumn, type StatementRow } from '@meritbooks/merit-ui';
import type { ProjectListRow } from '@/lib/pm/types';
import { marginCents, sumBy } from '@/lib/pm/money';

const M0 = { decimals: 0 as const };

/**
 * Jobs as a statement: company sections (workspace), a line per job, subtotals and a
 * grand total that tie. Margin % is shown in the label's second line (not summed).
 */
export function JobStatement({ rows, companyNames, multi, kind }: { rows: ProjectListRow[]; companyNames: Record<string, string>; multi: boolean; kind: 'margin' | 'backlog' }) {
  if (rows.length === 0) {
    return (
      <div className="surface">
        <WidgetState state={{ kind: 'empty', title: kind === 'backlog' ? 'No job is in progress' : 'No job has a contract yet', body: kind === 'backlog' ? 'Backlog counts jobs that have started and are not finished.' : 'Margin needs a contract value; set one on the job’s Contract tab.' }} />
      </div>
    );
  }
  const columns: StatementColumn[] = [
    { id: 'contract', header: 'Revised contract', width: 140, format: M0, current: true },
    { id: 'budget', header: 'Budget', width: 128, format: M0 },
    { id: 'est', header: 'Cost estimate', width: 128, format: M0 },
    { id: 'margin', header: 'Projected margin', width: 140, format: M0 },
  ];
  const vals = (rs: ReadonlyArray<ProjectListRow>) => [sumBy(rs, (p) => p.contract_revised_cents), sumBy(rs, (p) => p.budget_total_cents), sumBy(rs, (p) => p.cost_estimate_cents), sumBy(rs, marginCents)];
  const out: StatementRow[] = [];
  const companies = [...new Set(rows.map((r) => r.location_id))].sort((a, b) => (companyNames[a] ?? '').localeCompare(companyNames[b] ?? ''));
  const totals: string[] = [];
  for (const co of companies) {
    const mine = rows.filter((r) => r.location_id === co);
    const sorted = kind === 'margin' ? [...mine].sort((a, b) => ratio(marginCents(a), a.contract_revised_cents || 1) - ratio(marginCents(b), b.contract_revised_cents || 1)) : [...mine].sort((a, b) => b.contract_revised_cents - a.contract_revised_cents);
    if (multi) out.push({ kind: 'head', label: companyNames[co] ?? 'Company' });
    const ids: string[] = [];
    for (const r of sorted) {
      ids.push(r.job_id);
      const mf = ratio(marginCents(r), r.contract_revised_cents);
      out.push({
        kind: 'line',
        id: r.job_id,
        label: (
          <Link className="nlink" href={`/jobs/${r.job_id}?tab=budget`}>
            {[r.job_number, r.name].filter(Boolean).join(' · ')}
            <span className="ink-3"> · {r.stage_label} · {Number.isFinite(mf) ? pct(mf) : '—'}</span>
          </Link>
        ),
        values: vals([r]),
        bold: marginCents(r) < 0 ? [3] : undefined,
      });
    }
    if (multi) {
      out.push({ kind: 'sub', id: `${co}:sub`, label: `${companyNames[co] ?? 'Company'} · ${count(mine.length)} jobs`, sumOf: ids, values: vals(mine) });
      totals.push(`${co}:sub`);
    } else totals.push(...ids);
  }
  out.push({ kind: 'grand', label: `${count(rows.length)} jobs`, sumOf: totals, values: vals(rows) });
  const mf = ratio(sumBy(rows, marginCents), sumBy(rows, (p) => p.contract_revised_cents));
  return (
    <StatementTable
      aria-label={kind === 'margin' ? 'Margin by job' : 'Backlog by job'}
      unitLabel="Job · in US dollars"
      columns={columns}
      rows={out}
      caption={`Projected margin ${Number.isFinite(mf) ? pct(mf) : '—'} overall: revised contract less the cost estimate (approved revised budget, else original budget plus approved change-order cost). ${kind === 'backlog' ? 'Earned revenue comes from Merit Books in a later release; this is contract on jobs in progress.' : 'Lowest margin first.'} Totals tie.`}
    />
  );
}
