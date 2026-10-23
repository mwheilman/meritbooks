'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { RevRecTabs } from './rev-rec-tabs';

export default function RevRecPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        eyebrow={['Revenue', 'Recognition']}
        title="Revenue recognition"
        description="Choose how each company earns revenue on its jobs, then review and approve the month-end entry that books underbillings to Unbilled AR and overbillings to Deferred revenue."
      />
      {/* useSearchParams (the ?tab= deep link) needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <RevRecTabs />
      </Suspense>
    </div>
  );
}
