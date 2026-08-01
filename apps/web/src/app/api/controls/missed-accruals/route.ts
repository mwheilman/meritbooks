export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanMissedAccruals } from '@/lib/controls/missed-accruals';

/**
 * Financial Control Exception EC-2 — missed / mis-estimated accruals & deferrals.
 *
 * POST /api/controls/missed-accruals
 *   Scans the caller's org for recurring economic activity that should be accrued
 *   at period end but isn't — a recurring vendor that went silent this period, a
 *   recurring journal template due but never generated, a scheduled amortization /
 *   deferral with no run — for the period being closed. Each gap is queued into
 *   /exceptions (PROPOSED ai_decisions, feature 'MISSED_ACCRUAL') with a run-rate
 *   $-estimate and a DRAFTED, reversing accrual entry for a human to review and
 *   post through the deterministic engine. Idempotent — a second call REFRESHES the
 *   open exceptions (never duplicates; migration 070 unique index is the DB
 *   guarantor), leaves human-resolved gaps alone, and expires gaps that have since
 *   been closed. Returns a summary (gaps by kind/tier, total $ at risk).
 *
 *   ?period=YYYY-MM  — scan a specific close period (default: the month before now).
 *   ?dryRun=1        — compute + return the gaps WITHOUT persisting any rows.
 *
 * Authorization: authed + RLS-scoped, and gated on journal_entries:create (the
 * authority to book the accrual this control drafts). Reads/writes run through the
 * RLS-scoped client, so the database enforces org isolation; the route never filters
 * org_id by hand. This detects and DRAFTS remediations only — it never posts, pays,
 * or edits the ledger (canon §3: AI proposes; a human with the right role acts).
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
  const periodParam = url.searchParams.get('period');
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : undefined;

  const summary = await scanMissedAccruals(supabase, orgId, { dryRun, period });
  return NextResponse.json({ data: summary });
}
