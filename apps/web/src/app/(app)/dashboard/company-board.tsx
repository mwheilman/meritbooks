export const dynamic = 'force-dynamic';

import Link from 'next/link';
import {
  Building2,
  Wallet,
  ArrowDownRight,
  ArrowUpRight,
  AlertTriangle,
  Inbox,
  Sparkles,
  FileEdit,
  ArrowRight,
  Layers,
  ClipboardCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { EnterCompany } from './enter-company';
import {
  getWorkboard,
  type CompanyBoard,
  type PeriodStatus,
  type CashStatus,
} from './actions';

// ── Small presentational helpers ──────────────────────────────────────────────

const PERIOD_CONFIG: Record<PeriodStatus, { label: string; className: string }> = {
  OPEN: { label: 'Open', className: 'text-emerald-400 bg-emerald-500/10' },
  SOFT_CLOSE: { label: 'Soft close', className: 'text-amber-400 bg-amber-500/10' },
  HARD_CLOSE: { label: 'Closed', className: 'text-slate-400 bg-slate-500/10' },
  NO_PERIOD: { label: 'No period', className: 'text-slate-500 bg-slate-800/60' },
};

const CASH_CONFIG: Record<CashStatus, { label: string; className: string; dot: string }> = {
  HEALTHY: { label: 'Healthy', className: 'text-emerald-400', dot: 'bg-emerald-400' },
  ADEQUATE: { label: 'Adequate', className: 'text-blue-400', dot: 'bg-blue-400' },
  NEAR_MINIMUM: { label: 'Near min', className: 'text-amber-400', dot: 'bg-amber-400' },
  BELOW_MINIMUM: { label: 'Below min', className: 'text-red-400', dot: 'bg-red-400' },
  UNKNOWN: { label: '', className: 'text-slate-500', dot: 'bg-slate-600' },
};

/** A clickable work-count tile that pins the company and jumps into its queue. */
function StatTile({
  companyId,
  href,
  icon: Icon,
  label,
  count,
  tone,
}: {
  companyId: string;
  href: string;
  icon: typeof Inbox;
  label: string;
  count: number;
  tone: 'neutral' | 'amber' | 'indigo' | 'purple';
}) {
  const active = count > 0;
  const toneText =
    !active
      ? 'text-slate-600'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'indigo'
          ? 'text-indigo-400'
          : tone === 'purple'
            ? 'text-purple-400'
            : 'text-slate-200';

  return (
    <EnterCompany
      companyId={companyId}
      href={href}
      className={clsx(
        'flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
        active
          ? 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-800/50'
          : 'border-slate-800/60 bg-slate-900/20 hover:bg-slate-900/40',
      )}
    >
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-slate-500">
        <Icon size={12} className={active ? toneText : 'text-slate-600'} />
        {label}
      </span>
      <span className={clsx('font-mono text-lg font-semibold tabular-nums leading-none', toneText)}>
        {count}
      </span>
    </EnterCompany>
  );
}

/** A read-only KPI figure (cash / AR / AP). */
function Kpi({
  icon: Icon,
  label,
  value,
  valueClassName,
  hint,
  hintClassName,
  dotClassName,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  valueClassName?: string;
  hint?: string;
  hintClassName?: string;
  dotClassName?: string;
}) {
  return (
    <div className="flex-1">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-slate-500">
        <Icon size={12} />
        {label}
      </div>
      <div className={clsx('mt-1 font-mono text-sm font-semibold tabular-nums', valueClassName ?? 'text-slate-200')}>
        {value}
      </div>
      {hint && (
        <div className={clsx('mt-0.5 flex items-center gap-1 text-2xs', hintClassName ?? 'text-slate-500')}>
          {dotClassName && <span className={clsx('h-1.5 w-1.5 rounded-full', dotClassName)} />}
          {hint}
        </div>
      )}
    </div>
  );
}

// ── Company card ──────────────────────────────────────────────────────────────

function CompanyCard({ co }: { co: CompanyBoard }) {
  const period = PERIOD_CONFIG[co.periodStatus];
  const cash = CASH_CONFIG[co.cashStatus];
  const needsWork = co.totalOpen > 0;

  return (
    <div className="card flex flex-col overflow-hidden">
      {/* Header — name + short code enter the workspace; period status at a glance. */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <EnterCompany companyId={co.id} href="/bank-feed" className="group flex min-w-0 items-center gap-2.5 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/10">
            <Building2 size={15} className="text-brand-400" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-white transition-colors group-hover:text-brand-300">
              {co.name}
            </span>
            <span className="font-mono text-2xs uppercase tracking-wider text-slate-500">{co.shortCode}</span>
          </span>
        </EnterCompany>
        <span
          className={clsx(
            'shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium',
            period.className,
          )}
          title="Current-month fiscal period"
        >
          {period.label}
        </span>
      </div>

      {/* Work queues — each tile pins the company and jumps into that queue. */}
      <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-4">
        <StatTile
          companyId={co.id}
          href="/bank-feed"
          icon={Inbox}
          label="To review"
          count={co.toReview}
          tone="neutral"
        />
        <StatTile
          companyId={co.id}
          href="/exceptions"
          icon={AlertTriangle}
          label="Attention"
          count={co.needsAttention}
          tone="amber"
        />
        <StatTile
          companyId={co.id}
          href="/ai-decisions"
          icon={Sparkles}
          label="Proposals"
          count={co.openExceptions}
          tone="indigo"
        />
        <StatTile
          companyId={co.id}
          href="/journal-entries"
          icon={FileEdit}
          label="Draft JEs"
          count={co.draftJEs}
          tone="purple"
        />
      </div>

      {/* KPIs — read-only book-of-record figures. */}
      <div className="flex items-start gap-4 border-t border-slate-800/60 px-4 py-3">
        <Kpi
          icon={Wallet}
          label="Cash"
          value={formatMoney(co.cashCents, { compact: true })}
          valueClassName={cash.className}
          hint={cash.label || undefined}
          hintClassName={cash.label ? cash.className : undefined}
          dotClassName={cash.label ? cash.dot : undefined}
        />
        <Kpi
          icon={ArrowUpRight}
          label="Open AR"
          value={formatMoney(co.openARCents, { compact: true })}
        />
        <Kpi
          icon={ArrowDownRight}
          label="Open AP"
          value={formatMoney(co.openAPCents, { compact: true })}
        />
      </div>

      {/* Primary action — enter the company workspace. */}
      <div className="mt-auto flex items-center justify-between border-t border-slate-800/60 bg-slate-900/30 px-4 py-2.5">
        <span className="text-2xs text-slate-500">
          {needsWork ? `${co.totalOpen} item${co.totalOpen === 1 ? '' : 's'} need work` : 'All caught up'}
        </span>
        <EnterCompany
          companyId={co.id}
          href="/bank-feed"
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-500/10 px-2.5 py-1 text-xs font-medium text-brand-300 transition-colors hover:bg-brand-500/20"
        >
          Enter workspace <ArrowRight size={13} />
        </EnterCompany>
      </div>
    </div>
  );
}

// ── Consolidated strip (leadership view — read-only) ──────────────────────────

function ConsolStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Layers;
  label: string;
  value: string;
  tone?: 'amber' | 'indigo' | 'default';
}) {
  const valueTone =
    tone === 'amber' ? 'text-amber-400' : tone === 'indigo' ? 'text-indigo-400' : 'text-white';
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/70">
        <Icon size={15} className="text-slate-400" />
      </span>
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
        <div className={clsx('font-mono text-base font-semibold tabular-nums', valueTone)}>{value}</div>
      </div>
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

export async function CompanyBoardGrid() {
  const board = await getWorkboard();

  if (board.status === 'error') {
    return (
      <div className="card px-5 py-10 text-center">
        <AlertTriangle size={22} className="mx-auto mb-3 text-amber-400" />
        <p className="text-sm font-medium text-slate-300">Couldn&apos;t load your companies</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
          There was a problem reading the workboard. Refresh the page to try again — if it keeps
          happening, your session may have expired.
        </p>
      </div>
    );
  }

  if (board.status === 'empty' || board.companies.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center px-5 py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
          <Building2 size={24} className="text-slate-500" />
        </div>
        <h3 className="text-sm font-medium text-slate-300">No companies yet</h3>
        <p className="mx-auto mt-1 mb-4 max-w-sm text-sm text-slate-500">
          Set up your first company to start posting transactions and processing work. Onboarding
          walks you through the chart of accounts, fiscal calendar, and opening balances.
        </p>
        <Link href="/onboarding" className="btn-primary btn-sm">
          Start onboarding
        </Link>
      </div>
    );
  }

  const c = board.consolidated;

  return (
    <div className="space-y-5">
      {/* Consolidated strip — clearly read-only, all companies rolled up. */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-white">Consolidated</h2>
            <span className="rounded-full bg-slate-800/70 px-2 py-0.5 text-2xs font-medium text-slate-400">
              Read-only · {c.companyCount} {c.companyCount === 1 ? 'company' : 'companies'}
            </span>
          </div>
          {c.companiesClosed > 0 && (
            <span className="flex items-center gap-1 text-2xs text-slate-500">
              <ClipboardCheck size={12} className="text-emerald-400" />
              {c.companiesClosed} closed this period
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-800/60 sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          <ConsolStat icon={Inbox} label="To review" value={c.toReview.toLocaleString()} />
          <ConsolStat icon={AlertTriangle} label="Needs attention" value={c.needsAttention.toLocaleString()} tone="amber" />
          <ConsolStat icon={ClipboardCheck} label="Approvals" value={c.pendingApprovals.toLocaleString()} tone="indigo" />
          <ConsolStat icon={Wallet} label="Cash" value={formatMoney(c.cashCents, { compact: true })} />
          <ConsolStat icon={ArrowUpRight} label="Open AR" value={formatMoney(c.openARCents, { compact: true })} />
          <ConsolStat icon={ArrowDownRight} label="Open AP" value={formatMoney(c.openAPCents, { compact: true })} />
        </div>
      </div>

      {/* Per-company work board. */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Your companies</h2>
          <span className="text-2xs text-slate-500">Select a company to start working in it</span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {board.companies.map((co) => (
            <CompanyCard key={co.id} co={co} />
          ))}
        </div>
      </div>
    </div>
  );
}
