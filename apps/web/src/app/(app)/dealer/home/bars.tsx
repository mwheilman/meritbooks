'use client';

/**
 * Quiet horizontal bars for the dealer home (line utilization, aging strips).
 * Slate by default; amber past a client threshold; red only for a breach / hold.
 */

import { clsx } from 'clsx';

export function UtilizationBar({
  bps,
  warnBps,
  hold,
  label,
}: {
  bps: number | null;
  warnBps: number;
  hold?: boolean;
  label: string;
}) {
  const pct = bps === null ? 0 : Math.max(0, Math.min(100, bps / 100));
  const over = bps !== null && bps >= 10_000;
  const warn = bps !== null && bps >= warnBps;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bps === null ? undefined : Math.round(bps / 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800"
    >
      <div
        className={clsx('h-full rounded-full', hold || over ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-slate-400')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Share-of-max bar (aging buckets). */
export function ShareBar({ value, max, tone = 'neutral' }: { value: number; max: number; tone?: 'neutral' | 'warning' }) {
  const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={clsx('h-full rounded-full', tone === 'warning' ? 'bg-amber-500/80' : 'bg-slate-400')} style={{ width: `${pct}%` }} />
    </div>
  );
}
