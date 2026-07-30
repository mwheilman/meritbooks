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
import { useQuery } from '@/hooks';
import { PageHeader } from '@/components/ui';

// ── Types (mirror /api/exceptions) ─────────────────────────────────────────────

type ExceptionSource = 'bank' | 'receipt' | 'bill' | 'ai_proposal' | 'approval' | 'cost';

interface ExceptionItem {
  id: string;
  source: ExceptionSource;
  title: string;
  subtitle: string | null;
  amountCents: number | null;
  confidence: number | null;
  companyId: string | null;
  createdAt: string;
  href: string;
}

interface ExceptionsResponse {
  data: ExceptionItem[];
  counts: { total: number; bySource: Record<string, number> };
}

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

function ExceptionRow({ item, onOpen }: { item: ExceptionItem; onOpen: (href: string) => void }) {
  const meta = SOURCE_META[item.source];
  const Icon = meta.icon;

  return (
    <button
      type="button"
      onClick={() => onOpen(item.href)}
      className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-slate-800/30 focus:bg-slate-800/40 focus:outline-none"
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
        </div>
        {item.subtitle && (
          <p className="mt-0.5 truncate text-xs text-slate-500">{item.subtitle}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {item.amountCents !== null && (
          <span className="font-mono text-sm text-slate-200">{formatMoney(item.amountCents)}</span>
        )}
        <span className="text-[11px] text-slate-500">{relativeTime(item.createdAt)}</span>
      </div>
    </button>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function ExceptionsPage() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useQuery<ExceptionsResponse>('/api/exceptions');
  const [filter, setFilter] = useState<ExceptionSource | 'all'>('all');

  const items = useMemo(() => data?.data ?? [], [data]);
  const counts = data?.counts;

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.source === filter)),
    [items, filter]
  );

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Needs Attention"
        description={
          counts
            ? counts.total === 0
              ? "You're all caught up."
              : `${counts.total} ${counts.total === 1 ? 'item' : 'items'} across your queues need a human.`
            : 'Everything waiting on you, in one place.'
        }
      />

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
          {filtered.map((item) => (
            <ExceptionRow key={`${item.source}:${item.id}`} item={item} onOpen={open} />
          ))}
        </div>
      )}
    </div>
  );
}
