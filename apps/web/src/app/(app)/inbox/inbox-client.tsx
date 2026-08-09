'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
  Ban,
  CalendarClock,
  Sparkles,
  FileText,
  Inbox as InboxIcon,
  type LucideIcon,
} from 'lucide-react';

// ── Types (mirror /api/inbox) ──────────────────────────────────────────────────

type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';
export type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';
type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface InboxItem {
  id: string;
  type: InboxItemType;
  group: InboxGroupKey;
  title: string;
  subtitle: string | null;
  dueOrAge: string;
  severity: InboxSeverity;
  actionHref: string;
  actionLabel: string;
  amountCents: number | null;
  entity: { table: string; id: string };
  sortValue: number;
}

interface InboxGroup {
  key: InboxGroupKey;
  items: InboxItem[];
}

interface InboxResponse {
  asOf: string;
  canApproveMoney: boolean;
  items: InboxItem[];
  groups: InboxGroup[];
  counts: { total: number; byType: Record<InboxItemType, number> };
  degraded: string[];
}

// ── Presentation ────────────────────────────────────────────────────────────────

const GROUP_META: Record<
  InboxGroupKey,
  { title: string; hint: string; icon: LucideIcon; accent: string }
> = {
  APPROVALS: {
    title: 'Approvals',
    hint: 'Money movement + expense reports waiting on you',
    icon: ShieldCheck,
    accent: 'text-emerald-400',
  },
  POLICY_BLOCKS: {
    title: 'Policy blocks',
    hint: 'Held by AP or expense policy — resolve to release',
    icon: Ban,
    accent: 'text-red-400',
  },
  ALERTS: {
    title: 'Alerts',
    hint: 'Time-sensitive obligations — overdue or due soon',
    icon: CalendarClock,
    accent: 'text-amber-400',
  },
  EXCEPTIONS: {
    title: 'Exceptions',
    hint: 'AI proposals awaiting a human decision',
    icon: Sparkles,
    accent: 'text-indigo-400',
  },
  DRAFTS: {
    title: 'Drafts',
    hint: 'Unposted entries to review and finish',
    icon: FileText,
    accent: 'text-slate-300',
  },
};

const GROUP_ORDER: InboxGroupKey[] = ['APPROVALS', 'POLICY_BLOCKS', 'ALERTS', 'EXCEPTIONS', 'DRAFTS'];

const TYPE_LABEL: Record<InboxItemType, string> = {
  APPROVAL: 'Approvals',
  POLICY_BLOCK: 'Policy blocks',
  ALERT: 'Alerts',
  EXCEPTION: 'Exceptions',
  DRAFT: 'Drafts',
};

const SEVERITY_META: Record<InboxSeverity, { dot: string; label: string; text: string }> = {
  CRITICAL: { dot: 'bg-red-500', label: 'Critical', text: 'text-red-400' },
  HIGH: { dot: 'bg-amber-500', label: 'High', text: 'text-amber-400' },
  MEDIUM: { dot: 'bg-sky-500', label: 'Medium', text: 'text-sky-400' },
  LOW: { dot: 'bg-slate-500', label: 'Low', text: 'text-slate-400' },
};

const HORIZON_OPTIONS = [30, 60, 90];

// ── Row ───────────────────────────────────────────────────────────────────────

function InboxRow({ item }: { item: InboxItem }) {
  const sev = SEVERITY_META[item.severity];
  const overdue = item.dueOrAge.includes('overdue');

  return (
    <Link
      href={item.actionHref}
      className="group flex items-center gap-4 rounded-lg border border-slate-800 bg-surface-900 px-4 py-3 transition hover:border-slate-700 hover:bg-slate-800/40"
    >
      <span
        className={clsx('h-2 w-2 flex-none rounded-full', sev.dot)}
        title={`${sev.label} priority`}
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{item.title}</p>
        {item.subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{item.subtitle}</p>}
      </div>

      <div className="flex-none text-right">
        {item.amountCents !== null && (
          <p className="font-mono text-sm text-slate-200">{formatMoney(item.amountCents)}</p>
        )}
        <p className={clsx('text-xs', overdue ? 'text-red-400' : 'text-slate-500')}>{item.dueOrAge}</p>
      </div>

      <span className="flex w-24 flex-none items-center justify-end gap-1.5">
        <span className="rounded-md border border-slate-700 bg-slate-800/40 px-2 py-1 text-xs font-medium text-slate-300 transition group-hover:border-emerald-500/40 group-hover:text-emerald-400">
          {item.actionLabel}
        </span>
        <ChevronRight size={16} className="text-slate-600 transition group-hover:text-slate-400" />
      </span>
    </Link>
  );
}

