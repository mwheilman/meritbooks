export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanCashApplication } from '@/lib/controls/cash-application';

/**
 * AI Cash Application (GATE 8) — scan unmatched bank deposits and PROPOSE the open
 * customer invoice(s) each likely settles.
 *
 * POST /api/controls/cash-application
 *   Runs the cash-application matcher for the caller's org and returns a summary of
 *   what was scanned and how many NEW proposals were queued into /exceptions (as
 *   PROPOSED ai_decisions rows, feature 'CASH_APPLICATION'). Idempotent — a second
 *   call queues nothing new because each proposal carries dedup_key
 *   `cashapp:<bank_txn_id>` (migration 070's partial unique index is the DB guarantor).
 *
 * Read/write both run through the RLS-scoped client, so the database enforces org
 * isolation; the route never filters org_id by hand. This DETECTS and PROPOSES only
 * — it never creates a customer_payment, applies a payment, or posts to the ledger.
 * A human approves in the queue and the EXISTING payment-application path posts it
 * (canon §3: AI proposes; the deterministic engine posts; a human approves).
 *
 * Authorization: gated on invoices:approve — applying customer cash to AR is an AR
 * approval act, so the same role that may approve an invoice may run/consume this
 * proposal. Denied to roles without invoice-approve authority (403).
 */
export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  const summary = await scanCashApplication(supabase, orgId);
  return NextResponse.json({ data: summary });
}
