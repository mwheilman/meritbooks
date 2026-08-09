'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  Loader2,
  AlertCircle,
  Banknote,
  Play,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Download,
  Send,
  AlertTriangle,
  CreditCard,
  FileText,
  Hash,
  ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { PageHeader, EmptyState } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { VendorPaymentDetailsModal, type VendorPaymentProfileView } from './vendor-payment-details';

interface CheckRow {
  id: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'DRAFT' | 'RELEASED' | 'SETTLED' | 'REJECTED' | 'RETURNED';
  amountCents: number | null;
  preparedBy: string;
  approvedBy: string | null;
  createdAt: string;
  billId: string;
  billNumber: string | null;
  dueDate: string | null;
  billStatus: string | null;
  vendorName: string | null;
}

interface QueueResponse {
  data: CheckRow[];
}

interface RunResponse {
  prepared: number;
  skipped: number;
}

interface MethodTotals {
  count: number;
  totalCents: number;
}
interface BatchControls {
  itemCount: number;
  vendorCount: number;
  totalCents: number;
  byMethod: { ACH: MethodTotals; CHECK: MethodTotals };
  hasBlockingDuplicates: boolean;
}
interface DuplicateWarning {
  aApprovalId: string;
  bApprovalId: string;
  vendorId: string;
  vendorName: string;
  confidence: number;
  severity: 'warn' | 'critical';
  reason: string;
}
interface BatchItem {
  approvalId: string;
  billId: string;
  vendorId: string;
  vendorName: string;
  invoiceRef: string | null;
  amountCents: number;
  paymentDate: string;
  method: 'ACH' | 'CHECK';
}
interface VendorGroup {
  vendorId: string;
  vendorName: string;
  itemCount: number;
  subtotalCents: number;
  items: BatchItem[];
}
interface BatchResponse {
  groups: VendorGroup[];
  controls: BatchControls;
  duplicateWarnings: DuplicateWarning[];
  profiles: VendorPaymentProfileView[];
  checkNumbers: Record<string, string>;
  unresolved: string[];
}
interface ReleaseResponse {
  released: number;
  failed: number;
  blocked: number;
  skipped?: number;
  totalReleasedCents: number;
  error?: string;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  const parsed = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function ChecksClient() {
  const { userId } = useAuth();
  const [running, setRunning] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<QueueResponse>('/api/checks');
  const { data: batch, refetch: refetchBatch } = useQuery<BatchResponse>('/api/ap/disbursements/batch');
  const rows = data?.data ?? [];

  const refreshAll = useCallback(async () => {
    await Promise.all([refetch(), refetchBatch()]);
  }, [refetch, refetchBatch]);

  const runChecks = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/checks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueWithinDays: 7 }),
      });
      const result = (await res.json()) as RunResponse & { error?: string };
      if (!res.ok) {
        addToast('error', result.error ?? 'Check run failed');
        return;
      }
      const skippedNote = result.skipped > 0 ? ` (${result.skipped} already queued)` : '';
      addToast('success', `Queued ${result.prepared} check${result.prepared === 1 ? '' : 's'}${skippedNote}`);
      await refreshAll();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setRunning(false);
    }
  }, [refreshAll]);

  const approve = useCallback(
    async (row: CheckRow) => {
      setApprovingId(row.id);
      try {
        const res = await fetch(`/api/checks/${row.id}/approve`, { method: 'POST' });
        const result = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) {
          addToast('error', result.error ?? 'Approval failed');
          return;
        }
        addToast('success', `Approved payment to ${row.vendorName ?? 'vendor'}`);
        await refreshAll();
      } catch {
        addToast('error', 'Network error');
      } finally {
        setApprovingId(null);
      }
    },
    [refreshAll],
  );

  const pendingCount = rows.filter((r) => r.status === 'PENDING_APPROVAL').length;
  const approvedCount = rows.filter((r) => r.status === 'APPROVED').length;
  const totalCents = rows.reduce((sum, r) => sum + (r.amountCents ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Check Run"
        description="Tee up payments from due bills, approve (separation of duties), then export the bank file and release. Release posts to the GL — it never sends money; you upload the exported file to your bank to move funds."
        actions={
          <button
            onClick={runChecks}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run checks
          </button>
        }
      />

      {data && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Stat label="Pending approval" value={String(pendingCount)} tone="warn" />
          <Stat label="Approved" value={String(approvedCount)} tone="brand" />
          <Stat label="Total queued" value={formatMoney(totalCents)} />
        </div>
      )}

      {batch && batch.controls.itemCount > 0 && (
        <DisbursementBatchPanel batch={batch} onReleased={refreshAll} />
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-6 text-center">
          <AlertCircle className="mx-auto text-red-400 mb-2" size={20} />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Banknote}
            title="No checks queued"
            description="No checks queued — run a check batch to tee up payments from bills that are approved and due soon."
            action={{ label: running ? 'Running…' : 'Run checks', onClick: runChecks }}
          />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <Th>Vendor</Th>
                <Th>Bill #</Th>
                <Th align="right">Amount</Th>
                <Th>Due date</Th>
                <Th>Status</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {rows.map((row) => {
                const preparedByMe = !!userId && row.preparedBy === userId;
                const isPending = row.status === 'PENDING_APPROVAL';
                return (
                  <tr key={row.id} className="hover:bg-slate-800/20">
                    <td className="px-4 py-2.5 text-sm text-slate-200 max-w-[220px] truncate">
                      {row.vendorName ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono text-slate-400">{row.billNumber ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-200">
                      {formatMoney(row.amountCents ?? 0)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-slate-400">{formatDate(row.dueDate)}</td>
                    <td className="px-4 py-2.5">
                      {isPending ? (
                        <span className="inline-flex items-center gap-1 text-2xs font-medium text-amber-400">
                          <Clock size={11} /> Pending approval
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-2xs font-medium text-emerald-400">
                          <CheckCircle2 size={11} /> Approved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {isPending ? (
                        <span
                          title={
                            preparedByMe
                              ? 'You prepared this check. Separation of duties requires a different person to approve.'
                              : undefined
                          }
                          className="inline-block"
                        >
                          <button
                            onClick={() => approve(row)}
                            disabled={preparedByMe || approvingId === row.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {approvingId === row.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <ShieldCheck size={12} />
                            )}
                            Approve
                          </button>
                        </span>
                      ) : (
                        <span className="text-2xs text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={clsx(
        'px-4 py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'brand' | 'warn' }) {
  return (
    <div className="card p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p
        className={clsx(
          'text-lg font-mono font-semibold mt-1',
          tone === 'brand' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : 'text-white',
        )}
      >
        {value}
      </p>
    </div>
  );
}

// ── Pay-run workflow ─────────────────────────────────────────────────────────

const STEPS = ['Queue bills', 'Capture details', 'Review', 'Export / mark checks', 'Release'] as const;

function WorkflowStepper({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-1">
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium',
              i < current
                ? 'bg-emerald-600/15 text-emerald-300'
                : i === current
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-950 text-slate-500 border border-slate-800',
            )}
          >
            <span className="font-mono">{i + 1}</span> {label}
          </span>
          {i < STEPS.length - 1 && <ChevronRight size={12} className="text-slate-700" />}
        </div>
      ))}
    </div>
  );
}

/**
 * Disbursement batch — the APPROVED, ready-to-release payment run. Presents the
 * pay-run as an explicit workflow: capture per-vendor payment method + MASKED bank
 * details, review per-vendor totals (with the duplicate-pay guard), export the
 * bank file (bill-pay CSV / ACH template) OR mark hand-written check numbers, then
 * release. Releasing is the ONLY step that touches the GL (DR A/P / CR Cash via the
 * gated payment path); it never contacts a bank, and enforces releaser != preparer
 * + a duplicate-payment block server-side. A remittance-advice PDF is available per
 * vendor (which invoices the payment covers).
 */
function DisbursementBatchPanel({
  batch,
  onReleased,
}: {
  batch: BatchResponse;
  onReleased: () => Promise<void>;
}) {
  const [exporting, setExporting] = useState<'csv' | 'nacha' | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [override, setOverride] = useState(false);
  const [editVendor, setEditVendor] = useState<{ vendorId: string; vendorName: string } | null>(null);
  const [checkDrafts, setCheckDrafts] = useState<Record<string, string>>(() => ({ ...batch.checkNumbers }));
  const [savingChecks, setSavingChecks] = useState(false);
  const { controls, duplicateWarnings, groups } = batch;
  const criticalDupes = duplicateWarnings.filter((w) => w.severity === 'critical');

  const profileByVendor = useMemo(() => {
    const m = new Map<string, VendorPaymentProfileView>();
    for (const p of batch.profiles) m.set(p.vendorId, p);
    return m;
  }, [batch.profiles]);

  // Vendors that will be paid by ACH but have no bank detail on file yet — the
  // review gate surfaces these before an export/release.
  const missingAch = useMemo(
    () =>
      groups.filter((g) => {
        const p = profileByVendor.get(g.vendorId);
        const method = p?.paymentMethod ?? g.items[0]?.method ?? 'ACH';
        return method === 'ACH' && !(p?.hasBankDetails ?? false);
      }),
    [groups, profileByVendor],
  );

  const checkItems = useMemo(
    () =>
      groups.flatMap((g) =>
        g.items
          .filter((it) => (profileByVendor.get(g.vendorId)?.paymentMethod ?? it.method) === 'CHECK')
          .map((it) => ({ ...it })),
      ),
    [groups, profileByVendor],
  );

  const currentStep = releasing ? 4 : missingAch.length > 0 ? 1 : 3;

  const download = useCallback(async (format: 'csv' | 'nacha') => {
    setExporting(format);
    try {
      const res = await fetch(`/api/ap/disbursements/export?format=${format}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        addToast('error', j.error ?? 'Export failed');
        return;
      }
      const warnings = res.headers.get('X-Export-Warnings');
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `disbursements-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'ach'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      // Record the EXPORTED audit marker via POST — the GET download is
      // side-effect-free, so the write is a separate, explicit call (best-effort).
      void fetch('/api/ap/disbursements/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      }).catch(() => {});
      addToast('success', `Exported ${format === 'csv' ? 'bill-pay CSV' : 'ACH file'}`);
      if (warnings) addToast('error', warnings.slice(0, 180));
    } catch {
      addToast('error', 'Network error');
    } finally {
      setExporting(null);
    }
  }, []);

  const remittance = useCallback((vendorId: string) => {
    window.open(`/api/ap/disbursements/remittance?vendorId=${encodeURIComponent(vendorId)}`, '_blank', 'noopener');
  }, []);

  const saveCheckNumbers = useCallback(async () => {
    const entries = checkItems.map((it) => ({ approvalId: it.approvalId, checkNumber: checkDrafts[it.approvalId] ?? '' }));
    setSavingChecks(true);
    try {
      const res = await fetch('/api/ap/disbursements/check-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const result = (await res.json()) as { count?: number; error?: string };
      if (!res.ok) {
        addToast('error', result.error ?? 'Failed to save check numbers');
        return;
      }
      addToast('success', `Saved ${result.count ?? 0} check number(s)`);
      await onReleased();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setSavingChecks(false);
    }
  }, [checkItems, checkDrafts, onReleased]);

  const release = useCallback(async () => {
    if (
      !window.confirm(
        `Release ${controls.itemCount} payment(s) totaling ${formatMoney(controls.totalCents)}? This posts each payment to the general ledger (DR A/P / CR Cash). It does NOT send money to any bank — you still upload the exported file to your bank (or mail the checks) to move funds.`,
      )
    ) {
      return;
    }
    setReleasing(true);
    try {
      const res = await fetch('/api/ap/disbursements/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrideDuplicates: override }),
      });
      const result = (await res.json()) as ReleaseResponse & { code?: string };
      if (!res.ok) {
        addToast('error', result.error ?? 'Release failed');
        return;
      }
      const parts = [`Released ${result.released}`];
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      if (result.blocked > 0) parts.push(`${result.blocked} blocked (SoD)`);
      if (result.skipped && result.skipped > 0) parts.push(`${result.skipped} already released`);
      addToast(result.failed > 0 ? 'info' : 'success', parts.join(', '));
      await onReleased();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setReleasing(false);
    }
  }, [controls.itemCount, controls.totalCents, override, onReleased]);

  return (
    <div className="card p-4 space-y-4 border border-emerald-900/40">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Banknote size={15} className="text-emerald-400" /> Pay run — {controls.itemCount} payment(s) to{' '}
            {controls.vendorCount} vendor(s)
          </h2>
          <p className="text-2xs text-slate-500 mt-0.5 max-w-2xl">
            Confirm how each vendor is paid, review the run, then export the bank file (or mark check numbers) and
            release. Releasing posts to the GL — it never sends money. You upload the file to your bank or mail the
            checks to move funds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => download('csv')}
            disabled={exporting !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 transition-colors"
          >
            {exporting === 'csv' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Bill-pay CSV
          </button>
          <button
            onClick={() => download('nacha')}
            disabled={exporting !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 transition-colors"
          >
            {exporting === 'nacha' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} ACH (NACHA)
          </button>
          <button
            onClick={release}
            disabled={releasing || (controls.hasBlockingDuplicates && !override)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {releasing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Release batch
          </button>
        </div>
      </div>

      <WorkflowStepper current={currentStep} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total to release" value={formatMoney(controls.totalCents)} tone="brand" />
        <Stat label="Payments" value={String(controls.itemCount)} />
        <Stat label="ACH" value={`${controls.byMethod.ACH.count} · ${formatMoney(controls.byMethod.ACH.totalCents)}`} />
        <Stat label="Check" value={`${controls.byMethod.CHECK.count} · ${formatMoney(controls.byMethod.CHECK.totalCents)}`} />
      </div>

      {missingAch.length > 0 && (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
          <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
            <AlertTriangle size={13} /> {missingAch.length} vendor(s) set to ACH have no bank details on file
          </p>
          <p className="text-2xs text-amber-200/70 mt-1">
            Add masked bank details below, or switch the vendor to Check. The bill-pay CSV still works (your bank holds
            the payee record); the NACHA file will carry placeholders for these.
          </p>
        </div>
      )}

      {criticalDupes.length > 0 && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 space-y-2">
          <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
            <AlertTriangle size={13} /> {criticalDupes.length} possible duplicate payment(s) in this batch
          </p>
          <ul className="text-2xs text-red-200/80 space-y-1 list-disc pl-4">
            {criticalDupes.slice(0, 5).map((w) => (
              <li key={`${w.aApprovalId}-${w.bApprovalId}`}>{w.reason}</li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-2xs text-red-200 cursor-pointer select-none">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="accent-red-500" />
            I have reviewed these and want to release anyway (override the duplicate block).
          </label>
        </div>
      )}

      {/* Per-vendor review */}
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-800 bg-surface-950">
          <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendors in this run</p>
        </div>
        <div className="divide-y divide-slate-800/40">
          {groups.map((g) => {
            const p = profileByVendor.get(g.vendorId);
            const method = p?.paymentMethod ?? g.items[0]?.method ?? 'ACH';
            const ready = method === 'CHECK' ? true : !!p?.hasBankDetails;
            return (
              <div key={g.vendorId} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-100 truncate max-w-[220px]">{g.vendorName}</span>
                    <MethodBadge method={method} />
                  </div>
                  <p className="text-2xs text-slate-500 mt-0.5">
                    {g.itemCount} invoice(s)
                    {p?.accountMask ? ` · acct ${p.accountMask}` : ''}
                    {p?.bankName ? ` · ${p.bankName}` : ''}
                    {!ready ? ' · no bank details' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-mono text-slate-200">{formatMoney(g.subtotalCents)}</span>
                  <button
                    onClick={() => setEditVendor({ vendorId: g.vendorId, vendorName: g.vendorName })}
                    className={clsx(
                      'inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium transition-colors',
                      ready
                        ? 'bg-surface-950 border border-slate-800 text-slate-300 hover:bg-slate-800'
                        : 'bg-amber-600/15 border border-amber-700/50 text-amber-300 hover:bg-amber-600/25',
                    )}
                    title="Capture payment method + masked bank details"
                  >
                    <CreditCard size={11} /> {p ? 'Edit' : 'Add'} details
                  </button>
                  <button
                    onClick={() => remittance(g.vendorId)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-surface-950 border border-slate-800 text-slate-300 hover:bg-slate-800 transition-colors"
                    title="Remittance advice PDF (which invoices this payment covers)"
                  >
                    <FileText size={11} /> Remittance
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mark check numbers — the alternative to a bank file for hand-written checks */}
      {checkItems.length > 0 && (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 bg-surface-950 flex items-center justify-between">
            <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <Hash size={12} /> Mark check numbers ({checkItems.length})
            </p>
            <button
              onClick={saveCheckNumbers}
              disabled={savingChecks}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 transition-colors"
            >
              {savingChecks ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Save check #s
            </button>
          </div>
          <div className="divide-y divide-slate-800/40">
            {checkItems.map((it) => (
              <div key={it.approvalId} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-xs text-slate-200 truncate max-w-[200px] inline-block align-middle">{it.vendorName}</span>
                  <span className="text-2xs text-slate-500 ml-2">{it.invoiceRef ?? '—'}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-mono text-slate-300">{formatMoney(it.amountCents)}</span>
                  <input
                    value={checkDrafts[it.approvalId] ?? ''}
                    onChange={(e) => setCheckDrafts((d) => ({ ...d, [it.approvalId]: e.target.value }))}
                    placeholder="Check #"
                    inputMode="numeric"
                    className="w-24 px-2 py-1 rounded-md bg-surface-950 border border-slate-800 text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {editVendor && (
        <VendorPaymentDetailsModal
          vendorId={editVendor.vendorId}
          vendorName={editVendor.vendorName}
          existing={profileByVendor.get(editVendor.vendorId) ?? null}
          onClose={() => setEditVendor(null)}
          onSaved={() => void onReleased()}
        />
      )}
    </div>
  );
}

function MethodBadge({ method }: { method: 'ACH' | 'CHECK' }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-semibold uppercase tracking-wide',
        method === 'ACH' ? 'bg-blue-500/15 text-blue-300' : 'bg-slate-600/25 text-slate-300',
      )}
    >
      {method}
    </span>
  );
}
