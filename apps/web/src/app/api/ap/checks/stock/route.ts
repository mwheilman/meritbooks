export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { bankAccountQuery, stockSettingsSchema } from '@/lib/validations/checks';
import { loadStockView, saveStockSettings } from '@/lib/ap/checks/stock-service';
import { isTenantAdmin } from '@/lib/ap/checks/stock-security';
import { checkErrorResponse, requireCheckMoney, requireCheckView, userNames } from '@/lib/ap/checks/route-support';

/**
 * GET /api/ap/checks/stock?bank_account_id= — the account's check stock settings (masks
 * only; "on file" flags for the MICR numbers and signatures — never the values).
 * PUT — save layout, nudge, payer / bank blocks, thresholds, positive-pay format. Release
 * authority + session policy (these settings decide what prints on a negotiable check).
 */
export const GET = apiQueryHandler(bankAccountQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const admin = createAdminSupabase();
    const view = await loadStockView(supabase, orgId, q.bank_account_id, admin);
    const p = view.profile;
    const names = await userNames(supabase, [p?.micr_set_by ?? '', p?.signature_set_by ?? '', p?.signature2_set_by ?? '', p?.updated_by ?? '', ...view.securityChanges.map((c) => c.changed_by)]);
    // M9: may THIS user confirm someone else's security change? (UI hint; the route re-checks.)
    const canConfirmSecurity = view.securityChanges.some((c) => c.changed_by !== userId) ? await isTenantAdmin(admin, orgId, userId) : false;
    return NextResponse.json({ ...view, names, canConfirmSecurity });
  } catch (e) {
    return checkErrorResponse(e, 'Could not load the check stock settings.');
  }
});

export const PUT = apiHandler(stockSettingsSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'bank_details_edit' });
  if (!policy.ok) return policy.response;
  try {
    const { bankAccountId, ...settings } = body;
    await saveStockSettings(supabase, orgId, userId, bankAccountId, {
      ...settings,
      payerName: settings.payerName ?? null,
      payerAddress: settings.payerAddress ?? null,
      logoUrl: settings.logoUrl ?? null,
      bankName: settings.bankName ?? null,
      bankAddress: settings.bankAddress ?? null,
      bankFraction: settings.bankFraction ?? null,
      positivePayMapping: (settings.positivePayMapping as Record<string, unknown> | null) ?? null,
    });
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.stock.update',
      subjectTable: 'check_stock_profiles',
      summary: `Updated check stock settings (layout ${settings.layout}, positive pay ${settings.positivePayFormat})`,
      metadata: { bankAccountId, layout: settings.layout, offsetXPt: settings.offsetXPt, offsetYPt: settings.offsetYPt, secondSignatureOverCents: settings.secondSignatureOverCents, maxCheckCents: settings.maxCheckCents },
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return checkErrorResponse(e, 'Could not save the check stock settings.');
  }
});
