'use client';

import { useState } from 'react';
import { Button, Dialog, Field, Textarea, api, toast } from '@meritbooks/merit-ui';
import type { FluxBoard } from '@/lib/close/flux/types';

const MIN = 10;

/** Controller override of the flux close task — a typed reason, logged; or withdraw it. */
export function FluxWaiverDialog({ board, onClose, onSaved }: { board: FluxBoard; onClose: () => void; onSaved: () => void }) {
  const waived = board.waiver?.status === 'WAIVED';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = board.summary.material - board.summary.reviewed;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ ok: boolean }>('/api/close/flux/waiver', {
      location_id: board.location.id,
      year: board.period.year,
      month: board.period.month,
      waive: !waived,
      reason: waived ? null : reason,
    });
    setBusy(false);
    if (res.error) { setError(res.error.error); return; }
    toast(waived ? 'Waiver withdrawn — the flux review blocks the close again.' : 'Flux review waived for this month.');
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      dismissOnScrim={false}
      title={waived ? 'Withdraw the flux waiver?' : `Close ${board.period.label} without a full flux review?`}
      footNote="Recorded in the audit log with your name."
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={waived ? 'primary' : 'danger'} onClick={() => void submit()} disabled={busy || (!waived && reason.trim().length < MIN)}>
            {busy ? 'Saving…' : waived ? 'Withdraw waiver' : 'Waive flux review'}
          </Button>
        </>
      }
    >
      {waived ? (
        <p>The waiver ({board.waiver?.reason}) lets {board.location.name} hard-close {board.period.label} with {open} material change{open === 1 ? '' : 's'} not reviewed. Withdrawing it makes the flux review block the close again.</p>
      ) : (
        <>
          <p>{open} material change{open === 1 ? ' is' : 's are'} not yet reviewed for {board.location.name}. A waiver lets the period hard-close anyway; the open lines stay visible here and in the close package.</p>
          <Field label="Reason" error={error ?? undefined} help={`At least ${MIN} characters — e.g. "Interim close for the lender; flux reviewed with the CFO by phone."`}>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />
          </Field>
        </>
      )}
      {waived && error && <p role="alert" style={{ color: 'var(--neg)' }}>{error}</p>}
    </Dialog>
  );
}
