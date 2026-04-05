export const dynamic = "force-dynamic";
import { Suspense } from 'react';
import {
  Receipt,
  Wallet,
  ArrowDownRight,
  ArrowUpRight,
} from 'lucide-react';
import { PageHeader, MetricCard, MetricCardSkeleton } from '@/components/ui';
import { CompanySummaryTable } from './company-summary';
import { ActivityFeed } from './activity-feed';
import { getDashboardMetrics, getRecentActivity } from './actions';
import { formatMoney } from '@meritbooks/shared';

async function DashboardMetrics() {
  const m = await getDashboardMetrics();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <MetricCard
        label="Pending Review"
        value={m.pendingReview.toLocaleString()}
        icon={Receipt}
        change={{
          value: `${m.pendingReceipts} receipts · ${m.pendingBills} bills`,
          direction: m.pendingReview > 30 ? 'up' : 'flat',
        }}
      />
      <MetricCard
        label="Cash Position"
        value={formatMoney(m.cashPositionCents, { compact: true })}
        icon={Wallet}
        change={{
          value: 'All entities',
          direction: 'flat',
        }}
      />
      <MetricCard
        label="Open AP"
        value={formatMoney(m.openAPCents, { compact: true })}
        icon={ArrowDownRight}
        change={{
          value: 'Unpaid bills',
          direction: 'flat',
        }}
      />
      <MetricCard
        label="Open AR"
        value={formatMoney(m.openARCents, { compact: true })}
        icon={ArrowUpRight}
        change={{
          value: 'Outstanding invoices',
          direction: 'flat',
        }}
      />
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <MetricCardSkeleton key={i} />
      ))}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Portfolio overview across all entities"
      />

      <Suspense fallback={<MetricsSkeleton />}>
        <DashboardMetrics />
      </Suspense>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Suspense fallback={<div className="card p-8 animate-pulse h-64" />}>
            <CompanySummaryTable />
          </Suspense>
        </div>
        <div>
          <Suspense fallback={<div className="card p-8 animate-pulse h-64" />}>
            <ActivityFeed />
          </Suspense>
        </div>
      </div>
    </>
  );
}
