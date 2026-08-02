'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  AlertCircle,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Shield,
  Scale,
  Sparkles,
  History,
  ArrowUpRight,
  Bot,
  User,
  Cpu,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { PageHeader } from '@/components/ui';

// ── Types (mirror lib/controls/compliance-center.ts) ───────────────────────────

type ControlStatus = 'pass' | 'warn' | 'fail';
type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';
type AutonomyMode = 'OFF' | 'PROPOSE' | 'AUTO_UNDER_LIMIT';
type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';

interface ControlCard {
  id: string;
  feature: string;
  name: string;
  category: string;
  framework: string;
  drillHref: string;
  status: ControlStatus;
  openCount: number;
  clearedCount: number;
  escalateCount: number;
  exposureCents: number;
  detail: string;
}

interface SodViolation {
  approvalId: string;
  kind: string;
  amountCents: number | null;
  type: 'APPROVER_EQ_PREPARER' | 'RELEASER_EQ_PREPARER';
  detail: string;
}
interface SodEvidence {
  status: ControlStatus;
  evaluated: number;
  withApprover: number;
  sodSatisfied: number;
  released: number;
  violations: SodViolation[];
  byKind: Record<string, number>;
}

interface AutonomyPostureItem {
  feature: string;
  label: string;
  category: 'processing' | 'control';
  mode: AutonomyMode;
  materialityLimitCents: number | null;
  isDefault: boolean;
}
interface AutonomyPosture {
  status: ControlStatus;
  killSwitchEngaged: boolean;
  items: AutonomyPostureItem[];
  autoEnabledCount: number;
  proposeCount: number;
  offCount: number;
}

interface AuditCompleteness {
  status: ControlStatus;
  totalActions: number;
  byActor: Record<ActorType, number>;
  lastActionAt: string | null;
}

interface ComplianceSummary {
  totalControls: number;
  pass: number;
  warn: number;
  fail: number;
  openExceptions: number;
  totalExposureCents: number;
  overall: ControlStatus;
}

interface ComplianceCenter {
  generatedAt: string;
  summary: ComplianceSummary;
  controls: ControlCard[];
  exceptionsByClass: ControlCard[];
  sod: SodEvidence;
  autonomy: AutonomyPosture;
  audit: AuditCompleteness;
  hrefs: { exceptions: string; audit: string; autonomy: string };
}

interface Envelope {
  data: ComplianceCenter;
}

// ── Status presentation ─────────────────────────────────────────────────────────

const STATUS_META: Record<
  ControlStatus,
  { label: string; text: string; ring: string; bg: string; dot: string; icon: LucideIcon }
> = {
  pass: {
    label: 'Operating',
    text: 'text-emerald-400',
    ring: 'ring-emerald-500/25',
    bg: 'bg-emerald-500/10',
    dot: 'bg-emerald-400',
    icon: ShieldCheck,
  },
  warn: {
    label: 'Attention',
    text: 'text-amber-400',
    ring: 'ring-amber-500/25',
    bg: 'bg-amber-500/10',
    dot: 'bg-amber-400',
    icon: ShieldAlert,
  },
  fail: {
    label: 'Exception',
    text: 'text-red-400',
    ring: 'ring-red-500/25',
    bg: 'bg-red-500/10',
    dot: 'bg-red-400',
    icon: ShieldX,
  },
};

const MODE_META: Record<AutonomyMode, { label: string; cls: string }> = {
  OFF: { label: 'Off', cls: 'bg-slate-500/15 text-slate-300' },
  PROPOSE: { label: 'Propose → human', cls: 'bg-emerald-500/10 text-emerald-400' },
  AUTO_UNDER_LIMIT: { label: 'Auto under limit', cls: 'bg-amber-500/10 text-amber-400' },
};

const ACTOR_META: Record<ActorType, { label: string; icon: LucideIcon; cls: string }> = {
  HUMAN: { label: 'Human', icon: User, cls: 'text-slate-300' },
  AI: { label: 'AI', icon: Bot, cls: 'text-indigo-300' },
  SYSTEM: { label: 'System', icon: Cpu, cls: 'text-blue-300' },
};

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// ── Small building blocks ─────────────────────────────────────────────────────

