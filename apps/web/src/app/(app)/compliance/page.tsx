import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ComplianceControlsTabs } from './compliance-controls-tabs';

export const dynamic = 'force-dynamic';

/**
 * Compliance & Controls (merged shell).
 *
 * PAGE-LEVEL RBAC (identity gate #9): gated on the `compliance:view` permission — the
 * same authority that governs both the regulatory-filings tracker and the SOX controls
 * command center (held by controller / CFO / company-admin). Fails closed; the
 * underlying /api/compliance and /api/controls/compliance routes re-check it.
 *
 * The tabs shell reads `?tab=` (the /controls route redirects here with ?tab=controls),
 * so it must render inside a Suspense boundary in Next 14.
 */
export default async function CompliancePage() {
  await requirePagePermission('compliance', 'view');
  return (
    <Suspense fallback={null}>
      <ComplianceControlsTabs />
    </Suspense>
  );
}
