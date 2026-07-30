'use client';

import { Loader2, AlertCircle, Lock, Bot, Cpu, User, Activity, Gauge, Users, ClipboardList } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { PageHeader } from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';
type Tier = 'auto' | 'review' | 'escalate';

interface RecentActivity {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  summary: string | null;
  tier: Tier | null;
  confidence: number | null;
  createdAt: string;
}

interface OperationsResponse {
  totals: { all: number; last24h: number; last7d: number };
  byActor: Record<ActorType, number>;
  aiTiers: Record<Tier, number>;
  autonomyRate: number | null;
  recent: RecentActivity[];
}

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

// ── Tier chip ─────────────────────────────────────────────────────────────────

function TierChip({ tier }: { tier: Tier }) {
  const config: Record<Tier, { label: string; className: string }> = {
    auto: { label: 'Auto', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    review: { label: 'Review', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
    escalate: { label: 'Escalate', className: 'bg-red-500/10 text-red-400 border-red-500/20' },
  };
  const { label, className } = config[tier];
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium',
        className
      )}
    >
      {label}
    </span>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Activity;
}

function KpiCard({ label, value, hint, icon: Icon }: KpiCardProps) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500/10">
          <Icon size={16} className="text-brand-400" />
        </div>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-white font-mono tabular-nums">{value}</p>
      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const { loading: meLoading, user } = useMe();
  const canManage = user?.canManageUsers === true;

  const { data, isLoading, error } = useQuery<OperationsResponse>(canManage ? '/api/operations' : null);

  // Loading identity → spinner (avoids flashing the no-access state for a manager).
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
        <PageHeader title="Operations" description="How the system and your team are working — at a glance." />
        <div className="card p-12 text-center">
          <Lock className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">You don&apos;t have access</p>
          <p className="mt-1 text-xs text-slate-500">The operations overview is restricted to managers.</p>
        </div>
      </div>
    );
  }

  const autonomyRate = data?.autonomyRate ?? null;
  const autonomyDisplay = autonomyRate == null ? '—' : `${Math.round(autonomyRate * 100)}%`;
  const aiCount = data?.byActor.AI ?? 0;
  const humanCount = data?.byActor.HUMAN ?? 0;
  const needsReview = (data?.aiTiers.review ?? 0) + (data?.aiTiers.escalate ?? 0);
  const actionsToday = data?.totals.last24h ?? 0;
  const recent = data?.recent ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Operations" description="How the system and your team are working — at a glance." />

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Autonomy rate"
              value={autonomyDisplay}
              hint={autonomyRate == null ? 'No AI actions yet' : 'AI actions auto-applied'}
              icon={Gauge}
            />
            <KpiCard
              label="Machine vs human"
              value={`${aiCount} / ${humanCount}`}
              hint="AI actions vs human actions"
              icon={Users}
            />
            <KpiCard
              label="Needs review"
              value={String(needsReview)}
              hint="AI review + escalate"
              icon={ClipboardList}
            />
            <KpiCard label="Actions today" value={String(actionsToday)} hint="Last 24 hours" icon={Activity} />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-white">Recent activity</h2>
            {recent.length === 0 ? (
              <div className="card p-12 text-center">
                <Activity className="mx-auto mb-3 h-8 w-8 text-slate-600" />
                <p className="text-sm text-slate-400">
                  No activity yet — actions will appear as the system and your team work.
                </p>
              </div>
            ) : (
              <div className="card divide-y divide-slate-800/30">
                {recent.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5">
                      <ActorBadge type={r.actorType} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-slate-200">{r.actorName}</span>
                        <span className="font-mono text-xs text-slate-500">{r.action}</span>
                        {r.tier && <TierChip tier={r.tier} />}
                        {r.confidence != null && (
                          <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                            {Math.round(r.confidence * 100)}%
                          </span>
                        )}
                      </div>
                      {r.summary && <p className="mt-0.5 truncate text-xs text-slate-400">{r.summary}</p>}
                    </div>
                    <span
                      className="whitespace-nowrap text-xs text-slate-500"
                      title={absoluteTime(r.createdAt)}
                    >
                      {relativeTime(r.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
