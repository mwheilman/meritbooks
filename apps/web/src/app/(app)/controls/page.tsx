import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ControlsClient } from './controls-client';

export const dynamic = 'force-dynamic';

/**
 * Controls / SOX Compliance Command Center (read-only).
 *
 * PAGE-LEVEL RBAC (identity gate #9): gated on the existing `compliance:view`
 * permission — the same authority that governs the Compliance area. Held by
 * controller / CFO / company-admin; narrow and entry roles are redirected. Fails
 * closed. The /api/controls/compliance route re-checks the same permission.
 */
export default async function ControlsPage() {
  await requirePagePermission('compliance', 'view');
  return <ControlsClient />;
}
