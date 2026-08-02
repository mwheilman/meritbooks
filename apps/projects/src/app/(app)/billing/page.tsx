import Link from 'next/link';
import clsx from 'clsx';
import {
  Receipt,
  FileText,
  FileCheck2,
  CircleDollarSign,
  AlertTriangle,
  Lock,
} from 'lucide-react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { NewDraw, IssueDraw, type JobOption } from './billing-actions';

export const dynamic = 'force-dynamic';

// G7 Billing — the draws ledger for MeritProjects. Reads proj.billing_requests
// (RLS auto-scopes to the caller's org) joined in JS to core.jobs + proj.v_job_margin.
// A draw's amount is the SUM of its proj.billing_request_lines. UNISSUED draws are
// the Books-absent (standalone) terminal state: approved but with no ledger consumer,
// so nothing was ever invoiced — surfaced explicitly rather than hidden.

// ---- Domain types (no `any`) -------------------------------------------------

type BillingType = 'MILESTONE' | 'PROGRESS' | 'TIME_MATERIALS' | 'DRAW';
type BillingStatus = 'DRAFT' | 'EMITTED' | 'PROCESSED' | 'REJECTED' | 'UNISSUED';

interface BillingRequestRow {
  id: string;
  job_id: string;
  billing_type: BillingType;
  status: BillingStatus;
  occurred_on: string;
  source_ref: string;
  invoice_number: string | null;
  invoice_id: string | null;
}

interface BillingLineRow {
  billing_request_id: string;
  amount_cents: number;
}

interface JobRow {
  id: string;
  job_number: string;
  name: string;
}

interface JobMarginRow {
  job_id: string;
  revenue_contract_cents: number;
}

// A draw resolved for display: request + its job + summed line total.
interface Draw {
  id: string;
  jobNumber: string;
  jobName: string;
  billingType: BillingType;
  status: BillingStatus;
  occurredOn: string;
  invoiceNumber: string | null;
  amountCents: number;
}

// ---- Helpers -----------------------------------------------------------------

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const usdExact = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });

const BILLING_TYPE_LABEL: Record<BillingType, string> = {
  MILESTONE: 'Milestone',
  PROGRESS: 'Progress',
  TIME_MATERIALS: 'T&M',
  DRAW: 'Draw',
};

interface StatusMeta {
  label: string;
  // token-driven classes pulled straight from tailwind.config.ts fg colors
  dot: string;
  text: string;
  ring: string;
}

const STATUS_META: Record<BillingStatus, StatusMeta> = {
  DRAFT: { label: 'Draft', dot: 'bg-slate-500', text: 'text-slate-300', ring: 'border-surface-800' },
  EMITTED: { label: 'Emitted', dot: 'bg-info-fg', text: 'text-info-fg', ring: 'border-info/40' },
  PROCESSED: { label: 'Processed', dot: 'bg-success-fg', text: 'text-success-fg', ring: 'border-success/40' },
  UNISSUED: { label: 'Unissued', dot: 'bg-warning-fg', text: 'text-warning-fg', ring: 'border-warning/40' },
  REJECTED: { label: 'Rejected', dot: 'bg-danger-fg', text: 'text-danger-fg', ring: 'border-danger/40' },
};

const STATUS_ORDER: BillingStatus[] = ['DRAFT', 'EMITTED', 'PROCESSED', 'UNISSUED', 'REJECTED'];

// ---- Page --------------------------------------------------------------------

