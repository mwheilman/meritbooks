export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PaymentsSettings } from './payments-settings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Settings → Payments (merit-ui). PAGE-LEVEL RBAC (identity gate #9): connecting a payment
 * processor is a system/integration setting — fails closed before any client JS ships.
 * `?company=<id>` (the return from Stripe onboarding) opens that company and re-checks it.
 */
export default async function PaymentsSettingsPage({ searchParams }: { searchParams: { company?: string } }) {
  await requirePagePermission('settings_system', 'view');
  const company = typeof searchParams?.company === 'string' && UUID.test(searchParams.company) ? searchParams.company : null;
  return <PaymentsSettings initialCompany={company} />;
}
