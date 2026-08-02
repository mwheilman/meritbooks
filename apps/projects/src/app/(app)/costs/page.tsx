import {
  Wallet,
  Receipt,
  PackageOpen,
  TrendingUp,
  TriangleAlert,
  Layers,
  FileText,
  LockKeyhole,
} from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

// G5 portfolio Cost & Commitments. Reads three RLS-scoped proj views/tables plus
// core.jobs for names, all as the caller (org_isolation enforces the tenant cut).
// Cost-code slippage = per (job, cost_code) budget vs actual vs committed-open →
// projected-final + variance. Commitments = v_commitment_status aggregated back to
// the commitment (Σ amount/invoiced/open), joined to proj.commitments + core.jobs.

interface SlippageRow {
  job_id: string;
  cost_code: string | null;
  cost_code_name: string | null;
  budgeted_cents: number;
  committed_open_cents: number;
  actual_cents: number;
  pending_cents: number;
  projected_final_cents: number;
  variance_cents: number;
}

interface CommitmentStatusRow {
  commitment_id: string;
  commitment_line_id: string;
  job_id: string;
  cost_code_id: string | null;
  amount_cents: number;
  invoiced_cents: number;
  open_cents: number;
}

interface CommitmentRow {
  id: string;
  job_id: string;
  number: string | null;
  commitment_type: 'PURCHASE_ORDER' | 'SUBCONTRACT';
  status: string;
  revised_amount_cents: number;
}

interface JobRow {
  id: string;
  job_number: string | null;
  name: string | null;
}

// Aggregated commitment (lines rolled up to the commitment head).
interface CommitmentAgg {
  id: string;
  job_id: string;
  amount_cents: number;
  invoiced_cents: number;
  open_cents: number;
  number: string | null;
  commitment_type: 'PURCHASE_ORDER' | 'SUBCONTRACT' | null;
  status: string | null;
}

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const pct = (n: number, d: number): number => (d > 0 ? Math.max(0, Math.min(1, n / d)) : 0);

