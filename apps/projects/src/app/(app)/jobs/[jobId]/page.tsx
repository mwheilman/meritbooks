import Link from 'next/link';
import {
  ArrowLeft,
  AlertCircle,
  LockKeyhole,
  FileWarning,
  ClipboardList,
  ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

// G4 Job detail. Single job, three-number operational picture + slippage,
// commitments and external gates. Every panel RLS-scoped, all figures live
// from proj.* views. Money is integer cents; render as whole USD.

interface JobIdentityRow {
  id: string;
  job_number: string | null;
  name: string | null;
  archetype: string | null;
  status: string | null;
  customer_name: string | null;
}

interface JobMarginRow {
  job_id: string;
  revenue_contract_cents: number | null;
  operational_actual_cents: number | null;
  operational_pending_cents: number | null;
  committed_open_cents: number | null;
  projected_final_cents: number | null;
  operational_margin_cents: number | null;
  operational_margin_pct: number | string | null;
  budget_remaining_cents: number | null;
}

interface ContractRow {
  job_id: string;
  pct_complete: number | string | null;
  progress_basis: string | null;
  status: string | null;
}

interface SlippageRow {
  cost_code: string | null;
  cost_code_name: string | null;
  budgeted_cents: number | null;
  actual_cents: number | null;
  committed_open_cents: number | null;
  projected_final_cents: number | null;
  variance_cents: number | null;
}

interface CommitmentRow {
  id: string;
  number: string | null;
  commitment_type: string | null;
  status: string | null;
  original_amount_cents: number | null;
  revised_amount_cents: number | null;
}

interface CommitmentStatusRow {
  commitment_id: string;
  amount_cents: number | null;
  invoiced_cents: number | null;
  open_cents: number | null;
}

interface GateRow {
  gate_type: string | null;
  name: string | null;
  status: string | null;
}

const usd = (cents: number | null | undefined): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format((cents ?? 0) / 100);

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-brand-500/10 text-brand-300 ring-brand-500/20',
  BID: 'bg-info/10 text-info-fg ring-info/20',
  COMPLETE: 'bg-ai/10 text-ai-fg ring-ai/20',
  CLOSED: 'bg-surface-800 text-slate-400 ring-surface-800',
  ON_HOLD: 'bg-warning/10 text-warning-fg ring-warning/20',
  CANCELLED: 'bg-danger/10 text-danger-fg ring-danger/20',
};

const GATE_TONE: Record<string, string> = {
  APPROVED: 'bg-brand-500/10 text-brand-300 ring-brand-500/20',
  CLEARED: 'bg-brand-500/10 text-brand-300 ring-brand-500/20',
  WAIVED: 'bg-surface-800 text-slate-400 ring-surface-800',
  SUBMITTED: 'bg-info/10 text-info-fg ring-info/20',
  PENDING: 'bg-warning/10 text-warning-fg ring-warning/20',
  REJECTED: 'bg-danger/10 text-danger-fg ring-danger/20',
  EXPIRED: 'bg-danger/10 text-danger-fg ring-danger/20',
};

