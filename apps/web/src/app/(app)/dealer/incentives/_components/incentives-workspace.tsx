'use client';

/**
 * Manufacturer incentives (FPB §3.9; DL-7). Tabs: Claims (what manufacturers owe
 * under programs — earned → claimed → paid) and Programs (the client's programs and
 * their accounting treatment). Deep links: `?tab=claims|programs`, `?claim=<id>`,
 * `?status=`, `?aging=deadline|overdue`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Gift, Plus, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { INCENTIVE_STATUS, PROGRAM_TYPE, TREATMENT, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money, moneyCompact, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { incentiveAging, incentiveOpenCents, type ClaimsOverview, type IncentiveClaimRow } from '@/lib/dealer/ui/claims';
import type { IncentiveStatus } from '@/lib/dealer/types';
import { nameOf, useDealerList, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { Mono, Pill } from '../../_components/ui';
import { useUrlParams } from '../../_components/claims/use-url-params';
import { IncentiveDrawer } from './incentive-drawer';
import { AccrueModal } from './accrue-modal';
import { ProgramsTab } from './programs-tab';

type Segment = 'ALL' | 'ACCRUED' | 'SUBMITTED' | 'PARTIAL' | 'REJECTED' | 'PAID' | 'WRITTEN_OFF';
const SEGMENTS: Array<{ value: Segment; label: string; statuses: IncentiveStatus[] }> = [
  { value: 'ACCRUED', label: 'Earned — not claimed', statuses: ['ACCRUED'] },
  { value: 'SUBMITTED', label: 'Claimed', statuses: ['SUBMITTED'] },
  { value: 'PARTIAL', label: 'Partly paid', statuses: ['PARTIAL'] },
  { value: 'REJECTED', label: 'Rejected', statuses: ['REJECTED'] },
  { value: 'PAID', label: 'Paid', statuses: ['PAID'] },
  { value: 'WRITTEN_OFF', label: 'Written off', statuses: ['WRITTEN_OFF'] },
  { value: 'ALL', label: 'All', statuses: [] },
];

function segmentOf(p: string | null): Segment {
  const up = (p ?? '').toUpperCase();
  return SEGMENTS.some((s) => s.value === up) ? (up as Segment) : 'ALL';
}

export function IncentivesWorkspace() {
  const { locationId } = useDealerPack();
  const url = useUrlParams();
  const tab = url.get('tab') === 'programs' ? 'programs' : 'claims';
  const [accruing, setAccruing] = useState(false);
  if (!locationId) return null;

  return (
    <div>
      <PageHeader
        title="Manufacturer incentives"
        description="Rebates, bonuses, co-op and holdback the manufacturers owe this client — and the programs behind them."
        actions={
          tab === 'claims' ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setAccruing(true)}>
              <Plus size={13} /> Record earned incentive
            </button>
          ) : null
        }
      />
      <div role="tablist" aria-label="Incentives" className="mb-4 flex gap-1 border-b border-slate-800">
        {(['claims', 'programs'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => url.set({ tab: t === 'claims' ? null : t, claim: null, status: null, aging: null })}
            className={clsx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200')}
          >
            {t === 'claims' ? 'Claims' : 'Programs'}
          </button>
        ))}
      </div>
      {tab === 'claims' ? <ClaimsTab onAccrue={() => setAccruing(true)} accruing={accruing} setAccruing={setAccruing} /> : <ProgramsTab locationId={locationId} />}
    </div>
  );
}

function ClaimsTab({ onAccrue, accruing, setAccruing }: { onAccrue: () => void; accruing: boolean; setAccruing: (v: boolean) => void }) {
  const { settings } = useDealerPack();
  const url = useUrlParams();
  const today = todayLocal();
  const segment = segmentOf(url.get('status'));
  const agingParam = url.get('aging');
  const aging =
    agingParam === 'deadline'
      ? { label: 'Earned, not claimed — nearest claim deadline first', status: 'ACCRUED', sort: 'claim_deadline' }
      : agingParam
        ? { label: 'Claimed and unpaid — oldest first', status: 'SUBMITTED,PARTIAL', sort: 'earned_date' }
        : null;
  const claimParam = url.get('claim');
  const wantStatus = aging ? aging.status : (SEGMENTS.find((s) => s.value === segment)?.statuses ?? []).join(',');

  const list = useDealerList<IncentiveClaimRow>('/api/dealer/incentives', {
    sort: aging?.sort ?? 'earned_date',
    dir: aging ? 'asc' : 'desc',
    filters: wantStatus ? { status: wantStatus } : {},
  });
  const { setFilter, setSort, state } = list;
  useEffect(() => setFilter('status', wantStatus || null), [wantStatus, setFilter]);
  const agingSort = aging?.sort;
  useEffect(() => {
    if (!agingSort) return;
    setSort(agingSort);
    setSort(agingSort);
  }, [agingSort, setSort]);

  const overview = useDealerQuery<ClaimsOverview>('/api/dealer/claims-overview', { kind: 'incentive' });
  const rows = list.data?.rows ?? [];
  const programs = useNames('oem_programs', rows.map((r) => r.program_id));
  const units = useNames('units', rows.map((r) => r.unit_id));
  const counts = overview.data?.counts ?? {};

  const refreshAll = useCallback(() => {
    void list.refetch();
    void overview.refetch();
  }, [list, overview]);

  const columns = useMemo<DealerColumn<IncentiveClaimRow>[]>(
    () => [
      {
        key: 'program',
        header: 'Program',
        render: (r) => {
          const p = programs.get(r.program_id);
          return (
            <div className="min-w-0">
              <div className="truncate text-slate-100">{p?.label ?? '…'}</div>
              <div className="truncate text-2xs text-slate-500">{p?.meta?.type ? labelOf(PROGRAM_TYPE, String(p.meta.type)) : ''}{r.claim_reference ? ` · ${r.claim_reference}` : ''}</div>
            </div>
          );
        },
      },
      { key: 'treatment', header: 'Posts as', render: (r) => <span className="text-xs text-slate-400" title={TREATMENT[r.treatment]?.hint}>{labelOf(TREATMENT, r.treatment)}</span> },
      {
        key: 'unit',
        header: 'Unit / sale',
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            {r.unit_id ? (
              <Link href={dealerLinks.unit(r.unit_id)} onClick={(e) => e.stopPropagation()} className="font-mono text-emerald-400 hover:text-emerald-300">
                {nameOf(units, r.unit_id)}
              </Link>
            ) : (
              <span className="text-slate-600">—</span>
            )}
            {r.sale_id && (
              <Link href={dealerLinks.deal(r.sale_id)} onClick={(e) => e.stopPropagation()} className="text-2xs text-slate-400 hover:text-slate-200">
                View sale
              </Link>
            )}
          </div>
        ),
      },
      { key: 'earned', header: 'Earned', sortKey: 'earned_date', render: (r) => <Mono className="text-slate-300">{dateLabel(r.earned_date)}</Mono> },
      {
        key: 'deadline',
        header: 'Claim by',
        sortKey: 'claim_deadline',
        render: (r) => {
          const a = settings ? incentiveAging(r, settings, today) : null;
          const tone = (r.status === 'ACCRUED' || r.status === 'REJECTED') && a?.flag ? a.flag.tone : null;
          return <Mono className={tone === 'danger' ? 'text-red-400' : tone === 'warning' ? 'text-amber-400' : 'text-slate-400'}>{dateLabel(r.claim_deadline)}</Mono>;
        },
      },
      { key: 'accrued', header: 'Earned', sortKey: 'accrued_cents', align: 'right', render: (r) => <Mono className="text-white">{money(r.accrued_cents)}</Mono> },
      { key: 'claimed', header: 'Claimed', align: 'right', render: (r) => <Mono className={r.claimed_cents ? 'text-slate-300' : 'text-slate-600'}>{money(r.claimed_cents)}</Mono> },
      { key: 'settled', header: 'Paid', sortKey: 'settled_cents', align: 'right', render: (r) => <Mono className={r.settled_cents ? 'text-slate-300' : 'text-slate-600'}>{money(r.settled_cents)}</Mono> },
      {
        key: 'open',
        header: 'Open',
        align: 'right',
        render: (r) => {
          const o = r.status === 'VOID' ? 0 : incentiveOpenCents(r);
          return <Mono className={o > 0 ? 'text-white' : 'text-slate-600'}>{money(o)}</Mono>;
        },
      },
      {
        key: 'status',
        header: 'Status',
        sortKey: 'status',
        render: (r) => {
          const a = settings ? incentiveAging(r, settings, today) : null;
          return (
            <div className="flex flex-wrap items-center gap-1">
              <Pill label={labelOf(INCENTIVE_STATUS, r.status)} tone={toneOf(INCENTIVE_STATUS, r.status)} />
              {a?.flag && <Pill label={a.flag.label} tone={a.flag.tone} dot={false} />}
            </div>
          );
        },
      },
    ],
    [programs, units, settings, today],
  );

  return (
    <>
      <div className="card mb-6 grid divide-y divide-slate-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-5">
          <p className="text-caption uppercase tracking-caps text-slate-500">Owed by manufacturers</p>
          {overview.isLoading && !overview.data ? (
            <div className="mt-2 h-9 w-36 animate-pulse rounded bg-slate-800" />
          ) : (
            <p className="mt-1 font-mono text-display tabular-nums text-white">{moneyCompact(overview.data?.openCents ?? 0)}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">{overview.data ? `${overview.data.openCount} open incentive${overview.data.openCount === 1 ? '' : 's'}` : ' '}</p>
        </div>
        <button type="button" onClick={() => url.set({ aging: 'deadline', status: null, claim: null })} className="p-5 text-left hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
          <p className="text-caption uppercase tracking-caps text-slate-500">Not claimed — deadline close</p>
          <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${overview.data?.deadline.count ? 'text-red-300' : 'text-white'}`}>{money(overview.data?.deadline.cents ?? 0)}</p>
          <p className="mt-1 text-xs text-slate-500">{overview.data ? `${overview.data.deadline.count} within ${settings?.incentive_deadline_warn_days ?? 10} days or past` : ' '}</p>
        </button>
        <button type="button" onClick={() => url.set({ aging: 'overdue', status: null, claim: null })} className="p-5 text-left hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
          <p className="text-caption uppercase tracking-caps text-slate-500">Claimed, unpaid over {settings?.incentive_submitted_aging_days ?? 60} days</p>
          <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${overview.data?.overdue.count ? 'text-amber-300' : 'text-white'}`}>{money(overview.data?.overdue.cents ?? 0)}</p>
          <p className="mt-1 text-xs text-slate-500">{overview.data ? `${overview.data.overdue.count} to chase` : ' '}</p>
        </button>
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
          <Segments<Segment>
            label="Incentive status"
            value={aging ? ('' as Segment) : segment}
            onChange={(v) => url.set({ status: v === 'ALL' ? null : v, aging: null })}
            options={SEGMENTS.map((s) => ({ value: s.value, label: s.label, count: overview.data ? (s.value === 'ALL' ? overview.data.total : s.statuses.reduce((n, st) => n + (counts[st] ?? 0), 0)) : undefined }))}
          />
        </div>
        <TableToolbar>
          <div className="relative w-full max-w-xs">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input aria-label="Search incentive claims" value={state.search} onChange={(e) => list.setSearch(e.target.value)} placeholder="Claim reference…" className="input pl-8" />
          </div>
          {aging && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 py-1 pl-3 pr-1.5 text-xs text-slate-300">
              {aging.label}
              <button type="button" aria-label="Clear aging filter" onClick={() => url.set({ aging: null })} className="rounded-full p-0.5 text-slate-500 hover:text-slate-200">
                <X size={12} />
              </button>
            </span>
          )}
        </TableToolbar>
        <DealerTable<IncentiveClaimRow>
          caption="Incentive claims"
          columns={columns}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          dir={state.dir}
          onSort={list.setSort}
          onRowClick={(r) => url.set({ claim: r.id })}
          selectedId={claimParam}
          page={state.page}
          perPage={state.perPage}
          total={list.data?.total ?? 0}
          noun="incentives"
          onPageChange={list.setPage}
          empty={
            state.search || aging || segment !== 'ALL'
              ? { icon: Search, title: 'No incentives match', description: 'Try another status or search — or clear the filters.' }
              : {
                  icon: Gift,
                  title: 'No incentives recorded yet',
                  description: 'Record a dealer rebate, volume bonus or co-op earned under an approved program. Retail rebates are captured on the unit sale.',
                  action: (
                    <button type="button" className="btn-primary btn-sm" onClick={onAccrue}>
                      <Plus size={13} /> Record earned incentive
                    </button>
                  ),
                }
          }
        />
      </section>
      <p className="mt-3 text-xs text-slate-500">Keyboard: j / k to move, Enter to open an incentive, Esc to close it.</p>

      <IncentiveDrawer claimId={claimParam} onClose={() => url.set({ claim: null })} onChanged={refreshAll} />
      <AccrueModal
        open={accruing}
        onClose={() => setAccruing(false)}
        onSaved={(row) => {
          refreshAll();
          url.set({ claim: row.id });
        }}
      />
    </>
  );
}
