/**
 * BuildStatusBadge — honest, always-legible build-status label.
 *
 * MeritBooks' design criteria (§3 Chips/badges): "Build-status is honest and
 * always visible: `Live` (emerald), `In sandbox` / `In development` (amber).
 * Never imply a module is shipped when it isn't."
 *
 * This is presentation only — it reflects a status the surrounding surface
 * ALREADY knows (a payroll tenant with no provider connected, live billing not
 * activated, AI temporarily paused). It changes no logic and gates nothing.
 *
 * Tokens: mono, 11.5px, radius 7 (`rounded-brand-sm`) per the brand spec.
 */

import { clsx } from 'clsx';

export type BuildStatus = 'live' | 'sandbox' | 'development' | 'degraded';

const STATUS_META: Record<
  BuildStatus,
  { label: string; chip: string; dot: string; srPrefix: string }
> = {
  // Emerald = genuinely shipped and acting on real data.
  live: {
    label: 'Live',
    chip: 'bg-em/10 text-em-bright border border-em/25',
    dot: 'bg-em-bright',
    srPrefix: 'Build status: live —',
  },
  // Amber = provisional. Not shipped for real money / real posting yet.
  sandbox: {
    label: 'In sandbox',
    chip: 'bg-amber-500/10 text-amber-400 border border-amber-500/25',
    dot: 'bg-amber-400',
    srPrefix: 'Build status: in sandbox —',
  },
  development: {
    label: 'In development',
    chip: 'bg-amber-500/10 text-amber-400 border border-amber-500/25',
    dot: 'bg-amber-400',
    srPrefix: 'Build status: in development —',
  },
  // Amber = normally live, temporarily reduced (e.g. AI paused).
  degraded: {
    label: 'Degraded',
    chip: 'bg-amber-500/10 text-amber-400 border border-amber-500/25',
    dot: 'bg-amber-400',
    srPrefix: 'Build status: degraded —',
  },
};

export interface BuildStatusBadgeProps {
  status: BuildStatus;
  /** Override the default label (e.g. "Sandbox — estimate only"). */
  label?: string;
  /** Hide the leading status dot. */
  dot?: boolean;
  /** Native title tooltip / longer explanation. */
  title?: string;
  className?: string;
}

export function BuildStatusBadge({
  status,
  label,
  dot = true,
  title,
  className,
}: BuildStatusBadgeProps) {
  const meta = STATUS_META[status];
  const text = label ?? meta.label;
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-brand-sm px-2 py-0.5 font-mono text-[11.5px] font-medium leading-none tabular-nums',
        meta.chip,
        className,
      )}
    >
      {dot && <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />}
      <span className="sr-only">{meta.srPrefix} </span>
      {text}
    </span>
  );
}
