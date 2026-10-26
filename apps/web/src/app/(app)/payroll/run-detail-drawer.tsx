'use client';

import { useCallback, useState } from 'react';
import { Button, ButtonLink, Check, Icon, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { useQuery, addToast } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunDetail, type RunDetailResponse, type RunStatus } from './types';
import { RUN_STEPS, RunPipeline, RunStatusBadge, runStage, type PipeStep } from './run-status';
import s from './payroll.module.css';

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
  const masked = (cents: number) => (grouped ? '••••' : formatMoney(cents));
  const est = estimated ? ' (est.)' : '';

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width="lg"
      title={run ? `Payroll · pays ${fmtDate(run.payDate)}` : 'Payroll run'}
      subtitle={run ? `${fmtDate(run.periodStart)} → ${fmtDate(run.periodEnd)}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={run ? <RunStatusBadge status={run.status} size="md" /> : undefined}
    >
      {!isLoading && !error && !run && (
        <div className="wg-state">
          <span className="wg-empty-mark" aria-hidden="true"><Icon name="none" /></span>
          <span className="t-head">This run isn&apos;t available.</span>
          <p>It may have been removed, or it belongs to another company. Close this and pick a run from the list.</p>
        </div>
      )}
      {run && (
        <>
          {/* Five steps, one owner each (S20 run pipeline). */}
          <RunPipeline
            className={s.drawerPipe}
            label="Payroll run steps"
            steps={pipelineSteps(run, preparedByMe, estimated)}
          />

          {/* Summary */}
          <DetailSection title="Run">
            <DetailField label="Pay date" value={fmtDate(run.payDate)} mono />
            <DetailField label="Pay period" value={`${fmtDate(run.periodStart)} → ${fmtDate(run.periodEnd)}`} />
            <DetailField label="Employees" value={String(run.employeeCount ?? employees.length)} mono />
            {run.provider && <DetailField label="Provider" value={run.provider === 'mock' ? 'Estimate (no provider)' : run.provider} />}
            {run.memo && <DetailField label="Memo" value={run.memo} />}
          </DetailSection>

          {/* Totals */}
          {estimated && (
            <div style={{ marginTop: 16 }}>
              <InlineNotice tone="warn" title="Estimated run — no payroll provider was used.">
                Withholding and net pay are flat-rate estimates, not a tax calculation. Nothing here is withheld, filed or
                paid to any agency.
              </InlineNotice>
            </div>
          )}
          <DetailSection title={estimated ? 'Totals (estimated)' : 'Totals'}>
            <DetailField label="Gross wages" value={masked(run.grossCents)} mono />
            <DetailField label={`Employee withholding${est}`} value={masked(run.employeeTaxCents ?? 0)} mono />
            <DetailField label={`Employer tax & benefits${est}`} value={masked(run.employerTaxCents ?? 0)} mono />
            <DetailField label={`Net pay${est}`} value={masked(run.netCents)} mono />
            <DetailField label={`Bank funding total${est}`} value={<b>{masked(funding)}</b>} mono />
          </DetailSection>

          {/* Liabilities the run creates (what Record remittance later clears). */}
          <DetailSection title="Payroll liabilities">
            <DetailField label={`Employee tax withheld${est}`} value={masked(run.employeeTaxCents ?? 0)} mono />
            <DetailField label={`Employer payroll tax${est}`} value={masked(run.employerTaxCents ?? 0)} mono />
            <DetailField label="Benefit deductions" value={masked(run.benefitsCents ?? 0)} mono />
            <DetailField label="Other deductions & garnishments" value={masked(run.deductionsCents ?? 0)} mono />
            <DetailField label="Total to remit" value={<b>{masked(payablesOf(run))}</b>} mono />
          </DetailSection>

          {/* Per-employee breakdown */}
          {!grouped && employees.length > 0 && (
            <section className="panel-sec">
              <div className="panel-sec-h">
                <h3>By employee</h3>
                <span className="t-cap tnum">{employees.length}</span>
              </div>
              <DetailTable
                columns={[
                  { key: 'name', label: 'Employee' },
                  { key: 'gross', label: 'Gross', align: 'right' },
                  { key: 'tax', label: 'Emp. tax', align: 'right' },
                  { key: 'ded', label: 'Deductions', align: 'right' },
                  { key: 'net', label: 'Net', align: 'right' },
                ]}
              >
                {employees.map((e) => (
                  <tr key={e.employeeId} className="q-row">
                    <td><span className="l1">{e.name}</span></td>
                    <td className="n">{formatMoney(e.grossCents)}</td>
                    <td className="n">{formatMoney(e.employeeTaxCents)}</td>
                    <td className="n">{formatMoney(e.deductionsCents + e.benefitsCents)}</td>
                    <td className="n">{formatMoney(e.netCents)}</td>
                  </tr>
                ))}
                <tr className="q-row">
                  <td><span className="b">Total</span></td>
                  <td className="n b">{formatMoney(employees.reduce((t, e) => t + e.grossCents, 0))}</td>
                  <td className="n b">{formatMoney(employees.reduce((t, e) => t + e.employeeTaxCents, 0))}</td>
                  <td className="n b">{formatMoney(employees.reduce((t, e) => t + e.deductionsCents + e.benefitsCents, 0))}</td>
                  <td className="n b">{formatMoney(employees.reduce((t, e) => t + e.netCents, 0))}</td>
                </tr>
              </DetailTable>
            </section>
          )}
          {grouped && (
            <p className="t-cap" style={{ marginTop: 16 }}>
              Individual pay amounts are hidden for your role (grouped payroll visibility).
            </p>
          )}

          {/* Ledger impact: the posted entry, or a by-role preview of it. */}
          {run.glEntryId ? (
            <div className={s.glLink}>
              <span>
                <span className="t-head">Posted to the ledger</span>
                <span className="t-cap" style={{ display: 'block' }}>The balanced payroll entry is on the books.</span>
              </span>
              <ButtonLink href={`/journal-entries?entry=${run.glEntryId}`} variant="quiet" iconAfter="right">
                View journal entry
              </ButtonLink>
            </div>
          ) : (
            !grouped && run.grossCents > 0 && <LedgerPreview run={run} estimated={estimated} />
          )}

          {/* Remittance — clear the run's tax/benefit payables against cash. Available
              once the run is posted (its payables exist on the ledger). */}
          {run.glEntryId && (
            <RemitAffordance
              payablesCents={payablesOf(run)}
              grouped={grouped}
              canApprove={canApprove}
              pending={pending === 'remit'}
              onRemit={() => runAction('remit')}
            />
          )}

          {/* Approval audit */}
          <DetailSection title="Approval audit (separation of duties)">
            <DetailField label="Prepared by" value={run.preparedBy ?? '—'} />
            <DetailField label="Approved by" value={run.approvedBy ?? 'Not yet approved'} />
            <DetailField label="Released by" value={run.releasedBy ?? 'Not yet released'} />
          </DetailSection>

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

/** Tax & benefit payables the run books (the same sum Record remittance clears). */
function payablesOf(run: RunDetail): number {
  return (run.employeeTaxCents ?? 0) + (run.employerTaxCents ?? 0) + (run.benefitsCents ?? 0) + (run.deductionsCents ?? 0);
}

function pipelineSteps(run: RunDetail, preparedByMe: boolean, estimated: boolean): PipeStep[] {
  const stage = runStage(run.status, !!run.glEntryId);
  const who = [
    run.preparedBy ? (preparedByMe ? 'You' : run.preparedBy) : 'Preparer',
    run.approvedBy ?? 'A different person',
    run.releasedBy ?? 'An approver',
    estimated ? 'No money moves' : run.provider ?? 'Provider',
    run.glEntryId ? 'Posted' : 'Ledger',
  ];
  return RUN_STEPS.map((label, i) => ({
    label,
    who: who[i] ?? '',
    state: stage.done
      ? 'done'
      : stage.current === null
      ? 'todo'
      : i < stage.current
      ? 'done'
      : i === stage.current
      ? stage.failed
        ? 'attn'
        : 'cur'
      : 'todo',
  }));
}

/**
 * The entry Post will book, by account role — the same shape the posting engine
 * builds from the run totals (DR wages + DR employer tax = CR net pay + CR each
 * withholding / deduction + CR employer-tax payable). The company's mapped account
 * for each role is used when it posts.
 */
function LedgerPreview({ run, estimated }: { run: RunDetail; estimated: boolean }) {
  const ee = run.employeeTaxCents ?? 0;
  const er = run.employerTaxCents ?? 0;
  const ben = run.benefitsCents ?? 0;
  const ded = run.deductionsCents ?? 0;
  const net = run.grossCents - ee - ben - ded;
  const rows: Array<{ label: string; dr: number; cr: number }> = [
    { label: 'Wages expense', dr: run.grossCents, cr: 0 },
    { label: 'Payroll tax expense', dr: er, cr: 0 },
    { label: 'Net pay · payments in transit', dr: 0, cr: net },
    { label: 'Employee tax withholding payable', dr: 0, cr: ee },
    { label: 'Benefits payable', dr: 0, cr: ben },
    { label: 'Deductions & garnishments payable', dr: 0, cr: ded },
    { label: 'Employer payroll tax payable', dr: 0, cr: er },
  ].filter((r) => r.dr > 0 || r.cr > 0);
  const dr = rows.reduce((t, r) => t + r.dr, 0);
  const cr = rows.reduce((t, r) => t + r.cr, 0);
  return (
    <section className="panel-sec">
      <div className="panel-sec-h">
        <h3>Ledger entry preview{estimated ? ' (estimated)' : ''}</h3>
        <Tag>Not posted</Tag>
      </div>
      <DetailTable
        columns={[
          { key: 'role', label: 'Account role' },
          { key: 'dr', label: 'Debit', align: 'right' },
          { key: 'cr', label: 'Credit', align: 'right' },
        ]}
      >
        {rows.map((r) => (
          <tr key={r.label} className="q-row">
            <td><span className="l1">{r.label}</span></td>
            <td className="n">{r.dr > 0 ? formatMoney(r.dr) : <span className="ink-3">—</span>}</td>
            <td className="n">{r.cr > 0 ? formatMoney(r.cr) : <span className="ink-3">—</span>}</td>
          </tr>
        ))}
        <tr className="q-row">
          <td><span className="b">Totals</span></td>
          <td className="n b">{formatMoney(dr)}</td>
          <td className="n b">{formatMoney(cr)}</td>
        </tr>
      </DetailTable>
      <p className="t-cap" style={{ marginTop: 8 }}>
        Posts after release, to this company&apos;s mapped account for each role.
      </p>
    </section>
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
      <div className={s.actions}>
        <InlineNotice icon={<Icon name="check" />} title="This run is complete.">
          Posted runs can&apos;t be changed. A correction is a new reversing run.
        </InlineNotice>
      </div>
    );
  }
  if (failed) {
    return (
      <div className={s.actions}>
        <InlineNotice tone="neg" title={`This run ${status === 'RETURNED' ? 'was returned by the bank (NSF)' : status === 'REJECTED' ? 'was rejected in approval' : 'failed'}.`}>
          Resolve the cause and start a new run.
        </InlineNotice>
      </div>
    );
  }

  return (
    <div className={s.actions}>
      {awaitingApproval && (
        <>
          <p className="ink-2">
            Approval is a separation-of-duties control: someone other than the preparer must approve the amount before
            any money can move.
          </p>
          <div
            title={
              preparedByMe
                ? 'You prepared this run. Separation of duties requires a different person to approve it.'
                : !canApprove
                ? 'Your role cannot approve payroll runs.'
                : undefined
            }
            style={{ display: 'inline-block' }}
          >
            <Button
              variant="primary"
              icon="check"
              onClick={onApprove}
              disabled={preparedByMe || !canApprove || pending === 'approve'}
              aria-busy={pending === 'approve' || undefined}
            >
              {pending === 'approve' ? 'Approving…' : 'Approve run'}
            </Button>
          </div>
          {preparedByMe && <p className="t-cap warn">You prepared this run, so someone else must approve it.</p>}
          {!preparedByMe && !canApprove && <p className="t-cap">Your role can&apos;t approve payroll runs.</p>}
        </>
      )}

      {approved && !confirmingRelease && (
        <>
          {estimated ? (
            <InlineNotice tone="warn" title="Estimate run — no money moves.">
              No payroll provider is connected, so release only advances this workflow for preview. Nothing is debited
              from the bank and no employee, agency or garnishment recipient is paid.
            </InlineNotice>
          ) : (
            <InlineNotice tone="info" title="Release moves money.">
              It authorizes the provider to debit the bank{funding !== null ? <> for <b className="tnum">{formatMoney(funding)}</b></> : ''} and
              pay employees, tax agencies and garnishment recipients. This step can&apos;t be undone.
            </InlineNotice>
          )}
          <Button
            variant="primary"
            icon="dollar"
            onClick={onStartRelease}
            disabled={!canApprove}
            title={!canApprove ? 'Your role cannot release payroll funding.' : undefined}
          >
            Release to provider…
          </Button>
          {!canApprove && <p className="t-cap">Your role can&apos;t release payroll funding.</p>}
        </>
      )}

      {approved && confirmingRelease && (
        <div className={s.confirm} role="group" aria-label="Confirm release">
          <p className="t-head">{estimated ? 'Confirm release — estimate, no money moves' : 'Confirm release — money moves'}</p>
          {estimated ? (
            <p className="ink-2">
              This is an estimate run with no provider connected. Release only advances the workflow for preview. No bank
              debit occurs and no one is paid.
            </p>
          ) : (
            <p className="ink-2">
              The provider will debit the bank{funding !== null ? <> <b className="ink tnum">{formatMoney(funding)}</b></> : ''} and
              pay employees, agencies and garnishment recipients. This can&apos;t be undone.
            </p>
          )}
          <Check
            checked={ackRelease}
            onChange={onToggleAck}
            label={
              estimated
                ? 'I understand this is an estimate preview and no money will move.'
                : 'I authorize this bank debit and release of payroll funding.'
            }
          />
          <div className={s.right}>
            <Button onClick={onCancelRelease}>Cancel</Button>
            <Button
              variant="primary"
              icon="dollar"
              onClick={onConfirmRelease}
              disabled={!ackRelease || pending === 'release'}
              aria-busy={pending === 'release' || undefined}
            >
              {pending === 'release' ? 'Releasing…' : 'Release funding'}
            </Button>
          </div>
        </div>
      )}

      {releasedProcessing && (
        <>
          <p className="ink-2">
            Funding released. The provider is processing the debit. Post the run to record the balanced, job-costed
            journal entry in the ledger.
          </p>
          <Button variant="primary" icon="book" onClick={onPost} disabled={pending === 'post'} aria-busy={pending === 'post' || undefined}>
            {pending === 'post' ? 'Posting…' : 'Post to the ledger'}
          </Button>
        </>
      )}

      {status === 'DRAFT' && (
        <p className="ink-2">
          This run is a draft. Its preview didn&apos;t finish, so it can&apos;t be approved yet. Start a new run to compute
          the preview again.
        </p>
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
    <div className={s.remit}>
      <p className="t-head">Remit the payroll liabilities</p>
      <p className="ink-2">
        Record a remittance of this run&apos;s tax and benefit payables
        {grouped ? '' : <> (<b className="ink tnum">{formatMoney(payablesCents)}</b>)</>}. This debits the payroll
        liabilities and credits the operating bank, clearing them to zero. A run can be remitted once.
      </p>
      <Button
        icon="dollar"
        onClick={onRemit}
        disabled={pending || !canApprove}
        title={!canApprove ? 'Your role cannot remit payroll payables.' : undefined}
        aria-busy={pending || undefined}
      >
        {pending ? 'Recording…' : 'Record remittance'}
      </Button>
    </div>
  );
}
