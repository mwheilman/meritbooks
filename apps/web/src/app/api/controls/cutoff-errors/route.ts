export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanCutoffErrors } from '@/lib/controls/cutoff-errors';

/**
 * Financial Control Exception EC-12 — period cut-off errors.
 *
 * POST /api/controls/cutoff-errors
 *   Scans the caller's org's recent posted entries for revenue/expense recognized in
 *   the WRONG fiscal period — a posted P&L entry whose economic date (bill/invoice/
 *   receipt document date, or a service date in the memo) falls in a different period
 *   than where it was booked, within N days of the cut between them (a December
 *   invoice posted in January; a next-period bill expensed this period); plus large
 *   P&L entries landing right at a period boundary with no document to verify against.
 *   Each cut-off is queued into /exceptions (PROPOSED ai_decisions, feature
 *   'CUTOFF_ERROR') with the two periods, the $ shifted, a plain reason, and a DRAFTED
 *   correction (which period it belongs in — a reverse-and-repost respecting period
 *   locks) for a human to confirm. REVIEW tier; ESCALATE when the correction crosses a
 *   CLOSED/LOCKED period or the shift is very large. Idempotent — a second call
 *   REFRESHES the open exceptions (never duplicates; migration 070 unique index is the
 *   DB guarantor), leaves human-resolved cut-offs alone, and expires ones that have
 *   since been moved to the right period. Returns a summary (cut-offs by signal/tier,
 *   total $ shifted).
 *
 *   ?period=YYYY-MM  — restrict to entries whose posted or economic period is this.
 *   ?since=YYYY-MM-DD — only scan entries with entry_date >= this.
 *   ?limit=N          — cap the population loaded (default 2000, most recent).
 *   ?dryRun=1         — compute + return the cut-offs WITHOUT persisting any rows.
 *
 * Authorization: authed + RLS-scoped, and gated on journal_entries:create (the
 * authority to book the correction this control drafts) — matching the other control
 * routes. Reads/writes run through the RLS-scoped client, so the database enforces org
 * isolation; the route never filters org_id by hand. This detects and DRAFTS
 * remediations only — it never posts, reverses, or edits the ledger (canon §3: AI
 * proposes; a human with the right role confirms the period).
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
  const sinceParam = url.searchParams.get('since');
  const sinceDate = sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam) ? sinceParam : undefined;
  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(5000, parsedLimit)) : undefined;

  const summary = await scanCutoffErrors(supabase, orgId, { dryRun, period, sinceDate, limit });
  return NextResponse.json({ data: summary });
}
