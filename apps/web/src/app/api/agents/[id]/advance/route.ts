export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { advanceAgentRunSchema } from '@/lib/validations/agents';
import { advanceRun } from '@/lib/agents/runner';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/agents/[id]/advance — a human's decision at the run's current gate.
 *
 * Body: { decision: 'APPROVE' | 'REJECT', note? }. The runner applies it to the
 * WAITING step and continues to the next pause / completion. CRITICAL: advancing
 * NEVER posts money/GL — the money-moving approval flows through the existing gated
 * bill-approve engine (SoD-enforced); this endpoint's approval gate only OBSERVES that
 * the bill reached APPROVED there. RBAC: bills:create (a supervisory action).
 */
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = advanceAgentRunSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  let run;
  try {
    run = await advanceRun(
      { supabase, orgId, userId, locationId: null },
      params.id,
      { decision: parsed.data.decision, note: parsed.data.note ?? null, actorUserId: userId },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not advance the run', code: 'ADVANCE_FAILED' },
      { status: 409 },
    );
  }
  if (!run) return NextResponse.json({ error: 'Run not found', code: 'NOT_FOUND' }, { status: 404 });

  await logHumanAction(supabase, userId, orgId, {
    action: 'agent.run.advance',
    subjectTable: 'agent_runs',
    subjectId: run.id,
    summary: `${parsed.data.decision === 'APPROVE' ? 'Approved' : 'Rejected'} agent gate on: ${run.title}`,
    metadata: { decision: parsed.data.decision, status: run.status },
  });

  return NextResponse.json({ data: run });
}
