export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanSalesTaxNexus } from '@/lib/controls/sales-tax-nexus';

/**
 * Financial Control Exception EC-7 — sales/use-tax economic-nexus tripwire.
 *
 * POST /api/controls/sales-tax-nexus
 *   Aggregates the caller's org's trailing-12-month invoiced revenue AND transaction
 *   count by DESTINATION STATE (ship-to → bill-to → customer-HQ fallback) and flags
 *   any state that has crossed its economic-nexus threshold (tunable per state;
 *   default $100,000 in sales OR 200 transactions). Because there is no registration
 *   table yet, every crossing is surfaced as a CANDIDATE undisclosed sales/use-tax
 *   exposure — the six-figure liability the seller eats and that surfaces in
 *   diligence. Each crossed state is queued into /exceptions (PROPOSED ai_decisions,
 *   feature 'SALES_TAX_NEXUS') with the trailing sales + txn count, the threshold and
 *   basis crossed, a plain reason, and a DRAFTED next step (register + start
 *   collecting; nexus study / VDA for the back period). Idempotent — a second call
 *   REFRESHES the open exceptions (never duplicates; migration 070 unique index is
 *   the DB guarantor), leaves human-resolved crossings alone, and expires crossings
 *   whose trailing window has rolled past. Returns a summary (crossed + approaching
 *   states, tiers, total exposure).
 *
 *   ?windowEnd=YYYY-MM  — end the trailing-12mo window at a specific month
 *                          (default: the current month).
 *   ?dryRun=1           — compute + return the crossings WITHOUT persisting any rows.
 *
 * Authorization: authed + RLS-scoped, and gated on journal_entries:create — the same
 * guard the rest of the EC-* control set uses, keeping the family consistent (held by
 * controller / accounting-manager / -specialist; denied to general_admin /
 * business_user / check_processor → 403). Reads/writes run through the RLS-scoped
 * client, so the database enforces org isolation; the route never filters org_id by
 * hand. This DETECTS and DRAFTS only — it never registers, files, collects tax, or
 * edits the ledger (canon §3: AI proposes; a human with the right role acts).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const windowEndParam = url.searchParams.get('windowEnd');
  const windowEnd =
    windowEndParam && /^\d{4}-\d{2}$/.test(windowEndParam) ? windowEndParam : undefined;

  const summary = await scanSalesTaxNexus(supabase, orgId, { dryRun, windowEnd });
  return NextResponse.json({ data: summary });
}
