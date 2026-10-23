export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { logHumanAction } from '@/lib/trust/action-log';
import { clearChecksSchema } from '@/lib/validations/checks';
import { matchClearedChecks } from '@/lib/ap/checks/clearing';
import { checkErrorResponse, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/clear — match outstanding checks to bank-feed lines now ("CHECK 1043"
 * for the exact amount on the same account → CLEARED). Release authority (it links bank
 * lines to payments). The nightly bank sync runs the same matcher.
 */
export const POST = apiHandler(clearChecksSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const res = await matchClearedChecks(supabase, orgId, { bankAccountId: body.bankAccountId ?? null });
    if (res.cleared > 0) {
      await logHumanAction(supabase, userId, orgId, {
        action: 'ap.checks.clear',
        subjectTable: 'ap_checks',
        summary: `Matched ${res.cleared} cleared check(s) to the bank feed${res.flagged ? ` (${res.flagged} flagged for review)` : ''}`,
        metadata: { ...res, bankAccountId: body.bankAccountId ?? null },
      }).catch(() => {});
    }
    return NextResponse.json(res);
  } catch (e) {
    return checkErrorResponse(e, 'Could not match cleared checks.');
  }
});
