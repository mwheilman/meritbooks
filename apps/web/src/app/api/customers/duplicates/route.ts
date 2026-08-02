export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanCustomerDuplicates } from '@/lib/customers/dedupe';

/**
 * POST /api/customers/duplicates — run the org-wide duplicate-customer scan and
 * queue new merge proposals into /exceptions (feature CUSTOMER_DEDUPE). Gated on
 * `customers:edit` because it writes proposals; the scan itself only detects and
 * drafts — a human still approves each merge via /api/customers/merge (canon §3).
 */
export async function POST() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const guard = await requirePermission(userId, 'customers', 'edit');
  if (!guard.ok) return guard.response;

  const summary = await scanCustomerDuplicates(supabase, orgId);
  return NextResponse.json({ summary });
}
