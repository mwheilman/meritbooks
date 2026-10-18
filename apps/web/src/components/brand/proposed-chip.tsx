'use client';

/**
 * ProposedChip + ApprovePostButton — the visible grammar of "AI proposes, the
 * engine posts, a human approves" (design criteria §4 Proposed vs posted).
 *
 * ProposedChip is a compact, mono, emerald-tint confidence chip — the unified
 * look for every place the app ALREADY shows an AI proposal with a confidence
 * score (bank-feed rows, the AI decision log, the NL categorizer). It renders
 * a value like `94% · Auto-eligible`. It is presentation only: it neither
 * computes confidence nor decides eligibility — the caller passes what it
 * already knows.
 *
 * ApprovePostButton is the paired explicit emerald affordance. Its copy and
 * tooltip reinforce that the deterministic engine — not the AI — writes the
 * debits and credits.
 */

import { type ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

type ChipTone = 'auto' | 'emerald' | 'amber' | 'red';

function bandTone(pct: number): Exclude<ChipTone, 'auto'> {
  if (pct >= 85) return 'emerald';
  if (pct >= 70) return 'amber';
  return 'red';
}

function defaultLabel(pct: number): string {
  if (pct >= 85) return 'Auto-eligible';
  if (pct >= 70) return 'Review';
  return 'Needs review';
}

const TONE_CHIP: Record<Exclude<ChipTone, 'auto'>, string> = {
  emerald: 'bg-em/10 text-em-bright border border-em/25',
  amber: 'bg-amber-500/10 text-amber-400 border border-amber-500/25',
  red: 'bg-red-500/10 text-red-fig border border-red-500/25',
};

export interface ProposedChipProps {
  /** Confidence as a 0–1 fraction. When set, drives the % and the default tone/label. */
  confidence?: number | null;
  /** Override the label after the "·" (default derives from confidence band). */
  label?: ReactNode;
  /** Force a tone; 'auto' derives it from the confidence band. */
  tone?: ChipTone;
  /** Show the leading confidence percentage (default true when confidence is set). */
  showPercent?: boolean;
  /** Show the trailing "· label" (default true). Set false to render just the %. */
  showLabel?: boolean;
  className?: string;
}

export function ProposedChip({
  confidence,
  label,
  tone = 'auto',
  showPercent = true,
  showLabel = true,
  className,
}: ProposedChipProps) {
  const hasPct = confidence != null && Number.isFinite(confidence);
  const pct = hasPct ? Math.round((confidence as number) * 100) : null;
  const resolvedTone: Exclude<ChipTone, 'auto'> =
    tone === 'auto' ? (pct != null ? bandTone(pct) : 'emerald') : tone;
  const resolvedLabel = showLabel ? (label ?? (pct != null ? defaultLabel(pct) : 'Proposed')) : null;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-brand-sm px-2 py-0.5 font-mono text-[11.5px] font-medium leading-none tabular-nums',
        TONE_CHIP[resolvedTone],
        className,
      )}
    >
      <span className="sr-only">AI-proposed{pct != null ? `, ${pct}% confidence` : ''}: </span>
      {showPercent && pct != null && <span>{pct}%</span>}
      {showPercent && pct != null && resolvedLabel != null && (
        <span aria-hidden className="opacity-50">
          ·
        </span>
      )}
      {resolvedLabel != null && <span>{resolvedLabel}</span>}
    </span>
  );
}

export interface ApprovePostButtonProps {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Default "Approve & post". */
  label?: string;
  /** Native title; defaults to the engine-posts reinforcement. */
  title?: string;
  className?: string;
}

/**
 * The explicit emerald "Approve & post" action. The label + tooltip carry the
 * product's honesty contract: the human approves, the engine posts.
 */
export function ApprovePostButton({
  onClick,
  busy = false,
  disabled = false,
  size = 'md',
  label = 'Approve & post',
  title = 'The deterministic engine posts the balanced entry — the AI only proposes it.',
  className,
}: ApprovePostButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-brand font-medium text-ink-on-em transition-colors duration-fast',
        'bg-em hover:bg-em-bright disabled:cursor-not-allowed disabled:opacity-40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-em/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-950',
        'motion-reduce:transition-none',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        className,
      )}
    >
      {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Check size={14} />}
      {label}
    </button>
  );
}
