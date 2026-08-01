'use client';

import { useCallback, useState } from 'react';
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Banknote,
  CheckCircle2,
  BookOpen,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { useQuery, addToast } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunDetailResponse, type RunStatus } from './types';
import { RunStatusBadge } from './run-status';

type Action = 'approve' | 'release' | 'post';

export function RunDetailDrawer({
  runId,
  onClose,
  onChanged,
}: {
  runId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = useMe();
  const { data, isLoading, error, refetch } = useQuery<RunDetailResponse>(`/api/payroll/runs/${runId}`);
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [ackRelease, setAckRelease] = useState(false);

  const run = data?.run;
  const employees = data?.employees ?? [];

  const myClerkId = me.user?.clerkId ?? null;
  const preparedByMe = !!myClerkId && !!run?.preparedBy && run.preparedBy === myClerkId;
  const canApprove = me.can('payroll', 'approve');
  const grouped = me.user?.payrollVisibility !== 'ungrouped';

  const runAction = useCallback(
    async (action: Action) => {
      setPending(action);
      try {
        const res = await fetch(`/api/payroll/runs/${runId}/${action}`, { method: 'POST' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };
        if (!res.ok) {
          addToast('error', body.error ?? `Could not ${action} the run.`);
          return;
        }
        const label = action === 'approve' ? 'Run approved' : action === 'release' ? 'Funding released' : 'Posted to the ledger';
        addToast('success', label);
        setConfirmingRelease(false);
        setAckRelease(false);
        await refetch();
        onChanged();
      } catch {
        addToast('error', 'Network error.');
      } finally {
        setPending(null);
      }
    },
    [runId, refetch, onChanged],
  );

  const funding =
    run?.fundingCents ?? (run ? run.netCents + (run.employeeTaxCents ?? 0) + (run.employerTaxCents ?? 0) : 0);

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width="lg"
      title={run ? `Payroll · ${fmtDate(run.payDate)}` : 'Payroll run'}
      subtitle={run ? `${fmtDate(run.periodStart)} → ${fmtDate(run.periodEnd)}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={run ? <RunStatusBadge status={run.status} size="md" /> : undefined}
    >
      {run && (
        <>
          {/* Summary */}
          <DetailSection title="Run">
            <DetailField label="Pay date" value={fmtDate(run.payDate)} mono />
            <DetailField label="Pay period" value={`${fmtDate(run.periodStart)} → ${fmtDate(run.periodEnd)}`} />
            <DetailField label="Employees" value={String(run.employeeCount ?? employees.length)} mono />
            {run.provider && <DetailField label="Provider" value={run.provider} />}
            {run.memo && <DetailField label="Memo" value={run.memo} />}
          </DetailSection>

          {/* Totals */}
          <DetailSection title="Totals">
            <DetailField label="Gross wages" value={grouped ? '••••' : formatMoney(run.grossCents)} mono />
            <DetailField label="Employee withholding" value={grouped ? '••••' : formatMoney(run.employeeTaxCents ?? 0)} mono />
            <DetailField label="Employer tax & benefits" value={grouped ? '••••' : formatMoney(run.employerTaxCents ?? 0)} mono />
            <DetailField label="Net pay" value={grouped ? '••••' : formatMoney(run.netCents)} mono />
            <DetailField label="Bank funding total" value={grouped ? '••••' : formatMoney(funding)} mono />
          </DetailSection>

          {/* Per-employee breakdown */}
          {!grouped && employees.length > 0 && (
            <>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Employee breakdown ({employees.length})
              </h3>
              <DetailTable
                columns={[
                  { key: 'name', label: 'Employee' },
                  { key: 'gross', label: 'Gross', align: 'right' },
                  { key: 'tax', label: 'EE tax', align: 'right' },
                  { key: 'net', label: 'Net', align: 'right' },
                ]}
              >
                {employees.map((e) => (
                  <tr key={e.employeeId}>
                    <td className="px-3 py-2 text-sm text-slate-200">{e.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-slate-300">{formatMoney(e.grossCents)}</td>
                    <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-slate-400">{formatMoney(e.employeeTaxCents)}</td>
                    <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-emerald-400">{formatMoney(e.netCents)}</td>
                  </tr>
                ))}
              </DetailTable>
            </>
          )}

          {/* Audit trail */}
          <div className="mt-6">
            <DetailSection title="Approval audit (separation of duties)">
              <DetailField label="Prepared by" value={run.preparedBy ?? '—'} />
              <DetailField label="Approved by" value={run.approvedBy ?? 'Not yet approved'} />
              <DetailField label="Released by" value={run.releasedBy ?? 'Not yet released'} />
            </DetailSection>
          </div>

          {/* Posted GL entry */}
          {run.glEntryId && (
            <a
              href={`/journal-entries?entry=${run.glEntryId}`}
              className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-300 hover:bg-emerald-500/10"
            >
              <BookOpen size={15} /> Posted to the ledger — view journal entry
            </a>
          )}

          {/* Action rail */}
          <ActionRail
            status={run.status}
            preparedByMe={preparedByMe}
            canApprove={canApprove}
            pending={pending}
            confirmingRelease={confirmingRelease}
            ackRelease={ackRelease}
            funding={grouped ? null : funding}
            onApprove={() => runAction('approve')}
            onStartRelease={() => setConfirmingRelease(true)}
            onCancelRelease={() => {
              setConfirmingRelease(false);
              setAckRelease(false);
            }}
            onToggleAck={() => setAckRelease((v) => !v)}
            onConfirmRelease={() => runAction('release')}
            onPost={() => runAction('post')}
          />
        </>
      )}
    </DetailDrawer>
  );
}

function ActionRail({
  status,
  preparedByMe,
  canApprove,
  pending,
  confirmingRelease,
  ackRelease,
  funding,
  onApprove,
  onStartRelease,
  onCancelRelease,
  onToggleAck,
  onConfirmRelease,
  onPost,
}: {
  status: RunStatus;
  preparedByMe: boolean;
  canApprove: boolean;
  pending: Action | null;
  confirmingRelease: boolean;
  ackRelease: boolean;
  funding: number | null;
  onApprove: () => void;
  onStartRelease: () => void;
  onCancelRelease: () => void;
  onToggleAck: () => void;
  onConfirmRelease: () => void;
  onPost: () => void;
}) {
  const awaitingApproval = status === 'PREVIEWED' || status === 'PENDING_APPROVAL';
  const approved = status === 'APPROVED';
  const releasedProcessing = status === 'RELEASED' || status === 'PROCESSING';
  const terminalOk = status === 'PAID' || status === 'POSTED' || status === 'RECONCILED';
  const failed = status === 'FAILED' || status === 'RETURNED' || status === 'REJECTED';

  if (terminalOk) {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3 text-sm text-slate-300">
        <CheckCircle2 size={15} className="text-emerald-400" /> This run is complete. Posted runs are immutable — a
        correction is a new reversing run.
      </div>
    );
  }
  if (failed) {
    return (
      <div className="mt-5 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" /> This run {status === 'RETURNED' ? 'was returned by the bank (NSF)' : status === 'REJECTED' ? 'was rejected in approval' : 'failed'}. Resolve and start a new run.
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-slate-800 pt-4">
      {awaitingApproval && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
            <Info size={13} className="text-blue-400" />
            Approval is a separation-of-duties control: a different person than the preparer must approve the dollar
            amount before any money can move.
          </div>
          <div
            title={
              preparedByMe
                ? 'You prepared this run. Separation of duties requires a different person to approve it.'
                : !canApprove
                ? 'Your role cannot approve payroll runs.'
                : undefined
            }
            className="inline-block"
          >
            <button
              onClick={onApprove}
              disabled={preparedByMe || !canApprove || pending === 'approve'}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Approve run
            </button>
          </div>
          {preparedByMe && (
            <p className="mt-1.5 text-2xs text-amber-400">You prepared this run — it must be approved by someone else.</p>
          )}
        </div>
      )}

      {approved && !confirmingRelease && (
        <div>
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2 text-xs text-slate-300">
            <ShieldAlert size={14} className="mt-0.5 shrink-0 text-indigo-400" />
            <span>
              <span className="font-medium text-indigo-300">Release moves money.</span> It authorizes the provider to
              debit the bank{funding !== null ? ` for ${formatMoney(funding)}` : ''} and pay employees, tax agencies, and
              garnishment recipients. This step is irreversible.
            </span>
          </div>
          <button
            onClick={onStartRelease}
            disabled={!canApprove}
            title={!canApprove ? 'Your role cannot release payroll funding.' : undefined}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Banknote size={14} /> Release to provider…
          </button>
        </div>
      )}

      {approved && confirmingRelease && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/[0.08] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-indigo-200">
            <ShieldAlert size={16} /> Confirm release — money movement
          </div>
          <p className="mb-3 text-xs text-slate-300">
            The provider will debit the bank{funding !== null ? <span className="font-mono font-semibold text-white"> {formatMoney(funding)}</span> : ''} and pay
            employees, agencies, and garnishment recipients. This cannot be undone.
          </p>
          <label className="mb-3 flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={ackRelease} onChange={onToggleAck} className="mt-0.5" />
            I authorize this bank debit and release of payroll funding.
          </label>
          <div className="flex items-center justify-end gap-2">
            <button onClick={onCancelRelease} className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button
              onClick={onConfirmRelease}
              disabled={!ackRelease || pending === 'release'}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending === 'release' ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />}
              Release funding
            </button>
          </div>
        </div>
      )}

      {releasedProcessing && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
            <Info size={13} className="text-blue-400" />
            Funding released. The provider is processing the debit. Post the run to record the balanced, job-costed
            journal entry in the ledger.
          </div>
          <button
            onClick={onPost}
            disabled={pending === 'post'}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {pending === 'post' ? <Loader2 size={14} className="animate-spin" /> : <BookOpen size={14} />}
            Post to GL
          </button>
        </div>
      )}
    </div>
  );
}
