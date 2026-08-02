'use client';

import { useCallback, useState, type ReactNode } from 'react';
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
} from 'lucide-react';
import { clsx } from 'clsx';
import { PageHeader, EmptyState } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

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
interface BatchResponse {
  controls: BatchControls;
  duplicateWarnings: DuplicateWarning[];
  unresolved: string[];
}
interface ReleaseResponse {
  released: number;
  failed: number;
  blocked: number;
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

/**
 * Disbursement batch — the APPROVED, ready-to-release payment run. Exports the
 * bank file (bill-pay CSV or ACH template) and, on an explicit human release,
 * posts each payment (DR A/P / CR Cash) through the gated payment path. Nothing
 * here contacts a bank; releasing is the only step that touches the GL, and it
 * enforces releaser != preparer + a duplicate-payment block server-side.
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
  const { controls, duplicateWarnings } = batch;
  const criticalDupes = duplicateWarnings.filter((w) => w.severity === 'critical');

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
      addToast('success', `Exported ${format === 'csv' ? 'bill-pay CSV' : 'ACH file'}`);
      if (warnings) addToast('error', warnings.slice(0, 180));
    } catch {
      addToast('error', 'Network error');
    } finally {
      setExporting(null);
    }
  }, []);

  const release = useCallback(async () => {
    if (
      !window.confirm(
        `Release ${controls.itemCount} payment(s) totaling ${formatMoney(controls.totalCents)}? This posts each payment to the general ledger (DR A/P / CR Cash). It does NOT send money to any bank — you still upload the exported file to your bank to move funds.`,
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
            <Banknote size={15} className="text-emerald-400" /> Disbursement batch — ready to release
          </h2>
          <p className="text-2xs text-slate-500 mt-0.5">
            {controls.itemCount} approved payment(s) to {controls.vendorCount} vendor(s). Export the bank file, then
            release to post to the GL. Releasing never sends money — you upload the file to your bank.
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total to release" value={formatMoney(controls.totalCents)} tone="brand" />
        <Stat label="Payments" value={String(controls.itemCount)} />
        <Stat label="ACH" value={`${controls.byMethod.ACH.count} · ${formatMoney(controls.byMethod.ACH.totalCents)}`} />
        <Stat label="Check" value={`${controls.byMethod.CHECK.count} · ${formatMoney(controls.byMethod.CHECK.totalCents)}`} />
      </div>

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
    </div>
  );
}
