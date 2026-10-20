'use client';

/**
 * Floor-plan notes: server-paginated, sortable, filterable by status / line /
 * collateral, debounced search on the lender invoice # or description. Row → note page.
 */

import { useRouter } from 'next/navigation';
import { FileText, Search } from 'lucide-react';
import type { CollateralType } from '@/lib/dealer/types';
import { COLLATERAL, NOTE_STATUS, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useDealerList, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { Select } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { Money, Pill, Section } from '../../_components/ui';
import type { FpNote } from '../_lib/types';
import { DueDate, UnitLink } from './bits';

const LIVE = 'OPEN,SOLD_UNPAID,IN_DEFAULT';
type StatusSeg = '' | typeof LIVE | 'OPEN' | 'SOLD_UNPAID' | 'IN_DEFAULT' | 'PAID_OFF' | 'VOID';
const SEGMENTS: Array<{ value: StatusSeg; label: string }> = [
  { value: LIVE, label: 'Outstanding' },
  { value: 'OPEN', label: 'In stock' },
  { value: 'SOLD_UNPAID', label: 'Sold — payoff owed' },
  { value: 'IN_DEFAULT', label: 'In default' },
  { value: 'PAID_OFF', label: 'Paid off' },
  { value: 'VOID', label: 'Voided' },
  { value: '', label: 'All' },
];

function asSeg(v: string | null): StatusSeg {
  return (SEGMENTS.find((s) => s.value === v)?.value ?? LIVE) as StatusSeg;
}

export function NotesTab({ initialStatus, initialLineId }: { initialStatus: string | null; initialLineId: string | null }) {
  const router = useRouter();
  const { settings } = useDealerPack();
  const status = asSeg(initialStatus);
  const list = useDealerList<FpNote>('/api/dealer/notes', {
    sort: 'floored_date',
    dir: 'desc',
    filters: { ...(status ? { status } : {}), ...(initialLineId ? { line_id: initialLineId } : {}) },
  });
  const rows = list.data?.rows ?? [];
  const units = useNames('units', rows.map((r) => r.unit_id));
  const lines = useNames('lines', rows.map((r) => r.line_id));
  const today = todayLocal();
  const termWarn = settings?.term_warning_days ?? 60;

  const columns: DealerColumn<FpNote>[] = [
    { key: 'inv', header: 'Lender invoice #', sortKey: 'lender_invoice_number', render: (r) => <span className="font-mono tabular-nums text-white">{r.lender_invoice_number}</span> },
    {
      key: 'unit',
      header: 'Unit',
      render: (r) =>
        r.unit_id ? (
          <div className="min-w-0">
            <UnitLink unitId={r.unit_id} serial={units.get(r.unit_id)?.label} />
            {units.get(r.unit_id)?.sub && <div className="truncate text-2xs text-slate-500">{units.get(r.unit_id)?.sub}</div>}
          </div>
        ) : (
          <span className="text-xs text-slate-400">{labelOf(COLLATERAL, r.collateral_type)}</span>
        ),
    },
    { key: 'line', header: 'Line', render: (r) => <span className="text-slate-300">{nameOf(lines, r.line_id)}</span> },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (r) => <Pill label={labelOf(NOTE_STATUS, r.status)} tone={toneOf(NOTE_STATUS, r.status)} title={hintOf(NOTE_STATUS, r.status)} />,
    },
    { key: 'floored', header: 'Floored', sortKey: 'floored_date', render: (r) => <span className="font-mono tabular-nums text-slate-300">{dateLabel(r.floored_date)}</span> },
    { key: 'orig', header: 'Original', sortKey: 'original_principal_cents', align: 'right', render: (r) => <Money cents={r.original_principal_cents} muted /> },
    { key: 'bal', header: 'Balance', sortKey: 'principal_balance_cents', align: 'right', render: (r) => <Money cents={r.principal_balance_cents} /> },
    {
      key: 'ff',
      header: 'Free floor ends',
      render: (r) => (r.free_floor_end_date ? <span className="font-mono tabular-nums text-slate-400">{dateLabel(r.free_floor_end_date)}</span> : <span className="text-slate-500">—</span>),
    },
    {
      key: 'maturity',
      header: 'Maturity',
      sortKey: 'maturity_date',
      render: (r) => (r.status === 'OPEN' || r.status === 'IN_DEFAULT' ? <DueDate date={r.maturity_date} today={today} warnDays={termWarn} /> : <span className="text-slate-500">—</span>),
    },
    {
      key: 'payoff',
      header: 'Payoff due',
      sortKey: 'payoff_due_date',
      render: (r) => (r.status === 'SOLD_UNPAID' ? <DueDate date={r.payoff_due_date} today={today} /> : <span className="text-slate-500">—</span>),
    },
  ];

  return (
    <Section title="Notes" description="One note per floored unit (or open-account invoice). Click a note for its history, curtailments and payoff.">
      <TableToolbar>
        <div className="relative w-full max-w-xs">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            type="search"
            aria-label="Search notes by lender invoice # or description"
            placeholder="Search invoice # or description…"
            value={list.state.search}
            onChange={(e) => list.setSearch(e.target.value)}
            className="input w-full pl-8"
          />
        </div>
        <Segments<StatusSeg>
          label="Note status"
          value={(list.state.filters.status ?? '') as StatusSeg}
          onChange={(v) => list.setFilter('status', v || null)}
          options={SEGMENTS}
        />
        <div className="w-56">
          <LookupPicker kind="lines" value={list.state.filters.line_id ?? null} onChange={(id) => list.setFilter('line_id', id)} placeholder="All lines" aria-label="Filter by line" />
        </div>
        <div className="w-48">
          <Select<CollateralType>
            aria-label="Filter by collateral"
            value={(list.state.filters.collateral_type ?? '') as CollateralType | ''}
            onChange={(v) => list.setFilter('collateral_type', v || null)}
            placeholder="Any collateral"
            options={(Object.keys(COLLATERAL) as CollateralType[]).map((k) => ({ value: k, label: COLLATERAL[k] }))}
          />
        </div>
      </TableToolbar>
      <DealerTable<FpNote>
        caption="Floor-plan notes"
        columns={columns}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        sort={list.state.sort}
        dir={list.state.dir}
        onSort={list.setSort}
        onRowClick={(r) => router.push(dealerLinks.note(r.id))}
        rowClassName={(r) => (r.status === 'SOLD_UNPAID' && r.payoff_due_date && r.payoff_due_date < today ? 'bg-red-500/[0.04]' : undefined)}
        page={list.data?.page}
        perPage={list.data?.perPage}
        total={list.data?.total}
        noun="notes"
        onPageChange={list.setPage}
        empty={{
          icon: FileText,
          title: list.state.search || Object.keys(list.state.filters).length ? 'No notes match these filters' : 'No floor-plan notes yet',
          description:
            list.state.search || Object.keys(list.state.filters).length
              ? 'Try another status or line, or clear the search.'
              : 'Notes appear when a unit is floored — from a lender import, the opening load, or “Floor a unit” under Lenders & programs.',
        }}
      />
    </Section>
  );
}
