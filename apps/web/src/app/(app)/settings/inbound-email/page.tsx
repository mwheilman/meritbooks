export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { InboundEmailSettings } from './inbound-email-settings';

export const metadata = { title: 'Email inboxes' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Settings → Email inboxes (merit-ui). PAGE-LEVEL RBAC: anyone who can view Bills can
 * see their companies' addresses and the inbound log; changing an address's rules is
 * settings_system:edit, enforced by PATCH /api/inbound-email/aliases. `?company=<id>`
 * (from the Bills card) pre-filters the log to that company.
 */
export default async function InboundEmailPage({ searchParams }: { searchParams: { company?: string } }) {
  await requirePagePermission('bills', 'view');
  const company = typeof searchParams?.company === 'string' && UUID.test(searchParams.company) ? searchParams.company : null;
  return <InboundEmailSettings initialCompany={company} />;
}
