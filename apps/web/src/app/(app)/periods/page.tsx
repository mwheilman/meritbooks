'use client';

import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { PeriodsGrid } from './periods-grid';

export default function PeriodsPage() {
  // COMPANY-SCOPE CONTROL: periods are opened/closed per company per month.
  return (
    <div className="space-y-6">
      <PageHeader
        title="Fiscal Periods"
        description="Open, close, and generate accounting periods per company. Entries can only post into an open or soft-closed period."
      />
      <CompanyScopeGuard>
        <PeriodsGrid />
      </CompanyScopeGuard>
    </div>
  );
}
