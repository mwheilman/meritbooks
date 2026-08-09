'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  AlertCircle,
  Inbox,
  Landmark,
  Receipt,
  FileText,
  Sparkles,
  ShieldCheck,
  Briefcase,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

// ── Types (mirror /api/exceptions) ─────────────────────────────────────────────

type ExceptionSource = 'bank' | 'receipt' | 'bill' | 'ai_proposal' | 'approval' | 'cost';

type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';

interface ExceptionItem {
  id: string;
  source: ExceptionSource;
  title: string;
  subtitle: string | null;
  amountCents: number | null;
  confidence: number | null;
  disposition: Disposition | null;
  companyId: string | null;
  createdAt: string;
  href: string;
}

interface ExceptionsResponse {
  data: ExceptionItem[];
  counts: {
    total: number;
    bySource: Record<string, number>;
    byDisposition?: Record<Disposition, number>;
  };
}

// ── Autonomy disposition presentation ─────────────────────────────────────────
// The advisory verdict the tenant's per-feature dial + kill switch recorded on an
// AI proposal: what the machine WOULD do vs what it MUST route to a human. Auto-post
// stays OFF, so even an AUTO-eligible item still passes through the approve step.

const DISPOSITION_ORDER: Disposition[] = ['AUTO', 'REVIEW', 'ESCALATE', 'BLOCKED'];

const DISPOSITION_META: Record<
  Disposition,
  { label: string; badgeClass: string; help: string }
> = {
  AUTO: {
    label: 'AUTO-eligible',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20',
    help: 'The dial would let the machine apply this — but auto-post is off, so it still needs your approval.',
  },
  REVIEW: {
    label: 'Needs review',
    badgeClass: 'bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20',
    help: 'Routine: a human should review and approve.',
  },
  ESCALATE: {
    label: 'Escalate',
    badgeClass: 'bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/20',
    help: 'Urgent: low confidence or high risk — a human must look.',
  },
  BLOCKED: {
    label: 'Blocked',
    badgeClass: 'bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-500/25',
    help: 'The capability is off or the kill switch is engaged — suppressed from the auto lane.',
  },
};

// ── Source presentation ─────────────────────────────────────────────────────────

const SOURCE_META: Record<
  ExceptionSource,
  { label: string; icon: LucideIcon; badgeClass: string }
> = {
  bank: {
    label: 'Bank feed',
    icon: Landmark,
    badgeClass: 'bg-blue-500/10 text-blue-400',
  },
  receipt: {
    label: 'Receipt',
    icon: Receipt,
    badgeClass: 'bg-amber-500/10 text-amber-400',
  },
  bill: {
    label: 'Bill on hold',
    icon: FileText,
    badgeClass: 'bg-red-500/10 text-red-400',
  },
  ai_proposal: {
    label: 'AI proposal',
    icon: Sparkles,
    badgeClass: 'bg-indigo-500/10 text-indigo-400',
  },
  approval: {
    label: 'Approval',
    icon: ShieldCheck,
    badgeClass: 'bg-emerald-500/10 text-emerald-400',
  },
  cost: {
    label: 'Job cost',
    icon: Briefcase,
    badgeClass: 'bg-slate-500/10 text-slate-300',
  },
};

const SOURCE_ORDER: ExceptionSource[] = [
  'bank',
  'receipt',
  'bill',
  'ai_proposal',
  'approval',
  'cost',
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.9) return 'bg-emerald-500/10 text-emerald-400';
  if (confidence >= 0.7) return 'bg-amber-500/10 text-amber-400';
  return 'bg-red-500/10 text-red-400';
}

// ── Row ───────────────────────────────────────────────────────────────────────

/** Sources with a SAFE (non-financial) resolve action + the button verb to show. */
const RESOLVE_LABEL: Partial<Record<ExceptionSource, string>> = {
  bank: 'Resolve',
  receipt: 'Resolve',
  bill: 'Resolve',
  ai_proposal: 'Dismiss',
};

