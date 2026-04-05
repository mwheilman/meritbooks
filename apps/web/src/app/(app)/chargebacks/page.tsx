import { PageHeader } from '@/components/ui';
import { ChargebackDashboard } from './chargeback-dashboard';

export default function ChargebacksPage() {
  return (
    <>
      <PageHeader
        title="Chargeback Billing"
        description="Overhead allocation and intercompany billing across 17 entities"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">OH Rate History</button>
            <button className="btn-primary btn-sm">Generate Invoices</button>
          </div>
        }
      />
      <ChargebackDashboard />
    </>
  );
}