function StatusPill({ status }: { status: ControlStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
        m.bg,
        m.text,
        m.ring
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  status,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  status?: ControlStatus;
  icon: LucideIcon;
}) {
  const m = status ? STATUS_META[status] : null;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        <Icon size={15} className={clsx(m ? m.text : 'text-slate-500')} />
      </div>
      <p className={clsx('mt-2 font-mono text-2xl font-semibold', m ? m.text : 'text-white')}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ControlsClient() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useQuery<Envelope>('/api/controls/compliance');

  const center = data?.data;

  const controlsSorted = useMemo(() => {
    const rank: Record<ControlStatus, number> = { fail: 0, warn: 1, pass: 2 };
    return [...(center?.controls ?? [])].sort((a, b) => rank[a.status] - rank[b.status]);
  }, [center]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Controls & Compliance" description="The trust and controls surface, in one view." />
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
      </div>
    );
  }

  if (!center) {
    return (
      <div className="space-y-6">
        <PageHeader title="Controls & Compliance" description="The trust and controls surface, in one view." />
        <div className="card p-16 text-center">
          <Shield className="mx-auto mb-3 h-10 w-10 text-slate-700" />
          <p className="text-sm text-slate-400">No control data available yet.</p>
        </div>
      </div>
    );
  }

  const { summary, sod, autonomy, audit } = center;
  const overall = STATUS_META[summary.overall];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Controls & Compliance"
        description="Read-only command center for every financial control — exceptions, segregation of duties, AI autonomy, and the audit trail."
      />

      {/* Overall posture banner */}
      <div className={clsx('card flex items-center gap-4 p-4 ring-1 ring-inset', overall.bg, overall.ring)}>
        <div className={clsx('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg', overall.bg)}>
          <overall.icon size={22} className={overall.text} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={clsx('text-sm font-semibold', overall.text)}>
            {summary.overall === 'pass'
              ? 'All controls operating'
              : summary.overall === 'warn'
                ? 'Controls need attention'
                : 'Open control exceptions require action'}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {summary.pass} operating · {summary.warn} attention · {summary.fail} exception across{' '}
            {summary.totalControls} controls. Generated {relativeTime(center.generatedAt)}.
          </p>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile
          label="Control posture"
          value={`${summary.pass}/${summary.totalControls}`}
          sub="operating"
          status={summary.overall}
          icon={Shield}
        />
        <SummaryTile
          label="Open exceptions"
          value={String(summary.openExceptions)}
          sub={summary.fail > 0 ? `${summary.fail} escalated control(s)` : 'across all classes'}
          status={summary.openExceptions === 0 ? 'pass' : summary.fail > 0 ? 'fail' : 'warn'}
          icon={ShieldAlert}
        />
        <SummaryTile
          label="Exposure at risk"
          value={formatMoney(summary.totalExposureCents)}
          sub="open control exceptions"
          status={summary.totalExposureCents > 0 ? 'warn' : 'pass'}
          icon={Scale}
        />
        <SummaryTile
          label="SoD violations"
          value={String(sod.violations.length)}
          sub={`${sod.sodSatisfied} dual-control approvals`}
          status={sod.status}
          icon={Scale}
        />
      </div>

      {/* Control cards */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Financial controls</h2>
          <button
            onClick={() => router.push(center.hrefs.exceptions)}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-emerald-400"
          >
            View exception queue <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {controlsSorted.map((c) => {
            const m = STATUS_META[c.status];
            return (
              <button
                key={c.feature}
                onClick={() => router.push(c.drillHref)}
                className={clsx(
                  'card group flex flex-col gap-3 p-4 text-left transition-colors hover:border-slate-700',
                  'ring-1 ring-inset',
                  m.ring
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        {c.id}
                      </span>
                      <span className="text-2xs uppercase tracking-wide text-slate-500">{c.category}</span>
                    </div>
                    <p className="mt-1.5 truncate text-sm font-medium text-white">{c.name}</p>
                  </div>
                  <StatusPill status={c.status} />
                </div>

                <p className="text-xs text-slate-500">{c.detail}</p>

                <div className="mt-auto flex items-center justify-between border-t border-slate-800/60 pt-3">
                  <div className="flex items-center gap-3 text-xs">
                    <span className={clsx('font-mono font-semibold', c.openCount > 0 ? m.text : 'text-slate-500')}>
                      {c.openCount} open
                    </span>
                    {c.escalateCount > 0 && (
                      <span className="font-mono text-red-400">{c.escalateCount} escalated</span>
                    )}
                  </div>
                  {c.exposureCents > 0 && (
                    <span className="font-mono text-xs text-slate-300">{formatMoney(c.exposureCents)}</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-600">{c.framework}</p>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Segregation of duties */}
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <div className="flex items-center gap-2">
              <Scale size={15} className="text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">Segregation of duties</h2>
            </div>
            <StatusPill status={sod.status} />
          </div>
          <div className="grid grid-cols-3 gap-px bg-slate-800/60 text-center">
            {[
              { label: 'Movements', value: sod.evaluated },
              { label: 'Dual-control', value: sod.sodSatisfied },
              { label: 'Released', value: sod.released },
            ].map((s) => (
              <div key={s.label} className="bg-slate-950 px-3 py-3">
                <p className="font-mono text-lg font-semibold text-white">{s.value}</p>
                <p className="text-2xs uppercase tracking-wide text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="px-5 py-4">
            <p className="mb-2 text-xs text-slate-500">
              Preparer ≠ approver is enforced in the database on every money movement. This panel
              tallies the positive dual-control evidence and flags any weakness in the release step.
            </p>
            {sod.violations.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400">
                <ShieldCheck size={14} />
                No segregation-of-duties violations detected.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {sod.violations.slice(0, 6).map((v) => (
                  <li
                    key={`${v.approvalId}:${v.type}`}
                    className="flex items-start gap-2 rounded-lg bg-red-500/5 px-3 py-2 text-xs"
                  >
                    <ShieldX size={14} className="mt-0.5 shrink-0 text-red-400" />
                    <div className="min-w-0">
                      <span className="font-medium text-red-300">{v.kind}</span>
                      {v.amountCents !== null && (
                        <span className="ml-1.5 font-mono text-slate-400">{formatMoney(v.amountCents)}</span>
                      )}
                      <p className="text-slate-500">{v.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => router.push(center.hrefs.audit)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-emerald-400"
            >
              <History size={13} /> Open audit trail <ArrowUpRight size={12} />
            </button>
          </div>
        </section>

        {/* Autonomy posture */}
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-indigo-400" />
              <h2 className="text-sm font-semibold text-white">AI autonomy posture</h2>
            </div>
            <StatusPill status={autonomy.status} />
          </div>
          <div className="px-5 py-3">
            {autonomy.killSwitchEngaged && (
              <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                <ShieldAlert size={14} /> Global kill switch engaged — no AI action auto-applies.
              </div>
            )}
            <div className="mb-3 flex items-center gap-4 text-xs">
              <span className="text-emerald-400">{autonomy.proposeCount} propose</span>
              <span className="text-amber-400">{autonomy.autoEnabledCount} auto</span>
              <span className="text-slate-400">{autonomy.offCount} off</span>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {autonomy.items.map((it) => (
                <div
                  key={it.feature}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800/30"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-slate-300">{it.label}</p>
                    <p className="text-2xs uppercase tracking-wide text-slate-600">{it.category}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {it.mode === 'AUTO_UNDER_LIMIT' && it.materialityLimitCents !== null && (
                      <span className="font-mono text-2xs text-slate-500">
                        ≤ {formatMoney(it.materialityLimitCents)}
                      </span>
                    )}
                    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', MODE_META[it.mode].cls)}>
                      {MODE_META[it.mode].label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => router.push(center.hrefs.autonomy)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-indigo-400"
            >
              Manage autonomy dials <ArrowUpRight size={12} />
            </button>
          </div>
        </section>
      </div>

      {/* Audit-trail completeness */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <History size={15} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-white">Audit-trail completeness</h2>
          </div>
          <StatusPill status={audit.status} />
        </div>
        <div className="flex flex-wrap items-center gap-6 px-5 py-4 text-sm">
          <div>
            <p className="font-mono text-2xl font-semibold text-white">{audit.totalActions}</p>
            <p className="text-2xs uppercase tracking-wide text-slate-500">actions logged (recent)</p>
          </div>
          <div className="flex items-center gap-4">
            {(['HUMAN', 'AI', 'SYSTEM'] as ActorType[]).map((a) => {
              const meta = ACTOR_META[a];
              const Icon = meta.icon;
              return (
                <div key={a} className="flex items-center gap-1.5">
                  <Icon size={14} className={meta.cls} />
                  <span className="font-mono text-sm text-slate-200">{audit.byActor[a]}</span>
                  <span className="text-2xs uppercase tracking-wide text-slate-500">{meta.label}</span>
                </div>
              );
            })}
          </div>
          <div className="ml-auto text-xs text-slate-500">
            Last action {relativeTime(audit.lastActionAt)}
          </div>
        </div>
        <div className="border-t border-slate-800/60 px-5 py-2.5">
          <p className="text-xs text-slate-500">
            Every human, AI, and system action writes to the immutable Decision Log with actor
            attribution — the evidentiary backbone for control operation.
          </p>
        </div>
      </section>
    </div>
  );
}
