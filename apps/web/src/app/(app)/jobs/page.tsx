'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { JobList } from './job-list';
import { JobCreateForm } from './job-create-form';

export default function JobsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleCreated = useCallback(() => {
    setShowCreate(false);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div key={refreshKey}>
      <PageHeader
        title="Jobs & Projects"
        description="Budget tracking, cost analysis, and profitability across all entities"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/jobs/wip" className="btn-secondary btn-sm">WIP Schedule</Link>
            <Link href="/reports?report=wip" className="btn-secondary btn-sm">WIP Report</Link>
            <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>New Job</button>
          </div>
        }
      />
      <JobList />
      {showCreate && <JobCreateForm onClose={() => setShowCreate(false)} onCreated={handleCreated} />}
    </div>
  );
}
