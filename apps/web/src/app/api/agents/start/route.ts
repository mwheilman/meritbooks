export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { startAgentRunSchema } from '@/lib/validations/agents';
import { startRun } from '@/lib/agents/runner';
import { getRecipe } from '@/lib/agents/registry';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/agents/start — kick off a supervised agent run.
 *
 * Body: { recipe: 'AP_INTAKE', input: { bill_id } }. The runner drives the chain to
 * the first human gate (or completion). No step moves money/GL: PROPOSE steps only
 * apply reversible data entry when the M10 dial permits; HUMAN_GATE steps hand off to
 * the existing gated engines. RBAC: bills:create (starting an AP-intake loop).
 */
export async function POST(request: Request): Promise<NextResponse> {
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
  const parsed = startAgentRunSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const recipe = getRecipe(parsed.data.recipe);
  if (!recipe) {
    return NextResponse.json({ error: `Unknown agent recipe: ${parsed.data.recipe}`, code: 'UNKNOWN_RECIPE' }, { status: 400 });
  }

  const result = await startRun(
    { supabase, orgId, userId, locationId: null },
    recipe,
    parsed.data.input,
  );
  if ('error' in result) {
    return NextResponse.json({ error: result.error, code: 'START_FAILED' }, { status: 422 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'agent.run.start',
    subjectTable: 'agent_runs',
    subjectId: result.run.id,
    summary: `Started agent: ${result.run.title}`,
    metadata: { recipe: recipe.key, status: result.run.status },
  });

  return NextResponse.json({ data: result.run }, { status: 201 });
}
