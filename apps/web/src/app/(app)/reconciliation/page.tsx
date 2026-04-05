import { PageHeader } from '@/components/ui';
import { ReconciliationView } from './reconciliation-view';

export default function ReconciliationPage() {
  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        description="Match GL balances against bank statements"
        actions={<button className="btn-primary btn-sm">New Reconciliation</button>}
      />
      <ReconciliationView />
    </>
  );
}
