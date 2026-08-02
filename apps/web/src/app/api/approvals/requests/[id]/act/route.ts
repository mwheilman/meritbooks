export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { actOnRequest } from '@/lib/approvals/service';
import { WorkflowError } from '@/lib/approvals/workflow';

/**
 * POST /api/approvals/requests/:id/act  — approve or reject the request's CURRENT step.
 *
 * Authorization is decided by the pure engine (advanceChain): it enforces role-at-step
 * (the acting user's role, resolved from the core identity spine, must meet the step's
 * required role), preparer != approver (canon SoD), and distinct-approver on
 * require_distinct steps. A violation → 403 with the specific reason. On full approval
 * with a linked single-approval, the existing gated money-movement action fires
 * (posting is not forked). Every action is audited in approval_request_actions.
 */
const schema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(1000).optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  if (parsed.data.decision === 'REJECT' && !parsed.data.reason?.trim()) {
    return NextResponse.json({ error: 'A reason is required to reject.', code: 'REASON_REQUIRED' }, { status: 422 });
  }

  try {
    const result = await actOnRequest(createAdminSupabase(), ctx.orgId, {
      requestId: params.id,
      actorUserId: ctx.userId,
      decision: parsed.data.decision,
      reason: parsed.data.reason ?? null,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      const status = e.code === 'ROLE_NOT_AUTHORIZED' || e.code === 'PREPARER_CANNOT_APPROVE' || e.code === 'DISTINCT_APPROVER_REQUIRED' ? 403 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    throw e;
  }
}
