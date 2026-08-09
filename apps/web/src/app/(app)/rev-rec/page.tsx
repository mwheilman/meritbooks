'use client';

import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { RevRecRun } from './rev-rec-run';

export default function RevRecPage() {
  // COMPANY-SCOPE CONTROL: rev-rec posts revenue into one company's books.
  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue Recognition"
        description="Preview and post period revenue recognition. Each job recognizes by its resolved method (override → job-type mapping → company default)."
      />
      <CompanyScopeGuard>
        <RevRecRun />
      </CompanyScopeGuard>
    </div>
  );
}
