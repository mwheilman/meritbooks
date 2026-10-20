'use client';

/**
 * Small presentational pieces shared by the floor-plan and lender-statement screens.
 */

import Link from 'next/link';
import { clsx } from 'clsx';
import { useRef, type KeyboardEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { bpsToPct, dateLabel, daysBetween, relativeDue } from '@/lib/dealer/ui/format';
import { utilizationTone } from '../_lib/queues';

/** Principal-vs-limit bar (DL-10: amber ≥ warn, red on credit hold / over limit). */
export function UtilizationBar({ bps, warnBps, status, label }: { bps: number | null; warnBps: number; status: string; label: string }) {
  const tone = utilizationTone(bps, warnBps, status);
  const pct = bps === null ? 0 : Math.min(100, Math.max(0, bps / 100));
  return (
    <div className="min-w-[120px]">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={bps === null ? 'No credit limit set' : `${bpsToPct(bps, 1)} of the credit limit used`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800"
      >
        <div
          className={clsx('h-full rounded-full duration-slow', tone === 'danger' ? 'bg-red-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-emerald-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={clsx('mt-1 font-mono text-2xs tabular-nums', tone === 'danger' ? 'text-red-400' : tone === 'warning' ? 'text-amber-400' : 'text-slate-500')}>
        {bps === null ? 'No limit' : `${bpsToPct(bps, 1)} used`}
      </div>
    </div>
  );
}

/** Link to a unit page by serial (stops row-click propagation). */
export function UnitLink({ unitId, serial, className }: { unitId: string | null | undefined; serial: string | null | undefined; className?: string }) {
  if (!unitId) return <span className="text-slate-500">—</span>;
  return (
    <Link
      href={dealerLinks.unit(unitId)}
      onClick={(e) => e.stopPropagation()}
      className={clsx('font-mono tabular-nums text-slate-200 underline-offset-2 hover:text-emerald-400 hover:underline', className)}
    >
      {serial ?? '…'}
    </Link>
  );
}

export function NoteLink({ noteId, invoice }: { noteId: string | null | undefined; invoice: string | null | undefined }) {
  if (!noteId) return <span className="text-slate-500">—</span>;
  return (
    <Link
      href={dealerLinks.note(noteId)}
      onClick={(e) => e.stopPropagation()}
      className="font-mono tabular-nums text-slate-200 underline-offset-2 hover:text-emerald-400 hover:underline"
    >
      {invoice ?? '…'}
    </Link>
  );
}

export function JeLink({ glEntryId }: { glEntryId: string | null | undefined }) {
  if (!glEntryId) return <span className="text-slate-500">—</span>;
  return (
    <Link
      href={dealerLinks.journalEntry(glEntryId)}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-emerald-400"
    >
      Entry <ExternalLink size={11} aria-hidden />
    </Link>
  );
}

/** A date with a relative hint; red when past (and `pastIsBad`), amber within `warnDays`. */
export function DueDate({ date, today, warnDays = 0, pastIsBad = true, muted }: { date: string | null | undefined; today: string; warnDays?: number; pastIsBad?: boolean; muted?: boolean }) {
  if (!date) return <span className="text-slate-500">—</span>;
  const d = daysBetween(today, date) ?? 0;
  const tone = muted ? 'text-slate-400' : d < 0 && pastIsBad ? 'text-red-400' : d <= warnDays && warnDays > 0 ? 'text-amber-400' : 'text-slate-300';
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono tabular-nums text-slate-300">{dateLabel(date)}</span>
      <span className={clsx('ml-1.5 text-2xs', tone)}>{relativeDue(date, today)}</span>
    </span>
  );
}

/** Tabs with roving focus (←/→/Home/End) — WAI-ARIA tabs pattern. */
export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: Array<{ key: K; label: string; count?: number | null; alert?: boolean }>;
  active: K;
  onChange: (k: K) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].key);
  }
  return (
    <div role="tablist" aria-label={label} className="mb-5 flex gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-surface-900 p-1">
      {tabs.map((t, i) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${t.key}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={clsx(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
              on ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span
                className={clsx(
                  'rounded-full px-1.5 font-mono text-2xs tabular-nums',
                  t.alert ? 'bg-red-500/15 text-red-300' : 'bg-slate-700/60 text-slate-300',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Inline error list from a 4xx `details.problems` (strings). */
export function ProblemList({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-300">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}
