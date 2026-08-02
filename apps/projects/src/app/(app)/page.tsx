import Link from 'next/link';
import clsx from 'clsx';
import {
  Briefcase,
  Wallet,
  Receipt,
  FileClock,
  TrendingUp,
  TrendingDown,
  Stamp,
  ArrowUpRight,
  Boxes,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { currentOrgId, getEntitlements } from '@/lib/entitlements';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Portfolio operations overview — the MeritProjects landing surface.
// Server component; RLS auto-scopes every query to the caller's org. Reads the
// proj.v_job_margin roll-up (contract / actual / committed / projected-final)
// joined to core.jobs identity, plus live work-order / gate / billing counts.
// Keeps the G0' suite signal (entitlement + Books-present vs Standalone).
// ---------------------------------------------------------------------------

interface JobMarginRow {
  job_id: string;
  job_number: string;
  name: string;
  revenue_contract_cents: number | string | null;
  operational_actual_cents: number | string | null;
  operational_pending_cents: number | string | null;
  committed_open_cents: number | string | null;
  projected_final_cents: number | string | null;
  operational_margin_cents: number | string | null;
  operational_margin_pct: number | string | null;
  budget_remaining_cents: number | string | null;
}

interface JobCoreRow {
  id: string;
  archetype: string | null;
  status: string;
}

interface StatusRow {
  id: string;
  status: string;
}

// Numeric columns arrive from PostgREST as number OR string (bigint/numeric).
const n = (v: number | string | null | undefined): number => Number(v ?? 0);

const OPEN_WO_EXCLUDED = new Set(['COMPLETED', 'CANCELED']);
const CLOSED_GATE = new Set(['CLEARED', 'WAIVED']);

type Tone = 'brand' | 'info' | 'warning' | 'danger' | 'ai' | 'success' | 'neutral';

export default async function Dashboard() {
  const orgId = await currentOrgId();
  const ents = await getEntitlements(orgId);
  const sb = await createAuthedServerSupabase();

  // Boot / auth state: no authed client (no session token yet).
  if (!sb) {
    return (
      <div className="space-y-8">
        <PageHeader />
        <div className="rounded-xl border border-surface-800 bg-surface-900 p-8 text-center">
          <div className="text-heading text-white">Connecting to the suite…</div>
          <p className="mt-1 text-sm text-slate-400">
            Establishing your authenticated session. Refresh if this persists.
          </p>
        </div>
      </div>
    );
  }

  const [marginRes, jobsRes, woRes, gatesRes, billingRes] = await Promise.all([
    sb
      .schema('proj')
      .from('v_job_margin')
      .select(
        'job_id,job_number,name,revenue_contract_cents,operational_actual_cents,operational_pending_cents,committed_open_cents,projected_final_cents,operational_margin_cents,operational_margin_pct,budget_remaining_cents',
      ),
    sb.schema('core').from('jobs').select('id,archetype,status'),
    sb.schema('proj').from('work_orders').select('id,status'),
    sb.schema('proj').from('external_gates').select('id,status'),
    sb.schema('proj').from('billing_requests').select('id,status'),
  ]);

  const loadError = marginRes.error ?? jobsRes.error;
  const margins = (marginRes.data ?? []) as JobMarginRow[];
  const jobs = (jobsRes.data ?? []) as JobCoreRow[];
  const workOrders = (woRes.data ?? []) as StatusRow[];
  const gates = (gatesRes.data ?? []) as StatusRow[];
  const billing = (billingRes.data ?? []) as StatusRow[];

  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // ---- Portfolio aggregates -------------------------------------------------
  const activeJobs = jobs.filter((j) => j.status === 'ACTIVE').length;
  const totalContract = margins.reduce((s, m) => s + n(m.revenue_contract_cents), 0);
  const totalActual = margins.reduce((s, m) => s + n(m.operational_actual_cents), 0);
  const totalCommittedOpen = margins.reduce((s, m) => s + n(m.committed_open_cents), 0);
  const totalProjectedFinal = margins.reduce((s, m) => s + n(m.projected_final_cents), 0);
  const projectedMarginCents = totalContract - totalProjectedFinal;
  const projectedMarginPct = totalContract > 0 ? (projectedMarginCents / totalContract) * 100 : null;

  const openWorkOrders = workOrders.filter((w) => !OPEN_WO_EXCLUDED.has(w.status)).length;
  const openGates = gates.filter((g) => !CLOSED_GATE.has(g.status)).length;
  const openBilling = billing.filter((b) => b.status === 'DRAFT' || b.status === 'EMITTED').length;

  const marginPositive = projectedMarginCents >= 0;

  // Sort jobs at a glance by contract value desc — biggest exposure first.
  const rows = [...margins].sort(
    (a, b) => n(b.revenue_contract_cents) - n(a.revenue_contract_cents),
  );

  return (
    <div className="space-y-8">
      <PageHeader />

      {loadError && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger-fg">
          Couldn&apos;t load part of the portfolio ({loadError.message}). Figures below may be incomplete.
        </div>
      )}

      {/* Suite status strip — keeps the G0' signal: entitlement + ledger topology. */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-surface-800 bg-surface-900/60 px-5 py-3">
        <SuiteSignal label="App" value="Online" tone="success" />
        <span className="h-4 w-px bg-surface-800" />
        <SuiteSignal label="Entitlement" value={ents.projects ? 'projects' : '—'} tone={ents.projects ? 'info' : 'neutral'} />
        <span className="h-4 w-px bg-surface-800" />
        <SuiteSignal
          label="Ledger"
          value={ents.books ? 'Books present' : 'Standalone'}
          tone={ents.books ? 'ai' : 'warning'}
        />
      </section>

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={<Briefcase size={16} />} label="Active jobs" value={String(activeJobs)} tone="brand" mono={false} />
        <Kpi
          icon={<Wallet size={16} />}
          label="Contract value"
          value={formatMoney(totalContract, { compact: true })}
          tone="info"
        />
        <Kpi
          icon={<Receipt size={16} />}
          label="Cost to date"
          value={formatMoney(totalActual, { compact: true })}
          tone="neutral"
        />
        <Kpi
          icon={<Boxes size={16} />}
          label="Committed open"
          value={formatMoney(totalCommittedOpen, { compact: true })}
          tone="warning"
        />
        <Kpi
          icon={marginPositive ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          label="Projected margin"
          value={formatMoney(projectedMarginCents, { compact: true })}
          sub={projectedMarginPct === null ? undefined : `${projectedMarginPct.toFixed(1)}%`}
          tone={marginPositive ? 'success' : 'danger'}
        />
        <Kpi
          icon={<Stamp size={16} />}
          label="Open permits/gates"
          value={String(openGates)}
          sub={openBilling > 0 ? `${openBilling} billing open` : undefined}
          tone={openGates > 0 ? 'warning' : 'neutral'}
          mono={false}
        />
      </section>

      {/* Jobs at a glance */}
      <section className="rounded-xl border border-surface-800 bg-surface-900">
        <div className="flex items-center justify-between border-b border-surface-800 px-5 py-4">
          <div>
            <h2 className="text-heading text-white">Jobs at a glance</h2>
            <p className="text-2xs uppercase tracking-wider text-slate-500">
              {rows.length} {rows.length === 1 ? 'job' : 'jobs'} · {openWorkOrders} active work orders
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyPortfolio />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5 text-left font-medium">Job</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-right font-medium">Contract</th>
                  <th className="px-3 py-2.5 text-right font-medium">Projected final</th>
                  <th className="px-3 py-2.5 text-right font-medium">Margin</th>
                  <th className="hidden px-5 py-2.5 text-left font-medium md:table-cell">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800/70">
                {rows.map((m) => {
                  const core = jobById.get(m.job_id);
                  const contract = n(m.revenue_contract_cents);
                  const actual = n(m.operational_actual_cents);
                  const marginPct = m.operational_margin_pct === null ? null : n(m.operational_margin_pct);
                  const spentPct = contract > 0 ? Math.min(100, Math.round((actual / contract) * 100)) : 0;
                  const over = contract > 0 && actual > contract;
                  const marginGood = (marginPct ?? 0) >= 0;
                  return (
                    <tr key={m.job_id} className="group transition-colors hover:bg-surface-850/50">
                      <td className="px-5 py-3">
                        <Link href={`/jobs/${m.job_id}`} className="block">
                          <div className="flex items-center gap-1.5 font-medium text-white group-hover:text-brand-400">
                            <span className="num text-slate-400">{m.job_number}</span>
                            <span className="truncate max-w-[16rem]">{m.name}</span>
                            <ArrowUpRight
                              size={13}
                              className="opacity-0 text-brand-400 transition-opacity group-hover:opacity-100"
                            />
                          </div>
                          {core && <StatusDot status={core.status} />}
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        <ArchetypeChip value={core?.archetype ?? null} />
                      </td>
                      <td className="num px-3 py-3 text-right text-slate-300">
                        {formatMoney(contract, { compact: true })}
                      </td>
                      <td className="num px-3 py-3 text-right text-slate-300">
                        {formatMoney(n(m.projected_final_cents), { compact: true })}
                      </td>
                      <td className="num px-3 py-3 text-right">
                        {marginPct === null ? (
                          <span className="text-slate-600">—</span>
                        ) : (
                          <span className={marginGood ? 'text-success-fg' : 'text-danger-fg'}>
                            {marginPct.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="hidden px-5 py-3 md:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-800">
                            <div
                              className={clsx('h-full rounded-full', over ? 'bg-danger' : 'bg-brand-500')}
                              style={{ width: `${Math.max(spentPct, 2)}%` }}
                            />
                          </div>
                          <span className="num text-2xs text-slate-500">{spentPct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Module status strip — which gates are live in this build. */}
      <section className="rounded-xl border border-surface-800 bg-surface-900 p-5">
        <div className="mb-3 text-2xs uppercase tracking-wider text-slate-500">Module status</div>
        <div className="flex flex-wrap gap-2">
          <ModulePill code="G1" name="Polymorphic core" live />
          <ModulePill code="G4" name="Jobs" live />
          <ModulePill code="G5" name="Cost + commitments" live />
          <ModulePill code="G6" name="Schedule / field" live />
          <ModulePill code="G7" name="Billing engine" live={openBilling >= 0} />
          <ModulePill code="G10" name="Portal / Copilot" />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function PageHeader() {
  return (
    <header className="space-y-1">
      <h1 className="text-title text-white">Portfolio</h1>
      <p className="text-sm text-slate-400">
        Live operations across your active jobs — contract value, cost, commitments and margin, straight from the shared ledger.
      </p>
    </header>
  );
}

const KPI_TONE: Record<Tone, { fg: string; icon: string }> = {
  brand: { fg: 'text-brand-400', icon: 'text-brand-400 bg-brand-500/10' },
  info: { fg: 'text-info-fg', icon: 'text-info-fg bg-info/10' },
  warning: { fg: 'text-warning-fg', icon: 'text-warning-fg bg-warning/10' },
  danger: { fg: 'text-danger-fg', icon: 'text-danger-fg bg-danger/10' },
  ai: { fg: 'text-ai-fg', icon: 'text-ai-fg bg-ai/10' },
  success: { fg: 'text-success-fg', icon: 'text-success-fg bg-success/10' },
  neutral: { fg: 'text-white', icon: 'text-slate-400 bg-surface-800' },
};

function Kpi({
  icon,
  label,
  value,
  sub,
  tone,
  mono = true,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: Tone;
  mono?: boolean;
}) {
  const t = KPI_TONE[tone];
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-4">
      <div className="flex items-center justify-between">
        <span className="text-2xs uppercase tracking-wider text-slate-500">{label}</span>
        <span className={clsx('grid h-6 w-6 place-items-center rounded-md', t.icon)}>{icon}</span>
      </div>
      <div className={clsx('mt-2 text-heading font-semibold', mono && 'num', t.fg)}>{value}</div>
      {sub && <div className="num mt-0.5 text-2xs text-slate-500">{sub}</div>}
    </div>
  );
}

const SIGNAL_TONE: Record<Tone, string> = {
  brand: 'text-brand-400',
  info: 'text-info-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  ai: 'text-ai-fg',
  success: 'text-success-fg',
  neutral: 'text-slate-500',
};

function SuiteSignal({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs uppercase tracking-wider text-slate-500">{label}</span>
      <span className={clsx('text-sm font-medium', SIGNAL_TONE[tone])}>{value}</span>
    </div>
  );
}

// core.jobs.status → BID | ACTIVE | COMPLETE | CLOSED | ON_HOLD | CANCELLED
const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'text-success-fg',
  BID: 'text-info-fg',
  ON_HOLD: 'text-warning-fg',
  COMPLETE: 'text-slate-400',
  CLOSED: 'text-slate-500',
  CANCELLED: 'text-danger-fg',
};

function StatusDot({ status }: { status: string }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      <span className={clsx('text-2xs uppercase tracking-wider', STATUS_TONE[status] ?? 'text-slate-500')}>
        {status.replace('_', ' ').toLowerCase()}
      </span>
    </div>
  );
}

function ArchetypeChip({ value }: { value: string | null }) {
  if (!value) return <span className="text-2xs text-slate-600">—</span>;
  const label = value.replace(/[-_]/g, ' ');
  return (
    <span className="inline-flex max-w-[10rem] items-center truncate rounded-md border border-surface-800 bg-surface-850 px-2 py-0.5 text-2xs text-slate-300">
      {label}
    </span>
  );
}

function ModulePill({ code, name, live = false }: { code: string; name: string; live?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-2xs',
        live
          ? 'border-brand-500/30 bg-brand-500/10 text-brand-400'
          : 'border-surface-800 bg-surface-900 text-slate-500',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', live ? 'bg-brand-500' : 'bg-slate-600')} />
      <span className="num font-medium">{code}</span>
      <span className={live ? 'text-slate-300' : 'text-slate-500'}>{name}</span>
    </span>
  );
}

function EmptyPortfolio() {
  return (
    <div className="px-5 py-12 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-surface-800 bg-surface-850 text-slate-500">
        <FileClock size={20} />
      </div>
      <div className="mt-3 text-heading text-white">No jobs yet</div>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
        Once jobs are created and costed, this portfolio fills with live contract value, commitments and margin.
      </p>
    </div>
  );
}
