export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanBillAnomalies } from '@/lib/controls/bill-anomaly';

/**
 * Financial Control Exception — bill / AP anomaly scan (BEFORE it posts).
 *
 * POST /api/controls/bill-anomaly
 *   Runs the unapproved-bill anomaly detector for the caller's org and returns a
 *   summary of what was scanned and how many NEW exceptions were queued into
 *   /exceptions (as PROPOSED ai_decisions rows, feature 'BILL_ANOMALY'). Idempotent
 *   — a second call queues nothing new because each hit carries a stable dedup_key
 *   (`billanom:<bill_id>`; migration 070's partial unique index is the DB guarantor).
 *
 * Read/write both run through the RLS-scoped client, so the database enforces org
 * isolation; the route never filters org_id by hand. This detects and DRAFTS a
 * review only — it never approves a bill, blocks payment, or posts to the ledger
 * (canon §3: AI proposes; a human with the right role acts).
 */
export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  // Authorize — control scans enqueue exceptions + write AI-attributed audit rows,
  // so gate on journal_entries:create (same guard the EC-1 duplicate-payment and
  // missed-accruals controls use, keeping the whole control set consistent). Held
  // by controller/accounting-manager/-specialist; denied to general_admin,
  // business_user, check_processor (403).
  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const summary = await scanBillAnomalies(supabase, orgId);
  return NextResponse.json({ data: summary });
}
