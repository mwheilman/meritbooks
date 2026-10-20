'use client';

/**
 * Dealer Pack (D2) shared presentational primitives — built on the design system
 * (docs/DESIGN-SYSTEM.md): graphite surfaces, slate hairlines, one emerald accent,
 * JetBrains Mono tabular figures for every number.
 */

import Link from 'next/link';
import { clsx } from 'clsx';
import { AlertCircle, ArrowRight, Loader2, RefreshCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tone } from '@/lib/dealer/ui/labels';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { money } from '@/lib/dealer/ui/format';

const TONE_PILL: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-400',
  danger: 'bg-red-500/10 text-red-400',
  info: 'bg-blue-500/10 text-blue-400',
  neutral: 'bg-slate-500/10 text-slate-400',
  ai: 'bg-indigo-500/10 text-indigo-300',
};
const TONE_DOT: Record<Tone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-red-400',
  info: 'bg-blue-400',
  neutral: 'bg-slate-400',
  ai: 'bg-indigo-400',
};

/** Status pill with a plain-English label (never the raw code). */
export function Pill({ label, tone = 'neutral', title, dot = true }: { label: string; tone?: Tone; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap', TONE_PILL[tone])}>
      {dot && <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />}
      {label}
    </span>
  );
}

/** Money cell / figure: mono, tabular, red when negative. */
export function Money({ cents, className, muted }: { cents: number | null | undefined; className?: string; muted?: boolean }) {
  const neg = typeof cents === 'number' && cents < 0;
  return (
    <span className={clsx('font-mono tabular-nums', neg ? 'text-red-400' : muted ? 'text-slate-400' : 'text-white', className)}>
      {money(cents)}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono tabular-nums', className)}>{children}</span>;
}

/**
 * A KPI tile that ALWAYS drills to its list (no vanity metrics).
 * `tone='danger'` is reserved for SOT / missed money — the screen's alarm.
 */
export function StatTile({
  label,
  value,
  sub,
  href,
  tone = 'neutral',
  icon: Icon,
  hero,
  loading,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  href: string;
  tone?: Tone;
  icon?: LucideIcon;
  hero?: boolean;
  loading?: boolean;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        'group card card-hover block p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
        tone === 'danger' && 'border-red-500/40 bg-red-500/[0.04]',
        tone === 'warning' && 'border-amber-500/30',
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-caption uppercase tracking-caps text-slate-500">{label}</span>
        {Icon && <Icon size={14} className={clsx(tone === 'danger' ? 'text-red-400' : tone === 'warning' ? 'text-amber-400' : 'text-slate-500')} />}
      </div>
      {loading ? (
        <div className="h-8 w-28 animate-pulse rounded bg-slate-800" />
      ) : (
        <div className={clsx('font-mono tabular-nums', hero ? 'text-display' : 'text-2xl font-semibold', tone === 'danger' ? 'text-red-300' : 'text-white')}>
          {value}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-400">
        <span className="min-w-0 truncate">{sub}</span>
        <ArrowRight size={12} className="shrink-0 text-slate-600 transition-colors group-hover:text-slate-300" />
      </div>
    </Link>
  );
}

export function Section({ title, description, actions, children, className, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={clsx('card mb-6 overflow-hidden', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-heading text-white">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-slate-400">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Inline error with a plain-English explanation, an optional fix link and Retry. */
export function ErrorPanel({ error, onRetry, compact }: { error: DealerApiError | null; onRetry?: () => void; compact?: boolean }) {
  const x = explainDealerError(error);
  return (
    <div role="alert" className={clsx('flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/[0.06] text-sm', compact ? 'p-3' : 'm-5 p-4')}>
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-red-200">{x.title}</p>
        <p className="mt-0.5 text-slate-300">{x.message}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {x.fixHref && (
            <Link href={x.fixHref} className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
              {x.fixLabel ?? 'Fix this'} →
            </Link>
          )}
          {onRetry && (
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
              <RefreshCw size={12} /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500" role="status" aria-live="polite">
      <Loader2 size={18} className="animate-spin text-emerald-400" /> {label}
    </div>
  );
}

export function Empty({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800">
        <Icon size={20} className="text-slate-500" />
      </div>
      <h3 className="mb-1 text-sm font-medium text-slate-300">{title}</h3>
      <p className="mb-4 max-w-md text-sm text-slate-500">{description}</p>
      {action}
    </div>
  );
}

/** Label/value pairs in a detail drawer. */
export function DefList({ items }: { items: Array<{ label: string; value: ReactNode; mono?: boolean }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-body-sm">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-caption uppercase tracking-caps text-slate-500">{it.label}</dt>
          <dd className={clsx('mt-0.5 truncate text-slate-200', it.mono && 'font-mono tabular-nums')}>{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small "AI suggested" marker (indigo = the machine did this). */
export function AiBadge({ confidenceBps, title }: { confidenceBps?: number | null; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-2xs font-medium text-indigo-300">
      AI{typeof confidenceBps === 'number' ? <span className="font-mono tabular-nums">{Math.round(confidenceBps / 100)}%</span> : null}
    </span>
  );
}

/** Notice strip (info / warning) for inline guidance. */
export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warning' | 'danger'; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className={clsx(
        'mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
        tone === 'info' && 'border-blue-500/25 bg-blue-500/[0.05] text-slate-300',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/[0.05] text-amber-100',
        tone === 'danger' && 'border-red-500/40 bg-red-500/[0.06] text-red-100',
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
