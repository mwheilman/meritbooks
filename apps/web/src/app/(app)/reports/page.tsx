import { PageHeader } from '@/components/ui';
import { ReportViewer } from './report-viewer';

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Financial Reports"
        description="Generate statements from GL data across all entities"
      />
      <ReportViewer />
    </>
  );
}
