'use client';

/**
 * ProposalCard — the atom of the "review, don't enter" experience. AI (or a
 * deterministic heuristic) proposes a fact; the human ACCEPTS or EDITS. It never
 * shows a dollar it authored — the value it presents was computed deterministically
 * and the card only disposes it (design spec §5).
 *
 * Design system: indigo (`ai`) accent for the AI seam. Confidence is conveyed by
 * TEXT + ICON, never color alone:
 *   • 'high'      — "High confidence" + check (bulk-acceptable)
 *   • 'review'    — "Worth a look" + eye
 *   • 'needs-you' — "Needs you" + alert (never auto-accepted)
 *
 * Accessibility: a labelled group; the confidence chip carries an sr-only prefix so
 * it reads meaningfully; Accept/Edit are real buttons with focus rings.
 */

import { type ReactNode, useId } from 'react';
import { Check, Eye, AlertCircle, Pencil, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import type { ConfidenceBand } from './helpers';
import { confidenceLabel } from './helpers';

export interface ProposalCardProps {
  /** The proposed fact, plainly stated (e.g. "4100 Construction Revenue → Revenue (contract)"). */
  title: ReactNode;
  /** The "why this" — accountant-precise secondary line (reasoning / provenance). */
  subtitle?: ReactNode;
  /** How sure we are — drives the chip + icon (text, not color alone). */
  confidence: ConfidenceBand;
  /** Accept the proposal as-is. Omit to render a read-only proposal (e.g. already accepted). */
  onAccept?: () => void;
  /** Open inline edit UI. Omit when there is nothing to edit. */
  onEdit?: () => void;
  /** True once accepted — collapses actions into a confirmed state. */
  accepted?: boolean;
  /** Disable the actions (e.g. while saving). */
  busy?: boolean;
  /** Inline edit UI, rendered under the header when editing. */
  children?: ReactNode;
  className?: string;
}

const BAND_META: Record<ConfidenceBand, { icon: typeof Check; chip: string; dot: string }> = {
  'high': { icon: Check, chip: 'bg-brand-500/12 text-brand-300', dot: 'bg-brand-400' },
  'review': { icon: Eye, chip: 'bg-warning/12 text-warning-fg', dot: 'bg-warning' },
  'needs-you': { icon: AlertCircle, chip: 'bg-warning/12 text-warning-fg', dot: 'bg-warning' },
};

export function ProposalCard({
  title, subtitle, confidence, onAccept, onEdit, accepted = false, busy = false, children, className,
}: ProposalCardProps) {
  const labelId = useId();
  const meta = BAND_META[confidence];
  const ChipIcon = meta.icon;
  const label = confidenceLabel(confidence);

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={clsx(
        'rounded-xl border px-4 py-3 transition-colors',
        accepted ? 'border-slate-800 bg-surface-900/60' : 'border-ai/25 bg-ai/[0.04]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div id={labelId} className="flex items-center gap-2 text-sm text-white">
            <Sparkles size={13} className="shrink-0 text-ai-fg" aria-hidden />
            <span className="min-w-0">{title}</span>
          </div>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>

        <span
          className={clsx('flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.chip)}
        >
          <ChipIcon size={11} aria-hidden />
          <span className="sr-only">Confidence: </span>
          {label}
        </span>
      </div>

      {/* Inline edit body (caller-supplied). */}
      {children && <div className="mt-3">{children}</div>}

      {/* Actions — hidden once accepted or when the card is read-only. */}
      {!accepted && (onAccept || onEdit) && (
        <div className="mt-3 flex items-center gap-2">
          {onAccept && (
            <button
              type="button"
              onClick={onAccept}
              disabled={busy}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                busy ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400',
              )}
            >
              <Check size={13} aria-hidden /> Accept
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
            >
              <Pencil size={12} aria-hidden /> Edit
            </button>
          )}
        </div>
      )}

      {accepted && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-brand-400">
          <Check size={13} aria-hidden /> Accepted
        </p>
      )}
    </div>
  );
}
