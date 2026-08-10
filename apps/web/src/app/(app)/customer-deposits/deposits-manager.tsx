'use client';

import { useMemo, useState } from 'react';
import {
  PiggyBank, Plus, Search, X, ArrowDownRight, ArrowUpRight, Loader2,
  AlertCircle, CheckCircle2, Scale, Users,
} from 'lucide-react';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { api } from '@/lib/api-client';
import { useQuery } from '@/hooks/use-query';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { addToast } from '@/hooks/use-toast';
import { PageHeader, StatusBadge } from '@/components/ui';

// ─── Types (mirror the API payloads) ─────────────────────────────────────────
type DepositStatus = 'HELD' | 'PARTIALLY_APPLIED' | 'APPLIED' | 'REFUNDED';

interface DepositRow {
  id: string;
  location_id: string;
  customer_id: string;
  job_id: string | null;
  deposit_date: string;
  amount_cents: number;
  applied_cents: number;
  refunded_cents: number;
  status: DepositStatus;
  currency: string;
  memo: string | null;
  journal_entry_id: string | null;
  remainingCents: number;
  customerName: string;
  locationName: string | null;
  jobLabel: string | null;
}

interface CustomerRollup {
  customerId: string;
  customerName: string;
  outstandingCents: number;
  depositCount: number;
}

interface ListResponse {
  data: DepositRow[];
  customerRollup: CustomerRollup[];
  totalOutstandingCents: number;
}

interface TieOut {
  subledgerCents: number;
  glBalanceCents: number;
  differenceCents: number;
  inBalance: boolean;
}

interface CustomerOption { id: string; name: string }
interface JobOption { id: string; job_number?: string; name?: string }
interface OpenInvoice {
  id: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  totalCents: number; balanceCents: number; status: string; currency: string;
}
interface DepositDetail {
  deposit: DepositRow & { remainingCents: number };
  customer: { id: string; name: string; email: string | null } | null;
  applications: Array<{
    id: string; invoice_id: string; amount_cents: number;
    journal_entry_id: string | null; applied_by: string | null;
    applied_at: string; invoiceNumber: string | null;
  }>;
  openInvoices: OpenInvoice[];
}

const STATUS_VARIANT: Record<DepositStatus, 'info' | 'warning' | 'success' | 'neutral'> = {
  HELD: 'info',
  PARTIALLY_APPLIED: 'warning',
  APPLIED: 'success',
  REFUNDED: 'neutral',
};

const STATUS_TABS: Array<{ key: DepositStatus | 'ALL'; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'HELD', label: 'Held' },
  { key: 'PARTIALLY_APPLIED', label: 'Partially applied' },
  { key: 'APPLIED', label: 'Applied' },
  { key: 'REFUNDED', label: 'Refunded' },
];

