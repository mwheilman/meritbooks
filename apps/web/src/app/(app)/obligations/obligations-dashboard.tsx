'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import {
  Loader2,
  AlertCircle,
  CalendarClock,
  RefreshCw,
  Landmark,
  ShieldCheck,
  ShieldAlert,
  FileText,
  Repeat,
  CreditCard,
  Building2,
  ChevronRight,
  CheckCircle2,
} from 'lucide-react';
import type { Obligation, ObligationType, HorizonBucket } from '@/lib/obligations/collect';

interface ObligationsResponse {
  asOf: string;
  horizonDays: number;
  obligations: Obligation[];
  buckets: Record<HorizonBucket, Obligation[]>;
  summary: {
    total: number;
    overdue: number;
    d30: number;
    d60: number;
    d90: number;
    amountCentsAtRisk: number;
  };
  degraded: string[];
}

// --- Type presentation -----------------------------------------------------

const TYPE_META: Record<
  ObligationType,
  { label: string; icon: typeof Landmark; badge: string }
> = {
  LEASE: { label: 'Lease', icon: Building2, badge: 'bg-sky-500/10 text-sky-300 ring-sky-500/20' },
  DEBT_MATURITY: { label: 'Debt', icon: Landmark, badge: 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/20' },
  DEBT_PAYMENT: { label: 'Debt payment', icon: Landmark, badge: 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/20' },
  COVENANT: { label: 'Covenant', icon: ShieldCheck, badge: 'bg-violet-500/10 text-violet-300 ring-violet-500/20' },
  INSURANCE: { label: 'Insurance', icon: ShieldAlert, badge: 'bg-teal-500/10 text-teal-300 ring-teal-500/20' },
  SUBSCRIPTION: { label: 'Subscription', icon: Repeat, badge: 'bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-500/20' },
  VENDOR_W9: { label: 'W-9', icon: FileText, badge: 'bg-amber-500/10 text-amber-300 ring-amber-500/20' },
  VENDOR_COI: { label: 'COI', icon: FileText, badge: 'bg-amber-500/10 text-amber-300 ring-amber-500/20' },
  RECURRING_INVOICE: { label: 'Recurring invoice', icon: CreditCard, badge: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20' },
};

const HORIZON_SECTIONS: Array<{ key: HorizonBucket; title: string; hint: string }> = [
  { key: 'OVERDUE', title: 'Overdue', hint: 'Past due — act now' },
  { key: 'D30', title: 'Due within 30 days', hint: 'Next 30 days' },
  { key: 'D60', title: 'Due in 31–60 days', hint: '31 to 60 days out' },
  { key: 'D90', title: 'Due in 61–90 days', hint: '61 to 90 days out' },
];

const TYPE_FILTERS: Array<{ value: ObligationType | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'LEASE', label: 'Leases' },
  { value: 'DEBT_MATURITY', label: 'Debt maturities' },
  { value: 'DEBT_PAYMENT', label: 'Debt payments' },
  { value: 'COVENANT', label: 'Covenants' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'SUBSCRIPTION', label: 'Subscriptions' },
  { value: 'VENDOR_COI', label: 'COI' },
  { value: 'VENDOR_W9', label: 'W-9' },
  { value: 'RECURRING_INVOICE', label: 'Recurring' },
];

const HORIZON_OPTIONS = [30, 60, 90, 180, 365];

function relativeDue(days: number): { text: string; tone: string } {
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: 'text-red-400' };
  if (days === 0) return { text: 'Due today', tone: 'text-red-400' };
  if (days <= 7) return { text: `in ${days}d`, tone: 'text-amber-400' };
  if (days <= 30) return { text: `in ${days}d`, tone: 'text-slate-300' };
  return { text: `in ${days}d`, tone: 'text-slate-500' };
}

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// --- Row -------------------------------------------------------------------

function ObligationRow({ o }: { o: Obligation }) {
  const meta = TYPE_META[o.type];
  const Icon = meta.icon;
  const rel = relativeDue(o.daysUntil);

  return (
    <Link
      href={o.href}
      className="group flex items-center gap-4 rounded-lg border border-slate-800 bg-surface-900 px-4 py-3 transition hover:border-slate-700 hover:bg-slate-800/40"
    >
      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-800/60 text-slate-400">
        <Icon size={16} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'inline-flex flex-none items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
              meta.badge,
            )}
          >
            {meta.label}
          </span>
          <span className="truncate text-sm font-medium text-white">{o.title}</span>
        </div>
        {o.subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{o.subtitle}</p>}
      </div>

      <div className="flex-none text-right">
        {o.amountCents !== null && (
          <p className="font-mono text-sm text-slate-200">{formatMoney(o.amountCents)}</p>
        )}
        <p className="text-xs text-slate-500">{formatDate(o.dueDate)}</p>
      </div>

      <div className="flex w-24 flex-none items-center justify-end gap-1">
        <span className={clsx('font-mono text-xs font-medium', rel.tone)}>{rel.text}</span>
        <ChevronRight size={16} className="text-slate-600 transition group-hover:text-slate-400" />
      </div>
    </Link>
  );
}

