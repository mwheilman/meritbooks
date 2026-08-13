/**
 * AiUnavailableNotice — the calm, degrade-safe fallback for any drop-and-parse
 * section when the AI seam is off (design spec §5: "AI is OFF today; each step is
 * deterministic-first, fallbacks = connector pull / CSV column-map / manual entry;
 * the tie-out gate holds regardless").
 *
 * It never scolds and never blocks: it explains that the reader can still add the
 * domain by hand and deep-links to the domain's existing surface (which owns manual
 * entry / CSV). Presentational only (no hooks, no I/O); tokens only; text conveys
 * meaning, not color alone.
 */

import Link from 'next/link';
import { Info, PencilLine } from 'lucide-react';
import { clsx } from 'clsx';

export interface AiUnavailableNoticeProps {
  /** Deep-link to the domain surface where manual entry / CSV import live. */
  manualHref: string;
  /** Label for the manual fallback action (e.g. "Enter debt by hand"). */
  manualLabel: string;
  /** Optional override of the lead-in copy. */
  message?: string;
  className?: string;
}

export function AiUnavailableNotice({
  manualHref,
  manualLabel,
  message = 'Document reading is paused right now — you can still set this up by hand.',
  className,
}: AiUnavailableNoticeProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-slate-800 bg-surface-950 px-4 py-3',
        className,
      )}
    >
      <p className="flex items-start gap-2 text-xs text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />
        <span>{message}</span>
      </p>
      <Link
        href={manualHref}
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-brand-500/50 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
      >
        <PencilLine size={13} aria-hidden />
        {manualLabel}
      </Link>
    </div>
  );
}
