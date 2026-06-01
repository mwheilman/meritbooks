'use client';

import { PageHeader } from '@/components/ui';
import { PeriodsGrid } from './periods-grid';

export default function PeriodsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Fiscal Periods"
        description="Open, close, and generate accounting periods per company. Entries can only post into an open or soft-closed period."
      />
      <PeriodsGrid />
    </div>
  );
}
