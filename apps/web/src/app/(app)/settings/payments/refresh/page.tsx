export const dynamic = 'force-dynamic';

import { ReopenStripe } from './reopen-stripe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stripe sends people here when an onboarding link expired: mint a fresh one for the same company. */
export default function PaymentsRefreshPage({ searchParams }: { searchParams: { company?: string } }) {
  const company = typeof searchParams?.company === 'string' && UUID.test(searchParams.company) ? searchParams.company : null;
  return <ReopenStripe company={company} />;
}
