'use client';

import { PageHeader } from '@/components/ui';
import { RevRecRun } from './rev-rec-run';

export default function RevRecPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue Recognition"
        description="Preview and post period revenue recognition. Each job recognizes by its resolved method (override → job-type mapping → company default)."
      />
      <RevRecRun />
    </div>
  );
}
