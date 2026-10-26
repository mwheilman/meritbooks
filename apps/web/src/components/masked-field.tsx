'use client';

/**
 * MaskedField — renders a sensitive value at the caller's field level (05 R-6) and,
 * when the level is `reveal_logged` / `visible`, offers an explicit Reveal that asks
 * for a reason (logged server-side to core.field_reveals). Replaces any
 * window.prompt-style reveal (IA §8 component sheet).
 *
 * The component never holds the raw value until the server returns it for a logged
 * reveal; "Hide" drops it from state.
 *
 * Presentation: a kit detail row (`.mb-detail-row`) so it sits inside a DetailSection
 * beside DetailField rows. Kit classes + inline layout only (it renders inside bridged
 * and ported pages alike).
 */

import { useState } from 'react';
import { Button, Icon, Input, Tag } from '@meritbooks/merit-ui';

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
    <div className="mb-detail-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
      <span className="ink-2" style={{ flex: 'none' }}>{label}</span>
      <span className="row" style={{ minWidth: 0, justifyContent: 'flex-end', fontWeight: 500, color: 'var(--ink)' }}>
        {level === 'hidden' || shown == null ? (
          <span className="row ink-3" title="Hidden for your role" style={{ gap: 6, fontWeight: 400 }}>
            <Icon name="lock" /> {value == null && level !== 'hidden' ? 'Not on file' : 'Hidden'}
          </span>
        ) : (
          <span className="tnum mb-trunc">
            {shown}
          </span>
        )}
        {revealed && <Tag tone="warn">Revealed</Tag>}
        {canReveal && !revealed && !asking && (
          <Button
            variant="quiet"
            icon="eye"
            onClick={() => { setAsking(true); setError(null); }}
            aria-label={`Reveal ${label}`}
          >
            Reveal
          </Button>
        )}
        {revealed && (
          <Button
            variant="quiet"
            onClick={() => setRevealed(null)}
            aria-label={`Hide ${label}`}
          >
            Hide
          </Button>
        )}
      </span>
      {asking && (
        <form
          className="row"
          style={{ flexBasis: '100%' }}
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <label className="sr" htmlFor={`reveal-reason-${label}`}>Reason for revealing {label}</label>
          <Input
            id={`reveal-reason-${label}`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(false); setReason(''); } }}
            placeholder="Reason (logged)"
            maxLength={500}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button type="submit" variant="primary" icon="eye" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Revealing…' : 'Reveal'}
          </Button>
          <Button
            variant="quiet"
            onClick={() => { setAsking(false); setReason(''); setError(null); }}
          >
            Cancel
          </Button>
        </form>
      )}
      {error && <p className="field-error" role="alert" style={{ flexBasis: '100%', margin: 0 }}>{error}</p>}
      {revealed && <p className="t-cap" style={{ flexBasis: '100%', margin: 0 }}>Revealed — this access was logged.</p>}
    </div>
  );
}
