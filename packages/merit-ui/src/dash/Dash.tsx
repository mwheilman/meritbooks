'use client';

import { useId, type ReactNode } from 'react';
import { cx, cssVars, isDev } from '../cx';
import { Icon } from '../icons/Icon';
import { Tag } from '../primitives/Status';

export interface DashProps {
  children: ReactNode;
  /** Keep authored order (row) instead of dense packing. */
  flow?: 'dense' | 'row';
  className?: string;
}

/**
 * .dash — 12 columns × 136px rows, 24px gutters. The primary module goes
 * first: top-left, 8 of 12 (<Widget primary w={8} h={4}>). Widgets the user
 * has no right to are NOT rendered — the grid reflows; never a locked tile.
 */
export function Dash({ children, flow = 'dense', className }: DashProps) {
  return (
    <div className={cx('dash', className)} style={flow === 'row' ? { gridAutoFlow: 'row' } : undefined}>
      {children}
    </div>
  );
}

/** Registry sizes: S 3×2 · M 6×2 · L 6×4 · W 12×2 · XL 12×4, plus 4- and 8-wide primaries. */
export const WIDGET_SIZES = {
  S: { w: 3, h: 2 },
  M: { w: 6, h: 2 },
  L: { w: 6, h: 4 },
  W: { w: 12, h: 2 },
  XL: { w: 12, h: 4 },
  P8: { w: 8, h: 4 },
  P4: { w: 4, h: 4 },
} as const;

export type WidgetStateSpec =
  | { kind: 'loading'; label: string; lines?: number }
  | { kind: 'empty'; title: string; body?: ReactNode; action?: ReactNode }
  | { kind: 'done'; title: string; body?: ReactNode; action?: ReactNode }
  | { kind: 'error'; title: string; body?: ReactNode; onRetry?: () => void; retryLabel?: string; tag?: string };

export interface WidgetProps {
  /** The one question this widget answers ("Jobs over budget"). */
  title: ReactNode;
  /** Tabular count beside the title. */
  count?: ReactNode;
  /** Muted meta ("Ranked by margin fade"). */
  meta?: ReactNode;
  /** Header actions (one primary per module). */
  actions?: ReactNode;
  /** 40px foot ("Oldest 6 days · next reminder 4:00 PM"). */
  foot?: ReactNode;
  /** 2px Electric rule under the header; always top-left, 8 wide. */
  primary?: boolean;
  /** Grid span (columns 1–12, rows of 136px). */
  w?: number;
  h?: number;
  /** Optional explicit placement. */
  x?: number;
  y?: number;
  /** Pad the body 16px. */
  pad?: boolean;
  /** loading / empty / done / error. When set, replaces children. */
  state?: WidgetStateSpec;
  children?: ReactNode;
  className?: string;
}

/** .wg — white, hairline, 48px header (title · count · meta · actions), optional foot. */
export function Widget({ title, count, meta, actions, foot, primary, w = 6, h = 2, x, y, pad, state, children, className }: WidgetProps) {
  const titleId = useId();
  const loading = state?.kind === 'loading';
  return (
    <section
      className={cx('wg', primary && 'wg--primary', loading && 'wg-loading', className)}
      style={cssVars({ '--w': w, '--h': h, '--x': x, '--y': y })}
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
    >
      <div className="wg-head">
        <h3 className="wg-title" id={titleId}>
          {title}
        </h3>
        {count != null && <span className="wg-count">{count}</span>}
        {meta != null && <span className="wg-meta">{meta}</span>}
        {actions != null && <div className="wg-act">{actions}</div>}
      </div>
      {state ? (
        loading ? (
          <div className="wg-body wg-body--pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <WidgetState state={state} />
          </div>
        ) : (
          <div className="wg-body">
            <WidgetState state={state} />
          </div>
        )
      ) : (
        <div className={cx('wg-body', pad && 'wg-body--pad')}>{children}</div>
      )}
      {foot != null && <div className="wg-foot">{foot}</div>}
    </section>
  );
}

const BANNED_STATE_COPY = /\bno\s+data\b|\bnothing\s+to\s+show\b/i;

function checkCopy(text: string) {
  if (isDev() && BANNED_STATE_COPY.test(text)) {
    throw new Error(`[merit-ui] Widget state copy "${text}" is banned. Say what to do, or what's next ("Nothing due until Oct 26").`);
  }
}

const SKELETON_WIDTHS = ['80%', '60%', '72%', '64%', '52%'];

/**
 * The four states every module defines (§7.12):
 *   loading — skeleton bars shaped like content + what is loading
 *   empty   — nothing configured: dashed mark, what to do, one action
 *   done    — configured, nothing to do: spruce check, what's next
 *   error   — what happened, what to do, retry
 * (No permission → don't render the widget at all.)
 */
export function WidgetState({ state }: { state: WidgetStateSpec }) {
  switch (state.kind) {
    case 'loading':
      return (
        <>
          {SKELETON_WIDTHS.slice(0, state.lines ?? 3).map((w, i) => (
            <span key={i} className="bar-l" style={{ width: w }} aria-hidden="true" />
          ))}
          <span className="t-cap" role="status">
            {state.label}
          </span>
        </>
      );
    case 'empty':
      checkCopy(state.title);
      return (
        <div className="wg-state">
          <span className="wg-empty-mark" aria-hidden="true">
            <Icon name="plus" />
          </span>
          <span className="t-head">{state.title}</span>
          {state.body != null && <p>{state.body}</p>}
          {state.action}
        </div>
      );
    case 'done':
      checkCopy(state.title);
      return (
        <div className="wg-state">
          <span className="wg-done-mark" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="t-head">{state.title}</span>
          {state.body != null && <p>{state.body}</p>}
          {state.action}
        </div>
      );
    case 'error':
      checkCopy(state.title);
      return (
        <div className="wg-state" role="alert">
          <Tag tone="neg">{state.tag ?? 'Not loaded'}</Tag>
          <span className="t-head">{state.title}</span>
          {state.body != null && <p>{state.body}</p>}
          {state.onRetry && (
            <button className="btn" type="button" onClick={state.onRetry}>
              {state.retryLabel ?? 'Retry'}
            </button>
          )}
        </div>
      );
  }
}
