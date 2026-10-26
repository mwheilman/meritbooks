/**
 * BuildStatusBadge — honest, always-legible build-status label.
 *
 * MeritBooks' design criteria: build status is honest and always visible —
 * `Live` vs `In sandbox` / `In development` / `Degraded`. Never imply a module is
 * shipped when it isn't.
 *
 * This is presentation only — it reflects a status the surrounding surface
 * ALREADY knows (a payroll tenant with no provider connected, live billing not
 * activated, AI temporarily paused). It changes no logic and gates nothing.
 *
 * On the kit (Style Guide v2.3): a square `.tag` with a pip SHAPE + the word, so the
 * status is never carried by colour alone. Live = spruce wash + solid square;
 * provisional states = ochre wash + outline (sandbox / development) or the cut
 * half-pip (degraded).
 */

import { Pip, Tag, cx, type PipKind, type TagTone } from '@meritbooks/merit-ui';

export type BuildStatus = 'live' | 'sandbox' | 'development' | 'degraded';

const STATUS_META: Record<BuildStatus, { label: string; tone: TagTone; pip: PipKind; srPrefix: string }> = {
  // Genuinely shipped and acting on real data.
  live: { label: 'Live', tone: 'pos', pip: 'ready', srPrefix: 'Build status: live —' },
  // Provisional. Not shipped for real money / real posting yet.
  sandbox: { label: 'In sandbox', tone: 'warn', pip: 'soft', srPrefix: 'Build status: in sandbox —' },
  development: { label: 'In development', tone: 'warn', pip: 'soft', srPrefix: 'Build status: in development —' },
  // Normally live, temporarily reduced (e.g. AI paused).
  degraded: { label: 'Degraded', tone: 'warn', pip: 'risk', srPrefix: 'Build status: degraded —' },
};

export interface BuildStatusBadgeProps {
  status: BuildStatus;
  /** Override the default label (e.g. "Sandbox — estimate only"). */
  label?: string;
  /** Hide the leading status pip. */
  dot?: boolean;
  /** Native title tooltip / longer explanation. */
  title?: string;
  className?: string;
}

export function BuildStatusBadge({ status, label, dot = true, title, className }: BuildStatusBadgeProps) {
  const meta = STATUS_META[status];
  const text = label ?? meta.label;
  return (
    <Tag tone={meta.tone} title={title} className={cx(className)}>
      {dot && <Pip kind={meta.pip} />}
      <span className="sr">{meta.srPrefix} </span>
      {text}
    </Tag>
  );
}
