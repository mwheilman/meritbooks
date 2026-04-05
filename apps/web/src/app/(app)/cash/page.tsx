import { PageHeader } from '@/components/ui';
import { CashDashboard } from './cash-dashboard';

export default function CashPage() {
  return (
    <>
      <PageHeader
        title="Cash Position"
        description="Real-time cash across all entities with AI intelligence"
      />
      <CashDashboard />
    </>
  );
}
