import { Suspense } from 'react';
import {
  DollarSign,
  Receipt,
  FileText,
  Wallet,
  ArrowDownRight,
  ArrowUpRight,
} from 'lucide-react';
import { PageHeader, MetricCard, MetricCardSkeleton } from '@/components/ui';
import { CompanySummaryTable } from './company-summary';
import { ActivityFeed } from './activity-feed';
// import { getDashboardMetrics } from './actions';

// Demo metrics — replace with server action when Supabase is connected
const DEMO_METRICS = {
  pendingReview: 47,
  pendingReceipts: 23,
  pendingBills: 12,
  pendingJEs: 3,
  cashPositionCents: 234800000, // $2.348M
  openAPCents: 18740000, // $187.4K
  openARCents: 31200000, // $312K
};

export default function DashboardPage() {
  const m = DEMO_METRICS;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Portfolio overview across all 17 entities"
      />

      {/* KPI Row */}
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
          value={`$${(m.cashPositionCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          icon={Wallet}
          change={{
            value: '+$12.4K',
            direction: 'up',
            label: 'vs yesterday',
          }}
        />
        <MetricCard
          label="Open AP"
          value={`$${(m.openAPCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          icon={ArrowDownRight}
          change={{
            value: '14 bills',
            direction: 'flat',
          }}
        />
        <MetricCard
          label="Open AR"
          value={`$${(m.openARCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          icon={ArrowUpRight}
          change={{
            value: '8 invoices',
            direction: 'flat',
          }}
        />
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <CompanySummaryTable />
        </div>
        <div>
          <ActivityFeed />
        </div>
      </div>
    </>
  );
}
