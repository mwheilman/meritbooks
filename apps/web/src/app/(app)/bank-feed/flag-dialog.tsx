'use client';

import { useState, useCallback } from 'react';
import { Button, Dialog, Field, Textarea } from '@meritbooks/merit-ui';
import s from './bank-feed-panels.module.css';

/**
 * Flag-for-review dialog + action, shared by the Bank Feed and the Credit Cards
 * feed (audit 06 §5 bug 2: the card feed's Flag button had no handler). Both
 * post to the same /api/bank-feed/flag route — card lines are bank_transactions.
 */

export interface FlagResult {
  success: boolean;
  transaction_id: string;
  status: string;
}

/**
 * Direct-fetch flag action so the server's reason (e.g. "already flagged")
 * reaches the user instead of a generic failure.
 */
export function useFlagTransaction(): {
  flag: (transactionId: string, reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  isFlagging: boolean;
} {
  const [isFlagging, setIsFlagging] = useState(false);
  const flag = useCallback(async (transactionId: string, reason: string) => {
    setIsFlagging(true);
    try {
      const res = await fetch('/api/bank-feed/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId, reason: reason.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<FlagResult> & { error?: string };
      if (res.ok && json.success) return { ok: true as const };
      return { ok: false as const, error: json.error ?? `Failed to flag transaction (${res.status})` };
    } catch {
      return { ok: false as const, error: 'Network error while flagging' };
    } finally {
      setIsFlagging(false);
    }
  }, []);
  return { flag, isFlagging };
}

/**
 * Kit dialog (portal, focus-trapped). Esc and the scrim close it; ⌘↵ flags.
 * The dialog owns its keys ([aria-modal]), and the list's own shortcuts stand
 * down while it is open, so Esc closes this first.
 */
export function FlagDialog({
  transaction,
  isLoading,
  onSubmit,
  onClose,
}: {
  transaction: { description: string };
  isLoading: boolean;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length > 0 && !isLoading;
  const submit = () => {
    if (ready) onSubmit(reason);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Flag for review"
      width={480}
      footNote="A manager sees the reason in the review queue."
      actions={
        <>
          <Button variant="quiet" onClick={onClose} chord="escape">
            Cancel
          </Button>
          <Button variant="primary" icon="flag" onClick={submit} disabled={!ready} aria-busy={isLoading || undefined} chord="mod+enter">
            {isLoading ? 'Flagging…' : 'Flag transaction'}
          </Button>
        </>
      }
    >
      <p className={s.flagDesc} title={transaction.description}>
        {transaction.description}
      </p>
      <Field label={<>Reason<span className={s.req} aria-hidden="true">*</span></>} help="Required. Say what a manager should check.">
        <Textarea
          data-autofocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why does this need manager review?"
          rows={3}
          required
          aria-required="true"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </Dialog>
  );
}
