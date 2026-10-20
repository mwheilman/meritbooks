'use client';

import { useState, useEffect, useCallback } from 'react';

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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="flag-dialog-title"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-surface-900 border border-slate-800 rounded-xl shadow-2xl z-50 p-6"
      >
        <h3 id="flag-dialog-title" className="text-lg font-semibold text-white mb-1">Flag for Review</h3>
        <p className="text-sm text-slate-400 mb-4 truncate">{transaction.description}</p>
        <label htmlFor="flag-reason" className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
          Reason <span className="text-red-400">*</span>
        </label>
        <textarea
          id="flag-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why does this need manager review?"
          rows={3}
          autoFocus
          className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40 focus:border-amber-500/40 resize-none"
        />
        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(reason)}
            disabled={reason.trim().length === 0 || isLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors"
          >
            Flag Transaction
          </button>
        </div>
      </div>
    </>
  );
}
