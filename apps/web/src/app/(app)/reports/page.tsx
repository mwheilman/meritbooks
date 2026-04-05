import { PageHeader } from '@/components/ui';
import { ReportViewer } from './report-viewer';

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Financial Reports"
        description="Generate statements from GL data across all entities"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm">Schedule</button>
            <button className="btn-secondary btn-sm">Export</button>
          </div>
        }
      />
      <ReportViewer />
    </>
  );
}
