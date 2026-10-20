'use client';

/**
 * Manufacturer receivables (warranty + incentives aging, FPB §7) and the
 * subledger-to-GL tie-out (AC12 / DL-3). Every figure drills to its list.
 */

import Link from 'next/link';
import { clsx } from 'clsx';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { AgeBucket, TieoutRow } from '@/lib/dealer/engine/summary';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import { ROLE_SPEC, type DealerRole } from '@/lib/dealer/roles';
import { humanize } from '@/lib/dealer/ui/labels';
import { money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { Money, Section } from '../_components/ui';
import { ShareBar } from './bars';

const BUCKET_LABEL: Record<string, string> = {
  FLOOR_PLAN_PAYABLE: 'Floor plan payable',
  FLOOR_PLAN_INTEREST_ACCRUED: 'Accrued floor-plan interest',
  UNIT_INVENTORY: 'Unit inventory',
  WARRANTY_RECEIVABLE: 'Warranty receivable',
  OEM_INCENTIVE_RECEIVABLE: 'Manufacturer incentives receivable',
  TRADE_LIEN_PAYOFF: 'Trade-in liens owed',
};

function bucketName(bucket: string): string {
  return BUCKET_LABEL[bucket] ?? ROLE_SPEC[bucket as DealerRole]?.label ?? humanize(bucket);
}

function AgingBlock({
  title,
  openCents,
  byAge,
  over60Cents,
  href,
  over60Href,
  emptyText,
}: {
  title: string;
  openCents: number;
  byAge: AgeBucket[];
  over60Cents: number;
  href: string;
  over60Href: string;
  emptyText: string;
}) {
  const max = Math.max(0, ...byAge.map((b) => b.cents));
  return (
    <div className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <Link href={href} className="text-caption uppercase tracking-caps text-slate-500 hover:text-slate-300">
            {title} →
          </Link>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{money(openCents)}</div>
        </div>
        <Link
          href={over60Href}
          className={clsx(
            'rounded-lg border px-3 py-1.5 text-right text-xs hover:border-slate-600',
            over60Cents > 0 ? 'border-amber-500/30 text-amber-200' : 'border-slate-800 text-slate-400',
          )}
        >
          <div className="text-2xs uppercase tracking-caps text-slate-500">Over 60 days</div>
          <div className="font-mono tabular-nums">{money(over60Cents)}</div>
        </Link>
      </div>
      {openCents === 0 ? (
        <p className="text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {byAge.map((b) => (
            <li key={b.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-body-sm">
              <span className="text-slate-400">{b.maxDays === null ? `${b.minDays}+ days` : `${b.minDays}–${b.maxDays} days`}</span>
              <ShareBar value={b.cents} max={max} tone={b.minDays > 60 && b.cents > 0 ? 'warning' : 'neutral'} />
              <span className="font-mono tabular-nums text-slate-300">
                {money(b.cents)} <span className="text-slate-500">· {b.count}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReceivablesPanel({ summary }: { summary: DealerSummary }) {
  return (
    <Section title="Owed by manufacturers" description="Warranty claims and incentives the manufacturer still owes, by days since they were submitted (or earned).">
      <div className="grid divide-y divide-slate-800 md:grid-cols-2 md:divide-x md:divide-y-0">
        <AgingBlock
          title="Warranty receivable"
          openCents={summary.warranty.openCents}
          byAge={summary.warranty.byAge}
          over60Cents={summary.warranty.over60Cents}
          href={dealerLinks.warranty()}
          over60Href={dealerLinks.warranty({ aging: 'over60' })}
          emptyText="No submitted warranty claims are waiting on the manufacturer."
        />
        <AgingBlock
          title="Incentives receivable"
          openCents={summary.incentives.openCents}
          byAge={summary.incentives.byAge}
          over60Cents={summary.incentives.over60Cents}
          href={dealerLinks.incentives()}
          over60Href={dealerLinks.incentives({ aging: 'over60' })}
          emptyText="No earned incentives are waiting on the manufacturer."
        />
      </div>
    </Section>
  );
}

export function TieoutPanel({ tieout }: { tieout: DealerSummary['tieout'] }) {
  const rows: TieoutRow[] = tieout.rows;
  const off = rows.filter((r) => !r.account_id || Number(r.difference_cents) !== 0);
  return (
    <Section
      title="Dealer subledgers tie to the GL"
      description="Each dealer subledger total compared with its general-ledger account, to the cent."
      actions={
        <Link href={dealerLinks.reports('dealer_fp_position')} className="text-xs font-medium text-slate-300 hover:text-white">
          Tie-out report →
        </Link>
      }
    >
      <div className={clsx('flex items-start gap-3 px-5 py-4 text-sm', tieout.ok ? 'text-slate-300' : 'text-amber-100')}>
        {tieout.ok ? (
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-slate-400" />
        ) : (
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
        )}
        <p>
          {tieout.ok
            ? rows.length === 0
              ? 'Nothing to tie out yet — there are no dealer balances on the books.'
              : 'Every dealer subledger matches the general ledger.'
            : `${off.length} subledger${off.length === 1 ? ' does' : 's do'} not match the general ledger. Fix these before closing the month.`}
        </p>
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto border-t border-slate-800">
          <table className="w-full text-body">
            <caption className="sr-only">Subledger to GL tie-out</caption>
            <thead>
              <tr className="border-b border-slate-800">
                {['Balance', 'Dealer subledger', 'General ledger', 'Difference'].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={clsx(
                      'whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
                      i === 0 ? 'text-left' : 'text-right',
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {rows.map((r) => {
                const diff = Number(r.difference_cents);
                return (
                  <tr key={r.bucket} className="table-row-hover">
                    <td className="px-4 py-2.5 text-slate-200">
                      {bucketName(r.bucket)}
                      {!r.account_id && <span className="ml-2 text-xs text-amber-300">No account chosen</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Money cents={Number(r.subledger_cents)} muted />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Money cents={Number(r.gl_cents)} muted />
                    </td>
                    <td className={clsx('px-4 py-2.5 text-right font-mono tabular-nums', diff === 0 ? 'text-slate-500' : 'text-amber-300')}>
                      {diff === 0 ? '—' : money(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {off.some((r) => !r.account_id) && (
            <p className="border-t border-slate-800 px-4 py-2.5 text-xs text-slate-400">
              <Link href={dealerLinks.settings('accounts')} className="text-slate-200 hover:text-white">
                Choose the missing accounts in dealer settings →
              </Link>
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
