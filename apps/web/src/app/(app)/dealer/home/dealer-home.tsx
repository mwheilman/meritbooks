'use client';

/**
 * Dealer home (FPB §7 widgets). Order: sold-out-of-trust first (red), then the
 * money-at-risk tiles, floor-plan position by line, units by age, manufacturer
 * receivables, and the subledger-to-GL tie-out. Every number drills.
 *
 * Data: GET /api/dealer/summary + GET /api/dealer/sot (both accept `asOf`).
 */

import { useState } from 'react';
import Link from 'next/link';
import { CalendarClock, ClipboardCheck, FileUp, Loader2, Percent, Settings2, Timer, Warehouse, Landmark } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { addToast } from '@/hooks/use-toast';
import type { SotFinding } from '@/lib/dealer/engine/sot';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import { bpsToPct, dateLabel, money, moneyCompact, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { useDealerPack } from '../_components/dealer-shell';
import { DateInput } from '../_components/forms';
import { ErrorPanel, Section, StatTile } from '../_components/ui';
import { dealerSend, useDealerQuery } from '../_lib/use-dealer';
import { SotPanel } from './sot-panel';
import { FloorPlanPanel } from './floor-plan-panel';
import { InventoryPanel } from './inventory-panel';
import { ReceivablesPanel, TieoutPanel } from './receivables-panel';

interface ScanResult {
  queued: number;
  byDetector: Record<string, number>;
}

function GettingStarted({ enabled }: { enabled: boolean }) {
  const steps: Array<{ title: string; body: string; href: string; cta: string; icon: typeof Settings2 }> = [
    {
      title: 'Choose accounts and departments',
      body: 'Tell the pack which of this client’s accounts are floor plan payable, unit inventory, warranty receivable and so on, and which departments are new, used, parts and service.',
      href: dealerLinks.settings('accounts'),
      cta: 'Open settings',
      icon: Settings2,
    },
    {
      title: 'Add the floor-plan lenders',
      body: 'Each lender’s credit line and programs: free-floor days, rate, curtailment schedule and payoff terms.',
      href: dealerLinks.settings('lenders'),
      cta: 'Set up lenders',
      icon: Landmark,
    },
    {
      title: 'Import units and opening balances',
      body: 'Load the dealer system’s unit list and the lender’s open notes; the opening balances must tie to the migrated trial balance.',
      href: dealerLinks.imports(),
      cta: 'Go to imports',
      icon: FileUp,
    },
  ];
  return (
    <Section
      title={enabled ? 'Nothing on the books yet' : 'Set up the dealer pack'}
      description="Once units and floor-plan notes are loaded, this page shows what the lender is owed, what’s aging and what manufacturers owe you."
    >
      <ol className="grid divide-y divide-slate-800 md:grid-cols-3 md:divide-x md:divide-y-0">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col p-5">
            <div className="mb-2 flex items-center gap-2 text-caption uppercase tracking-caps text-slate-500">
              <span className="font-mono tabular-nums">{i + 1}</span>
              <s.icon size={14} />
            </div>
            <h3 className="mb-1 text-sm font-medium text-white">{s.title}</h3>
            <p className="mb-4 flex-1 text-body-sm text-slate-400">{s.body}</p>
            <Link href={s.href} className="btn-secondary btn-sm self-start">
              {s.cta}
            </Link>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function DealerHome() {
  const pack = useDealerPack();
  const today = todayLocal();
  const [asOf, setAsOf] = useState(today);
  const validAsOf = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : today;
  const summary = useDealerQuery<DealerSummary>('/api/dealer/summary', { asOf: validAsOf });
  const sot = useDealerQuery<SotFinding[]>('/api/dealer/sot', { asOf: validAsOf });
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);

  const s = summary.data;
  const warnBps = pack.settings?.line_utilization_warn_bps ?? 9000;
  const nothingYet = !!s && s.floorPlan.lines.length === 0 && s.units.inStockCount === 0 && s.sot.count === 0;

  async function runChecks() {
    if (!pack.locationId) return;
    setScanning(true);
    const res = await dealerSend<ScanResult>('post', '/api/dealer/controls/scan', pack.locationId, {});
    setScanning(false);
    if (res.status === 404) {
      addToast('info', 'Checks will run nightly — on-demand checks aren’t available yet.');
      return;
    }
    if (res.error) {
      const x = explainDealerError(res.error);
      addToast('error', `${x.title}. ${x.message}`);
      return;
    }
    if (res.data) {
      setScan(res.data);
      addToast('success', res.data.queued > 0 ? `Checks done — ${res.data.queued} item${res.data.queued === 1 ? '' : 's'} sent to Exceptions.` : 'Checks done — nothing new found.');
    }
    void summary.refetch();
    void sot.refetch();
  }

  const refetchAll = () => {
    void summary.refetch();
    void sot.refetch();
  };

  return (
    <div>
      <PageHeader
        title="Dealer home"
        description={`${pack.clientName ?? 'This client'} · as of ${dateLabel(validAsOf)}`}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="dealer-asof" className="sr-only">
              As of date
            </label>
            <div className="w-40">
              <DateInput id="dealer-asof" value={asOf} max={today} onChange={(v) => setAsOf(v || today)} />
            </div>
            <button type="button" onClick={() => void runChecks()} disabled={scanning || !pack.locationId} className="btn-primary btn-sm inline-flex items-center gap-1.5">
              {scanning ? <Loader2 size={13} className="animate-spin" /> : <ClipboardCheck size={13} />}
              Run checks now
            </button>
          </div>
        }
      />

      {scan && (
        <p className="mb-4 text-xs text-slate-400" role="status">
          Last check found <span className="font-mono tabular-nums text-slate-200">{scan.queued}</span> item{scan.queued === 1 ? '' : 's'}.{' '}
          <Link href={dealerLinks.exceptions()} className="font-medium text-slate-200 hover:text-white">
            Review in Exceptions →
          </Link>
        </p>
      )}

      <SotPanel
        sot={s?.sot ?? null}
        findings={sot.data}
        isLoading={sot.isLoading || summary.isLoading}
        error={sot.error}
        onRetry={() => void sot.refetch()}
        asOf={validAsOf}
      />

      {summary.error ? (
        <div className="card mb-6">
          <ErrorPanel error={summary.error} onRetry={refetchAll} />
        </div>
      ) : nothingYet ? (
        <GettingStarted enabled={pack.enabled} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatTile
              label="Owed to lenders"
              icon={Landmark}
              loading={!s}
              href={dealerLinks.floorPlan('positions')}
              value={moneyCompact(s?.floorPlan.totalPrincipalCents ?? 0)}
              sub={s ? `${bpsToPct(s.floorPlan.utilizationBps, 1)} of ${moneyCompact(s.floorPlan.totalLimitCents)} in lines` : undefined}
              tone={s && s.floorPlan.utilizationBps !== null && s.floorPlan.utilizationBps >= warnBps ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Interest this month"
              icon={Percent}
              loading={!s}
              href={dealerLinks.floorPlan('interest')}
              value={moneyCompact(s?.interestMtdCents ?? 0)}
              sub="Accrued plus lender true-ups"
            />
            <StatTile
              label="Curtailments, next 14 days"
              icon={CalendarClock}
              loading={!s}
              href={dealerLinks.floorPlan('curtailments')}
              value={s?.curtailmentsDue14d.count ?? 0}
              tone={(s?.curtailmentsDue14d.missedCount ?? 0) > 0 ? 'warning' : 'neutral'}
              sub={
                s
                  ? `${money(s.curtailmentsDue14d.cents)}${s.curtailmentsDue14d.missedCount > 0 ? ` · ${s.curtailmentsDue14d.missedCount} missed` : ''}`
                  : undefined
              }
            />
            <StatTile
              label="Units over 365 days"
              icon={Warehouse}
              loading={!s}
              href={dealerLinks.units({ status: 'IN_STOCK', minAge: 366 })}
              value={s?.units.over365Count ?? 0}
              tone={(s?.units.over365Count ?? 0) > 0 ? 'warning' : 'neutral'}
              sub="Aged inventory to act on"
            />
            <StatTile
              label="Near end of floor-plan term"
              icon={Timer}
              loading={!s}
              href={dealerLinks.floorPlan('notes', { sort: 'maturity_date', dir: 'asc' })}
              value={s?.units.withinTermWarning ?? 0}
              tone={(s?.units.withinTermWarning ?? 0) > 0 ? 'warning' : 'neutral'}
              sub={`Within ${pack.settings?.term_warning_days ?? 60} days of the lender’s term`}
            />
          </div>

          <FloorPlanPanel floorPlan={s?.floorPlan ?? null} warnBps={warnBps} asOf={validAsOf} isLoading={summary.isLoading} />
          <InventoryPanel units={s?.units ?? null} isLoading={summary.isLoading} />
          {s && <ReceivablesPanel summary={s} />}
          {s && <TieoutPanel tieout={s.tieout} />}
        </>
      )}
    </div>
  );
}
