export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanOutOfPolicyExpenses } from '@/lib/controls/out-of-policy-expense';

/**
 * Financial Control Exception EC-14 — out-of-policy employee expenses.
 *
 * POST /api/controls/out-of-policy-expense
 *   Re-evaluates the caller's live (SUBMITTED / APPROVED / REIMBURSED) expense
 *   reports against the ACTIVE compiled expense policy (the deterministic engine —
 *   no AI) and queues any report that still trips a WARN/BLOCK rule into /exceptions
 *   (PROPOSED ai_decisions, feature 'OUT_OF_POLICY_EXPENSE') with the $ out of policy,
 *   the offending lines, and a DRAFTED review for a human. Idempotent — a second call
 *   REFRESHES the open exceptions (never duplicates; migration 070 unique index is
 *   the DB guarantor), leaves human-resolved reports alone, and expires reports that
 *   were corrected or that the policy no longer flags. Returns a summary
 *   (exceptions by tier, total $ out of policy, whether an active policy drove it).
 *
 *   ?dryRun=1  — compute + return the exceptions WITHOUT persisting any rows.
 *
 * Authorization: authed + RLS-scoped, and gated on journal_entries:create (the same
 * guard the EC-1 duplicate-payment, missed-accruals, and cutoff controls use, keeping
 * the whole control set consistent). Reads/writes run through the RLS-scoped client,
 * so the database enforces org isolation; the route never filters org_id by hand. This
 * detects and DRAFTS a review only — it never edits, approves, or reverses an expense
 * report (canon §3: AI/heuristics propose; a human with the right role acts).
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

  const summary = await scanOutOfPolicyExpenses(supabase, orgId, { dryRun });
  return NextResponse.json({ data: summary });
}
