'use client';

/**
 * DomainSectionShell — the shared Setup-Home section CARD for the long-tail
 * drop-and-parse domains (Debt, Leases, Fixed assets). It renders the section idiom
 * ONCE (design spec §3): a titled card with a Done / Detected · review / Add-later
 * badge, a primary "drop a document" call-to-action, an always-present manual
 * fallback, and neutral dispositions (not-applicable / add-later) that never nag.
 *
 * It is presentational + orchestration-agnostic: the per-domain ReviewComponent owns
 * the actual parse→review→commit (by opening the domain's existing, proven review
 * modal, wrapped VERBATIM) and passes callbacks here. When the AI seam is off, the
 * caller sets `aiAvailable={false}` and the card degrades to `AiUnavailableNotice`
 * plus the manual path — the deterministic engines still work.
 *
 * Accessibility: real buttons/links with focus rings; status conveyed by text + icon,
 * never color alone; the card is a labelled region.
 */

import { type ReactNode, useId } from 'react';
import Link from 'next/link';
import { Check, Sparkles, UploadCloud, ArrowRight, Ban, Clock, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import type { BoardCardStatus } from '@/components/onboarding/helpers';
import { AiUnavailableNotice } from './ai-unavailable-notice';

export type SectionDisposition = 'none' | 'done' | 'n_a' | 'skipped';

export interface DomainSectionShellProps {
  title: string;
  description: string;
  tone: 'required' | 'recommended' | 'optional';
  /** Board status derived from live state + the detected hint (Done / Detected / Add-later). */
  boardStatus: BoardCardStatus;
  /** False when the AI seam is off → the card shows the manual fallback instead of the drop CTA. */
  aiAvailable: boolean;
  /** Deep-link to the domain surface for manual entry / CSV / the full flow. */
  manualHref: string;
  manualLabel: string;
  /** Primary drop-and-parse action. */
  primaryLabel: string;
  primaryHint?: string;
  onPrimary: () => void;
  /** Optional secondary drop action (e.g. Debt's covenants). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Local disposition the caller manages (done after commit, or n/a / add-later). */
  disposition?: SectionDisposition;
  onNotApplicable?: () => void;
  onSkip?: () => void;
  onReset?: () => void;
  /** Modals / extra content the caller mounts (rendered at the end). */
  children?: ReactNode;
}

const TONE_LABEL: Record<DomainSectionShellProps['tone'], string> = {
  required: 'Required', // required domains never appear on the optional board, but keep the map total
  recommended: 'Recommended',
  optional: 'Optional',
};

const STATUS_TAG: Record<BoardCardStatus, { label: string; cls: string; Icon: typeof Check }> = {
  done: { label: 'Done', cls: 'bg-brand-500/12 text-brand-300', Icon: Check },
  detected: { label: 'Detected · review', cls: 'bg-ai/15 text-ai-fg', Icon: Sparkles },
  'add-later': { label: 'Add later', cls: 'bg-surface-950 text-slate-500 border border-slate-800', Icon: ArrowRight },
};

export function DomainSectionShell({
  title, description, tone, boardStatus, aiAvailable, manualHref, manualLabel,
  primaryLabel, primaryHint, onPrimary, secondaryLabel, onSecondary,
  disposition = 'none', onNotApplicable, onSkip, onReset, children,
}: DomainSectionShellProps) {
  const labelId = useId();
  const tag = STATUS_TAG[disposition === 'done' ? 'done' : boardStatus];
  const TagIcon = tag.Icon;

  return (
    <section
      aria-labelledby={labelId}
      className="rounded-2xl border border-slate-800 bg-surface-900 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={labelId} className="flex items-center gap-2 text-sm font-semibold text-white">
            {title}
            <span className="rounded-full bg-slate-800/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
              {TONE_LABEL[tone]}
            </span>
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>
        </div>
        <span className={clsx('flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium', tag.cls)}>
          <TagIcon size={11} aria-hidden /> {tag.label}
        </span>
      </div>

      {/* Terminal dispositions collapse the actions into a calm confirmed state. */}
      {disposition === 'done' ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-brand-400">
          <Check size={13} aria-hidden /> Set up — it will tie to the ledger.
        </p>
      ) : disposition === 'n_a' ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs text-slate-500"><Ban size={13} aria-hidden /> Marked not applicable.</p>
          {onReset && (
            <button type="button" onClick={onReset} className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded">
              <RotateCcw size={11} aria-hidden /> Undo
            </button>
          )}
        </div>
      ) : disposition === 'skipped' ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs text-slate-500"><Clock size={13} aria-hidden /> You&apos;ll add this later.</p>
          {onReset && (
            <button type="button" onClick={onReset} className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded">
              <RotateCcw size={11} aria-hidden /> Undo
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3.5 space-y-3">
          {aiAvailable ? (
            <>
              <button
                type="button"
                onClick={onPrimary}
                className="group flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-slate-700 bg-surface-950/40 px-4 py-3.5 text-left transition-colors hover:border-brand-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
              >
                <UploadCloud size={20} className="shrink-0 text-slate-500 group-hover:text-brand-400" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-200">{primaryLabel}</span>
                  {primaryHint && <span className="block text-[11px] text-slate-500">{primaryHint}</span>}
                </span>
              </button>
              {secondaryLabel && onSecondary && (
                <button
                  type="button"
                  onClick={onSecondary}
                  className="inline-flex items-center gap-1.5 text-xs text-ai-fg hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded"
                >
                  <Sparkles size={12} aria-hidden /> {secondaryLabel}
                </button>
              )}
            </>
          ) : (
            <AiUnavailableNotice manualHref={manualHref} manualLabel={manualLabel} />
          )}

          {/* Always-present neutral dispositions + manual escape hatch. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5 text-[11px]">
            {aiAvailable && (
              <Link href={manualHref} className="text-slate-500 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded">
                Prefer to enter it by hand?
              </Link>
            )}
            {onNotApplicable && (
              <button type="button" onClick={onNotApplicable} className="text-slate-500 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded">
                Not applicable
              </button>
            )}
            {onSkip && (
              <button type="button" onClick={onSkip} className="text-slate-500 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 rounded">
                Add later
              </button>
            )}
          </div>
        </div>
      )}

      {children}
    </section>
  );
}
