'use client';

/**
 * Confirmation dialogs for every floor-plan money event (shared by the floor-plan
 * tabs and the note page): propose payoff, release payoff, pay / waive a
 * curtailment, pay an ad-hoc curtailment. Each one confirms in plain English what
 * the books will do, posts through the D1 route, and shows refusals inline.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerMutate } from '../../_lib/use-dealer';
import { ConfirmDialog, DateInput, Field, Modal, MoneyInput } from '../../_components/forms';
import { invalidateNoteRefs } from '../_lib/hooks';

function InlineError({ error }: { error: DealerApiError | null }) {
  if (!error) return null;
  const x = explainDealerError(error);
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs">
      <p className="font-medium text-red-200">{x.title}</p>
      <p className="mt-0.5 text-slate-300">{x.message}</p>
    </div>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  async function run<T>(path: string, locationId: string, body: Record<string, unknown>, ok: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    const res = await dealerMutate<T>('post', path, locationId, body, ok);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return null;
    }
    return res.data;
  }
  return { busy, error, setError, run };
}

export interface NoteLabel {
  noteId: string;
  invoice: string | null;
  serial: string | null;
  balanceCents: number | null;
}

function noteText(n: NoteLabel): string {
  return `${n.invoice ? `lender invoice ${n.invoice}` : 'this note'}${n.serial ? ` (unit ${n.serial})` : ''}`;
}

export function ProposePayoffDialog({ open, onClose, locationId, note, onDone }: { open: boolean; onClose: () => void; locationId: string; note: NoteLabel | null; onDone: () => void }) {
  const r = useRun();
  useEffect(() => {
    if (open) r.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!note) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Propose payoff"
      confirmLabel="Propose payoff"
      busy={r.busy}
      date={{ label: 'Planned payment date', initial: todayLocal() }}
      body={
        <>
          <p>
            Proposes paying the lender <span className="font-mono tabular-nums text-white">{money(note.balanceCents)}</span> to clear {noteText(note)}.
          </p>
          <p className="mt-2 text-slate-400">Nothing leaves the bank yet — a different person reviews and releases the payment from the payoff queue.</p>
        </>
      }
      error={<InlineError error={r.error} />}
      onConfirm={async ({ date }) => {
        const ok = await r.run('/api/dealer/payoffs/propose', locationId, { noteId: note.noteId, date }, 'Payoff proposed — waiting for release');
        if (ok) {
          invalidateNoteRefs([note.noteId]);
          onDone();
          onClose();
        }
      }}
    />
  );
}

export function ReleasePayoffDialog({
  open,
  onClose,
  locationId,
  txnId,
  note,
  proposedByMe,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  txnId: string | null;
  note: NoteLabel | null;
  proposedByMe: boolean;
  onDone: () => void;
}) {
  const r = useRun();
  useEffect(() => {
    if (open) r.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!txnId || !note) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Release payoff"
      confirmLabel="Release payment"
      danger
      busy={r.busy}
      date={{ label: 'Date paid', initial: todayLocal() }}
      body={
        <>
          <p>
            Pays the lender <span className="font-mono tabular-nums text-white">{money(note.balanceCents)}</span> for {noteText(note)} and closes the note.
          </p>
          <p className="mt-2 text-amber-200/90">Money leaves the operating bank. You can’t release a payoff you proposed — a different person must.</p>
          {proposedByMe && <p className="mt-2 text-red-300">You proposed this payoff, so the release will be refused. Ask a colleague with release rights.</p>}
        </>
      }
      error={<InlineError error={r.error} />}
      onConfirm={async ({ date }) => {
        const ok = await r.run('/api/dealer/payoffs/release', locationId, { txnId, paidDate: date }, 'Payoff released and posted');
        if (ok) {
          invalidateNoteRefs([note.noteId]);
          onDone();
          onClose();
        }
      }}
    />
  );
}

export function PayCurtailmentDialog({
  open,
  onClose,
  locationId,
  curtailmentId,
  amountCents,
  note,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  curtailmentId: string | null;
  amountCents: number | null;
  note: NoteLabel | null;
  onDone: () => void;
}) {
  const r = useRun();
  useEffect(() => {
    if (open) r.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!curtailmentId) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Pay curtailment"
      confirmLabel="Record payment"
      busy={r.busy}
      date={{ label: 'Date paid', initial: todayLocal() }}
      body={
        <>
          <p>
            Records a <span className="font-mono tabular-nums text-white">{money(amountCents)}</span> curtailment payment
            {note ? ` on ${noteText(note)}` : ''}: debit the floor-plan payable, credit the operating bank.
          </p>
          <p className="mt-2 text-slate-400">This reduces the loan; the unit’s cost doesn’t change.</p>
        </>
      }
      error={<InlineError error={r.error} />}
      onConfirm={async ({ date }) => {
        const ok = await r.run('/api/dealer/curtailments/pay', locationId, { curtailmentId, paidDate: date }, 'Curtailment paid and posted');
        if (ok) {
          if (note) invalidateNoteRefs([note.noteId]);
          onDone();
          onClose();
        }
      }}
    />
  );
}

export function WaiveCurtailmentDialog({ open, onClose, locationId, curtailmentId, amountCents, onDone }: { open: boolean; onClose: () => void; locationId: string; curtailmentId: string | null; amountCents: number | null; onDone: () => void }) {
  const r = useRun();
  useEffect(() => {
    if (open) r.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!curtailmentId) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Waive curtailment"
      confirmLabel="Waive"
      danger
      busy={r.busy}
      reason={{ label: 'Why is it waived?', required: true, placeholder: 'For example: the lender extended terms in writing on …' }}
      body={
        <>
          <p>
            Marks the <span className="font-mono tabular-nums text-white">{money(amountCents)}</span> curtailment as waived. No entry is posted and the note balance stays the same.
          </p>
          <p className="mt-2 text-slate-400">Only an approver can waive. The reason is kept in the audit log.</p>
        </>
      }
      error={<InlineError error={r.error} />}
      onConfirm={async ({ reason }) => {
        const ok = await r.run('/api/dealer/curtailments/waive', locationId, { curtailmentId, reason }, 'Curtailment waived');
        if (ok) {
          onDone();
          onClose();
        }
      }}
    />
  );
}

/** Pay down a note outside the schedule (noteId + amount). */
export function AdHocCurtailmentDialog({ open, onClose, locationId, note, onDone }: { open: boolean; onClose: () => void; locationId: string; note: NoteLabel | null; onDone: () => void }) {
  const r = useRun();
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayLocal());
  const amtId = useId();
  const dateId = useId();
  useEffect(() => {
    if (open) {
      r.setError(null);
      setAmount(null);
      setDate(todayLocal());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!note) return null;
  const max = note.balanceCents ?? 0;
  const amountError = amount !== null && (amount <= 0 || amount > max) ? `Enter an amount above zero and no more than the balance (${money(max)}).` : null;
  const canSubmit = amount !== null && !amountError && /^\d{4}-\d{2}-\d{2}$/.test(date) && !r.busy;
  return (
    <Modal
      open={open}
      onClose={r.busy ? () => undefined : onClose}
      title="Pay down this note"
      description="A principal payment outside the curtailment schedule."
      width="sm"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={r.busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary btn-sm inline-flex items-center gap-1.5"
            disabled={!canSubmit}
            onClick={async () => {
              const ok = await r.run('/api/dealer/curtailments/pay', locationId, { noteId: note.noteId, amountCents: amount, paidDate: date }, 'Payment recorded and posted');
              if (ok) {
                invalidateNoteRefs([note.noteId]);
                onDone();
                onClose();
              }
            }}
          >
            {r.busy && <Loader2 size={13} className="animate-spin" />}
            Record payment
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <p>
          Balance on {noteText(note)}: <span className="font-mono tabular-nums text-white">{money(max)}</span>. The payment debits the floor-plan payable and credits the operating
          bank; the unit’s cost doesn’t change.
        </p>
        <Field label="Amount" htmlFor={amtId} required error={amountError}>
          <MoneyInput id={amtId} cents={amount} onChange={setAmount} invalid={!!amountError} />
        </Field>
        <Field label="Date paid" htmlFor={dateId} required>
          <DateInput id={dateId} value={date} onChange={setDate} />
        </Field>
        <InlineError error={r.error} />
      </div>
    </Modal>
  );
}