function ExceptionRow({
  item,
  onOpen,
  onResolve,
  isResolving,
}: {
  item: ExceptionItem;
  onOpen: (href: string) => void;
  onResolve: (item: ExceptionItem) => void;
  isResolving: boolean;
}) {
  const meta = SOURCE_META[item.source];
  const Icon = meta.icon;
  const resolveLabel = RESOLVE_LABEL[item.source];

  return (
    <div className="group flex w-full items-center gap-4 px-4 py-3 transition-colors hover:bg-slate-800/30">
      <button
        type="button"
        onClick={() => onOpen(item.href)}
        className="flex min-w-0 flex-1 items-center gap-4 text-left focus:outline-none"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800/60">
          <Icon size={16} className="text-slate-400" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-white">{item.title}</p>
            <span
              className={clsx(
                'inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                meta.badgeClass
              )}
            >
              {meta.label}
            </span>
            {item.confidence !== null && (
              <span
                className={clsx(
                  'inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium',
                  confidenceClass(item.confidence)
                )}
              >
                {Math.round(item.confidence * 100)}%
              </span>
            )}
            {item.disposition && (
              <span
                title={DISPOSITION_META[item.disposition].help}
                className={clsx(
                  'inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                  DISPOSITION_META[item.disposition].badgeClass
                )}
              >
                {DISPOSITION_META[item.disposition].label}
              </span>
            )}
          </div>
          {item.subtitle && (
            <p className="mt-0.5 truncate text-xs text-slate-500">{item.subtitle}</p>
          )}
        </div>
      </button>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {item.amountCents !== null && (
          <span className="font-mono text-sm text-slate-200">{formatMoney(item.amountCents)}</span>
        )}
        <span className="text-[11px] text-slate-500">{relativeTime(item.createdAt)}</span>
      </div>

      {resolveLabel && (
        <button
          type="button"
          disabled={isResolving}
          onClick={(e) => {
            e.stopPropagation();
            onResolve(item);
          }}
          className={clsx(
            'inline-flex w-20 shrink-0 items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
            'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-400',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {isResolving ? <Loader2 size={13} className="animate-spin" /> : resolveLabel}
        </button>
      )}
    </div>
  );
}

// ── Queue ─────────────────────────────────────────────────────────────────────
// Extracted from the retired standalone /exceptions "Needs Attention" screen so the
// Inbox → Exceptions tab keeps the SAFE inline-resolve behavior (bank/receipt/bill
// resolve + ai_proposal dismiss via /api/exceptions/resolve). No PageHeader here —
// the Inbox tab shell owns the page chrome.

export function ExceptionsQueue() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useQuery<ExceptionsResponse>('/api/exceptions');
  const [filter, setFilter] = useState<ExceptionSource | 'all'>('all');
  const [dispoFilter, setDispoFilter] = useState<Disposition | 'all'>('all');
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const items = useMemo(() => data?.data ?? [], [data]);
  const counts = data?.counts;

  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (filter !== 'all' && i.source !== filter) return false;
        if (dispoFilter !== 'all' && i.disposition !== dispoFilter) return false;
        return true;
      }),
    [items, filter, dispoFilter]
  );

  const dispoChips = useMemo(() => {
    const byDisposition = counts?.byDisposition ?? { AUTO: 0, REVIEW: 0, ESCALATE: 0, BLOCKED: 0 };
    const total = DISPOSITION_ORDER.reduce((sum, d) => sum + (byDisposition[d] ?? 0), 0);
    if (total === 0) return [];
    const list: { key: Disposition | 'all'; label: string; count: number }[] = [
      { key: 'all', label: 'All AI', count: total },
    ];
    for (const d of DISPOSITION_ORDER) {
      const c = byDisposition[d] ?? 0;
      if (c > 0) list.push({ key: d, label: DISPOSITION_META[d].label, count: c });
    }
    return list;
  }, [counts]);

  const chips = useMemo(() => {
    const bySource = counts?.bySource ?? {};
    const list: { key: ExceptionSource | 'all'; label: string; count: number }[] = [
      { key: 'all', label: 'All', count: counts?.total ?? 0 },
    ];
    for (const src of SOURCE_ORDER) {
      const c = bySource[src] ?? 0;
      if (c > 0) list.push({ key: src, label: SOURCE_META[src].label, count: c });
    }
    return list;
  }, [counts]);

  function open(href: string) {
    router.push(href);
  }

  async function resolve(item: ExceptionItem) {
    const key = `${item.source}:${item.id}`;
    setResolvingKey(key);
    const verb = item.source === 'ai_proposal' ? 'Dismissed' : 'Resolved';
    const result = await api.post<{ ok: boolean }>('/api/exceptions/resolve', {
      source: item.source,
      id: item.id,
    });
    if (result.error) {
      addToast('error', result.error.error || 'Could not resolve item');
      setResolvingKey(null);
      return;
    }
    addToast('success', `${verb} — removed from queue`);
    await refetch();
    setResolvingKey(null);
  }

  return (
    <div className="space-y-6">
      {counts && counts.total > 0 && (
        <p className="text-xs text-slate-500">
          {counts.total} {counts.total === 1 ? 'item' : 'items'} across your queues need a human.
          Resolve safe (non-financial) flags inline, or open an item to act on it.
        </p>
      )}

      {/* Filter chips */}
      {!isLoading && !error && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                filter === chip.key
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200'
              )}
            >
              {chip.label}
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 font-mono text-[10px]',
                  filter === chip.key ? 'bg-emerald-500/20' : 'bg-slate-700/50 text-slate-400'
                )}
              >
                {chip.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Autonomy disposition filter — what the AI WOULD do vs must route (advisory) */}
      {!isLoading && !error && dispoChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            <Sparkles size={12} className="text-indigo-400" />
            AI disposition
          </span>
          {dispoChips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setDispoFilter(chip.key)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                dispoFilter === chip.key
                  ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                  : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200'
              )}
            >
              {chip.label}
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 font-mono text-[10px]',
                  dispoFilter === chip.key ? 'bg-indigo-500/20' : 'bg-slate-700/50 text-slate-400'
                )}
              >
                {chip.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Content states */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => refetch()}
            className="mt-4 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="card p-16 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500/70" />
          <p className="text-sm font-medium text-white">You&apos;re all caught up</p>
          <p className="mt-1 text-xs text-slate-500">
            Nothing needs your attention right now. New flags, proposals, and approvals will land
            here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <Inbox className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm text-slate-400">No items in this category.</p>
        </div>
      ) : (
        <div className="card divide-y divide-slate-800/40 overflow-hidden">
          {filtered.map((item) => {
            const key = `${item.source}:${item.id}`;
            return (
              <ExceptionRow
                key={key}
                item={item}
                onOpen={open}
                onResolve={resolve}
                isResolving={resolvingKey === key}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
