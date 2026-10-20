'use client';

/**
 * Warranty claims worklist (FPB §3.8; DL-5 / DL-6). Status pipeline with counts,
 * aging (days since submitted; amber past the client's setting) and filing-deadline
 * flags (red), sort / search / pagination, manufacturer filter, and the claim drawer
 * (`?claim=<id>`). Deep links: `?status=`, `?claim=`, `?aging=overdue|deadline|<days>`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Plus, Search, ShieldCheck, X } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { WARRANTY_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, money, moneyCompact, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { addDaysIso, warrantyAging, warrantyOpenCents, type ClaimsOverview, type WarrantyClaimRow } from '@/lib/dealer/ui/claims';
import type { WarrantyStatus } from '@/lib/dealer/types';
import { nameOf, useDealerList, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { LookupPicker } from '../../_components/lookup-picker';
import { Mono, Notice, Pill } from '../../_components/ui';
import { useUrlParams } from '../../_components/claims/use-url-params';
import { WarrantyDrawer, claimLabelOf } from './warranty-drawer';
import { WarrantyForm } from './warranty-form';

type Segment = 'ALL' | 'DRAFT' | 'SUBMITTED' | 'PARTIAL' | 'REJECTED' | 'RESUBMITTED' | 'PAID' | 'CLOSED';

const SEGMENTS: Array<{ value: Segment; label: string; statuses: WarrantyStatus[] }> = [
  { value: 'DRAFT', label: 'Draft', statuses: ['DRAFT'] },
  { value: 'SUBMITTED', label: 'Submitted', statuses: ['SUBMITTED'] },
  { value: 'PARTIAL', label: 'Partly paid', statuses: ['PARTIAL'] },
  { value: 'REJECTED', label: 'Rejected', statuses: ['REJECTED'] },
  { value: 'RESUBMITTED', label: 'Resubmitted', statuses: ['RESUBMITTED'] },
  { value: 'PAID', label: 'Paid', statuses: ['PAID'] },
  { value: 'CLOSED', label: 'Written off / charged back', statuses: ['WRITTEN_OFF', 'DEBITED'] },
  { value: 'ALL', label: 'All', statuses: [] },
];

const AWAITING = 'SUBMITTED,PARTIAL,RESUBMITTED';

function segmentFromParam(p: string | null): Segment {
  if (!p) return 'ALL';
  const up = p.toUpperCase();
  if (up === 'WRITTEN_OFF' || up === 'DEBITED') return 'CLOSED';
  return SEGMENTS.some((s) => s.value === up) ? (up as Segment) : 'ALL';
}

interface AgingView {
  key: string;
  label: string;
  statusFilter: string;
  to?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
}

function agingView(param: string | null, overdueDays: number, today: string): AgingView | null {
  if (!param) return null;
  if (param === 'deadline') return { key: param, label: 'Drafts by filing deadline (nearest first)', statusFilter: 'DRAFT', sort: 'filing_deadline', dir: 'asc' };
  const n = param === 'overdue' ? overdueDays : /^\D*(\d{1,4})\D*$/.test(param) ? Number(/(\d{1,4})/.exec(param)![1]) : null;
  if (n === null) return null;
  return { key: param, label: `Unpaid more than ${n} days`, statusFilter: AWAITING, to: addDaysIso(today, -(n + 1)), sort: 'submitted_date', dir: 'asc' };
}

export function WarrantyWorkspace() {
  const { settings, locationId } = useDealerPack();
  const url = useUrlParams();
  const today = todayLocal();
  const segment = segmentFromParam(url.get('status'));
  const claimParam = url.get('claim');
  const aging = agingView(url.get('aging'), settings?.warranty_submitted_aging_days ?? 45, today);
  const [creating, setCreating] = useState(false);

  const segStatuses = SEGMENTS.find((s) => s.value === segment)?.statuses ?? [];
  const wantStatus = aging ? aging.statusFilter : segStatuses.join(',');
  const wantTo = aging?.to;
  const list = useDealerList<WarrantyClaimRow>('/api/dealer/warranty', {
    sort: aging?.sort ?? 'created_at',
    dir: aging?.dir ?? 'desc',
    filters: wantStatus ? { status: wantStatus } : {},
    to: wantTo,
  });
  const { setFilter, setRange, setSort, state } = list;

  // Keep the list's status / aging filters in step with the URL (deep links, segments).
  useEffect(() => setFilter('status', wantStatus || null), [wantStatus, setFilter]);
  useEffect(() => setRange(undefined, wantTo), [wantTo, setRange]);
  const agingSort = aging?.sort;
  useEffect(() => {
    if (!agingSort) return;
    setSort(agingSort); // → desc
    setSort(agingSort); // → asc (oldest / nearest first)
  }, [agingSort, setSort]);

  const overview = useDealerQuery<ClaimsOverview>('/api/dealer/claims-overview', { kind: 'warranty' });
  const rows = list.data?.rows ?? [];
  const vendors = useNames('vendors', [...rows.map((r) => r.oem_vendor_id), ...(overview.data?.rejection.map((r) => r.oemVendorId) ?? [])]);

  const refreshAll = useCallback(() => {
    void list.refetch();
    void overview.refetch();
  }, [list, overview]);

  const counts = overview.data?.counts ?? {};
  const segmentOptions = SEGMENTS.map((s) => ({
    value: s.value,
    label: s.label,
    count: overview.data ? (s.value === 'ALL' ? overview.data.total : s.statuses.reduce((n, st) => n + (counts[st] ?? 0), 0)) : undefined,
  }));

  const flagged = (overview.data?.rejection ?? []).filter((r) => r.flagged);

  const columns = useMemo<DealerColumn<WarrantyClaimRow>[]>(
    () => [
      {
        key: 'claim',
        header: 'Claim',
        render: (r) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-slate-100">{r.oem_claim_number ?? r.dealer_claim_ref ?? <span className="font-sans text-slate-500">Not numbered yet</span>}</div>
            {r.repair_order_ref && <div className="truncate font-mono text-2xs text-slate-500">RO {r.repair_order_ref}</div>}
          </div>
        ),
      },
      { key: 'oem', header: 'Manufacturer', render: (r) => <span className="text-slate-300">{nameOf(vendors, r.oem_vendor_id)}</span> },
      {
        key: 'serial',
        header: 'Unit',
        render: (r) =>
          r.unit_id ? (
            <Link href={dealerLinks.unit(r.unit_id)} onClick={(e) => e.stopPropagation()} className="font-mono text-emerald-400 hover:text-emerald-300">
              {r.serial_number ?? 'Unit'}
            </Link>
          ) : (
            <Mono className="text-slate-400">{r.serial_number ?? '—'}</Mono>
          ),
      },
      { key: 'repair', header: 'Repaired', sortKey: 'repair_date', render: (r) => <Mono className="text-slate-400">{dateLabel(r.repair_date)}</Mono> },
      {
        key: 'submitted',
        header: 'Submitted',
        sortKey: 'submitted_date',
        render: (r) => {
          const a = settings ? warrantyAging(r, settings, today) : null;
          return (
            <div>
              <Mono className="text-slate-300">{dateLabel(r.submitted_date)}</Mono>
              {a?.daysOutstanding != null && (
                <div className={`font-mono text-2xs tabular-nums ${a.flag?.tone === 'warning' ? 'text-amber-400' : 'text-slate-500'}`}>{a.daysOutstanding} days</div>
              )}
            </div>
          );
        },
      },
      {
        key: 'deadline',
        header: 'Filing deadline',
        sortKey: 'filing_deadline',
        render: (r) => {
          const a = r.status === 'DRAFT' && settings ? warrantyAging(r, settings, today) : null;
          return <Mono className={a?.flag?.tone === 'danger' ? 'text-red-400' : 'text-slate-400'}>{dateLabel(r.filing_deadline)}</Mono>;
        },
      },
      { key: 'claimed', header: 'Claimed', sortKey: 'claimed_cents', align: 'right', render: (r) => <Mono className="text-white">{money(r.claimed_cents)}</Mono> },
      { key: 'settled', header: 'Paid', sortKey: 'settled_cents', align: 'right', render: (r) => <Mono className={r.settled_cents ? 'text-slate-300' : 'text-slate-600'}>{money(r.settled_cents)}</Mono> },
      {
        key: 'open',
        header: 'Open',
        align: 'right',
        render: (r) => {
          const o = r.status === 'DRAFT' || r.status === 'VOID' ? 0 : warrantyOpenCents(r);
          return <Mono className={o > 0 ? 'text-white' : 'text-slate-600'}>{money(o)}</Mono>;
        },
      },
      {
        key: 'status',
        header: 'Status',
        sortKey: 'status',
        render: (r) => {
          const a = settings ? warrantyAging(r, settings, today) : null;
          return (
            <div className="flex flex-wrap items-center gap-1">
              <Pill label={labelOf(WARRANTY_STATUS, r.status)} tone={toneOf(WARRANTY_STATUS, r.status)} />
              {a?.flag && <Pill label={a.flag.label} tone={a.flag.tone} dot={false} />}
            </div>
          );
        },
      },
    ],
    [vendors, settings, today],
  );

  if (!locationId) return null;

  return (
    <div>
      <PageHeader
        title="Warranty claims"
        description="What manufacturers owe this client for warranty repairs — from draft to paid."
        actions={
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New claim
          </button>
        }
      />

      <div className="card mb-6 grid divide-y divide-slate-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-5">
          <p className="text-caption uppercase tracking-caps text-slate-500">Owed by manufacturers</p>
          {overview.isLoading && !overview.data ? (
            <div className="mt-2 h-9 w-36 animate-pulse rounded bg-slate-800" />
          ) : (
            <p className="mt-1 font-mono text-display tabular-nums text-white">{moneyCompact(overview.data?.openCents ?? 0)}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">{overview.data ? `${overview.data.openCount} open claim${overview.data.openCount === 1 ? '' : 's'}` : ' '}</p>
        </div>
        <button type="button" onClick={() => url.set({ aging: 'overdue', status: null, claim: null })} className="p-5 text-left hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
          <p className="text-caption uppercase tracking-caps text-slate-500">Unpaid over {settings?.warranty_submitted_aging_days ?? 45} days</p>
          <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${overview.data?.overdue.count ? 'text-amber-300' : 'text-white'}`}>{money(overview.data?.overdue.cents ?? 0)}</p>
          <p className="mt-1 text-xs text-slate-500">{overview.data ? `${overview.data.overdue.count} claim${overview.data.overdue.count === 1 ? '' : 's'} — chase the manufacturer` : ' '}</p>
        </button>
        <button type="button" onClick={() => url.set({ aging: 'deadline', status: null, claim: null })} className="p-5 text-left hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
          <p className="text-caption uppercase tracking-caps text-slate-500">Drafts near their filing deadline</p>
          <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${overview.data?.deadline.count ? 'text-red-300' : 'text-white'}`}>{overview.data?.deadline.count ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">Within {settings?.warranty_deadline_warn_days ?? 5} days, or already past</p>
        </button>
      </div>

      {flagged.length > 0 && (
        <Notice tone="warning">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <div>
              {flagged.map((r) => (
                <p key={r.oemVendorId}>
                  <span className="font-medium">{nameOf(vendors, r.oemVendorId)}</span> rejected {r.rejected} of {r.submitted} claims ({bpsToPct(r.rateBps, 0)}) in the last 90 days.
                </p>
              ))}
              <p className="mt-1 text-xs text-amber-200/70">Above 10% usually means a documentation or labor-time pattern — check what was rejected before submitting more.</p>
            </div>
          </div>
        </Notice>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <Segments<Segment> label="Claim status" value={aging ? ('' as Segment) : segment} onChange={(v) => url.set({ status: v === 'ALL' ? null : v, aging: null })} options={segmentOptions} />
        </div>
        <TableToolbar>
          <div className="relative w-full max-w-xs">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              aria-label="Search claims"
              value={state.search}
              onChange={(e) => list.setSearch(e.target.value)}
              placeholder="Claim #, RO, serial…"
              className="input pl-8"
            />
          </div>
          <div className="w-56">
            <LookupPicker kind="vendors" aria-label="Filter by manufacturer" value={state.filters.oem_vendor_id ?? null} onChange={(v) => setFilter('oem_vendor_id', v)} placeholder="All manufacturers" />
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
        <DealerTable<WarrantyClaimRow>
          caption="Warranty claims"
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
          noun="claims"
          onPageChange={list.setPage}
          empty={
            state.search || state.filters.oem_vendor_id || aging || segment !== 'ALL'
              ? { icon: Search, title: 'No claims match', description: 'Try another status, manufacturer or search — or clear the filters.' }
              : {
                  icon: ShieldCheck,
                  title: 'No warranty claims yet',
                  description: 'Add a claim from a closed warranty repair order, or import the dealer system’s warranty register.',
                  action: (
                    <div className="flex gap-2">
                      <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
                        <Plus size={13} /> New claim
                      </button>
                      <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
                        Import claims
                      </Link>
                    </div>
                  ),
                }
          }
        />
      </section>
      <p className="mt-3 text-xs text-slate-500">Keyboard: j / k to move, Enter to open a claim, Esc to close it.</p>

      <WarrantyDrawer claimId={claimParam} onClose={() => url.set({ claim: null })} onChanged={refreshAll} />
      <WarrantyForm
        open={creating}
        onClose={() => setCreating(false)}
        initial={null}
        locationId={locationId}
        onSaved={(row) => {
          refreshAll();
          url.set({ claim: row.id });
        }}
      />
      <span className="sr-only" aria-live="polite">
        {claimParam && rows.find((r) => r.id === claimParam) ? `Opened ${claimLabelOf(rows.find((r) => r.id === claimParam)!)}` : ''}
      </span>
    </div>
  );
}
