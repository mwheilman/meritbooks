export const dynamic = 'force-dynamic';

import { ButtonLink } from '@meritbooks/merit-ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Stripe returns people after onboarding. The status check happens on the Payments screen. */
export default function PaymentsReturnPage({ searchParams }: { searchParams: { company?: string } }) {
  const company = typeof searchParams?.company === 'string' && UUID.test(searchParams.company) ? searchParams.company : null;
  const back = company ? `/settings/payments?company=${company}` : '/settings/payments';
  return (
    <div className="surface wg-state mb-state-block" style={{ maxWidth: 560, margin: '48px auto' }} role="status">
      <span className="t-head">Stripe setup sent</span>
      <p>Stripe is reviewing the details — usually a few minutes. Card and bank payments for this company turn on once it finishes. Back on the Payments screen we&rsquo;ll check its status straight away.</p>
      <ButtonLink href={back} variant="primary">Back to payments</ButtonLink>
    </div>
  );
}
