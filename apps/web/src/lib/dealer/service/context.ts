/**
 * The per-request dealer context: who, which tenant, which client, and the two
 * clients a dealer operation needs.
 *
 *  - `db`    the caller's RLS client — every READ goes through it, so tenant + client
 *            scope (mig 163) are enforced by the database.
 *  - `admin` the service-role client — the ONLY way to write dealer tables (mig 169
 *            revokes member writes). It is handed out only after requirePermission
 *            passed AND the caller proved (through RLS) that it can see the client.
 *            Every admin query in lib/dealer pins org_id (and location_id) explicitly.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { FeatureAction } from '@/lib/rbac/permissions';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { DealerError, dealerErrorResponse } from './errors';

export interface DealerCtx {
  userId: string;
  orgId: string;
  locationId: string;
  db: SupabaseClient;
  admin: SupabaseClient;
}

/** A permission the route requires: an existing (feature, action) cell. */
export interface DealerPermission {
  feature: string;
  action: FeatureAction;
}

/**
 * Closest existing permission cells (lib/rbac/permissions.ts is reserved spine). The
 * dedicated `dealer.*` capabilities the FPB §9.1 wants are listed in
 * docs/dealer-pack-api.md for the lead to register; swapping them in is a one-line
 * change here.
 */
export const DEALER_PERMS = {
  view: { feature: 'journal_entries', action: 'view' },
  edit: { feature: 'journal_entries', action: 'create' },
  post: { feature: 'journal_entries', action: 'post' },
  approveReceivable: { feature: 'invoices', action: 'approve' },
  approveUnit: { feature: 'close_mgmt', action: 'manage' },
  reconcile: { feature: 'reconciliation', action: 'reconcile' },
  release: { feature: 'payments_execute', action: 'run' },
  settings: { feature: 'settings_acct', action: 'edit' },
  imports: { feature: 'import', action: 'run' },
} as const satisfies Record<string, DealerPermission>;

/** Authorize + scope one dealer request. Returns a 4xx response instead of throwing. */
export async function openDealerContext(
  api: ApiContext,
  locationId: string,
  perm: DealerPermission,
  route?: string,
): Promise<DealerCtx | NextResponse> {
  if (!api.orgId) return dealerErrorResponse(new DealerError('NO_ORG', 'No organization is active for this session'));
  const guard = await requirePermission(api.userId, perm.feature, perm.action, { locationId, route });
  if (!guard.ok) return guard.response;
  if (guard.orgId !== api.orgId) return dealerErrorResponse(new DealerError('FORBIDDEN', 'Organization mismatch'));

  // Prove the caller can see this client THROUGH RLS (org + client scope, mig 163).
  const { data: loc, error } = await api.supabase
    .schema('core')
    .from('locations')
    .select('id')
    .eq('id', locationId)
    .maybeSingle();
  if (error) return dealerErrorResponse(new DealerError('DB_ERROR', `Client lookup failed: ${error.message}`));
  if (!loc) return dealerErrorResponse(new DealerError('NOT_FOUND', 'Client not found'));

  return { userId: api.userId, orgId: api.orgId, locationId, db: api.supabase, admin: createAdminSupabase() };
}

/** A second permission check inside an already-open context (e.g. action-specific). */
export async function requireAlso(d: DealerCtx, perm: DealerPermission, route?: string): Promise<void> {
  const guard = await requirePermission(d.userId, perm.feature, perm.action, { locationId: d.locationId, route });
  if (!guard.ok) throw new DealerError('FORBIDDEN', `This action needs the ${perm.feature}:${perm.action} permission`);
}
