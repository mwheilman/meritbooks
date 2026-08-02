import Link from 'next/link';
import clsx from 'clsx';
import {
  Wallet,
  AlertCircle,
  LockKeyhole,
  Briefcase,
  ArrowLeft,
  Search,
} from 'lucide-react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { AddAllowance, AllowanceRowActions, type CostCodeOption } from './allowances-actions';

export const dynamic = 'force-dynamic';

// G7 Allowances — owner allowances and their drawdown, per job. With no ?jobId
// this is a job picker; with a job it lists proj.v_allowance_status (allowance /
// consumed / remaining / % consumed) plus the create + drawdown + close actions.
// Money is bigint cents.

interface JobRow {
  id: string;
  job_number: string | null;
  name: string | null;
  customer_name: string | null;
  status: string | null;
}

interface AllowanceRow {
  id: string;
  job_id: string;
  cost_code_id: string | null;
  description: string;
  status: 'OPEN' | 'CLOSED';
  allowance_cents: number | null;
  consumed_cents: number | null;
  remaining_cents: number | null;
  pct_consumed: number | string | null;
}

interface CostCodeRow {
  id: string;
  code: string;
  name: string;
  job_id: string | null;
}

const usd = (cents: number | null | undefined): string =>
  ((cents ?? 0) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};

function Header() {
  return (
    <header className="space-y-1">
      <h1 className="flex items-center gap-2 text-title text-white">
        <Wallet className="h-6 w-6 text-brand-400" />
        Allowances
      </h1>
      <p className="text-sm text-slate-400">
        Owner allowances and their drawdown — track the budgeted allowance, what&apos;s been consumed,
        and what remains before an overrun.
      </p>
    </header>
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
      <Header />
      <div className="rounded-xl border border-surface-800 bg-surface-900 p-12 text-center">
        <Icon className="mx-auto h-8 w-8 text-slate-500" />
        <div className="mt-3 text-heading text-white">{title}</div>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">{body}</p>
      </div>
    </div>
  );
}

