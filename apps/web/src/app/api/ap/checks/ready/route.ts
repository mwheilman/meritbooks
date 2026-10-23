export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { bankAccountQuery } from '@/lib/validations/checks';
import { loadReadyToPrint } from '@/lib/ap/checks/print-service';
import { checkErrorResponse, loadPrintSod, requireCheckView, userNames } from '@/lib/ap/checks/route-support';

/**
 * GET /api/ap/checks/ready?bank_account_id= — released check payments waiting to print on
 * this account, grouped one check per vendor, each marked printable for THIS user (SoD)
 * or blocked with the reason. checks:view (printing itself needs release authority).
 */
export const GET = apiQueryHandler(bankAccountQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const sod = await loadPrintSod(orgId);
    const ready = await loadReadyToPrint(supabase, orgId, q.bank_account_id, userId, sod);
    const names = await userNames(supabase, ready.checks.flatMap((c) => c.payments.flatMap((p) => [p.releasedBy ?? '', p.preparedBy, p.approvedBy ?? ''])));
    return NextResponse.json({ ...ready, names });
  } catch (e) {
    return checkErrorResponse(e, 'Could not load the checks ready to print.');
  }
});
