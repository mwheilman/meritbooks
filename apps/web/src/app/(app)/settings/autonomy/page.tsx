export const dynamic = 'force-dynamic';

import { AutonomyConsole } from './autonomy-console';
import { requirePagePermission } from '@/lib/rbac/page-guard';

/**
 * Autonomy & Kill-Switch Control Plane (M10) — the supervision screen that governs
 * every AI capability. Turning autonomous action on/off is a system-level control,
 * so the page gates on settings_system:view (fails closed; mutations gate on
 * settings_system:edit at the API).
 */
export default async function AutonomySettingsPage() {
  await requirePagePermission('settings_system', 'view');
  return <AutonomyConsole />;
}
