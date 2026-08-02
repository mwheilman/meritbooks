import Link from 'next/link';
import clsx from 'clsx';
import {
  ArrowLeft,
  AlertCircle,
  LockKeyhole,
  FileWarning,
  Landmark,
  ArrowDownCircle,
  ArrowUpCircle,
} from 'lucide-react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { ReleaseRetainage } from './retainage-actions';

export const dynamic = 'force-dynamic';

// G7 Retainage — what's being withheld / released on one job, and the closeout
// action that bills accumulated retainage back. The header reads
// proj.v_job_retainage (held / released / outstanding); the ledger is every
// proj.retainage_ledger row. Releasing mints a DRAFT billing_request the
// operator then issues from /billing. Money is bigint cents; render whole USD in
// the header, exact USD in the ledger.

interface JobRow {
  id: string;
  job_number: string | null;
  name: string | null;
  customer_name: string | null;
  status: string | null;
}

interface RetainageSummaryRow {
  held_cents: number | null;
  released_cents: number | null;
  outstanding_cents: number | null;
}

interface LedgerRow {
  id: string;
  entry_type: 'HELD' | 'RELEASED';
  amount_cents: number | null;
  memo: string | null;
  created_at: string;
  billing_request_id: string | null;
}

const usd = (cents: number | null | undefined): string =>
  ((cents ?? 0) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const usdExact = (cents: number | null | undefined): string =>
  ((cents ?? 0) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  });

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
      <Link
        href="/billing"
        className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300"
      >
        <ArrowLeft className="h-4 w-4" /> Billing
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
  tone,
}: {
  label: string;
  value: string;
  tone?: 'held' | 'released' | 'outstanding';
}) {
  const valueTone =
    tone === 'outstanding'
      ? 'text-brand-400'
      : tone === 'released'
        ? 'text-info-fg'
        : 'text-white';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx('num mt-2 text-heading font-semibold', valueTone)}>{value}</div>
    </div>
  );
}

export default async function JobRetainagePage({ params }: { params: { jobId: string } }) {
  const { jobId } = params;
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <Shell
        icon={LockKeyhole}
        title="Sign in to view retainage"
        body="Your session couldn't be authenticated. Sign in again to load org-scoped retainage."
      />
    );
  }

  const [jobRes, summaryRes, ledgerRes] = await Promise.all([
    sb
      .schema('core')
      .from('jobs')
      .select('id, job_number, name, customer_name, status')
      .eq('id', jobId)
      .maybeSingle(),
    sb
      .schema('proj')
      .from('v_job_retainage')
      .select('held_cents, released_cents, outstanding_cents')
      .eq('job_id', jobId)
      .maybeSingle(),
    sb
      .schema('proj')
      .from('retainage_ledger')
      .select('id, entry_type, amount_cents, memo, created_at, billing_request_id')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false }),
  ]);

  if (jobRes.error) {
    return <Shell icon={AlertCircle} title="Couldn't load this job" body={jobRes.error.message} />;
  }
  const job = jobRes.data as JobRow | null;
  if (!job) {
    return (
      <Shell
        icon={FileWarning}
        title="Job not found"
        body="This job doesn't exist or isn't visible to your organization."
      />
    );
  }

  if (ledgerRes.error) {
    return (
      <Shell icon={AlertCircle} title="Couldn't load retainage" body={ledgerRes.error.message} />
    );
  }

  const summary = (summaryRes.data as RetainageSummaryRow | null) ?? null;
  const ledger = (ledgerRes.data ?? []) as LedgerRow[];

  const heldCents = Number(summary?.held_cents ?? 0);
  const releasedCents = Number(summary?.released_cents ?? 0);
  const outstandingCents = Number(summary?.outstanding_cents ?? 0);

  return (
    <div className="space-y-6">
      <Link
        href="/billing"
        className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300"
      >
        <ArrowLeft className="h-4 w-4" /> Billing
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="flex items-center gap-2 text-title text-white">
            <Landmark className="h-6 w-6 text-brand-400" />
            {job.name ?? 'Untitled job'}
          </h1>
          <div className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-slate-500">
            <span>{job.job_number ?? '—'}</span>
            {job.customer_name && <span>· {job.customer_name}</span>}
            <span>· Retainage</span>
          </div>
        </div>
        <Link
          href={`/jobs/${job.id}`}
          className="rounded-lg border border-surface-800 px-3 py-1.5 text-2xs font-medium text-slate-300 hover:bg-surface-850"
        >
          Job detail
        </Link>
      </header>

      {/* Summary */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Held to date" value={usd(heldCents)} tone="held" />
        <Kpi label="Released" value={usd(releasedCents)} tone="released" />
        <Kpi label="Outstanding" value={usd(outstandingCents)} tone="outstanding" />
      </section>

      {/* Release action */}
      <ReleaseRetainage jobId={job.id} outstandingCents={outstandingCents} />

      {/* Ledger */}
      <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        <div className="flex items-center justify-between border-b border-surface-800 px-5 py-3">
          <div className="text-heading text-white">Retainage ledger</div>
          <div className="text-2xs uppercase tracking-wider text-slate-500">Newest first</div>
        </div>

        {ledger.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Landmark className="mx-auto h-8 w-8 text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-300">No retainage yet</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
              Retainage is withheld as this job bills against its schedule of values. HELD and
              RELEASED entries will appear here as they accrue.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Entry</th>
                  <th className="px-5 py-2.5 font-medium">Memo</th>
                  <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {ledger.map((r) => {
                  const held = r.entry_type === 'HELD';
                  return (
                    <tr key={r.id} className="hover:bg-surface-850/40">
                      <td className="num px-5 py-3 text-slate-400">{fmtDateTime(r.created_at)}</td>
                      <td className="px-5 py-3">
                        <span
                          className={clsx(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium',
                            held
                              ? 'border-warning/40 text-warning-fg'
                              : 'border-info/40 text-info-fg',
                          )}
                        >
                          {held ? (
                            <ArrowDownCircle className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowUpCircle className="h-3.5 w-3.5" />
                          )}
                          {held ? 'Held' : 'Released'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-400">{r.memo ?? '—'}</td>
                      <td
                        className={clsx(
                          'num px-5 py-3 text-right font-medium',
                          held ? 'text-white' : 'text-info-fg',
                        )}
                      >
                        {held ? '' : '−'}
                        {usdExact(r.amount_cents)}
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
