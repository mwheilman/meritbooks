'use client';

/**
 * MaskedField — renders a sensitive value at the caller's field level (05 R-6) and,
 * when the level is `reveal_logged` / `visible`, offers an explicit Reveal that asks
 * for a reason (logged server-side to core.field_reveals). Replaces any
 * window.prompt-style reveal (IA §8 component sheet).
 *
 * The component never holds the raw value until the server returns it for a logged
 * reveal; "Hide" drops it from state.
 */

import { useState } from 'react';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { clsx } from 'clsx';

export type MaskLevel = 'hidden' | 'grouped' | 'masked' | 'reveal_logged' | 'visible';

export interface MaskedFieldProps {
  label: string;
  /** The value as the server returned it (already masked unless visible). */
  value: string | null;
  level: MaskLevel;
  /** Fetch the raw value for a logged reveal; resolve null when not granted. */
  onReveal?: (reason: string) => Promise<string | null>;
}

export function MaskedField({ label, value, level, onReveal }: MaskedFieldProps) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReveal = !!onReveal && level === 'reveal_logged' && value != null;
  const shown = revealed ?? value;

  async function submit() {
    if (!onReveal || reason.trim().length < 3) {
      setError('Give a reason (at least 3 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const raw = await onReveal(reason.trim());
      if (raw == null) setError('Reveal was not granted for your role.');
      else { setRevealed(raw); setAsking(false); setReason(''); }
    } catch {
      setError('Could not reveal. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-slate-500 shrink-0">{label}</span>
        <span className="flex items-center gap-2 min-w-0">
          {level === 'hidden' || shown == null ? (
            <span className="flex items-center gap-1 text-xs text-slate-500" title="Hidden for your role">
              <Lock size={12} aria-hidden /> {value == null && level !== 'hidden' ? 'Not on file' : 'Hidden'}
            </span>
          ) : (
            <span className={clsx('text-sm font-mono tabular-nums truncate', revealed ? 'text-amber-300' : 'text-slate-200')}>
              {shown}
            </span>
          )}
          {canReveal && !revealed && !asking && (
            <button
              type="button"
              onClick={() => { setAsking(true); setError(null); }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label={`Reveal ${label}`}
            >
              <Eye size={12} aria-hidden /> Reveal
            </button>
          )}
          {revealed && (
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label={`Hide ${label}`}
            >
              <EyeOff size={12} aria-hidden /> Hide
            </button>
          )}
        </span>
      </div>
      {asking && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <label className="sr-only" htmlFor={`reveal-reason-${label}`}>Reason for revealing {label}</label>
          <input
            id={`reveal-reason-${label}`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAsking(false); setReason(''); } }}
            placeholder="Reason (logged)"
            maxLength={500}
            className="flex-1 rounded-md border border-slate-700 bg-surface-950 px-2 py-1 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500"
          >
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Eye size={12} aria-hidden />} Reveal
          </button>
          <button
            type="button"
            onClick={() => { setAsking(false); setReason(''); setError(null); }}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:text-white"
          >
            Cancel
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-[11px] text-red-400" role="alert">{error}</p>}
      {revealed && <p className="mt-1 text-[11px] text-slate-500">Revealed — this access was logged.</p>}
    </div>
  );
}
