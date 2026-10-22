'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, Tag, useFocusTrap } from '@meritbooks/merit-ui';

/**
 * DetailDrawer — the shared slide-over used to drill into any record (merit-ui panel).
 *
 * A list row sets some `selectedId`; the drawer fetches `/api/<entity>/<id>`
 * and renders it over the list, returning the user exactly where they were on
 * close. This is the one detail idiom for the whole app (the bank-feed edit
 * panel established the pattern). Each entity supplies its own body via
 * children; the shell handles open/close, Escape, scrim, focus, loading and error.
 *
 * Rendered in place (no portal) on purpose: its children are the calling page's
 * own markup, and a bridged page's styles only reach content inside the page.
 */

export function DetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  isLoading,
  error,
  headerRight,
  children,
  width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string | null;
  isLoading?: boolean;
  error?: string | null;
  headerRight?: ReactNode;
  children?: ReactNode;
  width?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="scrim scrim--fixed mb-side-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-hotkeys="off"
        className="panel mb-side-panel"
        style={{ width: width === 'lg' ? 640 : 520 }}
      >
        <div className="panel-head">
          <div className="row row--between" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <h2 className="t-head mb-trunc">{title}</h2>
              {subtitle && <div className="t-cap mb-trunc">{subtitle}</div>}
            </div>
            <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
              {headerRight}
              <button type="button" onClick={onClose} className="btn btn--quiet btn--icon" aria-label="Close">
                <Icon name="x" />
              </button>
            </div>
          </div>
        </div>

        <div className="panel-body mb-drawer-body">
          {isLoading ? (
            <div className="wg-loading mb-drawer-state" aria-busy="true">
              <span className="bar-l" style={{ width: '72%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '56%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
              <span className="t-cap" role="status">Loading the record…</span>
            </div>
          ) : error ? (
            <div className="wg-state" role="alert">
              <Tag tone="neg">Not loaded</Tag>
              <span className="t-head">This record didn&apos;t load</span>
              <p>{error}</p>
            </div>
          ) : children}
        </div>
      </div>
    </div>
  );
}

/** A titled group of field rows. */
export function DetailSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="panel-sec">
      {title && (
        <div className="panel-sec-h">
          <h3>{title}</h3>
        </div>
      )}
      <div className="mb-detail-rows">{children}</div>
    </section>
  );
}

/** A label/value row inside a section. */
export function DetailField({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="mb-detail-row">
      <span className="ink-2">{label}</span>
      <span className={mono ? 'tnum mb-trunc' : 'mb-trunc'}>{value ?? '—'}</span>
    </div>
  );
}

/** A simple line-items table (e.g. JE lines, invoice lines). */
export function DetailTable({ columns, children }: { columns: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center' }>; children: ReactNode }) {
  return (
    <div className="mb-scroll-x mb-detail-table">
      <table className="tbl tbl-q tbl-q--compact tbl-q--flush">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'n' : c.align === 'center' ? 'mb-c' : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
