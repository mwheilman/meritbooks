export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanRevenueNotRecognized } from '@/lib/controls/revenue-not-recognized';

/**
 * Financial Control Exception EC-6 — Revenue not recognized on schedule.
 *
 * POST /api/controls/revenue-not-recognized
 *   Scans the caller's org for revenue that is EARNED but not yet RECOGNIZED for the
 *   period being closed — a deferred-revenue schedule whose recognition run is
 *   missing, an in-progress POC/percentage-complete job whose earned-to-date (per the
 *   rev-rec engine's own method math) exceeds recognized-to-date by a material amount,
 *   and a completed/closed job whose satisfied obligation is still short of full
 *   recognition (with residual Deferred Revenue un-released). Each gap is queued into
 *   /exceptions (PROPOSED ai_decisions, feature 'REVENUE_NOT_RECOGNIZED') with the
 *   $-under-recognized, a plain reason, and a DRAFTED release entry
 *   (DR Deferred Revenue 2410 / CR Revenue). Idempotent — a second call REFRESHES the
 *   open exceptions (never duplicates; migration 070 unique index is the DB
 *   guarantor), leaves human-resolved gaps alone, and expires gaps since recognized.
 *   Returns a summary (gaps by kind/tier, total $ at risk).
 *
 *   ?period=YYYY-MM  — scan a specific close period (default: the month before now).
 *   ?dryRun=1        — compute + return the gaps WITHOUT persisting any rows.
 *
 * Authorization: authed + RLS-scoped, and gated on journal_entries:create (the
 * authority to book the recognition this control drafts). Reads/writes run through the
 * RLS-scoped client, so the database enforces org isolation; the route never filters
 * org_id by hand. This detects and DRAFTS remediations only — it never posts revenue
 * or touches the ledger (canon §3: AI proposes; the rev-rec engine / a human acts).
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

  const summary = await scanRevenueNotRecognized(supabase, orgId, { dryRun, period });
  return NextResponse.json({ data: summary });
}
