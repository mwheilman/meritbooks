/**
 * The four states (plus "cannot compute") every chart defines. Copy says what is
 * true and what to do next — never "No data" (banned by the kit's Widget rules).
 * Each state reserves the chart's height, so swapping states never shifts layout.
 */
import type { ReactNode } from 'react';
import type { UnavailableReason } from './core/types';

export type ChartState =
  | { kind: 'loading'; label?: string }
  | { kind: 'empty'; title: string; body?: ReactNode; action?: ReactNode }
  | { kind: 'unavailable'; reason: UnavailableReason; detail?: ReactNode; action?: ReactNode }
  | { kind: 'error'; title?: string; body?: ReactNode; onRetry?: () => void };

/** Standard titles/bodies for the unavailable reasons (FEATURE-GAP-AUDIT §4.3). */
export const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, { title: string; body: string }>> = {
  not_enough_history: { title: 'Not enough history', body: 'This needs more closed periods than are on file. It appears once they close.' },
  not_on_file: { title: 'Not on file', body: 'The books for this period have not been loaded.' },
  not_mapped: { title: 'Not mapped', body: 'Some accounts are not mapped to a reporting line, so this figure would be incomplete.' },
  not_meaningful: { title: 'Not meaningful', body: 'The base is zero or negative, or the sign flips, so a percentage would mislead.' },
  no_approved_budget: { title: 'No approved budget', body: 'Approve a budget version for this year to compare against it.' },
  preliminary: { title: 'Preliminary', body: 'The period is not closed; figures may still change.' },
  no_activity: { title: 'No activity', body: 'Nothing posted in this period for the selected scope.' },
};

export function ChartStateView({ state, height }: { state: ChartState; height: number }) {
  if (state.kind === 'loading') {
    return (
      <div className="mc-state mc-state--loading" style={{ height }} aria-busy="true" role="status">
        <span className="sr">{state.label ?? 'Loading chart'}</span>
        <div className="mc-skel" aria-hidden="true">
          {[52, 68, 44, 80, 60, 72, 56, 88, 64, 76, 58, 92].map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    );
  }
  if (state.kind === 'empty') {
    return (
      <div className="mc-state" style={{ height }} role="status">
        <span className="mc-state-mark mc-state-mark--empty" aria-hidden="true" />
        <p className="t-head">{state.title}</p>
        {state.body && <p className="mc-state-b">{state.body}</p>}
        {state.action && <div className="mc-state-a">{state.action}</div>}
      </div>
    );
  }
  if (state.kind === 'unavailable') {
    const copy = UNAVAILABLE_COPY[state.reason];
    return (
      <div className="mc-state" style={{ height }} role="status">
        <span className="mc-state-mark mc-state-mark--na" aria-hidden="true" />
        <p className="t-head">{copy.title}</p>
        <p className="mc-state-b">{state.detail ?? copy.body}</p>
        {state.action && <div className="mc-state-a">{state.action}</div>}
      </div>
    );
  }
  return (
    <div className="mc-state mc-state--error" style={{ height }} role="alert">
      <span className="mc-state-mark mc-state-mark--err" aria-hidden="true" />
      <p className="t-head">{state.title ?? 'This chart could not load'}</p>
      <p className="mc-state-b">{state.body ?? 'The figures did not arrive. Nothing was changed.'}</p>
      {state.onRetry && (
        <div className="mc-state-a">
          <button type="button" className="btn" onClick={state.onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
