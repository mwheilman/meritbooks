'use client';

import type { ReactNode } from 'react';
import { WidgetState } from '@meritbooks/merit-ui';

/** Loading / error / empty around a job tab's fetched section. */
export function Loaded<T>({ q, empty, children, what }: {
  q: { data: T | null; error: string | null; isLoading: boolean; refetch: () => Promise<void> };
  empty?: (d: T) => { title: string; body?: string; action?: ReactNode } | null;
  children: (d: T) => ReactNode;
  what: string;
}) {
  if (q.isLoading && !q.data) return <WidgetState state={{ kind: 'loading', label: `Loading ${what}…`, lines: 4 }} />;
  if (q.error) return <WidgetState state={{ kind: 'error', title: `${what[0]!.toUpperCase()}${what.slice(1)} did not load`, body: q.error, onRetry: () => void q.refetch(), retryLabel: 'Try again' }} />;
  if (!q.data) return null;
  const e = empty?.(q.data);
  if (e) return <WidgetState state={{ kind: 'empty', title: e.title, body: e.body, action: e.action }} />;
  return <>{children(q.data)}</>;
}

/** A section heading inside a job tab (01 // style). */
export function Sec({ title, meta, actions, children }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec" style={{ marginBottom: 'var(--s4)' }}>
      <div className="sec-h">
        <h2 className="t-section">{title}</h2>
        {meta != null && <span className="t-cap ink-3">{meta}</span>}
        <span className="sp" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export const words = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/_/g, ' ');
export const num = (n: number | null | undefined, d = 1): string =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d });
