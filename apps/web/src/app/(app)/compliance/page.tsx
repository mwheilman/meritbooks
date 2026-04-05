import { PageHeader } from '@/components/ui';
import { ComplianceGrid } from './compliance-grid';

export default function CompliancePage() {
  return (
    <>
      <PageHeader
        title="Regulatory Compliance"
        description="Entity-by-obligation filing tracker across all 17 companies"
      />
      <ComplianceGrid />
    </>
  );
}