export default async function BillingPage() {
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <StateShell>
        <EmptyCard
          icon={<Lock className="h-5 w-5 text-slate-500" />}
          title="Sign in to view billing"
          body="Your session couldn't be resolved. Billing is scoped to your organization and requires an authenticated session."
          action={
            <Link href="/sign-in" className="text-sm text-brand-400 hover:text-brand-300">
              Go to sign in
            </Link>
          }
        />
      </StateShell>
    );
  }

  const [requestsRes, linesRes, jobsRes, marginRes] = await Promise.all([
    sb
      .schema('proj')
      .from('billing_requests')
      .select('id,job_id,billing_type,status,occurred_on,source_ref,invoice_number,invoice_id')
      .order('occurred_on', { ascending: false }),
    sb.schema('proj').from('billing_request_lines').select('billing_request_id,amount_cents'),
    sb.schema('core').from('jobs').select('id,job_number,name'),
    sb.schema('proj').from('v_job_margin').select('job_id,revenue_contract_cents'),
  ]);

  const firstError =
    requestsRes.error || linesRes.error || jobsRes.error || marginRes.error;
  if (firstError) {
    return (
      <StateShell>
        <EmptyCard
          icon={<AlertTriangle className="h-5 w-5 text-danger-fg" />}
          title="Couldn't load billing"
          body={firstError.message}
        />
      </StateShell>
    );
  }

  const requests = (requestsRes.data ?? []) as BillingRequestRow[];
  const lines = (linesRes.data ?? []) as BillingLineRow[];
  const jobs = (jobsRes.data ?? []) as JobRow[];
  const margins = (marginRes.data ?? []) as JobMarginRow[];

  // Sum line amounts per request (money is bigint cents — integer add, never float math).
  const amountByRequest = new Map<string, number>();
  for (const line of lines) {
    amountByRequest.set(
      line.billing_request_id,
      (amountByRequest.get(line.billing_request_id) ?? 0) + Number(line.amount_cents),
    );
  }

  const jobById = new Map<string, JobRow>(jobs.map((j) => [j.id, j]));

  // Job options for the "New draw" picker (sorted by job number for scanability).
  const jobOptions: JobOption[] = [...jobs]
    .sort((a, b) => a.job_number.localeCompare(b.job_number))
    .map((j) => ({ id: j.id, jobNumber: j.job_number, name: j.name }));

  const draws: Draw[] = requests.map((r) => {
    const job = jobById.get(r.job_id);
    return {
      id: r.id,
      jobNumber: job?.job_number ?? '—',
      jobName: job?.name ?? 'Unknown job',
      billingType: r.billing_type,
      status: r.status,
      occurredOn: r.occurred_on,
      invoiceNumber: r.invoice_number,
      amountCents: amountByRequest.get(r.id) ?? 0,
    };
  });

  // KPIs
  const contractedCents = margins.reduce((sum, m) => sum + Number(m.revenue_contract_cents), 0);
  const emittedCents = draws
    .filter((d) => d.status === 'EMITTED')
    .reduce((sum, d) => sum + d.amountCents, 0);

  const countByStatus = STATUS_ORDER.reduce<Record<BillingStatus, number>>(
    (acc, s) => {
      acc[s] = draws.filter((d) => d.status === s).length;
      return acc;
    },
    { DRAFT: 0, EMITTED: 0, PROCESSED: 0, UNISSUED: 0, REJECTED: 0 },
  );

  const hasUnissued = countByStatus.UNISSUED > 0;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-title text-white">
            <Receipt className="h-6 w-6 text-brand-400" />
            Billing
          </h1>
          <p className="text-sm text-slate-400">
            Draws across the portfolio — milestone, progress, and T&amp;M billing requests, from
            draft through issued invoice.
          </p>
        </div>
      </header>

      {/* New draw: a right-aligned button that expands into a full-width composer. */}
      <div className="flex justify-end">
        <NewDraw jobs={jobOptions} />
      </div>

      {/* KPI strip */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi
          icon={<CircleDollarSign className="h-4 w-4 text-brand-400" />}
          label="Contracted value"
          value={usd(contractedCents)}
          hint={`${margins.length} job${margins.length === 1 ? '' : 's'} under contract`}
          tone="brand"
        />
        <Kpi
          icon={<FileCheck2 className="h-4 w-4 text-info-fg" />}
          label="Emitted (in-flight)"
          value={usd(emittedCents)}
          hint={`${countByStatus.EMITTED} draw${countByStatus.EMITTED === 1 ? '' : 's'} awaiting the ledger`}
          tone="info"
        />
        <Kpi
          icon={<FileText className="h-4 w-4 text-slate-300" />}
          label="Draws"
          value={String(draws.length)}
          hint={STATUS_ORDER.filter((s) => countByStatus[s] > 0)
            .map((s) => `${countByStatus[s]} ${STATUS_META[s].label.toLowerCase()}`)
            .join(' · ') || 'None yet'}
          tone="neutral"
        />
      </section>

      {hasUnissued && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-surface-900 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-warning-fg">
              {countByStatus.UNISSUED} unissued draw{countByStatus.UNISSUED === 1 ? '' : 's'}.
            </span>{' '}
            These were approved while running standalone (Books absent), so no invoice was cut and no
            ledger event was emitted. Connect MeritBooks to issue them.
          </p>
        </div>
      )}

      {/* Draws table */}
      <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        <div className="flex items-center justify-between border-b border-surface-800 px-5 py-3">
          <div className="text-heading text-white">Draws</div>
          <div className="text-2xs uppercase tracking-wider text-slate-500">Newest first</div>
        </div>

        {draws.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Receipt className="mx-auto h-8 w-8 text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-300">No draws yet</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
              Billing requests appear here as jobs bill against their contracts. Milestone, progress,
              and T&amp;M draws all land in this ledger.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5 font-medium">Job</th>
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Invoice</th>
                  <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-5 py-2.5 text-right font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {draws.map((d) => {
                  const meta = STATUS_META[d.status];
                  return (
                    <tr
                      key={d.id}
                      className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/40"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-baseline gap-2">
                          <span className="num text-2xs text-slate-500">{d.jobNumber}</span>
                          <span className="truncate font-medium text-white">{d.jobName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center rounded-md border border-surface-800 bg-surface-950 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-slate-300">
                          {BILLING_TYPE_LABEL[d.billingType]}
                        </span>
                      </td>
                      <td className="num px-5 py-3 text-slate-400">{fmtDate(d.occurredOn)}</td>
                      <td className="px-5 py-3">
                        {d.invoiceNumber ? (
                          <span className="num inline-flex items-center gap-1.5 text-slate-300">
                            <FileText className="h-3.5 w-3.5 text-slate-500" />
                            {d.invoiceNumber}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="num px-5 py-3 text-right font-medium text-white">
                        {usdExact(d.amountCents)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end">
                          <span
                            className={clsx(
                              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium',
                              meta.ring,
                              meta.text,
                            )}
                          >
                            <span className={clsx('h-1.5 w-1.5 rounded-full', meta.dot)} />
                            {meta.label}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end">
                          {d.status === 'DRAFT' ? (
                            <IssueDraw drawId={d.id} />
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
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

// ---- Presentational bits -----------------------------------------------------

function StateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-title text-white">
          <Receipt className="h-6 w-6 text-brand-400" />
          Billing
        </h1>
        <p className="text-sm text-slate-400">Draws across the portfolio.</p>
      </header>
      {children}
    </div>
  );
}

function EmptyCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-surface-800 bg-surface-950">
        {icon}
      </div>
      <div className="mt-3 text-sm font-medium text-white">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone: 'brand' | 'info' | 'neutral';
}) {
  const valueTone =
    tone === 'brand' ? 'text-brand-400' : tone === 'info' ? 'text-info-fg' : 'text-white';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-slate-500">
        {icon}
        {label}
      </div>
      <div className={clsx('num mt-2 text-heading font-semibold', valueTone)}>{value}</div>
      <div className="mt-1 text-2xs text-slate-500">{hint}</div>
    </div>
  );
}
