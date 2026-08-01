'use client';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, Lock, Bot, Cpu, User, History } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { PageHeader } from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';

interface AuditEntry {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  summary: string | null;
  subjectTable: string | null;
  subjectId: string | null;
  tier: string | null;
  confidence: number | null;
  createdAt: string;
}

interface AuditResponse {
  data: AuditEntry[];
}

type ActorFilter = 'all' | ActorType;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

// ── Actor badge ─────────────────────────────────────────────────────────────────

function ActorBadge({ type }: { type: ActorType }) {
  const config: Record<ActorType, { label: string; className: string; icon: typeof User }> = {
    HUMAN: { label: 'Human', className: 'bg-slate-500/10 text-slate-300 border-slate-500/20', icon: User },
    AI: { label: 'AI', className: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20', icon: Bot },
    SYSTEM: { label: 'System', className: 'bg-blue-500/10 text-blue-300 border-blue-500/20', icon: Cpu },
  };
  const { label, className, icon: Icon } = config[type];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        className
      )}
    >
      <Icon size={11} />
      {label}
    </span>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

const ACTOR_TABS: { key: ActorFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'HUMAN', label: 'Human' },
  { key: 'AI', label: 'AI' },
  { key: 'SYSTEM', label: 'System' },
];

export function AuditClient() {
  const { loading: meLoading, user } = useMe();
  const canManage = user?.canManageUsers === true;

  const [filter, setFilter] = useState<ActorFilter>('all');

  const { data, isLoading, error } = useQuery<AuditResponse>(
    canManage ? '/api/audit' : null,
    filter === 'all' ? undefined : { actorType: filter }
  );

  const entries = useMemo(() => data?.data ?? [], [data]);

  // Loading identity → spinner (avoids flashing the no-access state for an admin).
  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Audit Trail"
          description="Every action, with machine-vs-human attribution."
        />
        <div className="card p-12 text-center">
          <Lock className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">You don&apos;t have access</p>
          <p className="mt-1 text-xs text-slate-500">
            The audit trail is restricted to administrators.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Trail" description="Every action, with machine-vs-human attribution." />

      <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-800/30 p-0.5 w-fit">
        {ACTOR_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={clsx(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              filter === tab.key
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="card p-12 text-center">
          <History className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm text-slate-400">
            {filter === 'all'
              ? 'No actions recorded yet.'
              : `No ${filter.toLowerCase()} actions recorded yet.`}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Actor</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Action</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Summary</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ActorBadge type={e.actorType} />
                      <span className="text-xs text-slate-300">{e.actorName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-slate-400">{e.action}</span>
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <span className="text-xs text-slate-300">{e.summary ?? '—'}</span>
                    {e.confidence != null && (
                      <span className="ml-2 rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                        {Math.round(e.confidence * 100)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="whitespace-nowrap text-xs text-slate-500" title={absoluteTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