// ── Metric card ────────────────────────────────────────────────────────────────

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg font-semibold', tone ?? 'text-white')}>{value}</p>
    </div>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export function InboxClient({ only }: { only?: InboxGroupKey[] } = {}) {
  const [horizon, setHorizon] = useState(30);

  const params = useMemo<Record<string, string>>(() => ({ alert_horizon: String(horizon) }), [horizon]);
  const { data, error, isLoading, refetch } = useQuery<InboxResponse>('/api/inbox', params);

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="mr-2 animate-spin" size={18} />
        Loading your inbox…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-red-900/40 bg-red-950/20 py-16 text-center">
        <AlertCircle className="mb-3 text-red-400" size={28} />
        <p className="text-sm font-medium text-red-300">Could not load your action inbox</p>
        <p className="mt-1 max-w-md text-xs text-slate-500">{error}</p>
        <button onClick={() => refetch()} className="btn-secondary btn-sm mt-4">
          <RefreshCw size={14} className="mr-1.5" />
          Retry
        </button>
      </div>
    );
  }

  const counts = data?.counts;
  const groups = data?.groups ?? [];
  const byType = counts?.byType;

  // When mounted inside a tabbed shell, restrict which groups render to the
  // active tab's groups. Absent `only`, show everything (standalone behavior).
  const orderToShow = only ? GROUP_ORDER.filter((k) => only.includes(k)) : GROUP_ORDER;
  const visibleItemCount = orderToShow.reduce((n, key) => {
    const g = groups.find((gr) => gr.key === key);
    return n + (g?.items.length ?? 0);
  }, 0);

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric
          label="Needs you"
          value={String(counts?.total ?? 0)}
          tone={(counts?.total ?? 0) > 0 ? 'text-white' : 'text-emerald-400'}
        />
        <Metric
          label="Approvals"
          value={String(byType?.APPROVAL ?? 0)}
          tone={(byType?.APPROVAL ?? 0) > 0 ? 'text-emerald-400' : 'text-white'}
        />
        <Metric
          label="Policy blocks"
          value={String(byType?.POLICY_BLOCK ?? 0)}
          tone={(byType?.POLICY_BLOCK ?? 0) > 0 ? 'text-red-400' : 'text-white'}
        />
        <Metric
          label="Alerts"
          value={String(byType?.ALERT ?? 0)}
          tone={(byType?.ALERT ?? 0) > 0 ? 'text-amber-400' : 'text-white'}
        />
        <Metric label="Exceptions" value={String(byType?.EXCEPTION ?? 0)} tone="text-indigo-300" />
        <Metric label="Drafts" value={String(byType?.DRAFT ?? 0)} tone="text-slate-200" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {data?.canApproveMoney
            ? 'You have money-movement approval authority — approvals you can clear are flagged critical.'
            : 'Approvals awaiting another approver are shown for visibility.'}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="inbox-horizon" className="text-xs text-slate-500">
            Alerts within
          </label>
          <select
            id="inbox-horizon"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            className="rounded-lg border border-slate-800 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500/50 focus:outline-none"
          >
            {HORIZON_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} days
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
          Some sources were unavailable and skipped: {data.degraded.join(', ')}. The rest of your
          inbox is complete.
        </p>
      )}

      {/* Empty state */}
      {counts && counts.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-surface-900 py-20 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <CheckCircle2 size={24} className="text-emerald-400" />
          </div>
          <h3 className="text-sm font-medium text-slate-200">You&apos;re all caught up</h3>
          <p className="mt-1 max-w-sm text-sm text-slate-500">
            Nothing needs you right now. New approvals, policy blocks, alerts, AI proposals, and
            drafts will land here — ranked by what&apos;s most urgent.
          </p>
        </div>
      ) : only && visibleItemCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-surface-900 py-16 text-center">
          <CheckCircle2 size={22} className="mb-2 text-emerald-400" />
          <p className="text-sm text-slate-300">Nothing in this tab right now.</p>
          <p className="mt-1 text-xs text-slate-500">
            You still have items in other tabs — the counts above show the full picture.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {orderToShow.map((key) => {
            const group = groups.find((g) => g.key === key);
            if (!group || group.items.length === 0) return null;
            const meta = GROUP_META[key];
            const Icon = meta.icon;
            return (
              <section key={key}>
                <div className="mb-3 flex items-center gap-2">
                  <Icon size={16} className={meta.accent} />
                  <h2 className="text-sm font-semibold text-slate-200">{meta.title}</h2>
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                    {group.items.length}
                  </span>
                  <span className="text-xs text-slate-600">· {meta.hint}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => (
                    <InboxRow key={item.id} item={item} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Footnote — reinforces the read-only, aggregate nature */}
      {counts && counts.total > 0 && (
        <p className="flex items-center gap-1.5 pt-2 text-xs text-slate-600">
          <InboxIcon size={12} />
          {TYPE_LABEL.APPROVAL} and blocks are ranked first, then time-sensitive alerts, then AI
          exceptions and drafts. This view is read-only — acting on an item opens its own screen.
        </p>
      )}
    </div>
  );
}
