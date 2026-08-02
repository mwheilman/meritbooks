import Link from 'next/link';
import { Hammer, ArrowUpRight, AlertCircle, LockKeyhole } from 'lucide-react';
import clsx from 'clsx';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

// G4 Jobs — the hinge surface. Lists every job the caller's org owns (RLS-scoped)
// with the operational margin picture straight from proj.v_job_margin, enriched
// with archetype/status/customer identity from core.jobs.

interface JobMarginRow {
  job_id: string;
  job_number: string | null;
  name: string | null;
  revenue_contract_cents: number | null;
  operational_actual_cents: number | null;
  committed_open_cents: number | null;
  projected_final_cents: number | null;
  operational_margin_pct: number | string | null;
}

interface JobIdentityRow {
  id: string;
  archetype: string | null;
  status: string | null;
  customer_name: string | null;
}

const usd = (cents: number | null | undefined): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format((cents ?? 0) / 100);

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-brand-500/10 text-brand-300 ring-brand-500/20',
  BID: 'bg-info/10 text-info-fg ring-info/20',
  COMPLETE: 'bg-ai/10 text-ai-fg ring-ai/20',
  CLOSED: 'bg-surface-800 text-slate-400 ring-surface-800',
  ON_HOLD: 'bg-warning/10 text-warning-fg ring-warning/20',
  CANCELLED: 'bg-danger/10 text-danger-fg ring-danger/20',
};

function StatusChip({ status }: { status: string | null }) {
  const s = status ?? 'UNKNOWN';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ring-1 ring-inset',
        STATUS_TONE[s] ?? 'bg-surface-800 text-slate-400 ring-surface-800',
      )}
    >
      {s.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

function marginPct(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function EmptyShell({ icon: Icon, title, body }: { icon: typeof Hammer; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-12 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-500" />
      <div className="mt-3 text-heading text-white">{title}</div>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">{body}</p>
    </div>
  );
}

export default async function JobsPage() {
  const sb = await createAuthedServerSupabase();

  const header = (
    <header className="space-y-1">
      <h1 className="text-title text-white">Jobs</h1>
      <p className="text-sm text-slate-400">
        Operational margin across every job in your book — contract, actual cost, open commitments and
        projected final at completion.
      </p>
    </header>
  );

  if (!sb) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyShell
          icon={LockKeyhole}
          title="Sign in to view jobs"
          body="Your session couldn't be authenticated. Sign in again to load org-scoped job data."
        />
      </div>
    );
  }

  const [marginRes, jobsRes] = await Promise.all([
    sb.schema('proj').from('v_job_margin').select('*'),
    sb.schema('core').from('jobs').select('id, archetype, status, customer_name'),
  ]);

  if (marginRes.error) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyShell
          icon={AlertCircle}
          title="Couldn't load jobs"
          body={marginRes.error.message}
        />
      </div>
    );
  }

  const margins = (marginRes.data ?? []) as JobMarginRow[];
  const identities = (jobsRes.data ?? []) as JobIdentityRow[];
  const idMap = new Map(identities.map((j) => [j.id, j]));

  if (margins.length === 0) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyShell
          icon={Hammer}
          title="No jobs yet"
          body="Once opportunities convert to jobs they'll appear here with live cost and margin figures."
        />
      </div>
    );
  }

  const rows = [...margins].sort((a, b) =>
    (b.projected_final_cents ?? 0) - (a.projected_final_cents ?? 0),
  );

  return (
    <div className="space-y-6">
      {header}

      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3 font-medium">Job</th>
              <th className="px-4 py-3 font-medium">Archetype</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Contract</th>
              <th className="px-4 py-3 text-right font-medium">Actual cost</th>
              <th className="px-4 py-3 text-right font-medium">Committed open</th>
              <th className="px-4 py-3 text-right font-medium">Projected final</th>
              <th className="px-4 py-3 text-right font-medium">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-800">
            {rows.map((r) => {
              const id = idMap.get(r.job_id);
              const pct = marginPct(r.operational_margin_pct);
              return (
                <tr key={r.job_id} className="group transition-colors hover:bg-surface-850/60">
                  <td className="px-4 py-3">
                    <Link href={`/jobs/${r.job_id}`} className="flex flex-col">
                      <span className="flex items-center gap-1.5 font-medium text-white group-hover:text-brand-300">
                        {r.name ?? 'Untitled job'}
                        <ArrowUpRight className="h-3.5 w-3.5 text-slate-500 group-hover:text-brand-400" />
                      </span>
                      <span className="num text-2xs text-slate-500">
                        {r.job_number ?? '—'}
                        {id?.customer_name ? ` · ${id.customer_name}` : ''}
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {id?.archetype ? (
                      <span className="inline-flex items-center rounded-md bg-surface-800 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-slate-300">
                        {id.archetype.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={id?.status ?? null} />
                  </td>
                  <td className="num px-4 py-3 text-right text-slate-200">
                    {usd(r.revenue_contract_cents)}
                  </td>
                  <td className="num px-4 py-3 text-right text-slate-200">
                    {usd(r.operational_actual_cents)}
                  </td>
                  <td className="num px-4 py-3 text-right text-slate-400">
                    {usd(r.committed_open_cents)}
                  </td>
                  <td className="num px-4 py-3 text-right text-slate-200">
                    {usd(r.projected_final_cents)}
                  </td>
                  <td className="num px-4 py-3 text-right">
                    {pct === null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <span className={pct >= 0 ? 'text-brand-400' : 'text-danger-fg'}>
                        {pct >= 0 ? '' : '−'}
                        {Math.abs(pct).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-2xs text-slate-500">
        {rows.length} job{rows.length === 1 ? '' : 's'} · projected final = actual + pending + committed
        open. Margin colored emerald when positive, red when underwater.
      </p>
    </div>
  );
}
