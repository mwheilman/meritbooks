export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { micrSchema } from '@/lib/validations/checks';
import { setMicrNumbers } from '@/lib/ap/checks/stock-service';
import { supabaseCheckSecrets } from '@/lib/ap/checks/secrets';
import { checkErrorResponse, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/stock/micr — set / replace the routing + account numbers printed on
 * the MICR line. Stored in Vault; the row keeps last-4 masks; the full values are never
 * returned or logged. Release authority + the bank-details session policy.
 */
export const POST = apiHandler(micrSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'bank_details_edit' });
  if (!policy.ok) return policy.response;
  try {
    const admin = createAdminSupabase();
    const masks = await setMicrNumbers(supabase, orgId, userId, body.bankAccountId, { routing: body.routing, account: body.account }, supabaseCheckSecrets(admin));
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.stock.micr',
      subjectTable: 'check_stock_profiles',
      summary: `Set the check MICR bank numbers (routing ${masks.routingMask}, account ${masks.accountMask})`,
      metadata: { bankAccountId: body.bankAccountId, ...masks },
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...masks });
  } catch (e) {
    return checkErrorResponse(e, 'Could not save the bank numbers.');
  }
});
