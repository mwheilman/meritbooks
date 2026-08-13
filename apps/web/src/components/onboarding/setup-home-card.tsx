'use client';

/**
 * SetupHomeCard — one domain on the optional "Setup Home" board (design spec §3).
 * Every long-tail domain (AR/AP, jobs/WIP, debt, leases, fixed assets, tax, team…)
 * is a card in one of three states — and the neutral one NEVER nags:
 *
 *   • 'done'      — imported / entered (emerald, check).
 *   • 'detected'  — an import surfaced it; needs a look (indigo AI accent, deep-link).
 *   • 'add-later' — neutral grey "not used yet" (never red).
 *
 * The whole card is a link to the domain's existing surface. Status is conveyed by
 * text + icon, not color alone. Tokens only.
 */

import Link from 'next/link';
import { Check, Sparkles, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';
import type { BoardCardStatus } from './helpers';

export interface SetupHomeCardProps {
  title: string;
  status: BoardCardStatus;
  /** Plain-language description / next action for this domain. */
  description: string;
  /** Deep-link to the domain's existing surface. */
  href: string;
  className?: string;
}

const STATUS_TAG: Record<BoardCardStatus, { label: string; cls: string }> = {
  'done': { label: 'Done', cls: 'bg-brand-500/12 text-brand-300' },
  'detected': { label: 'Detected · review', cls: 'bg-ai/15 text-ai-fg' },
  'add-later': { label: 'Add later', cls: 'bg-surface-950 text-slate-500 border border-slate-800' },
};

export function SetupHomeCard({ title, status, description, href, className }: SetupHomeCardProps) {
  const tag = STATUS_TAG[status];
  const Glyph = status === 'done' ? Check : status === 'detected' ? Sparkles : ArrowRight;

  return (
    <Link
      href={href}
      className={clsx(
        'group flex flex-col gap-2 rounded-2xl border px-4 py-3.5 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
        status === 'detected'
          ? 'border-ai/25 bg-ai/[0.04] hover:border-ai/40'
          : 'border-slate-800 bg-surface-900 hover:border-slate-600',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          {title}
        </span>
        <span className={clsx('flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium', tag.cls)}>
          <Glyph size={10} aria-hidden /> {tag.label}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">{description}</p>
    </Link>
  );
}
