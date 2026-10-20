'use client';

/**
 * Floor-plan position by line (FPB §7 "Floor-plan utilization by line", DL-10):
 * principal vs limit, utilization bar, sold-not-paid, accrued interest, the next
 * curtailments, and the last signed lender reconciliation. Every row drills.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Landmark } from 'lucide-react';
import type { DealerSummary, LinePosition } from '@/lib/dealer/service/insights';
import type { LineStatus } from '@/lib/dealer/types';
import { LINE_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, daysBetween, money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { Empty, Money, Pill, Section } from '../_components/ui';
import { nameOf, useNames } from '../_lib/use-dealer';
import { UtilizationBar } from './bars';

function lineFlag(l: LinePosition, warnBps: number): { label: string; tone: 'danger' | 'warning' } | null {
  if (l.lineStatus === 'CREDIT_HOLD') return { label: 'Credit hold', tone: 'danger' };
  if (l.utilizationBps !== null && l.utilizationBps >= 10_000) return { label: 'Over limit', tone: 'danger' };
  if (l.utilizationBps !== null && l.utilizationBps >= warnBps) return { label: 'Near limit', tone: 'warning' };
  return null;
}

export function FloorPlanPanel({
  floorPlan,
  warnBps,
  asOf,
  isLoading,
}: {
  floorPlan: DealerSummary['floorPlan'] | null;
  warnBps: number;
  asOf: string;
  isLoading: boolean;
}) {
  const router = useRouter();
  const lines = floorPlan?.lines ?? [];
  const lenders = useNames('vendors', lines.map((l) => l.lenderVendorId));
  const flagged = lines.filter((l) => lineFlag(l, warnBps));

  return (
    <Section
      title="Floor-plan position"
      description={
        floorPlan && floorPlan.totalLimitCents > 0 ? (
          <span>
            <span className="font-mono tabular-nums text-slate-300">{money(floorPlan.totalPrincipalCents)}</span> owed of{' '}
            <span className="font-mono tabular-nums">{money(floorPlan.totalLimitCents)}</span> in credit lines ·{' '}
            <span className="font-mono tabular-nums">{bpsToPct(floorPlan.utilizationBps, 1)}</span> used
            {flagged.length > 0 && (
              <span className="text-amber-300">
                {' '}
                · {flagged.length} line{flagged.length === 1 ? '' : 's'} need attention
              </span>
            )}
          </span>
        ) : (
          'What each floor-plan lender is owed against its credit line.'
        )
      }
      actions={
        <Link href={dealerLinks.floorPlan('positions')} className="text-xs font-medium text-slate-300 hover:text-white">
          Floor plan →
        </Link>
      }
    >
      {isLoading && !floorPlan ? (
        <div className="space-y-3 p-5" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-800" />
          ))}
        </div>
      ) : lines.length === 0 ? (
        <Empty
          icon={Landmark}
          title="No floor-plan lines yet"
          description="Add each lender’s credit line and its programs (free-floor days, rate, curtailments) in dealer settings, then import the lender’s flooring."
          action={
            <Link href={dealerLinks.settings('lenders')} className="btn-secondary btn-sm">
              Set up lenders
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <caption className="sr-only">Floor-plan position by line</caption>
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  ['Line', 'left'],
                  ['Owed / limit', 'right'],
                  ['Used', 'left'],
                  ['Sold, not paid', 'right'],
                  ['Accrued interest', 'right'],
                  ['Curtailments next 30 days', 'right'],
                  ['Last reconciled', 'left'],
                ].map(([h, a]) => (
                  <th
                    key={h}
                    scope="col"
                    className={clsx(
                      'whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
                      a === 'right' ? 'text-right' : 'text-left',
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {lines.map((l) => {
                const flag = lineFlag(l, warnBps);
                const href = dealerLinks.floorPlan('positions', { lineId: l.lineId });
                const recAge = daysBetween(l.lastReconciledDate, asOf);
                return (
                  <tr
                    key={l.lineId}
                    tabIndex={0}
                    onClick={() => router.push(href)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        router.push(href);
                      }
                    }}
                    className="row-clickable cursor-pointer focus:outline-none focus-visible:bg-slate-800/40"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-white">{l.lineName}</span>
                        {l.lineStatus !== 'ACTIVE' && l.lineStatus !== 'CREDIT_HOLD' && (
                          <Pill label={labelOf(LINE_STATUS, l.lineStatus)} tone={toneOf(LINE_STATUS, l.lineStatus as LineStatus)} />
                        )}
                        {flag && <Pill label={flag.label} tone={flag.tone} />}
                      </div>
                      <div className="text-xs text-slate-500">
                        {nameOf(lenders, l.lenderVendorId)} · <span className="font-mono tabular-nums">{l.openNoteCount}</span> open notes
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={l.principalCents} />
                      <div className="font-mono text-xs tabular-nums text-slate-500">of {money(l.creditLimitCents)}</div>
                    </td>
                    <td className="min-w-[140px] px-4 py-2.5">
                      <UtilizationBar bps={l.utilizationBps} warnBps={warnBps} hold={l.lineStatus === 'CREDIT_HOLD'} label={`${l.lineName} utilization`} />
                      <div className="mt-1 font-mono text-xs tabular-nums text-slate-400">{bpsToPct(l.utilizationBps, 1)}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {l.soldUnpaidCount > 0 ? (
                        <>
                          <span className="font-mono tabular-nums text-red-300">{money(l.soldUnpaidCents)}</span>
                          <div className="font-mono text-xs tabular-nums text-slate-500">{l.soldUnpaidCount} units</div>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={l.accruedInterestCents} muted />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={l.curtailmentsDue30dCents} muted />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <Link
                        href={dealerLinks.lenderStatements({ lineId: l.lineId })}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={clsx(
                          'font-mono text-body-sm tabular-nums hover:underline',
                          !l.lastReconciledDate ? 'text-amber-300' : recAge !== null && recAge > 45 ? 'text-amber-300' : 'text-slate-300',
                        )}
                      >
                        {l.lastReconciledDate ? dateLabel(l.lastReconciledDate) : 'Never signed off'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