export default async function CostsPage() {
  const sb = await createAuthedServerSupabase();
  if (!sb) return <AuthNeeded />;

  const [slippageRes, commitStatusRes, commitmentsRes, jobsRes] = await Promise.all([
    sb
      .schema('proj')
      .from('v_cost_code_slippage')
      .select(
        'job_id, cost_code, cost_code_name, budgeted_cents, committed_open_cents, actual_cents, pending_cents, projected_final_cents, variance_cents',
      ),
    sb
      .schema('proj')
      .from('v_commitment_status')
      .select('commitment_id, commitment_line_id, job_id, cost_code_id, amount_cents, invoiced_cents, open_cents'),
    sb
      .schema('proj')
      .from('commitments')
      .select('id, job_id, number, commitment_type, status, revised_amount_cents'),
    sb.schema('core').from('jobs').select('id, job_number, name'),
  ]);

  const slippage = (slippageRes.data ?? []) as SlippageRow[];
  const commitStatus = (commitStatusRes.data ?? []) as CommitmentStatusRow[];
  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[];
  const jobs = (jobsRes.data ?? []) as JobRow[];

  const slippageErr = slippageRes.error?.message ?? null;
  const commitErr = commitStatusRes.error?.message ?? commitmentsRes.error?.message ?? null;

  // Join key: job_id → job (names resolved in JS, per contract).
  const jobMap = new Map<string, JobRow>(jobs.map((j) => [j.id, j]));
  const jobLabel = (id: string): { number: string; name: string } => {
    const j = jobMap.get(id);
    return { number: j?.job_number ?? '—', name: j?.name ?? 'Unassigned job' };
  };

  // ── Cost-code slippage: group by job, sorted by job number ──
  const byJob = new Map<string, SlippageRow[]>();
  for (const r of slippage) {
    const arr = byJob.get(r.job_id) ?? [];
    arr.push(r);
    byJob.set(r.job_id, arr);
  }
  const jobGroups = [...byJob.entries()].sort((a, b) =>
    jobLabel(a[0]).number.localeCompare(jobLabel(b[0]).number, undefined, { numeric: true }),
  );

  // ── Commitments: aggregate v_commitment_status to the commitment level ──
  const aggMap = new Map<string, CommitmentAgg>();
  for (const l of commitStatus) {
    const cur =
      aggMap.get(l.commitment_id) ??
      ({
        id: l.commitment_id,
        job_id: l.job_id,
        amount_cents: 0,
        invoiced_cents: 0,
        open_cents: 0,
        number: null,
        commitment_type: null,
        status: null,
      } as CommitmentAgg);
    cur.amount_cents += l.amount_cents;
    cur.invoiced_cents += l.invoiced_cents;
    cur.open_cents += l.open_cents;
    aggMap.set(l.commitment_id, cur);
  }
  const commitmentMap = new Map<string, CommitmentRow>(commitments.map((c) => [c.id, c]));
  const commitmentRows: CommitmentAgg[] = [...aggMap.values()]
    .map((v) => {
      const c = commitmentMap.get(v.id);
      return {
        ...v,
        number: c?.number ?? null,
        commitment_type: c?.commitment_type ?? null,
        status: c?.status ?? null,
      };
    })
    .sort((a, b) => b.open_cents - a.open_cents || b.amount_cents - a.amount_cents);

  // ── KPIs ──
  const totalCommitted = [...aggMap.values()].reduce((s, v) => s + v.amount_cents, 0);
  const totalInvoiced = [...aggMap.values()].reduce((s, v) => s + v.invoiced_cents, 0);
  const totalOpen = [...aggMap.values()].reduce((s, v) => s + v.open_cents, 0);
  const totalProjected = slippage.reduce((s, r) => s + r.projected_final_cents, 0);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-title text-white">Cost &amp; Commitments</h1>
        <p className="text-sm text-slate-400">
          Portfolio slippage and outstanding commitments across every live job. Figures are RLS-scoped to your org.
        </p>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<Wallet className="h-4 w-4" />} label="Total committed" value={usd(totalCommitted)} tone="brand" />
        <Kpi icon={<Receipt className="h-4 w-4" />} label="Total invoiced" value={usd(totalInvoiced)} tone="info" />
        <Kpi icon={<PackageOpen className="h-4 w-4" />} label="Open commitment" value={usd(totalOpen)} tone="warn" />
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />}
          label="Projected final"
          value={usd(totalProjected)}
          tone="slate"
        />
      </section>

      {/* Section 1 — Cost-code slippage */}
      <section className="rounded-xl border border-surface-800 bg-surface-900">
        <SectionHead
          icon={<Layers className="h-4 w-4 text-brand-400" />}
          title="Cost-code slippage"
          sub="Budget vs cleared actual vs open commitment, by cost code. Projected = actual + pending + committed-open."
          count={slippage.length}
          unit="lines"
        />
        {slippageErr ? (
          <ErrorState message={slippageErr} />
        ) : jobGroups.length === 0 ? (
          <EmptyState
            title="No cost activity yet"
            sub="Budget lines and job costs appear here once jobs are underway."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-surface-800 text-2xs uppercase tracking-wider text-slate-500">
                  <th className="py-2 pl-5 pr-3 text-left font-medium">Cost code</th>
                  <th className="px-3 py-2 text-right font-medium">Budget</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Committed open</th>
                  <th className="px-3 py-2 text-right font-medium">Projected final</th>
                  <th className="py-2 pl-3 pr-5 text-right font-medium">Variance</th>
                </tr>
              </thead>
              <tbody>
                {jobGroups.map(([jobId, rows]) => {
                  const jl = jobLabel(jobId);
                  const jobProjected = rows.reduce((s, r) => s + r.projected_final_cents, 0);
                  const jobVariance = rows.reduce((s, r) => s + r.variance_cents, 0);
                  return (
                    <JobBlock key={jobId} jl={jl} projected={jobProjected} variance={jobVariance}>
                      {rows
                        .slice()
                        .sort((a, b) => (a.cost_code ?? '').localeCompare(b.cost_code ?? '', undefined, { numeric: true }))
                        .map((r, i) => (
                          <SlippageRowCells key={`${jobId}-${r.cost_code ?? 'none'}-${i}`} row={r} />
                        ))}
                    </JobBlock>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2 — Commitments */}
      <section className="rounded-xl border border-surface-800 bg-surface-900">
        <SectionHead
          icon={<FileText className="h-4 w-4 text-brand-400" />}
          title="Commitments"
          sub="Purchase orders and subcontracts, rolled up from lines. Progress = invoiced against committed amount."
          count={commitmentRows.length}
          unit="commitments"
        />
        {commitErr ? (
          <ErrorState message={commitErr} />
        ) : commitmentRows.length === 0 ? (
          <EmptyState
            title="No open commitments"
            sub="Approved purchase orders and subcontracts appear here as they are issued."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-surface-800 text-2xs uppercase tracking-wider text-slate-500">
                  <th className="py-2 pl-5 pr-3 text-left font-medium">Commitment</th>
                  <th className="px-3 py-2 text-left font-medium">Job</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Invoiced</th>
                  <th className="px-3 py-2 text-right font-medium">Open</th>
                  <th className="py-2 pl-3 pr-5 text-left font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {commitmentRows.map((c) => {
                  const jl = jobLabel(c.job_id);
                  const p = pct(c.invoiced_cents, c.amount_cents);
                  return (
                    <tr key={c.id} className="border-b border-surface-800/60 last:border-0 hover:bg-surface-950/40">
                      <td className="py-3 pl-5 pr-3 align-middle">
                        <div className="flex items-center gap-2">
                          <TypeChip type={c.commitment_type} />
                          <div className="min-w-0">
                            <div className="num truncate text-white">{c.number ?? '—'}</div>
                            <div className="text-2xs uppercase tracking-wider text-slate-500">
                              {c.status ?? 'UNKNOWN'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="num text-slate-300">{jl.number}</div>
                        <div className="truncate text-2xs text-slate-500">{jl.name}</div>
                      </td>
                      <td className="num px-3 py-3 text-right align-middle text-white">{usd(c.amount_cents)}</td>
                      <td className="num px-3 py-3 text-right align-middle text-slate-300">{usd(c.invoiced_cents)}</td>
                      <td className="num px-3 py-3 text-right align-middle text-warning-fg">{usd(c.open_cents)}</td>
                      <td className="py-3 pl-3 pr-5 align-middle">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-950">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${p * 100}%` }} />
                          </div>
                          <span className="num text-2xs text-slate-500">{Math.round(p * 100)}%</span>
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
    </div>
  );
}

/* ── Cost-code slippage: job subheader + its rows ── */
function JobBlock({
  jl,
  projected,
  variance,
  children,
}: {
  jl: { number: string; name: string };
  projected: number;
  variance: number;
  children: ReactNode;
}) {
  const under = variance >= 0;
  return (
    <>
      <tr className="bg-surface-950/60">
        <td colSpan={4} className="py-2 pl-5 pr-3">
          <div className="flex items-baseline gap-2">
            <span className="num text-sm font-semibold text-white">{jl.number}</span>
            <span className="truncate text-xs text-slate-400">{jl.name}</span>
          </div>
        </td>
        <td className="num px-3 py-2 text-right text-2xs text-slate-400">{usd(projected)}</td>
        <td className={clsx('num py-2 pl-3 pr-5 text-right text-2xs', under ? 'text-success-fg' : 'text-danger-fg')}>
          {under ? '+' : ''}
          {usd(variance)}
        </td>
      </tr>
      {children}
    </>
  );
}

function SlippageRowCells({ row }: { row: SlippageRow }) {
  const under = row.variance_cents >= 0;
  const over = row.projected_final_cents > row.budgeted_cents;
  const barPct = pct(row.projected_final_cents, row.budgeted_cents) * 100;
  return (
    <tr className="border-b border-surface-800/40 last:border-0 hover:bg-surface-950/30">
      <td className="py-2.5 pl-5 pr-3 align-middle">
        <div className="num text-slate-200">{row.cost_code ?? '—'}</div>
        <div className="truncate text-2xs text-slate-500">{row.cost_code_name ?? 'Uncoded'}</div>
      </td>
      <td className="num px-3 py-2.5 text-right align-middle text-slate-300">{usd(row.budgeted_cents)}</td>
      <td className="num px-3 py-2.5 text-right align-middle text-slate-300">{usd(row.actual_cents)}</td>
      <td className="num px-3 py-2.5 text-right align-middle text-slate-400">{usd(row.committed_open_cents)}</td>
      <td className="px-3 py-2.5 align-middle">
        <div className="flex flex-col items-end gap-1">
          <span className="num text-white">{usd(row.projected_final_cents)}</span>
          <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-950">
            <div
              className={clsx('h-full rounded-full', over ? 'bg-danger' : 'bg-brand-500')}
              style={{ width: `${barPct}%` }}
            />
          </div>
        </div>
      </td>
      <td className="py-2.5 pl-3 pr-5 text-right align-middle">
        <span className={clsx('num inline-flex items-center gap-1', under ? 'text-success-fg' : 'text-danger-fg')}>
          {!under && <TriangleAlert className="h-3 w-3" />}
          {under ? '+' : ''}
          {usd(row.variance_cents)}
        </span>
      </td>
    </tr>
  );
}

function TypeChip({ type }: { type: 'PURCHASE_ORDER' | 'SUBCONTRACT' | null }) {
  const isSub = type === 'SUBCONTRACT';
  const label = type === 'PURCHASE_ORDER' ? 'PO' : type === 'SUBCONTRACT' ? 'SUB' : '—';
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider',
        isSub
          ? 'border-ai/30 bg-ai/10 text-ai-fg'
          : 'border-info/30 bg-info/10 text-info-fg',
      )}
    >
      {label}
    </span>
  );
}

function Kpi({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: 'brand' | 'info' | 'warn' | 'slate';
}) {
  const fg =
    tone === 'brand'
      ? 'text-brand-400'
      : tone === 'info'
        ? 'text-info-fg'
        : tone === 'warn'
          ? 'text-warning-fg'
          : 'text-slate-300';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-4">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-slate-500">
        <span className={fg}>{icon}</span>
        {label}
      </div>
      <div className={clsx('num mt-2 text-heading font-semibold', fg)}>{value}</div>
    </div>
  );
}

function SectionHead({
  icon,
  title,
  sub,
  count,
  unit,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  count: number;
  unit: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">{icon}</span>
        <div>
          <div className="text-heading text-white">{title}</div>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-500">{sub}</p>
        </div>
      </div>
      <div className="num shrink-0 whitespace-nowrap text-2xs uppercase tracking-wider text-slate-500">
        {count} {unit}
      </div>
    </div>
  );
}

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="border-t border-surface-800 px-5 py-12 text-center">
      <div className="text-sm font-medium text-slate-300">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="border-t border-surface-800 px-5 py-8">
      <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/5 p-4">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
        <div>
          <div className="text-sm font-medium text-danger-fg">Couldn&apos;t load this section</div>
          <p className="num mt-1 text-2xs text-slate-500">{message}</p>
        </div>
      </div>
    </div>
  );
}

function AuthNeeded() {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-title text-white">Cost &amp; Commitments</h1>
        <p className="text-sm text-slate-400">Portfolio slippage and outstanding commitments.</p>
      </header>
      <div className="rounded-xl border border-surface-800 bg-surface-900 px-5 py-12 text-center">
        <LockKeyhole className="mx-auto h-5 w-5 text-slate-500" />
        <div className="mt-3 text-sm font-medium text-slate-300">Sign in to view cost data</div>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
          This page reads live, org-scoped figures and needs an authenticated session.
        </p>
      </div>
    </div>
  );
}
