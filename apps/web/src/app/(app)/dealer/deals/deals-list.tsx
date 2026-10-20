'use client';

/**
 * Deals (GET /api/dealer/sales) and trade-ins (GET /api/dealer/trade-ins) for the
 * client — server-paginated, sortable, filterable, debounced search. Each row
 * opens the deal recap.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { HandCoins, Repeat, Search } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import type { LienStatus, RowStatus, SaleSource, TradeStatus } from '@/lib/dealer/types';
import { LIEN_STATUS, SALE_SOURCE, TRADE_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { SALE_STATUS } from '@/lib/dealer/ui/unit-deal-labels';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { lienUnpaid } from '@/lib/dealer/ui/deal-math';
import type { SaleView, TradeView } from '@/lib/dealer/ui/unit-deal-types';
import { useDealerPack } from '../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../_components/dealer-table';
import { DateInput, Select } from '../_components/forms';
import { Money, Pill } from '../_components/ui';
import { nameOf, useDealerList, useNames } from '../_lib/use-dealer';

type Tab = 'deals' | 'trades';
const SALE_STATUSES: RowStatus[] = ['PROPOSED', 'POSTED', 'VOID'];
const TRADE_STATUSES: TradeStatus[] = ['DRAFT', 'APPROVED', 'POSTED', 'VOID'];
const LIENS: LienStatus[] = ['OWED', 'PROPOSED', 'PAID', 'NONE'];

function SearchBox({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <input id={id} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input w-full pl-8" />
    </div>
  );
}

function DealsTab({ initialStatus }: { initialStatus?: string }) {
  const router = useRouter();
  const startStatus = initialStatus && SALE_STATUSES.includes(initialStatus as RowStatus) ? initialStatus : undefined;
  const list = useDealerList<SaleView>('/api/dealer/sales', { sort: 'sale_date', filters: startStatus ? { status: startStatus } : {} });
  const { state } = list;
  const rows = list.data?.rows ?? [];
  const units = useNames('units', rows.map((r) => r.unit_id));
  const customers = useNames('customers', rows.map((r) => r.customer_id));

  const columns: DealerColumn<SaleView>[] = [
    { key: 'date', header: 'Sale date', sortKey: 'sale_date', render: (s) => <span className="whitespace-nowrap font-mono tabular-nums text-slate-300">{dateLabel(s.sale_date)}</span> },
    {
      key: 'unit',
      header: 'Unit',
      render: (s) => (
        <div>
          <div className="font-mono tabular-nums text-white">{nameOf(units, s.unit_id)}</div>
          <div className="text-xs text-slate-500">{units.get(s.unit_id)?.sub ?? ''}</div>
        </div>
      ),
    },
    { key: 'customer', header: 'Customer', render: (s) => <span className="text-slate-300">{nameOf(customers, s.customer_id)}</span> },
    { key: 'price', header: 'Price', sortKey: 'sale_price_cents', align: 'right', render: (s) => <Money cents={s.sale_price_cents} /> },
    { key: 'trade', header: 'Trade', render: (s) => (s.trade_in_id ? <Pill label="Trade-in" tone="info" dot={false} /> : <span className="text-slate-600">—</span>) },
    { key: 'source', header: 'Source', sortKey: 'source', render: (s) => <span className="text-body-sm text-slate-400">{labelOf(SALE_SOURCE, s.source)}</span> },
    { key: 'ref', header: 'Deal #', render: (s) => <span className="font-mono tabular-nums text-slate-400">{s.external_deal_ref ?? '—'}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (s) => <Pill label={labelOf(SALE_STATUS, s.status)} tone={toneOf(SALE_STATUS, s.status)} /> },
  ];

  return (
    <>
      <TableToolbar>
        <Segments<string>
          label="Deal status"
          value={state.filters.status ?? 'all'}
          onChange={(v) => list.setFilter('status', v === 'all' ? null : v)}
          options={[{ value: 'all', label: 'All' }, ...SALE_STATUSES.map((s) => ({ value: s, label: SALE_STATUS[s].label }))]}
        />
        <SearchBox id="deal-search" value={state.search} onChange={list.setSearch} placeholder="Deal #, salesperson…" />
        <div className="w-48">
          <Select<SaleSource | ''>
            aria-label="Source"
            value={(state.filters.source as SaleSource | undefined) ?? ''}
            onChange={(v) => list.setFilter('source', v || null)}
            placeholder="Any source"
            options={(Object.keys(SALE_SOURCE) as SaleSource[]).map((s) => ({ value: s, label: SALE_SOURCE[s] }))}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-36">
            <DateInput aria-label="Sold from" value={state.from ?? ''} onChange={(v) => list.setRange(v || undefined, state.to)} />
          </div>
          <span className="text-xs text-slate-500">to</span>
          <div className="w-36">
            <DateInput aria-label="Sold to" value={state.to ?? ''} onChange={(v) => list.setRange(state.from, v || undefined)} />
          </div>
        </div>
      </TableToolbar>
      <DealerTable<SaleView>
        caption="Deals"
        columns={columns}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={state.sort}
        dir={state.dir}
        onSort={list.setSort}
        onRowClick={(s) => router.push(dealerLinks.deal(s.id))}
        page={list.data?.page ?? state.page}
        perPage={list.data?.perPage ?? state.perPage}
        total={list.data?.total ?? 0}
        noun="deals"
        onPageChange={list.setPage}
        empty={
          state.search || state.from || state.to || state.filters.source || state.filters.status
            ? { icon: Search, title: 'No deals match', description: 'Try a different status, date range or search.' }
            : {
                icon: HandCoins,
                title: 'No deals yet',
                description: 'Record a sale from a unit’s page, or import the dealer system’s deals.',
                action: (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => router.push(dealerLinks.units({ status: 'IN_STOCK' }))}>
                    Choose a unit to sell
                  </button>
                ),
              }
        }
      />
    </>
  );
}

function TradesTab({ initialStatus }: { initialStatus?: string }) {
  const router = useRouter();
  const pack = useDealerPack();
  const today = todayLocal();
  const startStatus = initialStatus && TRADE_STATUSES.includes(initialStatus as TradeStatus) ? initialStatus : undefined;
  const list = useDealerList<TradeView>('/api/dealer/trade-ins', { sort: 'created_at', filters: startStatus ? { status: startStatus } : {} });
  const { state } = list;
  const rows = list.data?.rows ?? [];
  const lienholders = useNames('vendors', rows.map((r) => r.lienholder_vendor_id));
  const limit = pack.settings?.lien_unpaid_days ?? 10;

  const columns: DealerColumn<TradeView>[] = [
    { key: 'created', header: 'Recorded', sortKey: 'created_at', render: (t) => <span className="whitespace-nowrap font-mono tabular-nums text-slate-300">{dateLabel(t.created_at.slice(0, 10))}</span> },
    {
      key: 'serial',
      header: 'Trade-in',
      render: (t) => (
        <div>
          <div className="font-mono tabular-nums text-white">{t.serial_number ?? '—'}</div>
          <div className="text-xs text-slate-500">{[t.model_year, t.model].filter(Boolean).join(' ') || ''}</div>
        </div>
      ),
    },
    { key: 'allowance', header: 'Allowance', sortKey: 'allowance_cents', align: 'right', render: (t) => <Money cents={t.allowance_cents} /> },
    { key: 'acv', header: 'Appraised (ACV)', sortKey: 'acv_cents', align: 'right', render: (t) => <Money cents={t.acv_cents} muted /> },
    { key: 'recorded', header: 'On the books at', align: 'right', render: (t) => <Money cents={t.recorded_value_cents} /> },
    {
      key: 'over',
      header: 'Over-allowance',
      align: 'right',
      render: (t) => (t.over_allowance_cents > 0 ? <span className="font-mono tabular-nums text-amber-300">{money(t.over_allowance_cents)}</span> : <span className="text-slate-600">—</span>),
    },
    {
      key: 'lien',
      header: 'Lien',
      sortKey: 'lien_status',
      render: (t) => {
        const clock = lienUnpaid(t.lien_status, t.created_at.slice(0, 10), today, limit);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill label={labelOf(LIEN_STATUS, t.lien_status)} tone={toneOf(LIEN_STATUS, t.lien_status)} />
            {t.lien_payoff_cents > 0 && <Money cents={t.lien_payoff_cents} muted className="text-xs" />}
            {clock?.overdue && <Pill label={`Unpaid ${clock.days} days`} tone="warning" dot={false} title={`More than ${limit} days since the deal — the dealer can’t get clean title until it’s paid.`} />}
            {t.lienholder_vendor_id && <span className="text-xs text-slate-500">{nameOf(lienholders, t.lienholder_vendor_id)}</span>}
          </div>
        );
      },
    },
    { key: 'status', header: 'Status', sortKey: 'status', render: (t) => <Pill label={labelOf(TRADE_STATUS, t.status)} tone={toneOf(TRADE_STATUS, t.status)} /> },
  ];

  return (
    <>
      <TableToolbar>
        <Segments<string>
          label="Trade-in status"
          value={state.filters.status ?? 'all'}
          onChange={(v) => list.setFilter('status', v === 'all' ? null : v)}
          options={[{ value: 'all', label: 'All' }, ...TRADE_STATUSES.map((s) => ({ value: s, label: TRADE_STATUS[s].label }))]}
        />
        <SearchBox id="trade-search" value={state.search} onChange={list.setSearch} placeholder="Serial, model…" />
        <div className="w-48">
          <Select<LienStatus | ''>
            aria-label="Lien"
            value={(state.filters.lien_status as LienStatus | undefined) ?? ''}
            onChange={(v) => list.setFilter('lien_status', v || null)}
            placeholder="Any lien status"
            options={LIENS.map((s) => ({ value: s, label: LIEN_STATUS[s].label }))}
          />
        </div>
      </TableToolbar>
      <DealerTable<TradeView>
        caption="Trade-ins"
        columns={columns}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={state.sort}
        dir={state.dir}
        onSort={list.setSort}
        onRowClick={(t) => t.sale_id && router.push(dealerLinks.deal(t.sale_id))}
        page={list.data?.page ?? state.page}
        perPage={list.data?.perPage ?? state.perPage}
        total={list.data?.total ?? 0}
        noun="trade-ins"
        onPageChange={list.setPage}
        empty={
          state.search || state.filters.status || state.filters.lien_status
            ? { icon: Search, title: 'No trade-ins match', description: 'Try a different status or search.' }
            : { icon: Repeat, title: 'No trade-ins yet', description: 'Trade-ins are recorded as part of a deal — add one when you record the sale.' }
        }
      />
    </>
  );
}

export function DealsList({ initialTab, initialStatus }: { initialTab: Tab; initialStatus?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div>
      <PageHeader title="Deals & trade-ins" description="Unit sales, what each customer owes, and the trade-ins taken in — with appraisal approvals and lien payoffs." />
      <div className="mb-4">
        <Segments<Tab>
          label="Deals or trade-ins"
          value={tab}
          onChange={(t) => {
            setTab(t);
            router.replace(dealerLinks.deals({ tab: t }), { scroll: false });
          }}
          options={[
            { value: 'deals', label: 'Deals' },
            { value: 'trades', label: 'Trade-ins' },
          ]}
        />
      </div>
      <div className="card overflow-hidden">{tab === 'deals' ? <DealsTab initialStatus={initialStatus} /> : <TradesTab initialStatus={initialStatus} />}</div>
    </div>
  );
}
