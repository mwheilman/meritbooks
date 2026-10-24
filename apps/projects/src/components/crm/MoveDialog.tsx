'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Textarea } from '@meritbooks/merit-ui';
import { LOST_REASONS } from '@/lib/crm/types';
import { reasonProblem, reasonPrompt, type MoveReasonKind } from '@/lib/crm/stages';
import './crm.css';

/** The reason a Lost or Reopen move needs (BP-51), with the common lost reasons one click away. */
export function MoveDialog({ open, kind, leadTitle, stageName, busy, onClose, onConfirm }: {
  open: boolean;
  kind: MoveReasonKind | null;
  leadTitle: string;
  stageName: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setProblem(null);
    }
  }, [open]);
  if (!kind) return null;
  const p = reasonPrompt(kind);
  const go = () => {
    const pr = reasonProblem(kind, reason);
    setProblem(pr);
    if (!pr) onConfirm(reason.trim());
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={p.title}
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={busy} aria-busy={busy || undefined}>{p.verb}</Button>
        </>
      }
    >
      <p className="t-body" style={{ marginBottom: 12 }}>
        {leadTitle} moves to <b>{stageName}</b>.
      </p>
      {kind === 'lost' && (
        <div className="crm-filters" role="group" aria-label="Common reasons" style={{ marginBottom: 8 }}>
          {LOST_REASONS.map((r) => (
            <button key={r} type="button" className="crm-filter" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
      )}
      <Field label={p.label} error={problem ?? undefined} help={kind === 'lost' ? 'Name the competitor when there was one. Reports group losses by reason.' : undefined}>
        <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}
