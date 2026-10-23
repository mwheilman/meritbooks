export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { companyOptionsToColumns, companyPaymentOptions, type TermsLevel } from '@/lib/money/payment-terms';
import { writeAudit } from '@/lib/money/payment-accounts';
import { companyPaymentOptionsBody } from '@/lib/validations/payments';

/**
 * PUT /api/payments/company-options
 *   { location_id, card_enabled, ach_enabled, check_enabled, card_fee_payer, ach_fee_payer }
 *
 * A company's default payment options — the company level of the invoice → job →
 * customer → company cascade (core.locations.payment_methods_allowed /
 * card_surcharge_enabled / ach_surcharge_enabled). Customer, job and invoice overrides
 * still win. What MeritBooks charges (Layer 1) is NOT settable here.
 *
 * Same gate as the company row of /api/entity-invoice-settings (settings_acct:edit);
 * core.locations is service-role-write only (migration 167), so the write runs as the
 * service role after the check, pinned to the org and the caller's client scope. Every
 * changed field is audited.
 */
export const PUT = apiHandler(companyPaymentOptionsBody, async (b, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_acct', 'edit', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  try {
    await assertWriteScope(ctx.supabase, orgId, [b.location_id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }

  const admin = createAdminSupabase();
  const { data: before } = await admin.schema('core').from('locations')
    .select('payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled')
    .eq('org_id', orgId).eq('id', b.location_id).maybeSingle<TermsLevel>();
  if (!before) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const cols = companyOptionsToColumns({
    cardEnabled: b.card_enabled,
    achEnabled: b.ach_enabled,
    checkEnabled: b.check_enabled,
    cardFeePayer: b.card_fee_payer,
    achFeePayer: b.ach_fee_payer,
  });
  const { error } = await admin.schema('core').from('locations').update(cols).eq('org_id', orgId).eq('id', b.location_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const fmt = (v: unknown) => (v == null ? null : Array.isArray(v) ? v.join(',') : String(v));
  for (const field of ['payment_methods_allowed', 'card_surcharge_enabled', 'ach_surcharge_enabled'] as const) {
    if (fmt(before[field]) !== fmt(cols[field])) {
      await writeAudit(admin, { orgId, table: 'locations', recordId: b.location_id, field, oldValue: fmt(before[field]), newValue: fmt(cols[field]), userId: ctx.userId });
    }
  }
  return NextResponse.json({ ok: true, options: companyPaymentOptions(cols) });
});
