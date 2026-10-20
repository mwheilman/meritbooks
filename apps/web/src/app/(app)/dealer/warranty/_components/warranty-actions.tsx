'use client';

/**
 * Status-dependent warranty claim actions with plain-English GL consequences.
 * Approver actions (accept short-pay, write off, charge-back) need a parts & service
 * manager (DEALER_PERMS.approveReceivable); the server enforces it, FORBIDDEN is
 * shown plainly.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import {
  warrantyOpenCents,
  warrantyResolveEffect,
  warrantyRoCloseEffect,
  warrantySubmitEffect,
  type WarrantyAction,
  type WarrantyClaimRow,
} from '@/lib/dealer/ui/claims';
import type { DealerSettings } from '@/lib/dealer/types';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { ConfirmDialog, DateInput, Field, Modal, MoneyInput, TextArea, TextInput } from '../../_components/forms';
import { ErrorPanel } from '../../_components/ui';
import { SettleDialog } from '../../_components/claims/settle-dialog';

export const WARRANTY_ACTION_LABEL: Record<WarrantyAction, string> = {
  EDIT: 'Edit',
  RO_CLOSE: 'Close repair order',
  SUBMIT: 'Submit to manufacturer',
  SETTLE: 'Record payment',
  ACCEPT_SHORT_PAY: 'Accept short-pay',
  WRITE_OFF: 'Write off',
  REJECTED_BY_OEM: 'Rejected by manufacturer',
  RESUBMIT: 'Resubmit',
  DEBIT: 'Charge-back debit',
};

type Props = {
  action: WarrantyAction | null;
  onClose: () => void;
  claim: WarrantyClaimRow;
  claimLabel: string;
  manufacturer: string | null;
  settings: DealerSettings | null;
  locationId: string;
  onDone: () => void;
};

export function WarrantyActionDialogs({ action, onClose, claim, claimLabel, manufacturer, settings, locationId, onDone }: Props) {
  const open = warrantyOpenCents(claim);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);

  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [action]);

  async function resolve(resolution: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/warranty/resolve', locationId, { claimId: claim.id, resolution }, ok);
    setBusy(false);
    if (res.error) return setError(res.error);
    onDone();
    onClose();
  }

  async function roClose(date: string) {
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/warranty/ro-close', locationId, { claimId: claim.id, roClosedDate: date }, 'Repair order close recorded');
    setBusy(false);
    if (res.error) return setError(res.error);
    onDone();
    onClose();
  }

  const err = error ? <ErrorPanel error={error} compact /> : null;
  const approverNote = <p className="text-xs text-slate-500">This needs a parts & service manager (an approver). If you don’t have approval rights you’ll be told before anything posts.</p>;

  return (
    <>
      <SubmitDialog open={action === 'SUBMIT'} onClose={onClose} claim={claim} manufacturer={manufacturer} relieveParts={settings?.warranty_relieve_parts_inventory ?? true} locationId={locationId} onDone={onDone} />

      <ConfirmDialog
        open={action === 'RO_CLOSE'}
        onClose={onClose}
        title="Close the repair order"
        confirmLabel="Record close"
        busy={busy}
        date={{ label: 'Repair order closed on', initial: claim.repair_date ?? todayLocal() }}
        body={<p>{warrantyRoCloseEffect(settings?.warranty_recognition ?? 'ON_SUBMIT', !!claim.recognized_gl_entry_id)}</p>}
        error={err}
        onConfirm={({ date }) => roClose(date)}
      />

      <SettleDialog
        open={action === 'SETTLE'}
        onClose={onClose}
        kind="warranty"
        claimId={claim.id}
        claimLabel={claimLabel}
        openCents={open}
        defaultMethod={settings?.oem_settlement_default ?? 'STATEMENT_CREDIT'}
        manufacturer={manufacturer}
        locationId={locationId}
        onDone={onDone}
      />

      <ConfirmDialog
        open={action === 'ACCEPT_SHORT_PAY'}
        onClose={onClose}
        title={`Accept the ${money(open)} short-pay?`}
        confirmLabel="Accept short-pay"
        danger
        busy={busy}
        date={{ label: 'Date', initial: todayLocal() }}
        reason={{ label: 'Note (optional)', placeholder: 'e.g. labor cut to 1.8 hours per the manufacturer’s time guide' }}
        body={
          <div className="space-y-2">
            <p>
              {manufacturer ?? 'The manufacturer'} paid {money(claim.settled_cents)} of {money(claim.claimed_cents)}.
            </p>
            <p className="text-slate-200">{warrantyResolveEffect('ACCEPT_SHORT_PAY', { openCents: open, manufacturer })}</p>
            {approverNote}
          </div>
        }
        error={err}
        onConfirm={({ date, reason }) => resolve({ action: 'ACCEPT_SHORT_PAY', date, note: reason || null }, 'Short-pay accepted')}
      />

      <ConfirmDialog
        open={action === 'WRITE_OFF'}
        onClose={onClose}
        title={`Write off ${money(open)}?`}
        confirmLabel="Write off"
        danger
        busy={busy}
        date={{ label: 'Date', initial: todayLocal() }}
        reason={{ label: 'Why (optional)', placeholder: 'e.g. past the filing deadline; manufacturer won’t reconsider' }}
        body={
          <div className="space-y-2">
            <p className="text-slate-200">{warrantyResolveEffect('WRITE_OFF', { openCents: open, manufacturer })}</p>
            {approverNote}
          </div>
        }
        error={err}
        onConfirm={({ date, reason }) => resolve({ action: 'WRITE_OFF', date, note: reason || null }, 'Claim written off')}
      />

      <ConfirmDialog
        open={action === 'REJECTED_BY_OEM'}
        onClose={onClose}
        title="Record a manufacturer rejection"
        confirmLabel="Mark rejected"
        busy={busy}
        date={{ label: 'Rejected on', initial: todayLocal() }}
        reason={{ label: 'Rejection reason', required: true, placeholder: 'As the manufacturer stated it' }}
        body={<p>{warrantyResolveEffect('REJECTED_BY_OEM', { openCents: open, manufacturer })}</p>}
        error={err}
        onConfirm={({ date, reason }) => resolve({ action: 'REJECTED_BY_OEM', date, reason }, 'Rejection recorded')}
      />

      <ConfirmDialog
        open={action === 'RESUBMIT'}
        onClose={onClose}
        title="Resubmit the claim"
        confirmLabel="Mark resubmitted"
        busy={busy}
        date={{ label: 'Resubmitted on', initial: todayLocal() }}
        reason={{ label: 'What changed (optional)', placeholder: 'e.g. added the failed-part photos' }}
        body={<p>{warrantyResolveEffect('RESUBMIT', { openCents: open, manufacturer })}</p>}
        error={err}
        onConfirm={({ date, reason }) => resolve({ action: 'RESUBMIT', date, note: reason || null }, 'Claim resubmitted')}
      />

      <DebitDialog open={action === 'DEBIT'} onClose={onClose} claim={claim} manufacturer={manufacturer} locationId={locationId} onDone={onDone} />
    </>
  );
}

function SubmitDialog({
  open,
  onClose,
  claim,
  manufacturer,
  relieveParts,
  locationId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  claim: WarrantyClaimRow;
  manufacturer: string | null;
  relieveParts: boolean;
  locationId: string;
  onDone: () => void;
}) {
  const [date, setDate] = useState(todayLocal());
  const [claimNo, setClaimNo] = useState(claim.oem_claim_number ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setDate(todayLocal());
    setClaimNo(claim.oem_claim_number ?? '');
    setError(null);
  }, [open, claim.oem_claim_number]);

  const late = claim.filing_deadline && date > claim.filing_deadline;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/warranty/submit', locationId, { claimId: claim.id, submittedDate: date, oemClaimNumber: claimNo.trim() || null }, 'Claim submitted — receivable booked');
    setBusy(false);
    if (res.error) return setError(res.error);
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="sm"
      title="Submit to the manufacturer"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Submit {money(claim.claimed_cents)}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <Field label="Submitted on" htmlFor={`${id}-d`} required error={late ? 'This is after the filing deadline — the manufacturer may reject it.' : null}>
          <DateInput id={`${id}-d`} value={date} onChange={setDate} />
        </Field>
        <Field label="Manufacturer claim #" htmlFor={`${id}-n`} hint="Statement credits are matched by this number — add it if you have it">
          <TextInput id={`${id}-n`} value={claimNo} onChange={setClaimNo} maxLength={100} className="font-mono" />
        </Field>
        <p className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs">
          <span className="font-medium text-slate-200">What this posts: </span>
          {warrantySubmitEffect({ claim, relieveParts, manufacturer })}
        </p>
        {error && <ErrorPanel error={error} compact />}
      </div>
    </Modal>
  );
}

function DebitDialog({
  open,
  onClose,
  claim,
  manufacturer,
  locationId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  claim: WarrantyClaimRow;
  manufacturer: string | null;
  locationId: string;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayLocal());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setAmount(null);
    setDate(todayLocal());
    setNote('');
    setError(null);
  }, [open]);

  const valid = amount !== null && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/warranty/resolve', locationId, { claimId: claim.id, resolution: { action: 'DEBIT', date, amountCents: amount, note: note.trim() || null } }, 'Charge-back recorded');
    setBusy(false);
    if (res.error) return setError(res.error);
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="sm"
      title="Record a manufacturer charge-back"
      description="A debit on the manufacturer’s statement against a claim it already paid (often after an audit)."
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger btn-sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Record charge-back
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" htmlFor={`${id}-a`} required>
            <MoneyInput id={`${id}-a`} cents={amount} onChange={setAmount} />
          </Field>
          <Field label="Date" htmlFor={`${id}-d`} required>
            <DateInput id={`${id}-d`} value={date} onChange={setDate} />
          </Field>
        </div>
        <Field label="Note (optional)" htmlFor={`${id}-n`}>
          <TextArea id={`${id}-n`} value={note} onChange={setNote} rows={2} maxLength={1000} placeholder="e.g. audit finding reference" />
        </Field>
        <p className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs">
          <span className="font-medium text-slate-200">What this posts: </span>
          {warrantyResolveEffect('DEBIT', { openCents: 0, debitCents: amount, manufacturer })}
        </p>
        <p className="text-xs text-slate-500">This needs a parts & service manager (an approver).</p>
        {error && <ErrorPanel error={error} compact />}
      </div>
    </Modal>
  );
}
