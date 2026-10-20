import type { ReactNode } from 'react';
import { cx } from '../cx';

/**
 * The slash meter (§7.5) — the monogram's 45° stroke, spaced like "//".
 * Read by count; the number always sits beside it. No rings, no gradients.
 *   on = Electric · part = Blue-200 · cur = outlined (current step) ·
 *   bad = brick (the step that's stuck) · off = grey
 */
export type Stroke = 'on' | 'part' | 'cur' | 'bad' | 'off';

export interface MeterProps {
  strokes: ReadonlyArray<Stroke>;
  /** Required: the meter is role="img" ("Stage 2 of 8, Connect, blocked"). */
  label: string;
  size?: 'md' | 'lg';
  className?: string;
}

/** .meter — pure CSS strokes. */
export function Meter({ strokes, label, size = 'md', className }: MeterProps) {
  return (
    <span className={cx('meter', size === 'lg' && 'meter--lg', className)} role="img" aria-label={label}>
      {strokes.map((s, i) => (
        <i key={i} className={s === 'off' ? undefined : s} />
      ))}
    </span>
  );
}

/**
 * Strokes for a step sequence (close steps, migration stages, job phases):
 * steps before `current` are on; `current` is cur (or bad when blocked);
 * the rest are off. `current` is 0-based; pass `total` to mark everything done.
 */
export function stepStrokes(total: number, current: number, opts: { blocked?: boolean } = {}): Stroke[] {
  return Array.from({ length: total }, (_, i): Stroke => {
    if (i < current) return 'on';
    if (i === current) return opts.blocked ? 'bad' : 'cur';
    return 'off';
  });
}

/**
 * Strokes for a count of things (one stroke each): done = on, inReview = part.
 * "Clients ready · 4 of 13" with 3 in review → 4 on, 3 part, 6 off.
 */
export function countStrokes(total: number, done: number, inReview = 0): Stroke[] {
  return Array.from({ length: total }, (_, i): Stroke => (i < done ? 'on' : i < done + inReview ? 'part' : 'off'));
}

/** Confidence below this is "low" (Decide band: under 70). */
export const LOW_CONFIDENCE = 70;

/**
 * Five strokes for a 0–100 confidence score. 90+ (the Ready band) is all on;
 * otherwise one stroke per full 20 points, plus a part stroke for a remainder
 * of 10 or more.  97 → 5 on · 74 → 3 on + part · 58 → 2 on + part · 63 → 3 on.
 */
export function scoreStrokes(score: number): Stroke[] {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  if (s >= 90) return ['on', 'on', 'on', 'on', 'on'];
  const full = Math.floor(s / 20);
  const part = s % 20 >= 10;
  return Array.from({ length: 5 }, (_, i): Stroke => (i < full ? 'on' : i === full && part ? 'part' : 'off'));
}

export interface ConfProps {
  /** 0–100. */
  score: number;
  /** Override the accessible label ("Confidence 74 of 100"). */
  label?: string;
  /** Force the low (ochre) treatment; default: score < 70. */
  low?: boolean;
  className?: string;
}

/** .conf — confidence meter + number. Low confidence turns ochre. */
export function Conf({ score, label, low, className }: ConfProps) {
  const isLow = low ?? score < LOW_CONFIDENCE;
  return (
    <span className={cx('conf', isLow && 'conf--lo', className)}>
      <Meter strokes={scoreStrokes(score)} label={label ?? `Confidence ${Math.round(score)} of 100`} />
      <b aria-hidden="true">{Math.round(score)}</b>
    </span>
  );
}

export interface StageMeterProps {
  /** Stage names in order (8 for a migration: Plan → Live). */
  stages: ReadonlyArray<string>;
  /** 0-based current stage; stages.length = all done. */
  current: number;
  blocked?: boolean;
  /** .l2 line under the stage name ("day 9 · late"). */
  detail?: ReactNode;
}

/** The 8-stroke migration meter (marks.css .stgw): meter + stage name + detail. */
export function StageMeter({ stages, current, blocked, detail }: StageMeterProps) {
  const name = stages[Math.min(current, stages.length - 1)] ?? '';
  const done = current >= stages.length;
  const label = done ? `All ${stages.length} stages done` : `Stage ${current + 1} of ${stages.length}, ${name}${blocked ? ', blocked' : ''}`;
  return (
    <div className="stgw">
      <Meter strokes={stepStrokes(stages.length, current, { blocked })} label={label} />
      <span className="who">
        <span className="l1">{done ? stages[stages.length - 1] : name}</span>
        {detail != null && <span className="l2">{detail}</span>}
      </span>
    </div>
  );
}
