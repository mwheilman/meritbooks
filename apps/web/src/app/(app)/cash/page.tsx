import { PageHeader } from '@/components/ui';
import { CashDashboard } from './cash-dashboard';
import { CashForecast } from './cash-forecast';

export default function CashPage() {
  return (
    <>
      <PageHeader
        title="Cash Position"
        description="Real-time cash across all entities with AI intelligence"
      />
      <CashDashboard />
      <div className="mt-8">
        <CashForecast />
      </div>
    </>
  );
}
