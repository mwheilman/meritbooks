export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listRuns, type ListRunsOptions } from '@/lib/agents/runner';
import { listRecipeSummaries } from '@/lib/agents/registry';
import type { AgentRunStatus } from '@/lib/agents/types';

/**
 * GET /api/agents — the supervised-agent run history + the recipe catalog.
 *
 * RBAC: reads gate on bills:view (the AP-intake loop is an AP feature). Degrade-safe:
 * if the persistence tables are absent, `runs` is [] and the surface shows an empty
 * history rather than erroring. RLS-scoped throughout — never filters org by hand.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'view');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const recipeParam = url.searchParams.get('recipe');
  const opts: ListRunsOptions = {};
  const VALID: AgentRunStatus[] = ['RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
  if (statusParam && (VALID as string[]).includes(statusParam)) opts.status = statusParam as AgentRunStatus;
  if (recipeParam) opts.recipe = recipeParam;

  const runs = await listRuns({ supabase, orgId, userId, locationId: null }, opts);

  return NextResponse.json({ data: { runs, recipes: listRecipeSummaries() } });
}
