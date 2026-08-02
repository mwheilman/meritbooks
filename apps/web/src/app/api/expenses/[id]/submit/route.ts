export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { submitReport, PolicyBlockError } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

/**
 * POST /api/expenses/[id]/submit — submit a DRAFT report for approval.
 *
 * Deterministic policy enforcement (migration 086 + policy-engine.ts): the report
 * is re-evaluated against the org's ACTIVE compiled ruleset. BLOCK-severity
 * violations HALT submission (422 POLICY_BLOCK) unless the body carries an explicit
 * `{ override: true, override_reason }` — the override is audited to the action log.
 * WARN violations never block; they ride along on the lines for the approver.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  // Optional override body (submission past a policy block).
  let override = false;
  let overrideReason: string | undefined;
  try {
    const body = (await req.json()) as { override?: unknown; override_reason?: unknown };
    override = body?.override === true;
    overrideReason = typeof body?.override_reason === 'string' ? body.override_reason : undefined;
  } catch {
    /* no body — normal submit */
  }

  try {
    const res = await submitReport(supabase, orgId, params.id, userId, { override, overrideReason });
    await logAction(supabase, {
      orgId,
      actorType: 'HUMAN',
      actorUserId: null,
      action: res.overridden ? 'expenses.submit.override' : 'expenses.submit',
      subjectTable: 'expense_reports',
      subjectId: params.id,
      summary: res.overridden
        ? `Expense report submitted with POLICY OVERRIDE (${res.blockCount} block(s)) — reason: ${overrideReason ?? ''}`.slice(0, 300)
        : `Expense report submitted (${res.flaggedCount} policy flag(s))`,
      metadata: {
        submitted_by_clerk_user: userId,
        flagged: res.flaggedCount,
        block_count: res.blockCount,
        overridden: res.overridden,
        override_reason: res.overridden ? overrideReason ?? null : null,
        required_approval_tier: res.requiredApprovalTier,
      },
    });
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PolicyBlockError) {
      return NextResponse.json(
        { error: e.message, code: 'POLICY_BLOCK', blockCount: e.blockCount },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to submit' }, { status: 400 });
  }
}
