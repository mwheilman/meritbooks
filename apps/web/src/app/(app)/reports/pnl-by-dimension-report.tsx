'use client';

import { useMemo } from 'react';
import { Button, InlineNotice, StatementTable, type StatementColumn, type StatementRow } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import type { PnlByDimension, PnlDimension, SplitFigures } from '@/lib/reports/pnl-by-dimension';

/**
 * P&L by Department / by Class (merit-ui StatementTable). One column per dimension
 * value that has activity, "Unassigned" for untagged lines, and a Total column that
 * equals the plain Profit & Loss for the same period and clients. Totals tie (the
 * kit asserts it in development). Read-only; RLS-scoped via the API.
 */

interface Props {
  dimension: PnlDimension;
  /** start_date / end_date / location_ids from the report viewer. */
  params: Record<string, string>;
}

interface Payload extends PnlByDimension {
  filters: { startDate: string; endDate: string; basis: 'accrual' };
  activeValueCount: number;
}

const NOUN: Record<PnlDimension, { one: string; many: string }> = {
  department: { one: 'department', many: 'departments' },
  class: { one: 'class', many: 'classes' },
};

function valuesOf(f: SplitFigures, ids: readonly string[]): number[] {
  return [...ids.map((id) => f.byColumn[id] ?? 0), f.totalCents];
}

export function PnlByDimensionReport({ dimension, params }: Props) {
  const query = useMemo(() => {
    const q: Record<string, string> = { dimension };
    for (const k of ['start_date', 'end_date', 'location_ids'] as const) if (params[k]) q[k] = params[k];
    return q;
  }, [dimension, params]);
  const { data, isLoading, error, refetch } = useQuery<Payload>('/api/reports/pnl-by-dimension', query);
  const noun = NOUN[dimension];

  const table = useMemo(() => {
    if (!data) return null;
    const ids = data.columns.map((c) => c.id);
    const columns: StatementColumn[] = [
      ...data.columns.map((c) => ({ id: c.id, header: c.name, width: 132 })),
      { id: 'total', header: 'Total', current: true, width: 140 },
    ];
    const rows: StatementRow[] = [];
    const sectionIds: Record<string, string> = {};
    for (const s of data.sections) {
      const accts = s.groups.flatMap((g) => g.accounts);
      if (accts.length === 0) continue;
      rows.push({ kind: 'head', label: s.label });
      for (const a of accts) {
        rows.push({ kind: 'line', id: `a:${a.accountNumber}`, label: `${a.accountNumber} · ${a.accountName}`, values: valuesOf(a, ids) });
      }
      const sid = `s:${s.type}`;
      sectionIds[s.type] = sid;
      rows.push({ kind: 'sub', id: sid, label: `Total ${s.label.toLowerCase()}`, values: valuesOf(s, ids), sumOf: accts.map((a) => `a:${a.accountNumber}`) });
      rows.push({ kind: 'gap' });
    }
    const ref = (t: string, sign: 1 | -1) => (sectionIds[t] ? [{ id: sectionIds[t], sign }] : []);
    rows.push({
      kind: 'sub',
      id: 'gp',
      label: 'Gross profit',
      values: valuesOf(data.summary.grossProfit, ids),
      sumOf: [...ref('REVENUE', 1), ...ref('COGS', -1)],
    });
    rows.push({
      kind: 'grand',
      id: 'ni',
      label: 'Net income',
      values: valuesOf(data.summary.netIncome, ids),
      sumOf: [{ id: 'gp', sign: 1 }, ...ref('OPEX', -1), ...ref('OTHER', -1)],
    });
    return { columns, rows };
  }, [data]);

  if (isLoading && !data) {
    return (
      <div className="surface wg-loading mb-state-block" aria-busy="true">
        <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '55%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '62%' }} aria-hidden="true" />
        <span className="t-cap" role="status">
          Splitting the P&amp;L by {noun.one}…
        </span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="surface wg-state mb-state-block" role="alert">
        <span className="tag tag--neg">Not loaded</span>
        <span className="t-head">This report didn’t load</span>
        <p>{error}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }
  if (!data || !table || data.sections.every((s) => s.groups.length === 0)) {
    return (
      <div className="surface wg-state mb-state-block">
        <span className="t-head">No posted activity in this period</span>
        <p>The split fills in as entries post. Pick a wider period, or another client.</p>
      </div>
    );
  }

  const tagged = data.columns.filter((c) => c.id !== 'unassigned').length;
  return (
    <div className="surface" style={{ padding: 16 }}>
      {tagged === 0 && (
        <InlineNotice tone="info" title={`No lines are tagged with a ${noun.one} in this period.`}>
          Everything sits under Unassigned. Tag lines with a {noun.one} on journal entries, bills and the bank feed to split the P&amp;L.
        </InlineNotice>
      )}
      <p className="t-cap" style={{ margin: '8px 0' }}>
        {data.filters.startDate} to {data.filters.endDate} · accrual basis · {tagged} {tagged === 1 ? noun.one : noun.many} with activity
        {data.columns.some((c) => c.id === 'unassigned') ? ' + Unassigned' : ''}. The Total column equals the Profit &amp; Loss for the same period.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <StatementTable
          aria-label={`Profit and loss by ${noun.one}`}
          unitLabel="In US dollars"
          columns={table.columns}
          rows={table.rows}
          labelWidth={280}
          caption="Totals tie: each column’s net income = revenue − cost of goods sold − operating expenses − other; the columns sum to Total."
        />
      </div>
    </div>
  );
}
