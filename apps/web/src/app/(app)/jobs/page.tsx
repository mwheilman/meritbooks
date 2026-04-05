import { PageHeader } from '@/components/ui';
import { JobList } from './job-list';

export default function JobsPage() {
  return (
    <>
      <PageHeader
        title="Jobs & Projects"
        description="Budget tracking, cost analysis, and profitability across all entities"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">WIP Report</button>
            <button className="btn-primary btn-sm">New Job</button>
          </div>
        }
      />
      <JobList />
    </>
  );
}
