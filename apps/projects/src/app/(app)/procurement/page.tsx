import {
  ShoppingCart,
  FileText,
  PackageOpen,
  FileClock,
  TriangleAlert,
  LockKeyhole,
} from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import {
  NewCommitmentForm,
  ApproveButton,
  type JobOption,
  type VendorOption,
  type CostCodeOption,
} from './procurement-actions';

export const dynamic = 'force-dynamic';

// Procurement — create POs/subcontracts and approve them (approval mints the PO#).
// Reads proj.commitments (all statuses) joined to core.jobs + core.vendors for
// identity and to proj.v_commitment_status (APPROVED/PARTIAL only) for the
// invoiced/open roll-up. Pickers (jobs, vendors, cost codes) are passed to the
// client create form. Every read is RLS-scoped to the caller's org.

interface CommitmentRow {
  id: string;
  job_id: string;
  vendor_id: string | null;
  commitment_type: 'PURCHASE_ORDER' | 'SUBCONTRACT';
  number: string | null;
  status: 'DRAFT' | 'APPROVED' | 'PARTIAL' | 'CLOSED' | 'VOID';
  original_amount_cents: number;
  revised_amount_cents: number;
  created_at: string;
}

interface CommitmentStatusRow {
  commitment_id: string;
  amount_cents: number;
  invoiced_cents: number;
  open_cents: number;
}

interface JobRow {
  id: string;
  job_number: string | null;
  name: string | null;
  status: string | null;
}

interface VendorRow {
  id: string;
  name: string;
  display_name: string | null;
  is_active: boolean | null;
}

interface CostCodeRow {
  id: string;
  code: string;
  name: string;
  job_id: string | null;
  is_active: boolean | null;
}

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const pct = (n: number, d: number): number => (d > 0 ? Math.max(0, Math.min(1, n / d)) : 0);

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-surface-800 text-slate-300 ring-surface-800',
  APPROVED: 'bg-brand-500/10 text-brand-300 ring-brand-500/20',
  PARTIAL: 'bg-info/10 text-info-fg ring-info/20',
  CLOSED: 'bg-ai/10 text-ai-fg ring-ai/20',
  VOID: 'bg-danger/10 text-danger-fg ring-danger/20',
};

