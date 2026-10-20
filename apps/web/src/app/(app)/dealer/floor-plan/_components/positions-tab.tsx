'use client';

/**
 * Positions: one row per floor-plan line from the dealer summary (principal vs limit
 * with the DL-10 utilization bar, open notes, sold-unpaid exposure, accrued interest,
 * curtailments due in 30 days, next maturity, last signed-off reconciliation).
 */

import Link from 'next/link';
import { AlertOctagon, Banknote, CalendarClock, Landmark, Percent } from 'lucide-react';
import type { DealerSummary, LinePosition } from '@/lib/dealer/service/insights';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { LINE_STATUS, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, money, moneyCompact, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, type DealerColumn } from '../../_components/dealer-table';
import { ErrorPanel, Money, Notice, Pill, Section, StatTile } from '../../_components/ui';
import { DueDate, UtilizationBar } from './bits';
import type { GoTab } from './workspace';

type Row = LinePosition & { id: string };

export function PositionsTab({
  summary,
  isLoading,
  error,
  onRetry,
  go,
}: {
  summary: DealerSummary | null;
  isLoading: boolean;
  error: DealerApiError | null;
  onRetry: () => void;
  go: GoTab;
}) {
  const { settings } = useDealerPack();
  const warnBps = settings?.line_utilization_warn_bps ?? 9000;
  const lines = summary?.floorPlan.lines ?? [];
  const lenders = useNames('vendors', lines.map((l) => l.lenderVendorId));
  const today = todayLocal();
  const rows: Row[] = lines.map((l) => ({ ...l, id: l.lineId }));
  const holds = lines.filter((l) => l.lineStatus === 'CREDIT_HOLD');
  const hot = lines.filter((l) => l.lineStatus !== 'CREDIT_HOLD' && l.utilizationBps !== null && l.utilizationBps >= warnBps);

  if (error) {
    return (
      <div className="card">
        <ErrorPanel error={error} onRetry={onRetry} />
      </div>
    );
  }

  const fp = summary?.floorPlan;
  const soldUnpaidCents = lines.reduce((s, l) => s + l.soldUnpaidCents, 0);
  const soldUnpaidCount = lines.reduce((s, l) => s + l.soldUnpaidCount, 0);
  const curt30 = lines.reduce((s, l) => s + l.curtailmentsDue30dCents, 0);

  const columns: DealerColumn<Row>[] = [
    {
      key: 'line',
      header: 'Line',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-white">{r.lineName}</div>
          <div className="truncate text-xs text-slate-400">{nameOf(lenders, r.lenderVendorId)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill label={labelOf(LINE_STATUS, r.lineStatus)} tone={toneOf(LINE_STATUS, r.lineStatus)} title={hintOf(LINE_STATUS, r.lineStatus)} />,
    },
    {
      key: 'principal',
      header: 'Principal / limit',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-3">
          <div className="text-right">
            <Money cents={r.principalCents} />
            <div className="font-mono text-2xs tabular-nums text-slate-500">of {money(r.creditLimitCents)}</div>
          </div>
          <UtilizationBar bps={r.utilizationBps} warnBps={warnBps} status={r.lineStatus} label={`${r.lineName} utilization`} />
        </div>
      ),
    },
    {
      key: 'notes',
      header: 'Open notes',
      align: 'right',
      render: (r) => (
        <Link
          href={dealerLinks.floorPlan('notes', { lineId: r.lineId, status: 'OPEN,SOLD_UNPAID,IN_DEFAULT' })}
          onClick={(e) => e.stopPropagation()}
          className="font-mono tabular-nums text-slate-200 hover:text-emerald-400"
        >
          {r.openNoteCount.toLocaleString()}
        </Link>
      ),
    },
    {
      key: 'sau',
      header: 'Sold, not paid off',
      align: 'right',
      render: (r) =>
        r.soldUnpaidCount > 0 ? (
          <Link
            href={dealerLinks.floorPlan('notes', { lineId: r.lineId, status: 'SOLD_UNPAID' })}
            onClick={(e) => e.stopPropagation()}
            className="text-right hover:underline"
          >
            <span className="font-mono tabular-nums text-red-300">{money(r.soldUnpaidCents)}</span>
            <span className="block text-2xs text-red-400/80">
              {r.soldUnpaidCount} unit{r.soldUnpaidCount === 1 ? '' : 's'}
            </span>
          </Link>
        ) : (
          <span className="text-slate-500">—</span>
        ),
    },
    { key: 'interest', header: 'Accrued interest', align: 'right', render: (r) => <Money cents={r.accruedInterestCents} muted={r.accruedInterestCents === 0} /> },
    {
      key: 'curt',
      header: 'Curtailments 30d',
      align: 'right',
      render: (r) => (r.curtailmentsDue30dCents > 0 ? <span className="font-mono tabular-nums text-amber-300">{money(r.curtailmentsDue30dCents)}</span> : <span className="text-slate-500">—</span>),
    },
    {
      key: 'maturity',
      header: 'Next maturity',
      render: (r) => <DueDate date={r.nextMaturityDate} today={today} warnDays={settings?.term_warning_days ?? 60} />,
    },
    {
      key: 'rec',
      header: 'Last signed-off rec',
      render: (r) => (
        <Link href={dealerLinks.lenderStatements({ lineId: r.lineId })} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-xs hover:text-emerald-400">
          {r.lastReconciledDate ? <span className="font-mono tabular-nums text-slate-300">{dateLabel(r.lastReconciledDate)}</span> : <span className="text-amber-400">Never — reconcile</span>}
        </Link>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Floor-plan principal"
          hero
          loading={isLoading && !summary}
          value={moneyCompact(fp?.totalPrincipalCents ?? 0)}
          sub={fp ? `${fp.utilizationBps === null ? 'No limits set' : `${bpsToPct(fp.utilizationBps, 1)} of ${moneyCompact(fp.totalLimitCents)}`}` : '—'}
          href={dealerLinks.floorPlan('notes', { status: 'OPEN,SOLD_UNPAID,IN_DEFAULT' })}
          icon={Landmark}
        />
        <StatTile
          label="Sold out of trust"
          tone={(summary?.sot.count ?? 0) > 0 ? 'danger' : 'neutral'}
          loading={isLoading && !summary}
          value={summary ? summary.sot.count.toLocaleString() : '—'}
          sub={summary && summary.sot.count > 0 ? `${money(summary.sot.principalCents)} · ${summary.sot.criticalCount} critical` : 'Nothing past its payoff date'}
          href={dealerLinks.floorPlan('sot')}
          icon={AlertOctagon}
        />
        <StatTile
          label="Sold, payoff owed"
          tone={soldUnpaidCount > 0 ? 'warning' : 'neutral'}
          loading={isLoading && !summary}
          value={moneyCompact(soldUnpaidCents)}
          sub={`${soldUnpaidCount} unit${soldUnpaidCount === 1 ? '' : 's'} · propose payoffs`}
          href={dealerLinks.floorPlan('payoffs')}
          icon={Banknote}
        />
        <StatTile
          label="Curtailments next 14 days"
          tone={(summary?.curtailmentsDue14d.missedCount ?? 0) > 0 ? 'danger' : (summary?.curtailmentsDue14d.count ?? 0) > 0 ? 'warning' : 'neutral'}
          loading={isLoading && !summary}
          value={moneyCompact(summary?.curtailmentsDue14d.cents ?? 0)}
          sub={
            summary
              ? `${summary.curtailmentsDue14d.count} due${summary.curtailmentsDue14d.missedCount ? ` · ${summary.curtailmentsDue14d.missedCount} missed` : ''} · ${money(curt30)} in 30 days`
              : '—'
          }
          href={dealerLinks.floorPlan('curtailments')}
          icon={CalendarClock}
        />
      </div>

      {holds.length > 0 && (
        <Notice tone="danger">
          <span className="font-medium">Credit hold:</span> {holds.map((h) => h.lineName).join(', ')} — the lender isn’t releasing new orders until the account is current. Clear
          sold-unpaid payoffs and missed curtailments first.
        </Notice>
      )}
      {hot.length > 0 && (
        <Notice tone="warning">
          {hot.map((h) => `${h.lineName} is at ${bpsToPct(h.utilizationBps, 1)} of its limit`).join('; ')} (warning at {bpsToPct(warnBps, 0)}).
        </Notice>
      )}

      <Section
        title="Lines"
        description={
          <>
            Interest month to date <span className="font-mono tabular-nums text-slate-300">{money(summary?.interestMtdCents ?? 0)}</span>. Click a line to see its notes.
          </>
        }
        actions={
          <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => go('interest')}>
            <Percent size={13} /> Month-end interest
          </button>
        }
      >
        <DealerTable<Row>
          caption="Floor-plan lines"
          columns={columns}
          rows={rows}
          isLoading={isLoading}
          onRowClick={(r) => go('notes', { lineId: r.lineId })}
          rowClassName={(r) => (r.lineStatus === 'CREDIT_HOLD' ? 'bg-red-500/[0.04]' : undefined)}
          empty={{
            icon: Landmark,
            title: 'No floor-plan lines yet',
            description: 'Add each lender line (credit limit, payment days, sold-and-unpaid codes) and its programs before flooring units.',
            action: (
              <button type="button" className="btn-primary btn-sm" onClick={() => go('setup')}>
                Set up a lender line
              </button>
            ),
          }}
        />
      </Section>
    </div>
  );
}
