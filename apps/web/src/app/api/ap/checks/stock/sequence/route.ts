export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { logHumanAction } from '@/lib/trust/action-log';
import { sequenceSchema } from '@/lib/validations/checks';
import { setNextCheckNumber } from '@/lib/ap/checks/stock-service';
import { checkErrorResponse, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/stock/sequence — move the account's next check number (a new box of
 * stock). It must stay above every number already printed; the jump is recorded as a
 * declared skip so the register's gap check stays clean. Release authority.
 */
export const POST = apiHandler(sequenceSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const res = await setNextCheckNumber(supabase, orgId, userId, body.bankAccountId, body.nextNumber, body.reason);
    if (res.status === 'applied') {
      await logHumanAction(supabase, userId, orgId, {
        action: 'ap.checks.sequence',
        subjectTable: 'bank_check_sequences',
        summary: `Next check number ${res.previous_next_number ?? '?'} → ${res.next_number}: ${body.reason}`,
        metadata: { bankAccountId: body.bankAccountId, ...res },
      }).catch(() => {});
    }
    return NextResponse.json(res);
  } catch (e) {
    return checkErrorResponse(e, 'Could not change the next check number.');
  }
});
