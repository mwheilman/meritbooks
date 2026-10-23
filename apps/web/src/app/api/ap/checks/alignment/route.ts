export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { alignmentSchema } from '@/lib/validations/checks';
import { loadBankAccount, loadProfile, checkWriter } from '@/lib/ap/checks/db';
import { checkErrorResponse, pdfAccountLabel, pdfResponse, renderAlignment, requireCheckView } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/alignment — a plain-paper alignment test sheet for the account's
 * layout and printer nudge (or the unsaved values being tried). Uses no check number and
 * carries no bank numbers. checks:view. The test print is logged as an ALIGNMENT run.
 */
export const POST = apiHandler(alignmentSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const ba = await loadBankAccount(supabase, orgId, body.bankAccountId);
    const profile = await loadProfile(supabase, orgId, body.bankAccountId);
    const layout = body.layout ?? profile?.layout ?? 'VOUCHER_TOP';
    const x = body.offsetXPt ?? Number(profile?.offset_x_pt ?? 0);
    const y = body.offsetYPt ?? Number(profile?.offset_y_pt ?? 0);
    const pdf = await renderAlignment(layout, x, y, pdfAccountLabel(ba.account_name, ba.account_mask));
    const writer = await checkWriter(supabase, orgId, ba.location_id);
    await writer.from('check_print_runs').insert({
      org_id: orgId, location_id: ba.location_id, bank_account_id: ba.id, kind: 'ALIGNMENT', layout, printed_by: userId,
      note: `nudge x ${x} pt, y ${y} pt`,
    });
    return pdfResponse(pdf, 'check-alignment-test.pdf');
  } catch (e) {
    return checkErrorResponse(e, 'Could not build the alignment test.');
  }
});