// ─── Posting preview (emerald debit / red credit) ────────────────────────────
function PostingPreview({ legs }: { legs: Array<{ label: string; side: 'DR' | 'CR'; cents: number }> }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 p-3">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">Journal entry preview</p>
      <div className="space-y-1">
        {legs.map((l, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-300">
              <span className={l.side === 'DR' ? 'font-mono font-semibold text-emerald-400' : 'font-mono font-semibold text-red-400'}>
                {l.side}
              </span>
              {l.label}
            </span>
            <span className={`font-mono tabular-nums ${l.side === 'DR' ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatMoney(l.cents)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────
export function DepositsManager() {
  const { activeCompanyId, activeCompany } = useActiveCompany();
  const [status, setStatus] = useState<DepositStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const listParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (status !== 'ALL') p.status = status;
    return p;
  }, [status]);

  const { data, isLoading, error, refetch } = useQuery<ListResponse>(
    '/api/customer-deposits',
    listParams,
    { key: String(refetchKey) },
  );
  const { data: tie, refetch: refetchTie } = useQuery<{ data: TieOut }>(
    '/api/customer-deposits/tie-out',
    undefined,
    { key: String(refetchKey) },
  );

  const deposits = data?.data ?? [];
  const rollup = data?.customerRollup ?? [];
  const totalOutstanding = data?.totalOutstandingCents ?? 0;
  const tieOut = tie?.data;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return deposits;
    return deposits.filter(
      (d) => d.customerName.toLowerCase().includes(q) || (d.memo ?? '').toLowerCase().includes(q),
    );
  }, [deposits, search]);

  const openCount = deposits.filter((d) => d.status === 'HELD' || d.status === 'PARTIALLY_APPLIED').length;

  function afterMutation() {
    setRefetchKey((k) => k + 1);
    refetch();
    refetchTie();
  }

  return (
    <div>
      <PageHeader
        title="Customer Deposits & Retainers"
        description="Unapplied customer cash held as a liability (Customer Deposits, 2420), drawn down against invoices and refunded when unearned."
        actions={
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Take deposit
          </button>
        }
      />

      {/* Metrics strip */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-slate-400">Outstanding liability</span>
            <PiggyBank className="h-4 w-4 text-brand-400" />
          </div>
          <p className="font-mono text-xl font-semibold tabular-nums text-white">{formatMoney(totalOutstanding)}</p>
          <p className="mt-1 text-2xs text-slate-500">{openCount} open deposit{openCount === 1 ? '' : 's'}</p>
        </div>

        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-slate-400">Deposits (all statuses)</span>
            <Users className="h-4 w-4 text-slate-400" />
          </div>
          <p className="font-mono text-xl font-semibold tabular-nums text-white">{deposits.length}</p>
          <p className="mt-1 text-2xs text-slate-500">{rollup.length} customer{rollup.length === 1 ? '' : 's'} with a balance</p>
        </div>

        {/* Tie-out */}
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-slate-400">Subledger ⇄ GL 2420</span>
            <Scale className={`h-4 w-4 ${tieOut ? (tieOut.inBalance ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`} />
          </div>
          {tieOut ? (
            <>
              <p className={`flex items-center gap-1.5 font-mono text-xl font-semibold tabular-nums ${tieOut.inBalance ? 'text-emerald-400' : 'text-red-400'}`}>
                {tieOut.inBalance ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                {tieOut.inBalance ? 'In balance' : formatMoney(Math.abs(tieOut.differenceCents))}
              </p>
              <p className="mt-1 text-2xs text-slate-500 tabular-nums">
                Subledger {formatMoney(tieOut.subledgerCents)} · GL {formatMoney(tieOut.glBalanceCents)}
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-500">Not available</p>
          )}
        </div>
      </div>

      {/* Per-customer roll-up */}
      {rollup.length > 0 && (
        <div className="card mb-6 p-4">
          <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-slate-500">Outstanding deposit liability by customer</p>
          <div className="flex flex-wrap gap-2">
            {rollup.map((r) => (
              <div key={r.customerId} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-950 px-3 py-1.5">
                <span className="text-sm text-slate-200">{r.customerName}</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-brand-400">{formatMoney(r.outstandingCents)}</span>
                <span className="text-2xs text-slate-500">· {r.depositCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-950 p-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setStatus(t.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                status === t.key ? 'bg-brand-500/15 text-brand-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer or memo…"
            aria-label="Search deposits"
            className="w-full rounded-lg border border-slate-800 bg-surface-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
          />
        </div>
      </div>

      {/* Table / states */}
      {isLoading ? (
        <div className="card flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="card flex flex-col items-center gap-2 py-16 text-center">
          <AlertCircle className="h-7 w-7 text-red-400" />
          <p className="text-red-400">Failed to load deposits</p>
          <p className="text-sm text-slate-500">{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/10">
            <PiggyBank className="h-6 w-6 text-brand-400" />
          </div>
          <p className="text-white">No deposits{status !== 'ALL' ? ` in ${status.replace(/_/g, ' ').toLowerCase()}` : ''} yet</p>
          <p className="max-w-sm text-sm text-slate-500">
            Take a deposit when {activeCompany?.name ?? 'this company'} receives customer cash before (or without) an invoice — a retainer or progress deposit held as a liability.
          </p>
          <button
            onClick={() => setShowNew(true)}
            className="mt-1 flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Take deposit
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">Applied</th>
                  <th className="px-4 py-3 text-right font-medium">Refunded</th>
                  <th className="px-4 py-3 text-right font-medium">Remaining</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    className="cursor-pointer border-b border-slate-800/60 transition-colors last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-200">{d.customerName}</div>
                      {d.jobLabel && <div className="text-2xs text-slate-500">{d.jobLabel}</div>}
                      {d.memo && <div className="max-w-[240px] truncate text-2xs text-slate-500">{d.memo}</div>}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{d.deposit_date}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-white">{formatMoney(d.amount_cents)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-400">{d.applied_cents ? formatMoney(d.applied_cents) : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-400">{d.refunded_cents ? formatMoney(d.refunded_cents) : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-brand-400">{formatMoney(d.remainingCents)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} variant={STATUS_VARIANT[d.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showNew && (
        <NewDepositModal
          locationId={activeCompanyId}
          onClose={() => setShowNew(false)}
          onDone={() => {
            setShowNew(false);
            afterMutation();
          }}
        />
      )}

      {selectedId && (
        <DepositDrawer
          depositId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={afterMutation}
        />
      )}
    </div>
  );
}

// ─── New deposit modal ───────────────────────────────────────────────────────
function NewDepositModal({
  locationId, onClose, onDone,
}: { locationId: string; onClose: () => void; onDone: () => void }) {
  const [customerId, setCustomerId] = useState('');
  const [jobId, setJobId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [depositTo, setDepositTo] = useState<'bank' | 'undeposited'>('bank');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: custData } = useQuery<{ customers?: CustomerOption[]; data?: CustomerOption[] }>(
    '/api/customers?per_page=500',
    undefined,
    { scope: false },
  );
  const customers = custData?.customers ?? custData?.data ?? [];

  const { data: jobData } = useQuery<{ data?: JobOption[] }>('/api/jobs', { status: 'ACTIVE' });
  const jobs = jobData?.data ?? [];

  const amountCents = amount ? dollarsToCents(parseFloat(amount)) : 0;
  const valid = customerId && amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    if (!valid) {
      setFormError('Select a customer and enter a positive amount.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const res = await api.post<{ data: DepositRow }>('/api/customer-deposits', {
      location_id: locationId,
      customer_id: customerId,
      job_id: jobId || null,
      deposit_date: date,
      amount_cents: amountCents,
      memo: memo || null,
      undeposited: depositTo === 'undeposited',
      rail: depositTo === 'undeposited' ? undefined : 'ach',
    });
    setSubmitting(false);
    if (res.error) {
      setFormError(res.error.error);
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Deposit recorded and posted to the GL');
    onDone();
  }

  return (
    <Overlay onClose={onClose} title="Take customer deposit">
      <div className="space-y-4">
        <Field label="Customer" required>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="input"
            aria-label="Customer"
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Job (optional)">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} className="input" aria-label="Job">
            <option value="">No job</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{`${j.job_number ?? ''} ${j.name ?? ''}`.trim()}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" required>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
              <input
                type="number" min="0" step="0.01" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="input pl-7 font-mono tabular-nums"
                aria-label="Amount"
              />
            </div>
          </Field>
          <Field label="Deposit date" required>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" aria-label="Deposit date" />
          </Field>
        </div>

        <Field label="Received into">
          <div className="flex gap-2">
            {(['bank', 'undeposited'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setDepositTo(opt)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  depositTo === opt ? 'border-brand-500/50 bg-brand-500/10 text-brand-400' : 'border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt === 'bank' ? 'Operating bank' : 'Undeposited funds'}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Memo (optional)">
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. 25% progress deposit" className="input" aria-label="Memo" />
        </Field>

        {amountCents > 0 && (
          <PostingPreview
            legs={[
              { label: depositTo === 'undeposited' ? 'Undeposited Funds' : 'Operating Bank', side: 'DR', cents: amountCents },
              { label: 'Customer Deposits (2420)', side: 'CR', cents: amountCents },
            ]}
          />
        )}

        {formError && <p className="text-sm text-red-400">{formError}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
          <button
            onClick={submit}
            disabled={!valid || submitting}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Record & post
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ─── Deposit detail drawer (apply + refund) ─────────────────────────────────
function DepositDrawer({
  depositId, onClose, onChanged,
}: { depositId: string; onClose: () => void; onChanged: () => void }) {
  const [refetchKey, setRefetchKey] = useState(0);
  const { data, isLoading, error } = useQuery<{ data: DepositDetail }>(
    `/api/customer-deposits/${depositId}`,
    undefined,
    { key: String(refetchKey), scope: false },
  );
  const detail = data?.data;

  const [invoiceId, setInvoiceId] = useState('');
  const [applyAmount, setApplyAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const deposit = detail?.deposit;
  const remaining = deposit?.remainingCents ?? 0;
  const selectedInvoice = detail?.openInvoices.find((i) => i.id === invoiceId) ?? null;
  const maxApply = selectedInvoice ? Math.min(remaining, selectedInvoice.balanceCents) : remaining;
  const applyCents = applyAmount ? dollarsToCents(parseFloat(applyAmount)) : 0;
  const canApply = !!deposit && (deposit.status === 'HELD' || deposit.status === 'PARTIALLY_APPLIED') && remaining > 0;
  const applyValid = canApply && invoiceId && applyCents > 0 && applyCents <= maxApply;

  function refresh() {
    setRefetchKey((k) => k + 1);
    onChanged();
  }

  async function doApply() {
    if (!applyValid) return;
    setBusy(true);
    setDrawerError(null);
    const res = await api.post(`/api/customer-deposits/${depositId}/apply`, {
      invoice_id: invoiceId,
      amount_cents: applyCents,
    });
    setBusy(false);
    if (res.error) {
      setDrawerError(res.error.error);
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Deposit applied to invoice');
    setInvoiceId('');
    setApplyAmount('');
    refresh();
  }

  async function doRefund() {
    if (!deposit || remaining <= 0) return;
    if (!confirm(`Refund the unapplied remainder of ${formatMoney(remaining)} to the customer? This posts DR 2420 / CR Cash and cannot be undone here.`)) return;
    setBusy(true);
    setDrawerError(null);
    const res = await api.post(`/api/customer-deposits/${depositId}/refund`, {});
    setBusy(false);
    if (res.error) {
      setDrawerError(res.error.error);
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Remaining deposit refunded');
    refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-slate-800 bg-surface-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <PiggyBank className="h-4 w-4 text-brand-400" />
            Deposit detail
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : error || !detail || !deposit ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <AlertCircle className="h-7 w-7 text-red-400" />
            <p className="text-red-400">{error ?? 'Deposit not found'}</p>
          </div>
        ) : (
          <div className="flex-1 space-y-5 p-5">
            {/* Summary */}
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-lg font-semibold text-white">{detail.customer?.name ?? deposit.customerName}</p>
                  <p className="text-xs text-slate-500">{deposit.deposit_date}{deposit.jobLabel ? ` · ${deposit.jobLabel}` : ''}</p>
                </div>
                <StatusBadge status={deposit.status} variant={STATUS_VARIANT[deposit.status]} size="md" />
              </div>
              {deposit.memo && <p className="mt-2 text-sm text-slate-400">{deposit.memo}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Amount" cents={deposit.amount_cents} />
              <Stat label="Remaining (held)" cents={remaining} accent />
              <Stat label="Applied" cents={deposit.applied_cents} muted />
              <Stat label="Refunded" cents={deposit.refunded_cents} muted />
            </div>

            {/* Apply */}
            {canApply ? (
              <div className="card space-y-3 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium text-white">
                  <ArrowDownRight className="h-4 w-4 text-brand-400" />
                  Apply to an invoice
                </p>
                {detail.openInvoices.length === 0 ? (
                  <p className="text-sm text-slate-500">No open invoices for this customer to apply against.</p>
                ) : (
                  <>
                    <Field label="Invoice">
                      <select
                        value={invoiceId}
                        onChange={(e) => {
                          const id = e.target.value;
                          setInvoiceId(id);
                          const inv = detail.openInvoices.find((i) => i.id === id);
                          if (inv) setApplyAmount((Math.min(remaining, inv.balanceCents) / 100).toFixed(2));
                        }}
                        className="input"
                        aria-label="Invoice to apply to"
                      >
                        <option value="">Select an open invoice…</option>
                        {detail.openInvoices.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.invoiceNumber} · bal {formatMoney(i.balanceCents)} · due {i.dueDate}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={`Amount (max ${formatMoney(maxApply)})`}>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                        <input
                          type="number" min="0" step="0.01" value={applyAmount}
                          onChange={(e) => setApplyAmount(e.target.value)}
                          className="input pl-7 font-mono tabular-nums"
                          aria-label="Apply amount"
                        />
                      </div>
                      {applyCents > maxApply && (
                        <p className="mt-1 text-2xs text-red-400">Cannot exceed the lesser of remaining and the invoice balance.</p>
                      )}
                    </Field>
                    {applyCents > 0 && applyCents <= maxApply && (
                      <PostingPreview
                        legs={[
                          { label: 'Customer Deposits (2420)', side: 'DR', cents: applyCents },
                          { label: 'Accounts Receivable', side: 'CR', cents: applyCents },
                        ]}
                      />
                    )}
                    <button
                      onClick={doApply}
                      disabled={!applyValid || busy}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      Apply deposit
                    </button>
                  </>
                )}
              </div>
            ) : (
              deposit.status === 'APPLIED' && (
                <div className="card p-4 text-sm text-slate-400">This deposit is fully applied.</div>
              )
            )}

            {/* Refund */}
            {remaining > 0 && deposit.status !== 'REFUNDED' && (
              <div className="card space-y-3 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium text-white">
                  <ArrowUpRight className="h-4 w-4 text-red-400" />
                  Refund remaining
                </p>
                <p className="text-sm text-slate-400">Return the unapplied {formatMoney(remaining)} to the customer.</p>
                <PostingPreview
                  legs={[
                    { label: 'Customer Deposits (2420)', side: 'DR', cents: remaining },
                    { label: 'Cash', side: 'CR', cents: remaining },
                  ]}
                />
                <button
                  onClick={doRefund}
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Refund {formatMoney(remaining)}
                </button>
              </div>
            )}

            {drawerError && <p className="text-sm text-red-400">{drawerError}</p>}

            {/* Applications history */}
            <div>
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">Application history</p>
              {detail.applications.length === 0 ? (
                <p className="text-sm text-slate-500">No applications yet.</p>
              ) : (
                <div className="space-y-1">
                  {detail.applications.map((a) => (
                    <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs">
                      <span className="text-slate-300">{a.invoiceNumber ?? 'Invoice'}</span>
                      <span className="text-slate-500">{new Date(a.applied_at).toLocaleDateString()}</span>
                      <span className="font-mono tabular-nums text-brand-400">{formatMoney(a.amount_cents)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Small presentational helpers ────────────────────────────────────────────
function Stat({ label, cents, accent, muted }: { label: string; cents: number; accent?: boolean; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 font-mono text-base font-semibold tabular-nums ${accent ? 'text-brand-400' : muted ? 'text-slate-400' : 'text-white'}`}>
        {formatMoney(cents)}
      </p>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-400">
        {label}{required && <span className="text-red-400"> *</span>}
      </span>
      {children}
    </label>
  );
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-surface-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