function Chip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ring-1 ring-inset',
        tone,
      )}
    >
      {label.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

function Shell({
  title,
  body,
  icon: Icon,
}: {
  title: string;
  body: string;
  icon: typeof AlertCircle;
}) {
  return (
    <div className="space-y-6">
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>
      <div className="rounded-xl border border-surface-800 bg-surface-900 p-12 text-center">
        <Icon className="mx-auto h-8 w-8 text-slate-500" />
        <div className="mt-3 text-heading text-white">{title}</div>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">{body}</p>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-4">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className={clsx(
          'num mt-1.5 text-heading font-semibold',
          tone === 'pos' ? 'text-brand-400' : tone === 'neg' ? 'text-danger-fg' : 'text-white',
        )}
      >
        {value}
      </div>
      {sub && <div className="num mt-0.5 text-2xs text-slate-500">{sub}</div>}
    </div>
  );
}

function SectionCard({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-surface-800 bg-surface-900">
      <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
        <h2 className="text-heading text-white">{title}</h2>
        {count !== undefined && <span className="num text-2xs text-slate-500">{count}</span>}
      </div>
      {children}
    </section>
  );
}

export default async function JobDetailPage({ params }: { params: { jobId: string } }) {
  const { jobId } = params;
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <Shell
        icon={LockKeyhole}
        title="Sign in to view this job"
        body="Your session couldn't be authenticated. Sign in again to load org-scoped job data."
      />
    );
  }

  const [jobRes, marginRes, contractRes, slippageRes, commitmentsRes, commitStatusRes, gatesRes] =
    await Promise.all([
      sb.schema('core').from('jobs').select('id, job_number, name, archetype, status, customer_name').eq('id', jobId).maybeSingle(),
      sb.schema('proj').from('v_job_margin').select('*').eq('job_id', jobId).maybeSingle(),
      sb.schema('proj').from('v_contract_current').select('job_id, pct_complete, progress_basis, status').eq('job_id', jobId).limit(1),
      sb.schema('proj').from('v_cost_code_slippage').select('cost_code, cost_code_name, budgeted_cents, actual_cents, committed_open_cents, projected_final_cents, variance_cents').eq('job_id', jobId),
      sb.schema('proj').from('commitments').select('id, number, commitment_type, status, original_amount_cents, revised_amount_cents').eq('job_id', jobId),
      sb.schema('proj').from('v_commitment_status').select('commitment_id, amount_cents, invoiced_cents, open_cents').eq('job_id', jobId),
      sb.schema('proj').from('external_gates').select('gate_type, name, status').eq('job_id', jobId),
    ]);

  if (jobRes.error) {
    return <Shell icon={AlertCircle} title="Couldn't load this job" body={jobRes.error.message} />;
  }

  const job = jobRes.data as JobIdentityRow | null;
  if (!job) {
    return (
      <Shell
        icon={FileWarning}
        title="Job not found"
        body="This job doesn't exist or isn't visible to your organization."
      />
    );
  }

  const margin = (marginRes.data as JobMarginRow | null) ?? null;
  const contract = ((contractRes.data ?? []) as ContractRow[])[0] ?? null;
  const slippage = (slippageRes.data ?? []) as SlippageRow[];
  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[];
  const commitStatus = (commitStatusRes.data ?? []) as CommitmentStatusRow[];
  const gates = (gatesRes.data ?? []) as GateRow[];

  // Aggregate commitment-line status up to each commitment.
  const statusByCommitment = new Map<string, { amount: number; invoiced: number; open: number }>();
  for (const s of commitStatus) {
    const cur = statusByCommitment.get(s.commitment_id) ?? { amount: 0, invoiced: 0, open: 0 };
    cur.amount += s.amount_cents ?? 0;
    cur.invoiced += s.invoiced_cents ?? 0;
    cur.open += s.open_cents ?? 0;
    statusByCommitment.set(s.commitment_id, cur);
  }

  const pctComplete = (() => {
    const p = num(contract?.pct_complete ?? null);
    if (p === null) return null;
    return Math.max(0, Math.min(100, p * 100));
  })();

  const marginPctVal = num(margin?.operational_margin_pct ?? null);
  const marginCents = margin?.operational_margin_cents ?? null;

  return (
    <div className="space-y-6">
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-title text-white">{job.name ?? 'Untitled job'}</h1>
          <div className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-slate-500">
            <span>{job.job_number ?? '—'}</span>
            {job.customer_name && <span>· {job.customer_name}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.archetype && (
            <span className="inline-flex items-center rounded-md bg-surface-800 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-slate-300">
              {job.archetype.replace(/_/g, ' ').toLowerCase()}
            </span>
          )}
          <Chip
            label={job.status ?? 'unknown'}
            tone={STATUS_TONE[job.status ?? ''] ?? 'bg-surface-800 text-slate-400 ring-surface-800'}
          />
        </div>
      </header>

      {/* KPI row — the three-number operational picture */}
      {margin ? (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Kpi label="Contract value" value={usd(margin.revenue_contract_cents)} />
          <Kpi label="Operational actual" value={usd(margin.operational_actual_cents)} />
          <Kpi label="Pending" value={usd(margin.operational_pending_cents)} />
          <Kpi label="Committed open" value={usd(margin.committed_open_cents)} />
          <Kpi label="Projected final" value={usd(margin.projected_final_cents)} />
          <Kpi
            label="Operational margin"
            value={usd(marginCents)}
            sub={marginPctVal === null ? undefined : `${marginPctVal >= 0 ? '' : '−'}${Math.abs(marginPctVal).toFixed(1)}%`}
            tone={marginCents === null ? undefined : marginCents >= 0 ? 'pos' : 'neg'}
          />
          <Kpi
            label="Budget remaining"
            value={usd(margin.budget_remaining_cents)}
            tone={(margin.budget_remaining_cents ?? 0) < 0 ? 'neg' : undefined}
          />
        </section>
      ) : (
        <div className="rounded-xl border border-surface-800 bg-surface-900 p-6 text-sm text-slate-400">
          No margin figures yet — this job has no contract, cost or commitment activity.
        </div>
      )}

      {/* Percent complete */}
      {pctComplete !== null && (
        <section className="rounded-xl border border-surface-800 bg-surface-900 p-4">
          <div className="flex items-center justify-between text-2xs uppercase tracking-wider text-slate-500">
            <span>Percent complete{contract?.progress_basis ? ` · ${contract.progress_basis.replace(/_/g, ' ').toLowerCase()}` : ''}</span>
            <span className="num text-slate-300">{pctComplete.toFixed(1)}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-800">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${pctComplete}%` }} />
          </div>
        </section>
      )}

      {/* Cost-code slippage */}
      <SectionCard title="Cost-code slippage" count={slippage.length}>
        {slippage.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No cost-code budget or activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Code</th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 text-right font-medium">Budget</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actual</th>
                  <th className="px-4 py-2.5 text-right font-medium">Committed open</th>
                  <th className="px-4 py-2.5 text-right font-medium">Projected final</th>
                  <th className="px-4 py-2.5 text-right font-medium">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {slippage.map((r, i) => {
                  const v = r.variance_cents ?? 0;
                  return (
                    <tr key={`${r.cost_code ?? 'n'}-${i}`} className="hover:bg-surface-850/60">
                      <td className="num px-4 py-2.5 text-slate-300">{r.cost_code ?? '—'}</td>
                      <td className="px-4 py-2.5 text-slate-300">{r.cost_code_name ?? '—'}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-400">{usd(r.budgeted_cents)}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-200">{usd(r.actual_cents)}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-400">{usd(r.committed_open_cents)}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-200">{usd(r.projected_final_cents)}</td>
                      <td className={clsx('num px-4 py-2.5 text-right', v < 0 ? 'text-danger-fg' : 'text-brand-400')}>
                        {usd(v)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Commitments */}
      <SectionCard title="Commitments" count={commitments.length}>
        {commitments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <ClipboardList className="h-6 w-6 text-slate-600" />
            <p className="text-sm text-slate-500">No purchase orders or subcontracts on this job yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Number</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 text-right font-medium">Invoiced</th>
                  <th className="px-4 py-2.5 text-right font-medium">Open</th>
                  <th className="px-4 py-2.5 font-medium">Billed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {commitments.map((c) => {
                  const agg = statusByCommitment.get(c.id);
                  const amount = agg?.amount ?? c.revised_amount_cents ?? c.original_amount_cents ?? 0;
                  const invoiced = agg?.invoiced ?? 0;
                  const open = agg?.open ?? Math.max(amount - invoiced, 0);
                  const pct = amount > 0 ? Math.max(0, Math.min(100, (invoiced / amount) * 100)) : 0;
                  return (
                    <tr key={c.id} className="hover:bg-surface-850/60">
                      <td className="num px-4 py-2.5 text-slate-200">{c.number ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className="text-2xs uppercase tracking-wide text-slate-400">
                          {(c.commitment_type ?? '—').replace(/_/g, ' ').toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Chip
                          label={c.status ?? 'draft'}
                          tone={STATUS_TONE[c.status ?? ''] ?? 'bg-surface-800 text-slate-400 ring-surface-800'}
                        />
                      </td>
                      <td className="num px-4 py-2.5 text-right text-slate-200">{usd(amount)}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-400">{usd(invoiced)}</td>
                      <td className="num px-4 py-2.5 text-right text-slate-300">{usd(open)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-800">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="num text-2xs text-slate-500">{pct.toFixed(0)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* External gates */}
      <SectionCard title="External gates" count={gates.length}>
        {gates.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <ShieldCheck className="h-6 w-6 text-slate-600" />
            <p className="text-sm text-slate-500">No permits, inspections or acceptance gates tracked.</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 p-4">
            {gates.map((g, i) => (
              <div
                key={`${g.gate_type ?? 'g'}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-950 px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-2xs uppercase tracking-wide text-slate-500">
                    {(g.gate_type ?? 'gate').replace(/_/g, ' ').toLowerCase()}
                  </span>
                  <span className="text-sm text-slate-200">{g.name ?? '—'}</span>
                </div>
                <Chip
                  label={g.status ?? 'pending'}
                  tone={GATE_TONE[g.status ?? ''] ?? 'bg-surface-800 text-slate-400 ring-surface-800'}
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
