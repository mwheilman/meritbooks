import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { SubscriptionsDashboard } from './subscriptions-dashboard';

export const metadata = {
  title: 'Subscriptions',
};

export default function SubscriptionsPage() {
  // COMPANY-SCOPE CONTROL: subscription keep/cancel actions act on one company's
  // detected spend, so processing is pinned to a single company.
  return (
    <>
      <PageHeader
        title="Subscription Catcher"
        description="MeritBooks detects recurring subscriptions from your bank feed and bills, tracks their terms and renewal dates, and flags creep — new spend, price hikes, overlapping tools, and zombie subscriptions. Keep or cancel each one; a cancel drafts the request for you to send. Nothing is cancelled automatically."
      />
      <CompanyScopeGuard>
        <SubscriptionsDashboard />
      </CompanyScopeGuard>
    </>
  );
}