// --- Metric card -----------------------------------------------------------

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg font-semibold', tone ?? 'text-white')}>{value}</p>
    </div>
  );
}

// --- Dashboard -------------------------------------------------------------

export function ObligationsDashboard() {
  const [horizon, setHorizon] = useState(90);
  const [typeFilter, setTypeFilter] = useState<ObligationType | 'ALL'>('ALL');

  const params = useMemo<Record<string, string>>(() => {
    const p: Record<string, string> = { horizon: String(horizon) };
    if (typeFilter !== 'ALL') p.type = typeFilter;
    return p;
  }, [horizon, typeFilter]);

  const { data, error, isLoading, refetch } = useQuery<ObligationsResponse>('/api/obligations', params);

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="mr-2 animate-spin" size={18} />
        Loading obligations…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-red-900/40 bg-red-950/20 py-16 text-center">
        <AlertCircle className="mb-3 text-red-400" size={28} />
        <p className="text-sm font-medium text-red-300">Could not load the obligations calendar</p>
        <p className="mt-1 max-w-md text-xs text-slate-500">{error}</p>
        <button onClick={() => refetch()} className="btn-secondary btn-sm mt-4">
          <RefreshCw size={14} className="mr-1.5" />
          Retry
        </button>
      </div>
    );
  }

  const summary = data?.summary;
  const buckets = data?.buckets;

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Metric label="Coming due" value={String(summary?.total ?? 0)} />
        <Metric
          label="Overdue"
          value={String(summary?.overdue ?? 0)}
          tone={(summary?.overdue ?? 0) > 0 ? 'text-red-400' : 'text-white'}
        />
        <Metric label="Next 30 days" value={String(summary?.d30 ?? 0)} tone="text-amber-400" />
        <Metric label="31–90 days" value={String((summary?.d60 ?? 0) + (summary?.d90 ?? 0))} />
        <Metric
          label="Amount at risk"
          value={formatMoney(summary?.amountCentsAtRisk ?? 0, { compact: true })}
          tone="text-slate-200"
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={clsx(
                'rounded-full px-3 py-1 text-xs font-medium transition',
                typeFilter === f.value
                  ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30'
                  : 'bg-slate-800/50 text-slate-400 hover:text-slate-200',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="horizon" className="text-xs text-slate-500">
            Horizon
          </label>
          <select
            id="horizon"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            className="rounded-lg border border-slate-800 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500/50 focus:outline-none"
          >
            {HORIZON_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Next {d} days
              </option>
            ))}
          </select>
          <button onClick={() => refetch()} className="btn-secondary btn-sm" title="Refresh">
            <RefreshCw size={14} className={clsx(isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Degraded-source note */}
      {data && data.degraded.length > 0 && (
        <p className="rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-2 text-xs text-amber-400/80">
          Some sources were unavailable and skipped: {data.degraded.join(', ')}. The rest of the
          calendar is complete.
        </p>
      )}

      {/* Empty state */}
      {summary && summary.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-surface-900 py-20 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <CheckCircle2 size={24} className="text-emerald-400" />
          </div>
          <h3 className="text-sm font-medium text-slate-200">Nothing due</h3>
          <p className="mt-1 max-w-sm text-sm text-slate-500">
            No obligations fall within the next {horizon} days
            {typeFilter !== 'ALL' ? ' for this type' : ''}. You&apos;re all caught up — nothing is
            about to lapse.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {HORIZON_SECTIONS.map((section) => {
            const items = buckets?.[section.key] ?? [];
            if (items.length === 0) return null;
            return (
              <section key={section.key}>
                <div className="mb-3 flex items-center gap-2">
                  <CalendarClock
                    size={16}
                    className={section.key === 'OVERDUE' ? 'text-red-400' : 'text-slate-500'}
                  />
                  <h2
                    className={clsx(
                      'text-sm font-semibold',
                      section.key === 'OVERDUE' ? 'text-red-400' : 'text-slate-200',
                    )}
                  >
                    {section.title}
                  </h2>
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                    {items.length}
                  </span>
                  <span className="text-xs text-slate-600">· {section.hint}</span>
                </div>
                <div className="space-y-2">
                  {items.map((o) => (
                    <ObligationRow key={`${o.type}-${o.entityId}-${o.dueDate}`} o={o} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
