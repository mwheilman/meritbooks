'use client';

import { PageHeader } from '@/components/ui';
import { RevRecTabs } from './rev-rec-tabs';

export default function RevRecPage() {
  // Run tab posts into ONE company's books (scope-guarded inside the tabs);
  // Reports tab is read-only and allows the consolidated view.
  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue Recognition"
        description="Preview and post period revenue recognition, then report on deferred-revenue rollforward, per-contract recognition waterfall, and revenue recognized by method."
      />
      <RevRecTabs />
    </div>
  );
}
