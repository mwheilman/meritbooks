export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { readQboConfig } from '@/lib/integrations/erp/quickbooks/config';
import {
  deleteQboConnection,
  readQboTokensForOrg,
} from '@/lib/integrations/erp/quickbooks/connection-store';
import { revokeToken } from '@/lib/integrations/erp/quickbooks/oauth';

/**
 * POST /api/integrations/erp/quickbooks/disconnect
 *
 * Revokes the grant at Intuit (revoking the refresh token ends the whole
 * authorization) and then deletes OUR copy: the Vault secret and the
 * core.erp_connections row. Revocation is best-effort — if Intuit is unreachable we
 * still delete locally (and say so), because holding a token the user asked us to
 * drop is worse than an un-revoked grant they can also remove from QuickBooks'
 * own "Apps" page. Imported data is untouched.
 *
 * GATE: settings_system:edit. Org from the verified claim. Idempotent.
 */
export async function POST() {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const guard = await requirePermission(authRes.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const admin = createAdminSupabase();

  let record;
  let tokens;
  try {
    ({ record, tokens } = await readQboTokensForOrg(admin, orgId));
  } catch {
    return NextResponse.json(
      { error: 'Could not load the QuickBooks connection.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
  if (!record) return NextResponse.json({ ok: true, disconnected: false, alreadyDisconnected: true });

  const config = readQboConfig();
  let revokedAtIntuit = false;
  if (config && tokens) revokedAtIntuit = await revokeToken(config, tokens.refreshToken);

  try {
    await deleteQboConnection(admin, record);
  } catch {
    return NextResponse.json(
      { error: 'Could not remove the QuickBooks connection. Please try again.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }

  await logHumanAction(admin, authRes.userId, orgId, {
    action: 'integration.quickbooks.disconnect',
    subjectTable: 'core.erp_connections',
    subjectId: record.id,
    summary: 'Disconnected QuickBooks Online',
    metadata: { revokedAtIntuit },
  }).catch(() => undefined);

  return NextResponse.json({
    ok: true,
    disconnected: true,
    revokedAtIntuit,
    message: revokedAtIntuit
      ? 'QuickBooks is disconnected. Anything you already imported stays in MeritBooks.'
      : 'QuickBooks is disconnected on our side. To be thorough, also remove MeritBooks from the connected apps list in QuickBooks.',
  });
}
