import type { ReactNode } from 'react';
import { cx } from '../cx';
import type { ShellContext } from './nav';

export type Density = 'cockpit' | 'report';

export interface AppShellProps {
  /** The bar state (§6.1). client is the quiet default. */
  context?: ShellContext;
  /** Pick by ROLE, not by page: cockpit for PMs/estimators/schedulers; report for owners/ops leaders. */
  density?: Density;
  /** Collapsed 64px rail (icons only). */
  mini?: boolean;
  /** Pin the shell to the viewport and scroll .main (default true; false for boards/screenshots). */
  viewport?: boolean;
  /** <SupportBand/> or <ViewAsBand/> — the 32px band above the shell. */
  band?: ReactNode;
  rail: ReactNode;
  bar: ReactNode;
  /** <ContextLine/> + <Page/>. */
  children: ReactNode;
  /** id of the main landmark (the skip link target). */
  mainId?: string;
  className?: string;
}

/**
 * .app[data-context] — rail, 48px bar, main (32px context line, then the
 * primary module). No banner, no greeting, nothing else above the fold.
 */
export function AppShell({
  context = 'client',
  density = 'cockpit',
  mini = false,
  viewport = true,
  band,
  rail,
  bar,
  children,
  mainId = 'main',
  className,
}: AppShellProps) {
  return (
    <div
      className={cx('app', `density-${density}`, mini && 'app--mini', viewport && 'app--viewport', className)}
      data-context={context}
    >
      <a className="skip" href={`#${mainId}`}>
        Skip to content
      </a>
      {band}
      {rail}
      {bar}
      <main className="main" id={mainId} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

export interface SessionBandProps {
  /** Lead in bold ("Support session"), then the facts joined by //. */
  lead: ReactNode;
  facts?: ReadonlyArray<ReactNode>;
  /** Countdown text ("42:00") — format with format.countdown(). */
  remaining: string;
  /** Spoken form ("42 minutes left"). */
  remainingLabel: string;
  /** End verb, always visible. */
  endLabel?: string;
  onEnd: () => void;
}

function Band({ kind, lead, facts = [], remaining, remainingLabel, endLabel, onEnd }: SessionBandProps & { kind: 'support' | 'viewas' }) {
  const slStyle = kind === 'support' ? { color: 'var(--white)' } : undefined;
  return (
    <div className={kind === 'support' ? 'support-band' : 'viewas-band'} role="status" aria-live="off">
      <span>
        <b>{lead}</b>
        {facts.map((f, i) => (
          <span key={i}>
            <span className="sl" style={slStyle} aria-hidden="true">
              {'//'}
            </span>
            <span className="sr">, </span>
            {f}
          </span>
        ))}
      </span>
      <span className="sp" />
      <span className="clock" aria-label={remainingLabel}>
        {remaining}
      </span>
      <span aria-hidden="true">left</span>
      <button className="btn" type="button" onClick={onEnd}>
        {endLabel ?? (kind === 'support' ? 'End session' : 'End view-as')}
      </button>
    </div>
  );
}

/** 32px brick band above the shell, hatched with the 45° slash — someone else is in your books. */
export function SupportBand(props: SessionBandProps) {
  return <Band kind="support" {...props} />;
}

/** 32px Sky band above the shell — you, looking through someone else's access. Read-only. */
export function ViewAsBand(props: SessionBandProps) {
  return <Band kind="viewas" {...props} />;
}
