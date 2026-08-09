export const dynamic = "force-dynamic";
import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { CompanyBoardGrid } from './company-board';
import { ActivityFeed } from './activity-feed';

function BoardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="card h-20 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-56 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your cross-company work and status board. Consolidated totals up top, then a card per company — select one to pin it and start working."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<BoardSkeleton />}>
            <CompanyBoardGrid />
          </Suspense>
        </div>
        <div>
          <Suspense fallback={<div className="card h-64 animate-pulse" />}>
            <ActivityFeed />
          </Suspense>
        </div>
      </div>
    </>
  );
}
