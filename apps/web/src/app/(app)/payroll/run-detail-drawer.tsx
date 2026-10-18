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
  FlaskConical,
} from 'lucide-react';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { useQuery, addToast } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunDetailResponse, type RunStatus } from './types';
import { RunStatusBadge } from './run-status';

type Action = 'approve' | 'release' | 'post' | 'remit';

export function RunDetailDrawer({
  runId,
  providerReady = false,
  onClose,
  onChanged,
}: {
  runId: string;
  /** True only when a licensed payroll provider is connected for this tenant. */
  providerReady?: boolean;
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

  // An "estimated" run is one computed without a real provider — either none is
  // connected now, or this run was computed/released on the deterministic mock
  // engine (provider === 'mock'). Its taxes are placeholder estimates and its
  // release does not instruct any external party to move money.
  const estimated = !providerReady || run?.provider === 'mock';

  const myClerkId = me.user?.clerkId ?? null;
  const preparedByMe = !!myClerkId && !!run?.preparedBy && run.preparedBy === myClerkId;
  const canApprove = me.can('payroll', 'approve');
  const grouped = me.user?.payrollVisibility !== 'ungrouped';

  const runAction = useCallback(
    async (action: Action) => {
      setPending(action);
      try {
        const res = await fetch(`/api/payroll/runs/${runId}/${action}`, { method: 'POST' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string; alreadyRemitted?: boolean };
        if (!res.ok) {
          addToast('error', body.error ?? `Could not ${action} the run.`);
          return;
        }
        if (action === 'remit' && body.alreadyRemitted) {
          addToast('info', 'This run’s payables were already remitted.');
        } else {
          const label =
            action === 'approve' ? 'Run approved'
            : action === 'release' ? 'Funding released'
            : action === 'remit' ? 'Payroll payables remitted'
            : 'Posted to the ledger';
          addToast('success', label);
        }
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
          {estimated && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2">
              <FlaskConical size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <p className="text-2xs text-amber-100/90">
                Estimated run — no payroll provider was used. Withholding and net pay are flat-rate estimates, not a tax
                calculation. Nothing here is withheld, filed, or paid to any agency.
              </p>
            </div>
          )}
          <DetailSection title={estimated ? 'Totals (estimated)' : 'Totals'}>
            <DetailField label="Gross wages" value={grouped ? '••••' : formatMoney(run.grossCents)} mono />
            <DetailField label={estimated ? 'Employee withholding (est.)' : 'Employee withholding'} value={grouped ? '••••' : formatMoney(run.employeeTaxCents ?? 0)} mono />
            <DetailField label={estimated ? 'Employer tax & benefits (est.)' : 'Employer tax & benefits'} value={grouped ? '••••' : formatMoney(run.employerTaxCents ?? 0)} mono />
            <DetailField label={estimated ? 'Net pay (est.)' : 'Net pay'} value={grouped ? '••••' : formatMoney(run.netCents)} mono />
            <DetailField label={estimated ? 'Bank funding total (est.)' : 'Bank funding total'} value={grouped ? '••••' : formatMoney(funding)} mono />
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

          {/* Remittance — clear the run's tax/benefit payables against cash. Available
              once the run is posted (its payables exist on the ledger). */}
          {run.glEntryId && (
            <RemitAffordance
              payablesCents={
                (run.employeeTaxCents ?? 0) + (run.employerTaxCents ?? 0) + (run.benefitsCents ?? 0) + (run.deductionsCents ?? 0)
              }
              grouped={grouped}
              canApprove={canApprove}
              pending={pending === 'remit'}
              onRemit={() => runAction('remit')}
            />
          )}

          {/* Action rail */}
          <ActionRail
            status={run.status}
            estimated={estimated}
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
  estimated,
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
  estimated: boolean;
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
          {estimated ? (
            <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100/90">
              <FlaskConical size={14} className="mt-0.5 shrink-0 text-amber-400" />
              <span>
                <span className="font-medium text-amber-200">Estimate run — no money moves.</span> No payroll provider is
                connected, so release only advances this workflow for preview. Nothing is debited from the bank and no
                employee, agency, or garnishment recipient is paid.
              </span>
            </div>
          ) : (
            <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2 text-xs text-slate-300">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-indigo-400" />
              <span>
                <span className="font-medium text-indigo-300">Release moves money.</span> It authorizes the provider to
                debit the bank{funding !== null ? ` for ${formatMoney(funding)}` : ''} and pay employees, tax agencies, and
                garnishment recipients. This step is irreversible.
              </span>
            </div>
          )}
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
            <ShieldAlert size={16} /> {estimated ? 'Confirm release — estimate (no money movement)' : 'Confirm release — money movement'}
          </div>
          {estimated ? (
            <p className="mb-3 text-xs text-slate-300">
              This is an estimate run with no provider connected. Release only advances the workflow for preview —{' '}
              <span className="font-medium text-amber-200">no bank debit occurs</span> and no one is paid.
            </p>
          ) : (
            <p className="mb-3 text-xs text-slate-300">
              The provider will debit the bank{funding !== null ? <span className="font-mono font-semibold text-white"> {formatMoney(funding)}</span> : ''} and pay
              employees, agencies, and garnishment recipients. This cannot be undone.
            </p>
          )}
          <label className="mb-3 flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={ackRelease} onChange={onToggleAck} className="mt-0.5" />
            {estimated
              ? 'I understand this is an estimate preview and no money will move.'
              : 'I authorize this bank debit and release of payroll funding.'}
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

/**
 * Remittance affordance — clears the run's tax & benefit payables (FEDERAL / FICA /
 * HEALTH / GARNISHMENT) against cash with a balanced, idempotent journal entry. Shown
 * once the run is posted. Gated on payroll:approve (same authority that posts the run).
 */
function RemitAffordance({
  payablesCents,
  grouped,
  canApprove,
  pending,
  onRemit,
}: {
  payablesCents: number;
  grouped: boolean;
  canApprove: boolean;
  pending: boolean;
  onRemit: () => void;
}) {
  if (payablesCents <= 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3">
      <div className="mb-2 flex items-start gap-1.5 text-xs text-slate-400">
        <Banknote size={13} className="mt-0.5 shrink-0 text-indigo-400" />
        <span>
          Record a remittance of this run’s tax &amp; benefit payables{grouped ? '' : ` (${formatMoney(payablesCents)})`}. This
          debits the payroll liabilities and credits the operating bank — clearing them to zero. Idempotent: a run can be
          remitted once.
        </span>
      </div>
      <button
        onClick={onRemit}
        disabled={pending || !canApprove}
        title={!canApprove ? 'Your role cannot remit payroll payables.' : undefined}
        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />}
        Record remittance
      </button>
    </div>
  );
}
