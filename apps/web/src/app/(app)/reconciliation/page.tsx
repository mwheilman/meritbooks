import { PageHeader } from '@/components/ui';
import { ReconciliationTabs } from './reconciliation-tabs';

export default function ReconciliationPage() {
  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        description="Clear statement lines against the GL, then reconcile to the statement"
      />
      <ReconciliationTabs />
    </>
  );
}
