'use client';

/**
 * Unit register — every serialized unit for the client: cost, days in stock,
 * floor-plan balance (floored vs owned) and the flags that need action (aged,
 * near term end, demo/rental on floor plan, registered-not-sold, payoff owed).
 * Server pagination / sort / filters / debounced search over GET /api/dealer/units.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Boxes, Download, Plus, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import type { UnitCondition, UnitSource } from '@/lib/dealer/types';
import { NOTE_STATUS, UNIT_CONDITION, UNIT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { UNIT_SOURCE } from '@/lib/dealer/ui/unit-deal-labels';
import { centsToInput, dateLabel, daysLabel, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { agingRange, daysInStock, unitFlags } from '@/lib/dealer/ui/unit-flags';
import type { NoteView, UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { useDealerPack } from '../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../_components/dealer-table';
import { Select } from '../_components/forms';
import { Money, Notice, Pill } from '../_components/ui';
import { nameOf, useDealerList, useNames } from '../_lib/use-dealer';
import { useLiveNotes } from './_lib/use-live-notes';
import { AddUnitModal } from './add-unit-modal';

export interface UnitsQuery {
  status?: string;
  condition?: string;
  minAge?: number;
  maxAge?: number;
  floored?: 'yes' | 'no';
  q?: string;
}

const STATUS_SEGMENTS = [
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'ON_ORDER,IN_TRANSIT', label: 'On order' },
  { value: 'SOLD,DELIVERED', label: 'Sold' },
  { value: 'RENTAL', label: 'Rental fleet' },
  { value: 'all', label: 'All' },
] as const;

const CONDITIONS = Object.keys(UNIT_CONDITION) as UnitCondition[];
const SOURCES = Object.keys(UNIT_SOURCE) as UnitSource[];

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function UnitsRegister({ initial }: { initial: UnitsQuery }) {
  const router = useRouter();
  const pack = useDealerPack();
  const today = todayLocal();
  const [age, setAge] = useState<{ min?: number; max?: number }>({ min: initial.minAge, max: initial.maxAge });
  const [floored, setFloored] = useState<'' | 'yes' | 'no'>(initial.floored ?? '');
  const [adding, setAdding] = useState(false);

  const startStatus = initial.status ?? 'IN_STOCK';
  const range = agingRange(today, age.min, age.max);
  const list = useDealerList<UnitView>('/api/dealer/units', {
    sort: 'received_date',
    dir: age.min ? 'asc' : 'desc',
    search: initial.q ?? '',
    from: range.from,
    to: range.to,
    filters: {
      ...(startStatus !== 'all' ? { status: startStatus } : {}),
      ...(initial.condition ? { condition: initial.condition } : {}),
    },
  });
  const { state, setFilter, setSearch, setSort, setPage, setRange } = list;

  useEffect(() => {
    const r = agingRange(today, age.min, age.max);
    setRange(r.from, r.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [age.min, age.max]);

  const rows = list.data?.rows ?? [];
  const makes = useNames('vendors', rows.map((r) => r.make_vendor_id));
  const notes = useLiveNotes(pack.locationId, rows.map((r) => r.id));
  const shown = useMemo(() => {
    if (!floored) return rows;
    return rows.filter((r) => (floored === 'yes' ? notes.byUnit.has(r.id) : !notes.byUnit.has(r.id)));
  }, [rows, floored, notes.byUnit]);

  const statusValue = state.filters.status ?? 'all';
  const segValue = STATUS_SEGMENTS.some((s) => s.value === statusValue) ? statusValue : 'all';
  const policy = pack.settings ? { aging_buckets: pack.settings.aging_buckets, term_warning_days: pack.settings.term_warning_days } : null;

  const columns: DealerColumn<UnitView>[] = [
    {
      key: 'serial',
      header: 'Serial',
      sortKey: 'serial_number',
      render: (u) => (
        <div className="min-w-0">
          <div className="font-mono tabular-nums text-white">{u.serial_number}</div>
          {u.vin_hin && <div className="font-mono text-xs tabular-nums text-slate-500">{u.vin_hin}</div>}
        </div>
      ),
    },
    { key: 'stock', header: 'Stock #', sortKey: 'stock_number', render: (u) => <span className="font-mono tabular-nums text-slate-300">{u.stock_number ?? '—'}</span> },
    { key: 'make', header: 'Make', render: (u) => <span className="text-slate-300">{nameOf(makes, u.make_vendor_id)}</span> },
    {
      key: 'model',
      header: 'Model',
      sortKey: 'model',
      render: (u) => (
        <span className="text-slate-200">
          {u.model ?? '—'}
          {u.model_year && <span className="ml-1.5 font-mono tabular-nums text-slate-500">{u.model_year}</span>}
        </span>
      ),
    },
    { key: 'condition', header: 'Condition', sortKey: 'condition', render: (u) => <Pill label={labelOf(UNIT_CONDITION, u.condition)} tone={toneOf(UNIT_CONDITION, u.condition)} dot={false} /> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (u) => <Pill label={labelOf(UNIT_STATUS, u.status)} tone={toneOf(UNIT_STATUS, u.status)} /> },
    {
      key: 'received',
      header: 'Received',
      sortKey: 'received_date',
      align: 'right',
      render: (u) => {
        const d = daysInStock(u.received_date, u.status === 'SOLD' || u.status === 'DELIVERED' ? u.sold_date ?? today : today);
        return (
          <div className="whitespace-nowrap">
            <div className="font-mono tabular-nums text-slate-200">{d === null ? '—' : daysLabel(d)}</div>
            <div className="font-mono text-xs tabular-nums text-slate-500">{dateLabel(u.received_date)}</div>
          </div>
        );
      },
    },
    { key: 'cost', header: 'Cost', sortKey: 'cost_cents', align: 'right', render: (u) => <Money cents={u.cost_cents} /> },
    {
      key: 'floor',
      header: 'Floor plan',
      align: 'right',
      render: (u) => {
        const n: NoteView | undefined = notes.byUnit.get(u.id);
        if (u.is_consignment) return <span className="text-xs text-slate-500">Consignment</span>;
        if (n)
          return (
            <div className="whitespace-nowrap">
              <Money cents={n.principal_balance_cents} />
              <div className="text-xs text-slate-500">{n.status === 'OPEN' ? 'Floored' : labelOf(NOTE_STATUS, n.status)}</div>
            </div>
          );
        if (notes.loading) return <span className="inline-block h-3 w-14 animate-pulse rounded bg-slate-800" aria-hidden />;
        return <span className="text-xs text-slate-500">Owned</span>;
      },
    },
    {
      key: 'flags',
      header: 'Flags',
      render: (u) => {
        const n = notes.byUnit.get(u.id) ?? null;
        const f = unitFlags(u, n, policy, today);
        if (f.length === 0) return <span className="text-slate-600">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {f.slice(0, 2).map((x) => (
              <Pill key={x.key} label={x.label} tone={x.tone} title={x.hint} dot={false} />
            ))}
            {f.length > 2 && <Pill label={`+${f.length - 2}`} tone="neutral" dot={false} title={f.slice(2).map((x) => x.label).join(', ')} />}
          </div>
        );
      },
    },
  ];

  function exportCsv() {
    const header = ['Serial', 'VIN/HIN', 'Stock #', 'Make', 'Model', 'Year', 'Condition', 'Status', 'Received', 'Days in stock', 'Cost', 'Floor-plan balance', 'Floor-plan status', 'Flags'];
    const lines = shown.map((u) => {
      const n = notes.byUnit.get(u.id) ?? null;
      return [
        u.serial_number,
        u.vin_hin,
        u.stock_number,
        makes.get(u.make_vendor_id ?? '')?.label ?? '',
        u.model,
        u.model_year,
        labelOf(UNIT_CONDITION, u.condition),
        labelOf(UNIT_STATUS, u.status),
        u.received_date,
        daysInStock(u.received_date, today),
        centsToInput(u.cost_cents),
        n ? centsToInput(n.principal_balance_cents) : '',
        u.is_consignment ? 'Consignment' : n ? labelOf(NOTE_STATUS, n.status) : 'Owned',
        unitFlags(u, n, policy, today).map((x) => x.label).join('; '),
      ]
        .map(csvCell)
        .join(',');
    });
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `units-${today}-page${state.page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const ageLabel =
    age.min !== undefined || age.max !== undefined
      ? age.max === undefined
        ? `${age.min}+ days in stock`
        : `${age.min ?? 0}–${age.max} days in stock`
      : null;
  const filtered = !!(state.search || state.filters.condition || state.filters.source || ageLabel || floored);

  return (
    <div>
      <PageHeader
        title="Units"
        description="Every serialized unit for this client — cost build-up, days in stock and what the floor-plan lender is owed."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={exportCsv} disabled={shown.length === 0}>
              <Download size={13} /> Export page
            </button>
            <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setAdding(true)} disabled={!pack.locationId}>
              <Plus size={13} /> Add unit
            </button>
          </>
        }
      />

      {notes.failed && (
        <Notice tone="warning">Floor-plan balances couldn’t be loaded for some units on this page. Costs and statuses are current; refresh to try again.</Notice>
      )}

      <div className="card overflow-hidden">
        <TableToolbar>
          <Segments
            label="Unit status"
            value={segValue}
            onChange={(v) => setFilter('status', v === 'all' ? null : v)}
            options={STATUS_SEGMENTS.map((s) => ({ value: s.value, label: s.label }))}
          />
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <label htmlFor="unit-search" className="sr-only">
              Search units
            </label>
            <input
              id="unit-search"
              type="search"
              value={state.search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Serial, stock #, model, VIN…"
              className="input w-full pl-8"
            />
          </div>
          <div className="w-40">
            <Select<string>
              aria-label="Condition"
              value={state.filters.condition ?? ''}
              onChange={(v) => setFilter('condition', v || null)}
              placeholder="Any condition"
              options={CONDITIONS.map((c) => ({ value: c, label: UNIT_CONDITION[c].label }))}
            />
          </div>
          <div className="w-44">
            <Select<string>
              aria-label="Source"
              value={state.filters.source ?? ''}
              onChange={(v) => setFilter('source', v || null)}
              placeholder="Any source"
              options={SOURCES.map((s) => ({ value: s, label: UNIT_SOURCE[s] }))}
            />
          </div>
          <div className="w-44">
            <Select<'' | 'yes' | 'no'>
              aria-label="Floor plan"
              value={floored}
              onChange={(v) => setFloored(v)}
              placeholder="Floored or owned"
              options={[
                { value: 'yes', label: 'On floor plan' },
                { value: 'no', label: 'Owned outright' },
              ]}
            />
          </div>
          {ageLabel && (
            <button
              type="button"
              onClick={() => setAge({})}
              className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
              aria-label={`Clear filter: ${ageLabel}`}
            >
              {ageLabel} <X size={12} />
            </button>
          )}
        </TableToolbar>
        {floored && (
          <p className="border-b border-slate-800 px-5 py-2 text-xs text-slate-500">
            The floor-plan filter applies to the units on this page ({shown.length} of {rows.length}). For the full floored list, use the floor plan’s notes.
          </p>
        )}
        <DealerTable<UnitView>
          caption="Unit register"
          columns={columns}
          rows={shown}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          dir={state.dir}
          onSort={setSort}
          onRowClick={(u) => router.push(dealerLinks.unit(u.id))}
          page={list.data?.page ?? state.page}
          perPage={list.data?.perPage ?? state.perPage}
          total={list.data?.total ?? 0}
          noun="units"
          onPageChange={setPage}
          empty={
            filtered
              ? { icon: Search, title: 'No units match', description: 'Try a different search or clear a filter.' }
              : {
                  icon: Boxes,
                  title: state.filters.status ? `No units: ${STATUS_SEGMENTS.find((x) => x.value === segValue)?.label.toLowerCase() ?? 'this status'}` : 'No units yet',
                  description: state.filters.status
                    ? 'Switch to All to see every unit, or import the dealer system’s unit list or the lender’s flooring.'
                    : 'Import the dealer system’s unit list or the lender’s flooring, or add a unit by hand.',
                  action: (
                    <div className="flex gap-2">
                      <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
                        Import units
                      </Link>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => setAdding(true)}>
                        Add a unit
                      </button>
                    </div>
                  ),
                }
          }
        />
      </div>

      {pack.locationId && (
        <AddUnitModal
          open={adding}
          onClose={() => setAdding(false)}
          locationId={pack.locationId}
          onCreated={(u) => {
            setAdding(false);
            router.push(dealerLinks.unit(u.id));
          }}
        />
      )}
    </div>
  );
}
