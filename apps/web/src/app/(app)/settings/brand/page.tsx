export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { BrandSettings } from './brand-settings';

/**
 * Settings → Brand (FPB-branding §5, merit-ui). PAGE-LEVEL RBAC: the brand prints on every
 * customer-facing document — a system setting (settings_system), checked before any client
 * JS ships. `?company=<id>` opens that company's brand.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BrandSettingsPage({ searchParams }: { searchParams: { company?: string } }) {
  await requirePagePermission('settings_system', 'view');
  const company = typeof searchParams?.company === 'string' && UUID.test(searchParams.company) ? searchParams.company : null;
  return <BrandSettings initialCompany={company} />;
}
