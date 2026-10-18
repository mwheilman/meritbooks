'use client';

import { useEffect, type ReactNode } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * DetailDrawer — the shared slide-over used to drill into any record.
 *
 * A list row sets some `selectedId`; the drawer fetches `/api/<entity>/<id>`
 * and renders it over the list, returning the user exactly where they were on
 * close. This is the one detail idiom for the whole app (the bank-feed edit
 * panel established the pattern). Each entity supplies its own body via
 * children; the shell handles open/close, Escape, backdrop, loading and error.
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
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div
        className={clsx(
          'fixed top-0 right-0 h-full bg-surface-900 border-l border-slate-800 z-50 flex flex-col animate-in slide-in-from-right duration-200 max-w-full',
          width === 'lg' ? 'w-[640px]' : 'w-[520px]'
        )}
      >
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerRight}
            <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
          ) : error ? (
            <div className="py-12 text-center">
              <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          ) : children}
        </div>
      </div>
    </>
  );
}

/** A titled group of field rows. */
export function DetailSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      {title && <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">{title}</h3>}
      <div className="rounded-lg bg-slate-800/30 divide-y divide-slate-800/50">{children}</div>
    </div>
  );
}

/** A label/value row inside a section. */
export function DetailField({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 gap-4">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className={clsx('text-sm text-slate-200 text-right truncate', mono && 'font-mono tabular-nums')}>
        {value ?? '--'}
      </span>
    </div>
  );
}

/** A simple line-items table (e.g. JE lines, invoice lines). */
export function DetailTable({ columns, children }: { columns: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center' }>; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            {columns.map((c) => (
              <th key={c.key} className={clsx(
                'px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-slate-500',
                c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
              )}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">{children}</tbody>
      </table>
    </div>
  );
}
