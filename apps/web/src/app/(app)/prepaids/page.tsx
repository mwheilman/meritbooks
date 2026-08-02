import { PageHeader } from '@/components/ui';
import { PrepaidsDashboard } from './prepaids-dashboard';

export const metadata = {
  title: 'Prepaid Expenses',
};

export default function PrepaidsPage() {
  return (
    <>
      <PageHeader
        title="Prepaid Expenses"
        description="Amortize prepaid costs — insurance, subscriptions, retainers — straight-line from the prepaid asset into expense, and post each month's amortization on schedule"
      />
      <PrepaidsDashboard />
    </>
  );
}