export default async function ProcurementPage() {
  const sb = await createAuthedServerSupabase();

  const header = (
    <header className="space-y-1">
      <h1 className="text-title text-white">Procurement</h1>
      <p className="text-sm text-slate-400">
        Draft purchase orders and subcontracts, then approve to commit the cost and mint the number.
        Figures are RLS-scoped to your org.
      </p>
    </header>
  );

  if (!sb) return <Shell header={header}>{<AuthNeeded />}</Shell>;

  const [commitmentsRes, statusRes, jobsRes, vendorsRes, costCodesRes] = await Promise.all([
    sb
      .schema('proj')
      .from('commitments')
      .select(
        'id, job_id, vendor_id, commitment_type, number, status, original_amount_cents, revised_amount_cents, created_at',
      ),
    sb.schema('proj').from('v_commitment_status').select('commitment_id, amount_cents, invoiced_cents, open_cents'),
    sb.schema('core').from('jobs').select('id, job_number, name, status'),
    sb.schema('core').from('vendors').select('id, name, display_name, is_active'),
    sb.schema('proj').from('cost_codes').select('id, code, name, job_id, is_active'),
  ]);

  const loadError =
    commitmentsRes.error?.message ??
    statusRes.error?.message ??
    jobsRes.error?.message ??
    vendorsRes.error?.message ??
    costCodesRes.error?.message ??
    null;

  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[];
  const statusRows = (statusRes.data ?? []) as CommitmentStatusRow[];
  const jobs = (jobsRes.data ?? []) as JobRow[];
  const vendors = (vendorsRes.data ?? []) as VendorRow[];
  const costCodes = (costCodesRes.data ?? []) as CostCodeRow[];

  // Roll v_commitment_status lines up to the commitment (invoiced / open).
  const statusMap = new Map<string, { amount: number; invoiced: number; open: number }>();
  for (const r of statusRows) {
    const cur = statusMap.get(r.commitment_id) ?? { amount: 0, invoiced: 0, open: 0 };
    cur.amount += r.amount_cents;
    cur.invoiced += r.invoiced_cents;
    cur.open += r.open_cents;
    statusMap.set(r.commitment_id, cur);
  }

  const jobMap = new Map<string, JobRow>(jobs.map((j) => [j.id, j]));
  const vendorMap = new Map<string, VendorRow>(vendors.map((v) => [v.id, v]));
  const jobLabel = (id: string): { number: string; name: string } => {
    const j = jobMap.get(id);
    return { number: j?.job_number ?? '—', name: j?.name ?? 'Unassigned job' };
  };

  // Sort: DRAFTs first (they need action), then most recent.
  const statusRank = (s: string): number => (s === 'DRAFT' ? 0 : s === 'PARTIAL' || s === 'APPROVED' ? 1 : 2);
  const rows = commitments
    .slice()
    .sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        b.created_at.localeCompare(a.created_at),
    );

  // KPIs across all commitments.
  const draftCount = commitments.filter((c) => c.status === 'DRAFT').length;
  const activeCount = commitments.filter((c) => c.status === 'APPROVED' || c.status === 'PARTIAL').length;
  const totalOpen = [...statusMap.values()].reduce((s, v) => s + v.open, 0);
  const totalCommitted = commitments
    .filter((c) => c.status !== 'DRAFT' && c.status !== 'VOID')
    .reduce((s, c) => s + c.revised_amount_cents, 0);

  // Picker props for the client form. Active vendors/cost codes only; jobs that
  // can still receive commitments (drop closed/cancelled) sorted by number.
  const jobOptions: JobOption[] = jobs
    .filter((j) => !['CLOSED', 'CANCELLED', 'COMPLETE'].includes(j.status ?? ''))
    .sort((a, b) => (a.job_number ?? '').localeCompare(b.job_number ?? '', undefined, { numeric: true }))
    .map((j) => ({ id: j.id, job_number: j.job_number, name: j.name, status: j.status }));
  const vendorOptions: VendorOption[] = vendors
    .filter((v) => v.is_active !== false)
    .map((v) => ({ id: v.id, name: v.display_name ?? v.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const costCodeOptions: CostCodeOption[] = costCodes
    .filter((c) => c.is_active !== false)
    .map((c) => ({ id: c.id, code: c.code, name: c.name, job_id: c.job_id }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return (
    <Shell header={header}>
      {/* KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<FileClock className="h-4 w-4" />} label="Draft commitments" value={String(draftCount)} tone="slate" />
        <Kpi icon={<FileText className="h-4 w-4" />} label="Active commitments" value={String(activeCount)} tone="brand" />
        <Kpi icon={<ShoppingCart className="h-4 w-4" />} label="Committed value" value={usd(totalCommitted)} tone="info" />
        <Kpi icon={<PackageOpen className="h-4 w-4" />} label="Open commitment" value={usd(totalOpen)} tone="warn" />
      </section>

      {/* Create form (client) */}
      <NewCommitmentForm jobs={jobOptions} vendors={vendorOptions} costCodes={costCodeOptions} />

      {/* Commitments list */}
      <section className="rounded-xl border border-surface-800 bg-surface-900">
        <SectionHead
          icon={<FileText className="h-4 w-4 text-brand-400" />}
          title="Commitments"
          sub="Every purchase order and subcontract in your book. Draft rows can be approved to mint their number."
          count={rows.length}
          unit="commitments"
        />
        {loadError ? (
          <ErrorState message={loadError} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No commitments yet"
            sub="Draft your first purchase order or subcontract with the form above."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-surface-800 text-2xs uppercase tracking-wider text-slate-500">
                  <th className="py-2 pl-5 pr-3 text-left font-medium">Commitment</th>
                  <th className="px-3 py-2 text-left font-medium">Job</th>
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Invoiced</th>
                  <th className="px-3 py-2 text-right font-medium">Open</th>
                  <th className="py-2 pl-3 pr-5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const jl = jobLabel(c.job_id);
                  const vendor = c.vendor_id ? vendorMap.get(c.vendor_id) : null;
                  const roll = statusMap.get(c.id);
                  // DRAFTs aren't in v_commitment_status; show the header amount.
                  const amount = roll?.amount ?? c.revised_amount_cents;
                  const invoiced = roll?.invoiced ?? 0;
                  const open = roll?.open ?? (c.status === 'DRAFT' ? 0 : amount);
                  const p = pct(invoiced, amount);
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-surface-800/60 last:border-0 hover:bg-surface-950/40"
                    >
                      <td className="py-3 pl-5 pr-3 align-middle">
                        <div className="flex items-center gap-2">
                          <TypeChip type={c.commitment_type} />
                          <div className="min-w-0">
                            <div className="num truncate text-white">
                              {c.number ?? <span className="text-slate-500">Not yet numbered</span>}
                            </div>
                            <StatusChip status={c.status} />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="num text-slate-300">{jl.number}</div>
                        <div className="max-w-[12rem] truncate text-2xs text-slate-500">{jl.name}</div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="max-w-[12rem] truncate text-slate-300">
                          {vendor ? vendor.display_name ?? vendor.name : <span className="text-slate-600">—</span>}
                        </div>
                      </td>
                      <td className="num px-3 py-3 text-right align-middle text-white">{usd(amount)}</td>
                      <td className="num px-3 py-3 text-right align-middle text-slate-300">{usd(invoiced)}</td>
                      <td className="num px-3 py-3 text-right align-middle text-warning-fg">
                        {c.status === 'DRAFT' ? <span className="text-slate-600">—</span> : usd(open)}
                      </td>
                      <td className="py-3 pl-3 pr-5 align-middle">
                        <div className="flex justify-end">
                          {c.status === 'DRAFT' ? (
                            <ApproveButton commitmentId={c.id} />
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-950">
                                <div
                                  className="h-full rounded-full bg-brand-500"
                                  style={{ width: `${p * 100}%` }}
                                />
                              </div>
                              <span className="num text-2xs text-slate-500">{Math.round(p * 100)}%</span>
                            </div>
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
    </Shell>
  );
}

function Shell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-8">
      {header}
      {children}
    </div>
  );
}

function TypeChip({ type }: { type: 'PURCHASE_ORDER' | 'SUBCONTRACT' | null }) {
  const isSub = type === 'SUBCONTRACT';
  const label = type === 'PURCHASE_ORDER' ? 'PO' : type === 'SUBCONTRACT' ? 'SUB' : '—';
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider',
        isSub ? 'border-ai/30 bg-ai/10 text-ai-fg' : 'border-info/30 bg-info/10 text-info-fg',
      )}
    >
      {label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider ring-1 ring-inset',
        STATUS_TONE[status] ?? 'bg-surface-800 text-slate-400 ring-surface-800',
      )}
    >
      {status.toLowerCase()}
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
          <div className="text-sm font-medium text-danger-fg">Couldn&apos;t load procurement data</div>
          <p className="num mt-1 text-2xs text-slate-500">{message}</p>
        </div>
      </div>
    </div>
  );
}

function AuthNeeded() {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 px-5 py-12 text-center">
      <LockKeyhole className="mx-auto h-5 w-5 text-slate-500" />
      <div className="mt-3 text-sm font-medium text-slate-300">Sign in to view procurement</div>
      <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
        This page reads and writes live, org-scoped commitments and needs an authenticated session.
      </p>
    </div>
  );
}
