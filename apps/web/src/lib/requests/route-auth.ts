/**
 * Who may see / work requests, until a dedicated `requests` permission exists
 * (FPB-request-engine-notifications §6, decision D3 — the lead owns permissions.ts):
 *
 *   view      compliance:view  OR vendors:view
 *   work      compliance:manage OR vendors:edit   (create · send now · snooze · cancel · fulfil)
 *   settings  settings_system:edit
 *
 * Each check is the standard server guard (requirePermission → org from the verified
 * claim, custom roles, v2 capability dual-run); the first that allows wins, else 403.
 */

import type { FeatureAction } from '@/lib/rbac/permissions';
import { requirePermission, type PermissionResult } from '@/lib/rbac/require-permission';

type Check = readonly [featureId: string, action: FeatureAction];

export const REQUESTS_VIEW: readonly Check[] = [
  ['compliance', 'view'],
  ['vendors', 'view'],
];
export const REQUESTS_WORK: readonly Check[] = [
  ['compliance', 'manage'],
  ['vendors', 'edit'],
];
export const REQUESTS_SETTINGS: readonly Check[] = [['settings_system', 'edit']];

export async function requireAny(userId: string, checks: readonly Check[], route: string): Promise<PermissionResult> {
  let last: PermissionResult | null = null;
  for (const [feature, action] of checks) {
    last = await requirePermission(userId, feature, action, { route });
    if (last.ok) return last;
  }
  return last as PermissionResult;
}