export default async function AllowancesPage({
  searchParams,
}: {
  searchParams: { jobId?: string };
}) {
  const jobId = typeof searchParams.jobId === 'string' ? searchParams.jobId : null;
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <Shell
        icon={LockKeyhole}
        title="Sign in to view allowances"
        body="Your session couldn't be authenticated. Sign in again to load org-scoped allowances."
      />
    );
  }

  // ── No job selected → job picker ──────────────────────────────────────────
  if (!jobId) {
    const jobsRes = await sb
      .schema('core')
      .from('jobs')
      .select('id, job_number, name, customer_name, status')
      .order('job_number', { ascending: true });

    if (jobsRes.error) {
      return <Shell icon={AlertCircle} title="Couldn't load jobs" body={jobsRes.error.message} />;
    }
    const jobs = (jobsRes.data ?? []) as JobRow[];

    return (
      <div className="space-y-6">
        <Header />
        <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
          <div className="flex items-center justify-between border-b border-surface-800 px-5 py-3">
            <div className="text-heading text-white">Select a job</div>
            <div className="text-2xs uppercase tracking-wider text-slate-500">
              {jobs.length} job{jobs.length === 1 ? '' : 's'}
            </div>
          </div>
          {jobs.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <Briefcase className="mx-auto h-8 w-8 text-slate-600" />
              <div className="mt-3 text-sm font-medium text-slate-300">No jobs yet</div>
              <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
                Allowances are tracked per job. Create a job first, then set its owner allowances.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-surface-800">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link
                    href={`/allowances?jobId=${j.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-850/40"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="num text-2xs text-slate-500">{j.job_number ?? '—'}</span>
                      <span className="font-medium text-white">{j.name ?? 'Untitled job'}</span>
                      {j.customer_name && (
                        <span className="text-2xs text-slate-500">· {j.customer_name}</span>
                      )}
                    </div>
                    <Search className="h-4 w-4 text-slate-600" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  // ── Job selected → allowance list + actions ───────────────────────────────
  const [jobRes, allowancesRes, costCodesRes] = await Promise.all([
    sb
      .schema('core')
      .from('jobs')
      .select('id, job_number, name, customer_name, status')
      .eq('id', jobId)
      .maybeSingle(),
    sb
      .schema('proj')
      .from('v_allowance_status')
      .select(
        'id, job_id, cost_code_id, description, status, allowance_cents, consumed_cents, remaining_cents, pct_consumed',
      )
      .eq('job_id', jobId)
      .order('description', { ascending: true }),
    sb
      .schema('proj')
      .from('cost_codes')
      .select('id, code, name, job_id')
      .or(`job_id.eq.${jobId},job_id.is.null`)
      .eq('is_active', true)
      .order('code', { ascending: true }),
  ]);

  if (jobRes.error) {
    return <Shell icon={AlertCircle} title="Couldn't load this job" body={jobRes.error.message} />;
  }
  const job = jobRes.data as JobRow | null;
  if (!job) {
    return (
      <Shell
        icon={AlertCircle}
        title="Job not found"
        body="This job doesn't exist or isn't visible to your organization."
      />
    );
  }
  if (allowancesRes.error) {
    return (
      <Shell icon={AlertCircle} title="Couldn't load allowances" body={allowancesRes.error.message} />
    );
  }

  const allowances = (allowancesRes.data ?? []) as AllowanceRow[];
  const costCodes = (costCodesRes.data ?? []) as CostCodeRow[];
  const costCodeById = new Map(costCodes.map((c) => [c.id, c]));
  const costCodeOptions: CostCodeOption[] = costCodes.map((c) => ({
    id: c.id,
    label: `${c.code} · ${c.name}`,
  }));

  // Roll-up totals across allowances (integer cents).
  const totalAllowance = allowances.reduce((s, a) => s + num(a.allowance_cents), 0);
  const totalConsumed = allowances.reduce((s, a) => s + num(a.consumed_cents), 0);
  const totalRemaining = totalAllowance - totalConsumed;

  return (
    <div className="space-y-6">
      <Link
        href="/allowances"
        className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300"
      >
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="flex items-center gap-2 text-title text-white">
            <Wallet className="h-6 w-6 text-brand-400" />
            {job.name ?? 'Untitled job'}
          </h1>
          <div className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-slate-500">
            <span>{job.job_number ?? '—'}</span>
            {job.customer_name && <span>· {job.customer_name}</span>}
            <span>· Allowances</span>
          </div>
        </div>
        <Link
          href={`/jobs/${job.id}`}
          className="rounded-lg border border-surface-800 px-3 py-1.5 text-2xs font-medium text-slate-300 hover:bg-surface-850"
        >
          Job detail
        </Link>
      </header>

      {/* Roll-up */}
      {allowances.length > 0 && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
            <div className="text-2xs uppercase tracking-wider text-slate-500">Total allowance</div>
            <div className="num mt-2 text-heading font-semibold text-white">
              {usd(totalAllowance)}
            </div>
          </div>
          <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
            <div className="text-2xs uppercase tracking-wider text-slate-500">Consumed</div>
            <div className="num mt-2 text-heading font-semibold text-info-fg">
              {usd(totalConsumed)}
            </div>
          </div>
          <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
            <div className="text-2xs uppercase tracking-wider text-slate-500">Remaining</div>
            <div
              className={clsx(
                'num mt-2 text-heading font-semibold',
                totalRemaining < 0 ? 'text-danger-fg' : 'text-brand-400',
              )}
            >
              {usd(totalRemaining)}
            </div>
          </div>
        </section>
      )}

      {/* Add allowance */}
      <div className="flex justify-end">
        <AddAllowance jobId={job.id} costCodes={costCodeOptions} />
      </div>

      {/* Allowance list */}
      <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        <div className="flex items-center justify-between border-b border-surface-800 px-5 py-3">
          <div className="text-heading text-white">Allowances</div>
          <div className="text-2xs uppercase tracking-wider text-slate-500">
            {allowances.length} total
          </div>
        </div>

        {allowances.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Wallet className="mx-auto h-8 w-8 text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-300">No allowances yet</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
              Add an owner allowance above — a budgeted sum (e.g. lighting, appliances) drawn down as
              actual selections are made.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-surface-800">
            {allowances.map((a) => {
              const allowance = num(a.allowance_cents);
              const consumed = num(a.consumed_cents);
              const remaining = num(a.remaining_cents);
              const pct = Math.round(num(a.pct_consumed) * 100);
              const over = remaining < 0;
              const code = a.cost_code_id ? costCodeById.get(a.cost_code_id) : null;
              const closed = a.status === 'CLOSED';
              return (
                <li key={a.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{a.description}</span>
                        {closed && (
                          <span className="inline-flex items-center rounded-full border border-surface-800 px-2 py-0.5 text-2xs font-medium text-slate-400">
                            Closed
                          </span>
                        )}
                        {over && !closed && (
                          <span className="inline-flex items-center rounded-full border border-danger/40 px-2 py-0.5 text-2xs font-medium text-danger-fg">
                            Over
                          </span>
                        )}
                      </div>
                      {code && (
                        <div className="num text-2xs text-slate-500">
                          {code.code} · {code.name}
                        </div>
                      )}
                    </div>
                    <AllowanceRowActions
                      allowanceId={a.id}
                      status={a.status}
                      consumedCents={consumed}
                      allowanceCents={allowance}
                    />
                  </div>

                  {/* Figures + drawdown bar */}
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <Figure label="Allowance" value={usd(allowance)} />
                    <Figure label="Consumed" value={usd(consumed)} tone="info" />
                    <Figure
                      label="Remaining"
                      value={usd(remaining)}
                      tone={over ? 'danger' : 'brand'}
                    />
                  </div>
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-2xs text-slate-500">
                      <span>Consumed</span>
                      <span className="num">{pct}%</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-800">
                      <div
                        className={clsx(
                          'h-full rounded-full',
                          over ? 'bg-danger-fg' : 'bg-brand-500',
                        )}
                        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'info' | 'brand' | 'danger';
}) {
  const valueTone =
    tone === 'info'
      ? 'text-info-fg'
      : tone === 'brand'
        ? 'text-brand-400'
        : tone === 'danger'
          ? 'text-danger-fg'
          : 'text-white';
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-950 px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx('num mt-0.5 text-sm font-semibold', valueTone)}>{value}</div>
    </div>
  );
}
