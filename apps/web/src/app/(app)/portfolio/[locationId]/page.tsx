'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  Landmark,
  ClipboardCheck,
  CheckCircle2,
  Inbox,
  ExternalLink,
  Building2,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { PageHeader } from '@/components/ui';

// ── Types (mirror /api/portfolio/entity → lib/portfolio/entity.ts) ─────────────

type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';

interface PeriodDelta {
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  deltaPct: number | null;
}
interface EntityPnl {
  revenue: PeriodDelta;
  grossProfit: PeriodDelta;
  netIncome: PeriodDelta;
  grossMarginPct: number;
  netMarginPct: number;
  cogsCents: number;
  opexCents: number;
  otherCents: number;
}
interface EntityBalanceSheet {
  cashCents: number;
  arCents: number;
  apCents: number;
  equityCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  balanceCheckCents: number;
  isBalanced: boolean;
  rolesResolved: { cash: boolean; ar: boolean; ap: boolean };
}
interface OverdueItem {
  id: string;
  name: string;
  reference: string;
  amountCents: number;
  bucket: string;
  dueDate: string | null;
}
interface OpenExceptionItem {
  id: string;
  feature: string;
  summary: string;
  confidence: number | null;
  createdAt: string;
}
interface EntityCloseState {
  periodId: string | null;
  periodStatus: PeriodStatus;
  closedAt: string | null;
  readyToClose: boolean;
  blockers: string[];
  blockerCount: number;
}
interface EntitySnapshot {
  locationId: string;
  name: string;
  shortCode: string;
  period: { year: number; month: number; label: string; startDate: string; endDate: string };
  priorPeriod: { year: number; month: number; label: string };
  generatedAt: string;
  pnl: EntityPnl;
  balanceSheet: EntityBalanceSheet;
  bankCashCents: number;
  minimumCashCents: number;
  overdueAr: { totalCents: number; items: OverdueItem[] };
  overdueAp: { totalCents: number; items: OverdueItem[] };
  openExceptions: { total: number; items: OpenExceptionItem[] };
  close: EntityCloseState;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function DeltaBadge({ delta }: { delta: PeriodDelta }) {
  if (delta.priorCents === 0 && delta.currentCents === 0) {
    return <span className="text-2xs text-slate-600">no prior</span>;
  }
  const up = delta.deltaCents >= 0;
  const pctText = delta.deltaPct == null ? '—' : `${delta.deltaPct > 0 ? '+' : ''}${delta.deltaPct}%`;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 text-2xs font-medium',
        up ? 'text-emerald-400' : 'text-red-400',
      )}
      title={`${formatMoney(delta.deltaCents, { showSign: true })} vs ${formatMoney(delta.priorCents)} prior`}
    >
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {pctText}
    </span>
  );
}

const CLOSE_PILL: Record<PeriodStatus, { label: string; cls: string }> = {
  HARD_CLOSE: { label: 'Closed', cls: 'border-slate-500/20 bg-slate-500/10 text-slate-300' },
  SOFT_CLOSE: { label: 'Soft close', cls: 'border-blue-500/20 bg-blue-500/10 text-blue-300' },
  OPEN: { label: 'Open', cls: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' },
  NO_PERIOD: { label: 'No period', cls: 'border-slate-600/30 bg-slate-700/20 text-slate-500' },
};

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EntitySnapshotPage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? '';

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading, error } = useQuery<EntitySnapshot>(
    locationId ? '/api/portfolio/entity' : null,
    { locationId, year: String(year), month: String(month) },
    { key: `${locationId}-${year}-${month}` },
  );

  function shiftPeriod(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  }

  return (
    <div className="pb-12">
      <Link
        href="/portfolio"
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
      >
        <ArrowLeft size={14} /> Entities
      </Link>

      <PageHeader
        title={data?.name ?? 'Company snapshot'}
        description={
          data
            ? `${data.shortCode || 'Entity'} · period snapshot — P&L, key balance-sheet lines, close and open items.`
            : 'Per-entity snapshot — mini P&L, balance-sheet lines, close status and open items.'
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftPeriod(-1)}
              className="rounded border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800"
              aria-label="Previous period"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[8rem] text-center text-sm font-medium text-slate-200">
              {data?.period.label ?? '—'}
            </span>
            <button
              onClick={() => shiftPeriod(1)}
              className="rounded border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800"
              aria-label="Next period"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-slate-500">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="card flex items-center gap-3 p-6 text-red-400">
          <AlertCircle size={18} /> <span className="text-sm">{error}</span>
        </div>
      ) : !data ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
            <Building2 size={24} className="text-slate-500" />
          </div>
          <h3 className="mb-1 text-sm font-medium text-slate-300">Company not found</h3>
          <p className="max-w-sm text-sm text-slate-500">
            This entity is not visible for the current organization.
          </p>
        </div>
      ) : (
        <Snapshot data={data} />
      )}
    </div>
  );
}

