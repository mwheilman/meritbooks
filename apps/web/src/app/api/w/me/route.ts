export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { assignmentsForUser } from '@/lib/receipts/cardholders';
import { workforceViewResponse } from '@/lib/receipts/workforce-api';

/**
 * GET /api/w/me — Merit Workforce (signed in): the caller's OWN cards, the charges that
 * still need a receipt, their recent receipts, and the job picker.
 *
 * Authorization is "you hold the card": the caller's card assignments are resolved from
 * their verified Clerk identity (core.users → core.memberships, or core.employees.
 * clerk_user_id) inside their resolved org. No feature permission is needed — a cardholder
 * sees only their own charges (FPB-workforce-app §8, role `employee`: own records only).
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const admin = createAdminSupabase();
  const assignments = await assignmentsForUser(admin, ctx.orgId, ctx.userId);
  return workforceViewResponse(admin, ctx.orgId, assignments);
}
