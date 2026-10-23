export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAccountMode, setAccountMode } from '@/lib/money/payment-accounts';
import { recordSettlementChange, requireSettlementAuthority } from '@/lib/money/settlement-guard';
import { paymentsSettingsBody } from '@/lib/validations/payments';

/**
 * PUT /api/payments/settings  { account_mode: 'per_company' | 'single' }
 *
 * per_company (default): every company collects into its own Stripe account.
 * single: every company collects into the one tenant-level account — an explicit
 * opt-in, because all companies' money then lands in one bank account.
 * core.org_payment_settings is SELECT-only for members (migration 175): written by the
 * service role after settings_system:edit, pinned to the caller's org. Audited.
 * Re-routing settlement is money movement: it also requires the money-movement release
 * authority, and a change notifies the tenant owner(s) (lib/money/settlement-guard).
 */
export const PUT = apiHandler(paymentsSettingsBody, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const money = await requireSettlementAuthority(ctx.userId);
  if (!money.ok) return money.response;
  const admin = createAdminSupabase();
  const before = await getAccountMode(admin, guard.orgId);
  await setAccountMode(admin, guard.orgId, body.account_mode, ctx.userId);
  if (before !== body.account_mode) {
    await recordSettlementChange(admin, {
      orgId: guard.orgId, actorUserId: ctx.userId, action: 'payments.account_mode.change',
      title: body.account_mode === 'single' ? 'All companies now collect into one account' : 'Each company now collects into its own account',
      body: body.account_mode === 'single'
        ? 'A team member switched online payments to one Stripe account for every company, so all customer payments settle to one bank account.'
        : 'A team member switched online payments back to one Stripe account per company.',
      subjectTable: 'org_payment_settings', subjectId: guard.orgId,
    });
  }
  return NextResponse.json({ ok: true, account_mode: body.account_mode });
});