// ── Snapshot body ──────────────────────────────────────────────────────────

function Snapshot({ data }: { data: EntitySnapshot }) {
  const { pnl, balanceSheet: bs, close } = data;
  return (
    <div className="space-y-5">
      {/* Cross-links */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CrossLink href={`/reports?location_id=${data.locationId}`} label="Full reports" />
        <CrossLink href="/close" label="Close center" />
        <CrossLink href="/exceptions" label="Exceptions" />
        <CrossLink href={`/cash?location_id=${data.locationId}`} label="Cash" />
      </div>

      {/* Mini P&L */}
      <div className="card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Income statement</h3>
          <span className="text-2xs text-slate-500">
            {data.period.label} · vs {data.priorPeriod.label}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <PnlStat label="Revenue" delta={pnl.revenue} />
          <PnlStat label="Gross profit" delta={pnl.grossProfit} hint={`${pnl.grossMarginPct}% margin`} />
          <PnlStat label="Net income" delta={pnl.netIncome} hint={`${pnl.netMarginPct}% margin`} />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-800 pt-4 text-xs">
          <MiniLine label="COGS" cents={pnl.cogsCents} />
          <MiniLine label="Operating expenses" cents={pnl.opexCents} />
          <MiniLine label="Other" cents={pnl.otherCents} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Balance sheet */}
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Landmark size={15} className="text-slate-500" /> Balance sheet
            </h3>
            <span className="text-2xs text-slate-500">as of {data.period.endDate}</span>
          </div>
          <div className="space-y-2.5">
            <BsLine label="Cash" cents={bs.cashCents} unmapped={!bs.rolesResolved.cash} />
            <BsLine label="Accounts receivable" cents={bs.arCents} unmapped={!bs.rolesResolved.ar} />
            <BsLine label="Accounts payable" cents={bs.apCents} unmapped={!bs.rolesResolved.ap} />
            <BsLine label="Equity" cents={bs.equityCents} emphasize />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-4">
            <MiniLine label="Total assets" cents={bs.totalAssetsCents} />
            <MiniLine label="Total liabilities" cents={bs.totalLiabilitiesCents} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-2xs">
            {bs.isBalanced ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 size={12} /> Balanced (A = L + E)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-400">
                <AlertCircle size={12} /> Out of balance by {formatMoney(bs.balanceCheckCents)}
              </span>
            )}
          </div>
        </div>

        {/* Close + cash */}
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <ClipboardCheck size={15} className="text-slate-500" /> Close status
            </h3>
            <span
              className={clsx(
                'inline-flex items-center rounded border px-2 py-0.5 text-2xs font-medium',
                CLOSE_PILL[close.periodStatus].cls,
              )}
            >
              {CLOSE_PILL[close.periodStatus].label}
            </span>
          </div>

          {close.periodStatus === 'HARD_CLOSE' ? (
            <p className="text-sm text-slate-300">
              Period hard-closed{close.closedAt ? ` on ${shortDate(close.closedAt)}` : ''}. The books are locked.
            </p>
          ) : close.periodStatus === 'NO_PERIOD' ? (
            <p className="text-sm text-slate-500">No fiscal period exists for this month.</p>
          ) : close.readyToClose ? (
            <p className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
              <CheckCircle2 size={15} /> Ready to hard-close — no blockers.
            </p>
          ) : (
            <div>
              <p className="mb-2 text-sm text-amber-400">
                {close.blockerCount} blocker{close.blockerCount === 1 ? '' : 's'} before close:
              </p>
              <ul className="space-y-1.5">
                {close.blockers.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                    {b}
                  </li>
                ))}
              </ul>
              <Link href="/close" className="mt-3 inline-flex items-center gap-1 text-xs text-brand-400 hover:underline">
                Resolve in Close center <ExternalLink size={11} />
              </Link>
            </div>
          )}

          <div className="mt-5 border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <Wallet size={13} /> Bank cash
              </span>
              <span
                className={clsx(
                  'font-mono text-sm tabular-nums',
                  data.minimumCashCents > 0 && data.bankCashCents < data.minimumCashCents
                    ? 'text-amber-400'
                    : 'text-slate-200',
                )}
              >
                {formatMoney(data.bankCashCents)}
              </span>
            </div>
            {data.minimumCashCents > 0 && (
              <p className="mt-1 text-right text-2xs text-slate-500">
                minimum {formatMoney(data.minimumCashCents)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Top open items */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <OpenItemsCard
          title="Overdue AR"
          total={data.overdueAr.totalCents}
          href="/collections"
          icon={ArrowDownRight}
          emptyText="No overdue receivables."
          rows={data.overdueAr.items.map((i) => ({
            id: i.id,
            primary: i.name,
            secondary: `${i.reference} · ${i.bucket}`,
            amountCents: i.amountCents,
          }))}
        />
        <OpenItemsCard
          title="Overdue AP"
          total={data.overdueAp.totalCents}
          href="/bills"
          icon={ArrowUpRight}
          emptyText="No overdue payables."
          rows={data.overdueAp.items.map((i) => ({
            id: i.id,
            primary: i.name,
            secondary: `${i.reference} · ${i.bucket}`,
            amountCents: i.amountCents,
          }))}
        />
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Inbox size={15} className="text-slate-500" /> Open exceptions
            </h3>
            {data.openExceptions.total > 0 && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs font-medium text-amber-400">
                {data.openExceptions.total}
              </span>
            )}
          </div>
          {data.openExceptions.items.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">No open exceptions.</p>
          ) : (
            <ul className="space-y-2.5">
              {data.openExceptions.items.map((x) => (
                <li key={x.id} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-200">{x.feature}</span>
                    {x.confidence != null && (
                      <span className="font-mono text-2xs text-slate-500">
                        {Math.round(x.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  {x.summary && <p className="mt-0.5 truncate text-slate-500" title={x.summary}>{x.summary}</p>}
                </li>
              ))}
            </ul>
          )}
          {data.openExceptions.total > 0 && (
            <Link href="/exceptions" className="mt-3 inline-flex items-center gap-1 text-xs text-brand-400 hover:underline">
              Review all <ExternalLink size={11} />
            </Link>
          )}
        </div>
      </div>

      <p className="text-2xs text-slate-600">
        Generated {new Date(data.generatedAt).toLocaleString()} · figures from the general ledger, RLS-scoped.
      </p>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function CrossLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md border border-slate-800 px-2.5 py-1 text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
    >
      {label} <ExternalLink size={11} className="text-slate-500" />
    </Link>
  );
}

function PnlStat({ label, delta, hint }: { label: string; delta: PeriodDelta; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums tracking-tight text-white">
        {formatMoney(delta.currentCents)}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <DeltaBadge delta={delta} />
        {hint && <span className="text-2xs text-slate-500">{hint}</span>}
      </div>
    </div>
  );
}

function MiniLine({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <p className="text-2xs text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-sm tabular-nums text-slate-200">{formatMoney(cents)}</p>
    </div>
  );
}

function BsLine({
  label,
  cents,
  unmapped,
  emphasize,
}: {
  label: string;
  cents: number;
  unmapped?: boolean;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={clsx('text-sm', emphasize ? 'font-medium text-slate-200' : 'text-slate-400')}>
        {label}
        {unmapped && (
          <span className="ml-1.5 text-2xs text-slate-600" title="Account role not mapped for this tenant">
            (unmapped)
          </span>
        )}
      </span>
      <span
        className={clsx(
          'font-mono text-sm tabular-nums',
          emphasize ? 'font-semibold text-white' : 'text-slate-200',
        )}
      >
        {formatMoney(cents)}
      </span>
    </div>
  );
}

function OpenItemsCard({
  title,
  total,
  href,
  icon: Icon,
  rows,
  emptyText,
}: {
  title: string;
  total: number;
  href: string;
  icon: typeof ArrowDownRight;
  rows: { id: string; primary: string; secondary: string; amountCents: number }[];
  emptyText: string;
}) {
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Icon size={15} className="text-slate-500" /> {title}
        </h3>
        <span className={clsx('font-mono text-sm tabular-nums', total > 0 ? 'text-amber-400' : 'text-slate-500')}>
          {formatMoney(total, { compact: true })}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-500">{emptyText}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-200">{r.primary}</p>
                <p className="truncate text-2xs text-slate-500">{r.secondary}</p>
              </div>
              <span className="shrink-0 font-mono tabular-nums text-slate-300">
                {formatMoney(r.amountCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {total > 0 && (
        <Link href={href} className="mt-3 inline-flex items-center gap-1 text-xs text-brand-400 hover:underline">
          Open <ExternalLink size={11} />
        </Link>
      )}
    </div>
  );
}
