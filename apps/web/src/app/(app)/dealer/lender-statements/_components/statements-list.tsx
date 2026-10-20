'use client';

/**
 * Lender statements list: filter by line / kind / status, see which lines still need
 * a signed-off reconciliation, enter a statement by hand, open a workspace.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileSpreadsheet, Plus, Upload } from 'lucide-react';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import type { StatementKind, StatementStatus } from '@/lib/dealer/types';
import { STATEMENT_KIND, STATEMENT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, lastDayOfPriorMonth, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useDealerList, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { Select } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { Money, Notice, Pill, Section } from '../../_components/ui';
import { actorLabel, useMe } from '../../floor-plan/_lib/hooks';
import type { LenderStatement } from '../../floor-plan/_lib/types';
import { EnterStatementModal } from './enter-statement';

type StatusSeg = '' | StatementStatus | 'IMPORTED,MATCHING';
const SEGS: Array<{ value: StatusSeg; label: string }> = [
  { value: 'IMPORTED,MATCHING', label: 'In progress' },
  { value: 'PREPARED', label: 'Awaiting sign-off' },
  { value: 'APPROVED', label: 'Signed off' },
  { value: '', label: 'All' },
];

export function StatementsList() {
  const sp = useSearchParams();
  const router = useRouter();
  const me = useMe();
  const { locationId } = useDealerPack();
  const initialLine = sp?.get('lineId') ?? null;
  const list = useDealerList<LenderStatement>('/api/dealer/lender-statements', {
    sort: 'statement_date',
    dir: 'desc',
    filters: initialLine ? { line_id: initialLine } : {},
  });
  const rows = list.data?.rows ?? [];
  const lines = useNames('lines', rows.map((r) => r.line_id));
  const summary = useDealerQuery<DealerSummary>('/api/dealer/summary');
  const [entering, setEntering] = useState(false);

  // Coverage: active lines whose last signed-off reconciliation is before last month-end.
  const monthEnd = lastDayOfPriorMonth(todayLocal());
  const behind = (summary.data?.floorPlan.lines ?? []).filter((l) => l.lineStatus !== 'CLOSED' && (!l.lastReconciledDate || l.lastReconciledDate < monthEnd));

  const cols: DealerColumn<LenderStatement>[] = [
    { key: 'date', header: 'Statement date', sortKey: 'statement_date', render: (r) => <span className="font-mono tabular-nums text-white">{dateLabel(r.statement_date)}</span> },
    { key: 'line', header: 'Line', render: (r) => <span className="text-slate-300">{nameOf(lines, r.line_id)}</span> },
    { key: 'kind', header: 'Kind', sortKey: 'kind', render: (r) => <span className="text-slate-300">{labelOf(STATEMENT_KIND, r.kind)}</span> },
    { key: 'principal', header: 'Lender principal', align: 'right', render: (r) => <Money cents={r.footer_principal_cents} /> },
    { key: 'count', header: 'Lines', align: 'right', render: (r) => <span className="font-mono tabular-nums text-slate-400">{r.footer_line_count ?? '—'}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <Pill label={labelOf(STATEMENT_STATUS, r.status)} tone={toneOf(STATEMENT_STATUS, r.status)} /> },
    {
      key: 'who',
      header: 'Prepared / signed off',
      render: (r) => (
        <span className="text-xs text-slate-400">
          {actorLabel(r.prepared_by, me)} / {actorLabel(r.approved_by, me)}
        </span>
      ),
    },
    { key: 'src', header: 'Source', render: (r) => <span className="text-xs text-slate-500">{r.import_batch_id ? 'Imported' : r.document_id ? 'From a document' : 'Entered by hand'}</span> },
  ];

  return (
    <div>
      {behind.length > 0 && (
        <Notice tone="warning" action={<span className="text-xs text-amber-200/70">Month end {dateLabel(monthEnd)}</span>}>
          <span className="font-medium">Not reconciled through last month-end:</span>{' '}
          {behind.map((l, i) => (
            <span key={l.lineId}>
              {i > 0 && ', '}
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => list.setFilter('line_id', l.lineId)}>
                {l.lineName}
              </button>
              {l.lastReconciledDate ? ` (last ${dateLabel(l.lastReconciledDate)})` : ' (never)'}
            </span>
          ))}
          . A signed-off reconciliation for every active line is a month-end close item.
        </Notice>
      )}

      <Section
        title="Statements and floor checks"
        description={
          <>
            Got a PDF, spreadsheet or the lender’s email?{' '}
            <Link href={dealerLinks.imports()} className="text-emerald-400 hover:text-emerald-300">
              Import it on the Imports page
            </Link>{' '}
            — it’s read for you and lands here. Or enter a short statement by hand.
          </>
        }
        actions={
          <>
            <Link href={dealerLinks.imports()} className="btn-secondary btn-sm inline-flex items-center gap-1.5">
              <Upload size={13} /> Import
            </Link>
            <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setEntering(true)}>
              <Plus size={13} /> Enter statement
            </button>
          </>
        }
      >
        <TableToolbar>
          <Segments<StatusSeg> label="Reconciliation status" value={(list.state.filters.status ?? '') as StatusSeg} onChange={(v) => list.setFilter('status', v || null)} options={SEGS} />
          <div className="w-56">
            <LookupPicker kind="lines" value={list.state.filters.line_id ?? null} onChange={(id) => list.setFilter('line_id', id)} placeholder="All lines" aria-label="Filter by line" />
          </div>
          <div className="w-48">
            <Select<StatementKind>
              aria-label="Filter by kind"
              value={(list.state.filters.kind ?? '') as StatementKind | ''}
              onChange={(v) => list.setFilter('kind', v || null)}
              placeholder="Any kind"
              options={(Object.keys(STATEMENT_KIND) as StatementKind[]).map((k) => ({ value: k, label: STATEMENT_KIND[k] }))}
            />
          </div>
        </TableToolbar>
        <DealerTable<LenderStatement>
          caption="Lender statements"
          columns={cols}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          sort={list.state.sort}
          dir={list.state.dir}
          onSort={list.setSort}
          onRowClick={(r) => router.push(dealerLinks.lenderStatement(r.id))}
          page={list.data?.page}
          perPage={list.data?.perPage}
          total={list.data?.total}
          noun="statements"
          onPageChange={list.setPage}
          empty={{
            icon: FileSpreadsheet,
            title: Object.keys(list.state.filters).length ? 'No statements match these filters' : 'No lender statements yet',
            description: Object.keys(list.state.filters).length
              ? 'Try another line, kind or status.'
              : 'Import the lender’s monthly statement or floor check, or enter one by hand, then match it to Books.',
            action: (
              <button type="button" className="btn-primary btn-sm" onClick={() => setEntering(true)}>
                Enter a statement
              </button>
            ),
          }}
        />
      </Section>
      {locationId && (
        <EnterStatementModal
          open={entering}
          onClose={() => setEntering(false)}
          locationId={locationId}
          defaultLineId={list.state.filters.line_id ?? null}
          onCreated={(id) => router.push(dealerLinks.lenderStatement(id))}
        />
      )}
    </div>
  );
}
