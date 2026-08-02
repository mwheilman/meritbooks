import { PageHeader } from '@/components/ui';
import { DriverBuilder } from './driver-builder';

export default function DriverBudgetPage() {
  return (
    <>
      <PageHeader
        title="Driver-Based Budget Builder"
        description="Build a full-year budget from driver assumptions — units × price, a cost as % of revenue, a fixed amount, or a growth curve — and save the expanded monthly lines as the plan of record."
      />
      <DriverBuilder />
    </>
  );
}
