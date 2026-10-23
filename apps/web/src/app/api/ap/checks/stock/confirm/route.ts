export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { confirmSecurityChange, isTenantAdmin } from '@/lib/ap/checks/stock-security';
import { checkErrorResponse, requireCheckMoney } from '@/lib/ap/checks/route-support';

const confirmSchema = z.object({ changeId: z.string().uuid('Choose a change to confirm') });

/**
 * POST /api/ap/checks/stock/confirm { changeId } — a SECOND tenant admin confirms a check
 * stock security change (signature / bank numbers / threshold), lifting the 24 h print hold
 * on the person who made it (security review M9). The confirmer must be an active tenant
 * admin, must not be the person who made the change (also a DB CHECK), needs release
 * authority and the bank-details session policy. Logged.
 */
export const POST = apiHandler(confirmSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'bank_details_edit' });
  if (!policy.ok) return policy.response;
  try {
    const admin = createAdminSupabase();
    const row = await confirmSecurityChange(supabase, admin, orgId, userId, body.changeId, await isTenantAdmin(admin, orgId, userId));
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.stock.security_confirm',
      subjectTable: 'check_stock_security_changes',
      subjectId: row.id,
      summary: `Confirmed check stock change: ${row.summary}`.slice(0, 300),
      metadata: { bankAccountId: row.bank_account_id, changeKind: row.change_kind, changedBy: row.changed_by },
    }).catch(() => {});
    return NextResponse.json({ ok: true, change: row });
  } catch (e) {
    return checkErrorResponse(e, 'Could not confirm the change.');
  }
});
