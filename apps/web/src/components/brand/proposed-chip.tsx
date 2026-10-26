'use client';

/**
 * ProposedChip + ApprovePostButton — the visible grammar of "AI proposes, the
 * engine posts, a human approves" (design criteria §4 Proposed vs posted).
 *
 * ProposedChip is the kit tag for every place the app ALREADY shows an AI proposal
 * with a confidence score (bank-feed rows, the AI decision log, the NL categorizer):
 * `94% · Auto-eligible`. AI is Sky/Electric (`tag--ai`); the review bands read as
 * ochre (70–84) and brick (under 70) washes, always with the word, never colour
 * alone. It is presentation only: it neither computes confidence nor decides
 * eligibility — the caller passes what it already knows.
 *
 * ApprovePostButton is the paired explicit affordance — the kit's Electric primary
 * (Electric is the only call-to-action colour). Its copy and tooltip reinforce that
 * the deterministic engine — not the AI — writes the debits and credits.
 */

import { type ReactNode } from 'react';
import { Button, Tag, type TagTone } from '@meritbooks/merit-ui';

/** 'emerald' is kept as the prop value for compatibility; it renders as the kit AI tag. */
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

const TONE_TAG: Record<Exclude<ChipTone, 'auto'>, TagTone> = {
  emerald: 'ai',
  amber: 'warn',
  red: 'neg',
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
    <Tag tone={TONE_TAG[resolvedTone]} className={className}>
      <span className="sr">AI-proposed{pct != null ? `, ${pct}% confidence` : ''}: </span>
      {showPercent && pct != null && <span className="tnum">{pct}%</span>}
      {showPercent && pct != null && resolvedLabel != null && <span aria-hidden="true">·</span>}
      {resolvedLabel != null && <span>{resolvedLabel}</span>}
    </Tag>
  );
}

export interface ApprovePostButtonProps {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Kept for compatibility: the kit button is one 32px size for both. */
  size?: 'sm' | 'md';
  /** Default "Approve & post". */
  label?: string;
  /** Native title; defaults to the engine-posts reinforcement. */
  title?: string;
  className?: string;
}

/**
 * The explicit "Approve & post" action. The label + tooltip carry the product's
 * honesty contract: the human approves, the engine posts.
 */
export function ApprovePostButton({
  onClick,
  busy = false,
  disabled = false,
  label = 'Approve & post',
  title = 'The deterministic engine posts the balanced entry — the AI only proposes it.',
  className,
}: ApprovePostButtonProps) {
  return (
    <Button
      variant="primary"
      icon={busy ? undefined : 'check'}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      title={title}
      className={className}
    >
      {busy ? 'Posting…' : label}
    </Button>
  );
}
