'use client';

/**
 * Sold out of trust (DL-1) — the first thing on the dealer home. Red when there is
 * anything to do; calm when there isn't. The tile drills to the floor-plan SOT list;
 * each finding drills to its unit.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { SotFinding } from '@/lib/dealer/engine/sot';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import { SOLD_DETECTED_BY } from '@/lib/dealer/ui/labels';
import { dateLabel, daysLabel, money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { ErrorPanel, Money, Pill, StatTile } from '../_components/ui';

const TOP = 5;

function evidenceText(f: SotFinding): string {
  const sources = [...new Set(f.evidence.map((e) => e.source))];
  const ordered = [f.detectedBy, ...sources.filter((s) => s !== f.detectedBy)];
  return ordered.map((s) => SOLD_DETECTED_BY[s]).join(' · ');
}

export function SotPanel({
  sot,
  findings,
  isLoading,
  error,
  onRetry,
  asOf,
}: {
  sot: DealerSummary['sot'] | null;
  findings: SotFinding[] | null;
  isLoading: boolean;
  error: DealerApiError | null;
  onRetry: () => void;
  asOf: string;
}) {
  const router = useRouter();
  const count = sot?.count ?? findings?.length ?? 0;
  const alarm = count > 0;
  const rows = [...(findings ?? [])].sort((a, b) => (a.severity === b.severity ? b.daysPastDue - a.daysPastDue : a.severity === 'CRITICAL' ? -1 : 1));
  const shown = rows.slice(0, TOP);

  return (
    <section
      aria-labelledby="sot-heading"
      className={clsx('card mb-6 overflow-hidden', alarm && 'border-red-500/40')}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0">
          <h2 id="sot-heading" className={clsx('text-heading', alarm ? 'text-red-200' : 'text-white')}>
            Sold, not paid off
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Units the lender is owed for because they were sold — or look sold to the lender — and the payoff is late. Lenders call this
            &ldquo;sold out of trust&rdquo;.
          </p>
        </div>
        <Link href={dealerLinks.floorPlan('sot')} className="text-xs font-medium text-slate-300 hover:text-white">
          Open the full list →
        </Link>
      </header>

      {error ? (
        <ErrorPanel error={error} onRetry={onRetry} />
      ) : (
        <div className="grid gap-0 lg:grid-cols-3">
          <div className="border-b border-slate-800 p-5 lg:border-b-0 lg:border-r">
            <StatTile
              label="Sold out of trust"
              hero
              loading={isLoading && !sot}
              tone={alarm ? 'danger' : 'neutral'}
              icon={alarm ? ShieldAlert : ShieldCheck}
              href={dealerLinks.floorPlan('sot')}
              value={<span>{count}</span>}
              sub={
                alarm ? (
                  <span>
                    <span className="font-mono tabular-nums">{money(sot?.principalCents ?? 0)}</span> owed
                    {sot?.oldestDays != null && (
                      <>
                        {' '}
                        · oldest <span className="font-mono tabular-nums">{daysLabel(sot.oldestDays)}</span>
                      </>
                    )}
                    {(sot?.criticalCount ?? 0) > 0 && (
                      <>
                        {' '}
                        · <span className="font-mono tabular-nums">{sot?.criticalCount}</span> critical
                      </>
                    )}
                  </span>
                ) : (
                  'Nothing owed late'
                )
              }
            />
          </div>
          <div className="lg:col-span-2">
            {isLoading && !findings ? (
              <div className="space-y-3 p-5" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-800" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <div className="flex h-full items-center gap-3 p-5 text-sm text-slate-400">
                <ShieldCheck size={16} className="shrink-0 text-slate-500" />
                <span>
                  No sold-out-of-trust units as of <span className="font-mono tabular-nums text-slate-300">{dateLabel(asOf)}</span>. Every
                  sold unit is inside its payoff terms, and no outside signal (dealer-system deal, warranty registration, lender floor check)
                  shows a sale Books is missing.
                </span>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <caption className="sr-only">Top sold-out-of-trust findings</caption>
                  <thead>
                    <tr className="border-b border-slate-800">
                      {['Serial', 'How we know it sold', 'Sold', 'Past due', 'Owed to lender'].map((h, i) => (
                        <th
                          key={h}
                          scope="col"
                          className={clsx(
                            'whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
                            i >= 3 ? 'text-right' : 'text-left',
                          )}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {shown.map((f) => (
                      <tr
                        key={f.dedupKey}
                        tabIndex={0}
                        onClick={() => router.push(dealerLinks.unit(f.unitId))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            router.push(dealerLinks.unit(f.unitId));
                          }
                        }}
                        className="row-clickable cursor-pointer focus:outline-none focus-visible:bg-slate-800/40"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono tabular-nums text-white">{f.serialNumber}</span>
                            {f.severity === 'CRITICAL' && <Pill label="Critical" tone="danger" />}
                            {f.saleMissingInBooks && (
                              <Pill label="Sale missing in Books" tone="danger" dot={false} title="Record the sale so the payoff can be proposed." />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-body-sm text-slate-300">{evidenceText(f)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono tabular-nums text-slate-400">{dateLabel(f.earliestSaleDate)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums text-red-300">
                          {f.daysPastDue > 0 ? daysLabel(f.daysPastDue) : 'due now'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <Money cents={f.principalCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > TOP && (
                  <p className="border-t border-slate-800 px-4 py-2.5 text-xs text-slate-500">
                    Showing the {TOP} most urgent of <span className="font-mono tabular-nums">{rows.length}</span>.{' '}
                    <Link href={dealerLinks.floorPlan('sot')} className="text-slate-300 hover:text-white">
                      See all →
                    </Link>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
