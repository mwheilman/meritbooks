export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { logFieldReveal } from '@/lib/rbac/field-masks';
import { bankAccountQuery, positivePaySchema } from '@/lib/validations/checks';
import { generatePositivePay, listPositivePayExports, type PositivePayOutput } from '@/lib/ap/checks/positive-pay-service';
import { supabaseCheckSecrets } from '@/lib/ap/checks/secrets';
import { checkErrorResponse, requireCheckMoney, requireCheckView, userNames } from '@/lib/ap/checks/route-support';

/**
 * GET  /api/ap/checks/positive-pay?bank_account_id= — file history + what the next
 *      "since last file" would carry (counts only). checks:view.
 * POST — generate the issue file in the account's bank format (preview: counts only).
 *      The file carries the full account number: release authority + session policy, and
 *      the reveal is logged to core.field_reveals before the file is returned.
 */
export const GET = apiQueryHandler(bankAccountQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const admin = createAdminSupabase();
    const [history, next] = await Promise.all([
      listPositivePayExports(supabase, orgId, q.bank_account_id),
      generatePositivePay(supabase, orgId, userId, { bankAccountId: q.bank_account_id, mode: 'SINCE_LAST', preview: true }, supabaseCheckSecrets(admin), async () => false),
    ]);
    const names = await userNames(supabase, history.map((h) => h.generated_by));
    return NextResponse.json({ history, next, names });
  } catch (e) {
    return checkErrorResponse(e, 'Could not load positive pay.');
  }
});

export const POST = apiHandler(positivePaySchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (!body.preview) {
    const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'money_release' });
    if (!policy.ok) return policy.response;
  }
  try {
    const admin = createAdminSupabase();
    const out = await generatePositivePay(
      supabase, orgId, userId,
      { bankAccountId: body.bankAccountId, mode: body.mode, from: body.from ?? null, through: body.through ?? null, preview: body.preview },
      supabaseCheckSecrets(admin),
      (e) => logFieldReveal(admin, { ...e, fieldClass: 'bank', subjectTable: 'bank_accounts' }),
    );
    if (body.preview || !('content' in out)) return NextResponse.json(out);
    const file = out as PositivePayOutput;
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.positive_pay',
      subjectTable: 'positive_pay_exports',
      subjectId: file.exportId,
      summary: `Generated positive-pay file ${file.fileName}: ${file.issueCount} issue(s), ${file.voidCount} void(s)`,
      metadata: { bankAccountId: body.bankAccountId, format: file.format, issueCount: file.issueCount, voidCount: file.voidCount, issueTotalCents: file.issueTotalCents, voidTotalCents: file.voidTotalCents },
    }).catch(() => {});
    return new NextResponse(file.content, {
      headers: {
        'Content-Type': `${file.mime}; charset=us-ascii`,
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
        'Cache-Control': 'no-store, max-age=0',
        'X-Positive-Pay-Issues': String(file.issueCount),
        'X-Positive-Pay-Voids': String(file.voidCount),
      },
    });
  } catch (e) {
    return checkErrorResponse(e, 'Could not generate the positive-pay file.');
  }
});
