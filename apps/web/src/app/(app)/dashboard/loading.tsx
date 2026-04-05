import { MetricCardSkeleton, TableSkeleton } from '@/components/ui';

export default function DashboardLoading() {
  return (
    <div>
      <div className="mb-6">
        <div className="h-6 w-32 rounded bg-slate-800 animate-pulse mb-2" />
        <div className="h-4 w-64 rounded bg-slate-800/50 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCardSkeleton />
        <MetricCardSkeleton />
        <MetricCardSkeleton />
        <MetricCardSkeleton />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <TableSkeleton rows={8} cols={5} />
        </div>
        <div>
          <TableSkeleton rows={6} cols={2} />
        </div>
      </div>
    </div>
  );
}
