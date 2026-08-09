import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { ReconciliationTabs } from './reconciliation-tabs';

export default function ReconciliationPage() {
  // COMPANY-SCOPE CONTROL: reconciliation clears one company's bank account.
  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        description="Clear statement lines against the GL, then reconcile to the statement"
      />
      <CompanyScopeGuard>
        <ReconciliationTabs />
      </CompanyScopeGuard>
    </>
  );
}
