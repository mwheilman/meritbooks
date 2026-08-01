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
  const rows = data?.data ?? [];

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
      await refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setRunning(false);
    }
  }, [refetch]);

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
        await refetch();
      } catch {
        addToast('error', 'Network error');
      } finally {
        setApprovingId(null);
      }
    },
    [refetch],
  );

  const pendingCount = rows.filter((r) => r.status === 'PENDING_APPROVAL').length;
  const approvedCount = rows.filter((r) => r.status === 'APPROVED').length;
  const totalCents = rows.reduce((sum, r) => sum + (r.amountCents ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Check Run"
        description="Tee up payments from due bills into an approval queue. Approving is a separation-of-duties step — it authorizes but does not release or pay."
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
