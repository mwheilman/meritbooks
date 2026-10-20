'use client';

/**
 * Units by age (FPB §7 / DL-4): one strip per aging bucket with count + cost; each
 * bucket drills to exactly those units in the register.
 */

import Link from 'next/link';
import { Boxes } from 'lucide-react';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import { money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { Empty, Section } from '../_components/ui';
import { ShareBar } from './bars';

function bucketLabel(minDays: number, maxDays: number | null): string {
  return maxDays === null ? `${minDays}+ days` : `${minDays}–${maxDays} days`;
}

export function InventoryPanel({ units, isLoading }: { units: DealerSummary['units'] | null; isLoading: boolean }) {
  const buckets = units?.byAge ?? [];
  const maxCents = Math.max(0, ...buckets.map((b) => b.cents));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const firstAgedIndex = 1; // everything past the first bucket is "aged"

  return (
    <Section
      title="Units by age"
      description={
        units ? (
          <span>
            <span className="font-mono tabular-nums text-slate-300">{units.inStockCount}</span> units carried at{' '}
            <span className="font-mono tabular-nums text-slate-300">{money(units.inStockCostCents)}</span> ·{' '}
            <span className="font-mono tabular-nums">{units.flooredCount}</span> on floor plan ·{' '}
            <span className="font-mono tabular-nums">{units.ownedCount}</span> owned outright
          </span>
        ) : (
          'Days in stock since the unit was received.'
        )
      }
      actions={
        <Link href={dealerLinks.units({ status: 'IN_STOCK' })} className="text-xs font-medium text-slate-300 hover:text-white">
          Unit register →
        </Link>
      }
    >
      {isLoading && !units ? (
        <div className="grid grid-cols-2 gap-px bg-slate-800 sm:grid-cols-5" aria-hidden>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface-900 p-4">
              <div className="mb-2 h-3 w-16 animate-pulse rounded bg-slate-800" />
              <div className="h-6 w-10 animate-pulse rounded bg-slate-800" />
            </div>
          ))}
        </div>
      ) : total === 0 ? (
        <Empty
          icon={Boxes}
          title="No units in stock"
          description="Import the dealer system’s unit list or the lender’s flooring to build the register."
          action={
            <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
              Import units
            </Link>
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-px bg-slate-800 sm:grid-cols-3 lg:grid-cols-5">
          {buckets.map((b, i) => (
            <li key={b.label} className="bg-surface-900">
              <Link
                href={dealerLinks.units({ status: 'IN_STOCK', minAge: b.minDays > 0 ? b.minDays : undefined, maxAge: b.maxDays ?? undefined })}
                className="group block h-full p-4 hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
              >
                <div className="text-caption uppercase tracking-caps text-slate-500">{bucketLabel(b.minDays, b.maxDays)}</div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xl font-semibold tabular-nums text-white">{b.count}</span>
                  <span className="font-mono text-body-sm tabular-nums text-slate-400">{money(b.cents)}</span>
                </div>
                <div className="mt-2">
                  <ShareBar value={b.cents} max={maxCents} tone={i >= firstAgedIndex + 2 && b.count > 0 ? 'warning' : 'neutral'} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
