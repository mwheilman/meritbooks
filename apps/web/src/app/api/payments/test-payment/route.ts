export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { createTestPayment, TestPaymentError } from '@/lib/money/test-payment';
import { testPaymentCreateBody } from '@/lib/validations/payments';

/**
 * POST /api/payments/test-payment  { location_id, confirm: true }
 *
 * Creates a $1.00 invoice on the company (posted to the GL, internal test customer) and
 * returns its hosted pay link, so the admin can pay it into that company's own Stripe
 * account and watch it post PAID → GL. In live mode this is real money; the screen
 * requires a confirmation saying so. One open test per company (an unpaid one is
 * returned instead of a new invoice). Requires settings_system:edit.
 */
export const POST = apiHandler(testPaymentCreateBody, async (b, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  try {
    await assertWriteScope(ctx.supabase, guard.orgId, [b.location_id]);
    const { run, reused } = await createTestPayment(createAdminSupabase(), { orgId: guard.orgId, locationId: b.location_id, userId: ctx.userId });
    return NextResponse.json({ ok: true, run, reused }, { status: reused ? 200 : 201 });
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    if (e instanceof TestPaymentError) return NextResponse.json({ error: e.message, code: 'TEST_PAYMENT' }, { status: e.status });
    throw e;
  }
});
