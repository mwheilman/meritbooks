export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sharedRateLimiter, retryAfterSeconds } from '@/lib/security/rate-limit';
import { assignmentsForUser } from '@/lib/receipts/cardholders';
import { workforceUploadResponse } from '@/lib/receipts/workforce-api';

const PER_USER = { windowMs: 60_000, max: 20 } as const;

/**
 * POST /api/w/me/upload — Merit Workforce (signed in): snap / upload a receipt, for one of
 * the caller's own charges (`transaction_id`) or unattached (auto-matches). The charge must
 * belong to one of the caller's card assignments (else 404). Service role writes, org +
 * company + cardholder taken from the caller's assignment — never from the form.
 */
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const t = sharedRateLimiter.checkAll([{ key: `w-upload:user:${ctx.userId}`, rule: PER_USER }]);
  if (!t.allowed) return NextResponse.json({ error: 'Too many uploads in a minute. Try again shortly.' }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(t)) } });
  const admin = createAdminSupabase();
  const assignments = await assignmentsForUser(admin, ctx.orgId, ctx.userId);
  if (assignments.length === 0) return NextResponse.json({ error: 'No company card is assigned to you yet.' }, { status: 404 });
  return workforceUploadResponse(req, admin, ctx.orgId, assignments, ctx.userId);
}
